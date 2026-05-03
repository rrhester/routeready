-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0034 · Weekly-scoped scheduling settings
--
-- Each (dsp_id, week_start) gets its own row of scheduling settings:
-- block hours, cushion %, max days, waves, timezone. Settings are
-- versioned per week — past weeks stay as they were, future weeks
-- inherit from the most recent earlier week (or DSP defaults).
--
-- generate_shifts and regenerate_all_shifts now look up the week's
-- settings instead of dsps.metadata.scheduling.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.scheduling_settings (
  dsp_id              uuid          not null references public.dsps(id) on delete cascade,
  week_start          date          not null,
  default_block_hours int           not null default 10,
  cushion_pct         numeric       not null default 10,
  max_days_per_week   int           not null default 5,
  waves               jsonb         not null default '[{"start":"07:00"}]'::jsonb,
  timezone            text          not null default 'UTC',
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),
  primary key (dsp_id, week_start)
);

create trigger trg_scheduling_settings_updated_at
  before update on public.scheduling_settings
  for each row execute function private.set_updated_at();

alter table public.scheduling_settings enable row level security;
create policy "scheduling_settings_tenant_rw"
  on public.scheduling_settings for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.scheduling_settings to authenticated;


-- ─── private.week_start_for(date) ─────────────────────────────────────────
-- Postgres date_trunc('week', d) returns Monday — exactly what we want.
create or replace function private.week_start_for(p_date date)
returns date
language sql
immutable
as $$
  select date_trunc('week', p_date)::date;
$$;


-- ─── private.get_week_settings(dsp, week_start) ──────────────────────────
-- Returns the effective settings for a week. Order of precedence:
--   1. Exact row in scheduling_settings for (dsp, week_start)
--   2. Most recent earlier week's row (inherited)
--   3. dsps.metadata.scheduling fallback (legacy)
-- Always returns a row; week_start is overwritten to the requested week
-- so the caller knows which slice it's reading.
create or replace function private.get_week_settings(p_dsp_id uuid, p_week_start date)
returns public.scheduling_settings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.scheduling_settings;
  v_meta jsonb;
begin
  -- Exact week
  select * into v_row from public.scheduling_settings
   where dsp_id = p_dsp_id and week_start = p_week_start;
  if found then return v_row; end if;

  -- Previous week
  select * into v_row from public.scheduling_settings
   where dsp_id = p_dsp_id and week_start < p_week_start
   order by week_start desc limit 1;
  if found then
    v_row.week_start := p_week_start;
    return v_row;
  end if;

  -- DSP metadata fallback
  select metadata into v_meta from public.dsps where id = p_dsp_id;
  v_row.dsp_id := p_dsp_id;
  v_row.week_start := p_week_start;
  v_row.default_block_hours := coalesce((v_meta->'scheduling'->>'default_block_hours')::int, 10);
  v_row.cushion_pct         := coalesce((v_meta->'scheduling'->>'cushion_pct')::numeric, 10);
  v_row.max_days_per_week   := coalesce((v_meta->'scheduling'->>'max_days_per_week')::int, 5);
  v_row.waves               := coalesce(v_meta->'scheduling'->'waves',
                                        jsonb_build_array(jsonb_build_object('start',
                                          coalesce(v_meta->'scheduling'->>'wave_start', '07:00'))));
  v_row.timezone            := coalesce(v_meta->'scheduling'->>'timezone', 'UTC');
  return v_row;
end;
$$;


