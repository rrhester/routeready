-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0039 · Cushion separation
--
-- Operator's mental model: OKAMI is the only demand input. Push to
-- schedule = generate exactly that many shifts. Cushion is a separate
-- manual tool the operator applies after the fact.
--
-- Before this migration:
--   okami_grid.needed = ceil(target_routes × (1 + cushion_pct / 100))
--   generate_shifts created `needed` shifts and tagged the extras
--   `is_cushion = true`. So OKAMI target=1 with 10% cushion silently
--   produced 2 shifts ("needed=2"), and the schedule view said 50%
--   covered when only one driver was on the day.
--
-- After this migration:
--   okami_grid.needed = target_routes (cushion does NOT multiply demand)
--   generate_shifts creates exactly target_routes shifts. No cushion.
--   Cushion stays on scheduling_settings as a *suggested default* the
--   operator can apply with apply_cushion_to_week(p_week_start), which
--   inserts is_cushion = true shifts on top of the existing demand.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. okami_grid: needed = target_routes ──
create or replace function public.okami_grid(p_start date, p_weeks int default 3)
returns table (
  date            date,
  station_id      uuid,
  station_code    text,
  target_routes   int,
  cushion_pct     numeric,
  needed          int,
  filled          int,
  open_count      int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_end date  := p_start + (p_weeks * 7 - 1);
  v_cushion numeric;
begin
  -- Still surface the cushion percent so the operator sees their preset,
  -- but it no longer multiplies `needed` — that's now exactly target_routes.
  select coalesce((metadata->'scheduling'->>'cushion_pct')::numeric, 10)
    into v_cushion
  from public.dsps where id = v_dsp;

  return query
  with dates as (
    select generate_series(p_start, v_end, interval '1 day')::date as date
  ),
  stations as (
    select * from public.stations where dsp_id = v_dsp and active = true
  ),
  cells as (
    select d.date, s.id as station_id, s.code as station_code
    from dates d cross join stations s
  ),
  filled as (
    select sh.date, sh.station_id, count(*)::int as n
    from public.shifts sh
    where sh.dsp_id = v_dsp
      and sh.date between p_start and v_end
      and sh.status in ('scheduled','completed')
      and sh.driver_id is not null
    group by sh.date, sh.station_id
  )
  select
    c.date,
    c.station_id,
    c.station_code,
    coalesce(od.target_routes, 0) as target_routes,
    v_cushion as cushion_pct,
    coalesce(od.target_routes, 0) as needed,
    coalesce(f.n, 0) as filled,
    greatest(0, coalesce(od.target_routes, 0) - coalesce(f.n, 0)) as open_count
  from cells c
  left join public.okami_demand od on od.dsp_id = v_dsp and od.station_id = c.station_id and od.date = c.date
  left join filled f                on f.date = c.date and f.station_id = c.station_id
  order by c.date, c.station_code;
end;
$$;
grant execute on function public.okami_grid(date, int) to authenticated;


-- ── 2. generate_shifts: generate exactly target_routes (no cushion) ──
create or replace function private.generate_shifts(p_dsp_id uuid, p_date date, p_station_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_target int;
  v_settings public.scheduling_settings;
  v_wave_count int;
  v_existing int;
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

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_settings.waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;

  -- Count the NON-cushion shifts already on the day. Cushion shifts are
  -- the operator's choice and are never auto-trimmed by demand changes.
  select count(*)::int
    into v_existing
  from public.shifts
   where dsp_id = p_dsp_id
     and station_id = p_station_id
     and date = p_date
     and status in ('scheduled','completed')
     and coalesce(is_cushion, false) = false;

  -- Trim if demand dropped — only delete unassigned non-cushion rows.
  if v_existing > v_target then
    v_to_delete := v_existing - v_target;
    delete from public.shifts
     where id in (
       select id from public.shifts
        where dsp_id = p_dsp_id
          and station_id = p_station_id
          and date = p_date
          and status = 'scheduled'
          and driver_id is null
          and coalesce(is_cushion, false) = false
        order by starts_at desc
        limit v_to_delete
     );
    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id = p_dsp_id
       and station_id = p_station_id
       and date = p_date
       and status in ('scheduled','completed')
       and coalesce(is_cushion, false) = false;
  end if;

  v_to_create := greatest(0, v_target - v_existing);
  if v_to_create = 0 then return 0; end if;

  for v_index in v_existing..(v_target - 1) loop
    v_wave_start := v_settings.waves->(v_index % v_wave_count)->>'start';
    v_starts := (p_date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone;
    v_ends   := v_starts + (v_settings.default_block_hours || ' hours')::interval;

    insert into public.shifts
      (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion)
    values
      (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto', v_settings.default_block_hours, false);
  end loop;

  return v_to_create;
end;
$$;


-- ── 3. apply_cushion_to_week — operator-controlled cushion application ──
-- Inserts is_cushion = true shifts on top of the existing demand for the
-- week, scaled by the DSP's cushion_pct. Idempotent: if cushion shifts
-- already exist for a (date, station), tops up to the target instead of
-- doubling.
create or replace function public.apply_cushion_to_week(p_week_start date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + 6;
  v_cushion_pct numeric;
  v_settings public.scheduling_settings;
  r record;
  v_existing_cushion int;
  v_target_cushion int;
  v_to_add int;
  v_index int;
  v_existing_total int;
  v_starts timestamptz;
  v_ends timestamptz;
  v_wave_start text;
  v_wave_count int;
  v_added int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_settings := private.get_week_settings(v_dsp, p_week_start);
  v_cushion_pct := coalesce(v_settings.cushion_pct, 0);
  if v_cushion_pct <= 0 then return 0; end if;

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then v_wave_count := 1; end if;

  for r in
    select date, station_id, target_routes
      from public.okami_demand
     where dsp_id = v_dsp
       and date between p_week_start and v_week_end
       and target_routes > 0
  loop
    v_target_cushion := ceil(r.target_routes::numeric * v_cushion_pct / 100)::int;

    select count(*)::int into v_existing_cushion
      from public.shifts
     where dsp_id = v_dsp
       and station_id = r.station_id
       and date = r.date
       and is_cushion = true
       and status in ('scheduled','completed');

    select count(*)::int into v_existing_total
      from public.shifts
     where dsp_id = v_dsp
       and station_id = r.station_id
       and date = r.date
       and status in ('scheduled','completed');

    v_to_add := greatest(0, v_target_cushion - v_existing_cushion);

    for v_index in v_existing_total..(v_existing_total + v_to_add - 1) loop
      v_wave_start := coalesce(v_settings.waves->(v_index % v_wave_count)->>'start', '07:00');
      v_starts := (r.date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone;
      v_ends   := v_starts + (v_settings.default_block_hours || ' hours')::interval;

      insert into public.shifts
        (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion)
      values
        (v_dsp, r.station_id, r.date, v_starts, v_ends, 'scheduled', 'auto', v_settings.default_block_hours, true);
      v_added := v_added + 1;
    end loop;
  end loop;

  return v_added;
end;
$$;
grant execute on function public.apply_cushion_to_week(date) to authenticated;


-- ── 4. Bulk-set OKAMI demand for an entire week to one value ──
-- Lets operators type a "Routes (max)" once and have all 7 days inherit it.
create or replace function public.set_okami_week_demand(p_week_start date, p_target_routes int)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + 6;
  r record;
  v_count int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for r in select id from public.stations where dsp_id = v_dsp and active = true loop
    insert into public.okami_demand (dsp_id, station_id, date, target_routes)
    select v_dsp, r.id, d, p_target_routes
      from generate_series(p_week_start, v_week_end, interval '1 day') d
    on conflict (dsp_id, station_id, date) do update
      set target_routes = excluded.target_routes;
    v_count := v_count + 7;
  end loop;
  return v_count;
end;
$$;
grant execute on function public.set_okami_week_demand(date, int) to authenticated;