-- ─── public.scheduling_settings_for_week(week_start) ─────────────────────
-- UI calls this to populate the panel for the visible week. Returns a
-- row plus an `is_inherited` flag so the UI can show "inherited from
-- previous week" vs "custom for this week".
create or replace function public.scheduling_settings_for_week(p_week_start date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_exact public.scheduling_settings;
  v_eff   public.scheduling_settings;
  v_inherited boolean;
begin
  v_eff := private.get_week_settings(v_dsp, p_week_start);
  select * into v_exact from public.scheduling_settings
   where dsp_id = v_dsp and week_start = p_week_start;
  v_inherited := not found;

  return jsonb_build_object(
    'week_start',          v_eff.week_start,
    'default_block_hours', v_eff.default_block_hours,
    'cushion_pct',         v_eff.cushion_pct,
    'max_days_per_week',   v_eff.max_days_per_week,
    'waves',               v_eff.waves,
    'timezone',            v_eff.timezone,
    'is_inherited',        v_inherited
  );
end;
$$;
grant execute on function public.scheduling_settings_for_week(date) to authenticated;


-- ─── public.upsert_scheduling_settings(payload) ──────────────────────────
-- Saves a week-scoped row. Triggers regenerate for that week's days only.
create or replace function public.upsert_scheduling_settings(p_payload jsonb)
returns public.scheduling_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_start date := (p_payload->>'week_start')::date;
  v_row public.scheduling_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.scheduling_settings
    (dsp_id, week_start, default_block_hours, cushion_pct, max_days_per_week, waves, timezone)
  values
    (v_dsp,
     v_week_start,
     coalesce((p_payload->>'default_block_hours')::int, 10),
     coalesce((p_payload->>'cushion_pct')::numeric, 10),
     coalesce((p_payload->>'max_days_per_week')::int, 5),
     coalesce(p_payload->'waves', jsonb_build_array(jsonb_build_object('start','07:00'))),
     coalesce(p_payload->>'timezone', 'UTC'))
  on conflict (dsp_id, week_start) do update
    set default_block_hours = excluded.default_block_hours,
        cushion_pct         = excluded.cushion_pct,
        max_days_per_week   = excluded.max_days_per_week,
        waves               = excluded.waves,
        timezone            = excluded.timezone,
        updated_at          = now()
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.upsert_scheduling_settings(jsonb) to authenticated;


-- ─── private.generate_shifts (now reads weekly settings) ─────────────────
create or replace function private.generate_shifts(p_dsp_id uuid, p_date date, p_station_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target int;
  v_settings public.scheduling_settings;
  v_wave_count int;
  v_existing int;
  v_needed int;
  v_to_create int;
  v_to_delete int;
  v_index int;
  v_starts timestamptz;
  v_ends   timestamptz;
  v_wave_start text;
begin
  select coalesce(target_routes, 0)
    into v_target
  from public.okami_demand
   where dsp_id = p_dsp_id
     and station_id = p_station_id
     and date = p_date;
  v_target := coalesce(v_target, 0);

  v_settings := private.get_week_settings(p_dsp_id, private.week_start_for(p_date));

  v_needed := ceil(v_target::numeric * (1 + v_settings.cushion_pct / 100))::int;
  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_settings.waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;

  select count(*)::int
    into v_existing
  from public.shifts
   where dsp_id = p_dsp_id
     and station_id = p_station_id
     and date = p_date
     and status in ('scheduled','completed');

  if v_existing > v_needed then
    v_to_delete := v_existing - v_needed;
    delete from public.shifts
     where id in (
       select id from public.shifts
        where dsp_id = p_dsp_id
          and station_id = p_station_id
          and date = p_date
          and status = 'scheduled'
          and driver_id is null
        order by is_cushion desc, starts_at desc
        limit v_to_delete
     );
    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id = p_dsp_id
       and station_id = p_station_id
       and date = p_date
       and status in ('scheduled','completed');
  end if;

  v_to_create := greatest(0, v_needed - v_existing);
  if v_to_create = 0 then return 0; end if;

  for v_index in v_existing..(v_needed - 1) loop
    v_wave_start := v_settings.waves->(v_index % v_wave_count)->>'start';
    v_starts := (p_date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone;
    v_ends   := v_starts + (v_settings.default_block_hours || ' hours')::interval;

    insert into public.shifts
      (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion)
    values
      (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto', v_settings.default_block_hours, v_index >= v_target);
  end loop;

  return v_to_create;
end;
$$;


-- ─── public.regenerate_week_shifts(week_start) ───────────────────────────
-- Regenerate just one week's shifts using THAT week's settings. The old
-- regenerate_all_shifts touched everything; per-week version is what the
-- per-week settings UI calls on save.
create or replace function public.regenerate_week_shifts(p_week_start date)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_settings public.scheduling_settings;
  v_wave_count int;
  v_count int := 0;
  r record;
  s record;
  v_pos int;
  v_wave_start text;
  v_starts timestamptz;
  v_week_end date := p_week_start + 6;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_settings := private.get_week_settings(v_dsp, p_week_start);
  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_settings.waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;

  -- Wipe unassigned scheduled shifts for this week only.
  delete from public.shifts
   where dsp_id = v_dsp
     and driver_id is null
     and status = 'scheduled'
     and date between p_week_start and v_week_end;

  -- Regenerate from okami_demand for this week.
  for r in
    select date, station_id from public.okami_demand
     where dsp_id = v_dsp and date between p_week_start and v_week_end
  loop
    v_count := v_count + private.generate_shifts(v_dsp, r.date, r.station_id);
  end loop;

  -- Reposition all shifts in this week to the configured wave times.
  for r in
    select distinct date, station_id from public.shifts
     where dsp_id = v_dsp and status = 'scheduled'
       and date between p_week_start and v_week_end
  loop
    v_pos := 0;
    for s in
      select id from public.shifts
       where dsp_id = v_dsp
         and date = r.date
         and station_id = r.station_id
         and status = 'scheduled'
       order by is_cushion asc, created_at asc, id asc
    loop
      v_wave_start := v_settings.waves->(v_pos % v_wave_count)->>'start';
      v_starts := (r.date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone;
      update public.shifts
         set starts_at  = v_starts,
             ends_at    = v_starts + (v_settings.default_block_hours || ' hours')::interval,
             block_hours = v_settings.default_block_hours
       where id = s.id;
      v_pos := v_pos + 1;
    end loop;
  end loop;

  return v_count;
end;
$$;
grant execute on function public.regenerate_week_shifts(date) to authenticated;


-- Backfill: populate scheduling_settings rows for every week that already
-- has okami_demand or shifts data, using the DSP's current metadata as the
-- starting value. Past weeks stay frozen at this state.
do $$
declare r record;
begin
  for r in
    select distinct dsp_id, private.week_start_for(date) as week_start
      from public.okami_demand
    union
    select distinct dsp_id, private.week_start_for(date) as week_start
      from public.shifts
  loop
    insert into public.scheduling_settings (
      dsp_id, week_start, default_block_hours, cushion_pct, max_days_per_week, waves, timezone
    )
    select
      r.dsp_id,
      r.week_start,
      coalesce((metadata->'scheduling'->>'default_block_hours')::int, 10),
      coalesce((metadata->'scheduling'->>'cushion_pct')::numeric, 10),
      coalesce((metadata->'scheduling'->>'max_days_per_week')::int, 5),
      coalesce(metadata->'scheduling'->'waves',
               jsonb_build_array(jsonb_build_object('start',
                 coalesce(metadata->'scheduling'->>'wave_start','07:00')))),
      coalesce(metadata->'scheduling'->>'timezone', 'UTC')
    from public.dsps where id = r.dsp_id
    on conflict do nothing;
  end loop;
end $$;
