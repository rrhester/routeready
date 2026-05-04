-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0045 · Per-wave shift generation
--
-- Phase 1 (migration 0044) gave the operator a way to plan demand per
-- wave time. Phase 2 (this migration) makes the generated shifts carry
-- a wave_index so each wave's shifts are a distinct, independently
-- managed bucket — adding demand to wave 2 only creates wave-2 shifts,
-- removing demand from wave 1 only trims wave-1 shifts. Drivers and
-- coverage views can also slice by wave from this point on.
--
-- Design notes:
--   • shifts.wave_index defaults to 0; existing rows are backfilled to 0
--     (no DSP currently has live multi-wave demand — Phase 1 just shipped).
--   • generate_shifts loops per wave instead of round-robining a single
--     daily target across waves. Each wave gets exactly its own
--     target_routes worth of shifts at that wave's start time.
--   • apply_cushion_to_week keeps cushion as a (date, station) total —
--     cushion is "extra capacity" not tied to a wave. New cushion shifts
--     still get a wave_index stamped on them (round-robin) so they're
--     queryable like every other shift, but cushion math stays whole-day.
--   • okami_grid gains a filled_by_wave jsonb column parallel to the
--     targets_by_wave column added in 0044, so the schedule view can
--     show per-wave coverage when the operator wants it.
--   • schedule_grid surfaces wave_index on each shift row so the front
--     end can sort the driver column by which wave a driver is on.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Schema ──
alter table public.shifts
  add column if not exists wave_index int not null default 0;

create index if not exists shifts_dsp_date_wave_idx
  on public.shifts (dsp_id, date, wave_index);


-- ── 2. generate_shifts: per-wave bucketing ──
create or replace function private.generate_shifts(p_dsp_id uuid, p_date date, p_station_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_settings public.scheduling_settings;
  v_wave_count int;
  v_wave_idx int;
  v_wave_start text;
  v_target int;
  v_existing int;
  v_to_create int;
  v_to_delete int;
  v_starts timestamptz;
  v_ends timestamptz;
  v_total_created int := 0;
begin
  v_settings := private.get_week_settings(p_dsp_id, private.week_start_for(p_date));

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_settings.waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;

  -- Walk each configured wave. Each wave is an independent bucket:
  -- target = okami_demand row at this (date, station, wave_index).
  -- existing = non-cushion shifts at this (date, station, wave_index).
  -- Trim or create only within the bucket; never spill across waves.
  for v_wave_idx in 0..(v_wave_count - 1) loop
    v_wave_start := v_settings.waves->v_wave_idx->>'start';
    if v_wave_start is null then v_wave_start := '07:00'; end if;

    select coalesce(target_routes, 0)
      into v_target
    from public.okami_demand
     where dsp_id     = p_dsp_id
       and station_id = p_station_id
       and date       = p_date
       and wave_index = v_wave_idx;
    v_target := coalesce(v_target, 0);

    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id     = p_dsp_id
       and station_id = p_station_id
       and date       = p_date
       and wave_index = v_wave_idx
       and status in ('scheduled','completed')
       and coalesce(is_cushion, false) = false;

    -- Shrink: drop unassigned non-cushion shifts in this wave bucket.
    if v_existing > v_target then
      v_to_delete := v_existing - v_target;
      delete from public.shifts
       where id in (
         select id from public.shifts
          where dsp_id     = p_dsp_id
            and station_id = p_station_id
            and date       = p_date
            and wave_index = v_wave_idx
            and status     = 'scheduled'
            and driver_id  is null
            and coalesce(is_cushion, false) = false
          order by created_at desc
          limit v_to_delete
       );
      select count(*)::int
        into v_existing
      from public.shifts
       where dsp_id     = p_dsp_id
         and station_id = p_station_id
         and date       = p_date
         and wave_index = v_wave_idx
         and status in ('scheduled','completed')
         and coalesce(is_cushion, false) = false;
    end if;

    -- Grow: add shifts at this wave's start time, tagged with this wave.
    v_to_create := greatest(0, v_target - v_existing);
    if v_to_create > 0 then
      v_starts := (p_date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone;
      v_ends   := v_starts + (v_settings.default_block_hours || ' hours')::interval;

      for i in 1..v_to_create loop
        insert into public.shifts
          (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index)
        values
          (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto', v_settings.default_block_hours, false, v_wave_idx);
        v_total_created := v_total_created + 1;
      end loop;
    end if;
  end loop;

  return v_total_created;
end;
$$;


-- ── 3. apply_cushion_to_week: stamp wave_index on cushion shifts ──
-- Cushion math stays at the (date, station) total-route level — cushion
-- is extra capacity, not a wave-specific allocation. The new cushion
-- shifts get a wave_index assigned by round-robin so they're queryable
-- and sortable like every other shift.
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
  v_wave_idx int;
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
    select date, station_id, sum(target_routes)::int as target_routes
      from public.okami_demand
     where dsp_id = v_dsp
       and date between p_week_start and v_week_end
     group by date, station_id
    having sum(target_routes) > 0
  loop
    v_target_cushion := ceil(r.target_routes::numeric * v_cushion_pct / 100)::int;

    select count(*)::int into v_existing_cushion
      from public.shifts
     where dsp_id     = v_dsp
       and station_id = r.station_id
       and date       = r.date
       and is_cushion = true
       and status in ('scheduled','completed');

    select count(*)::int into v_existing_total
      from public.shifts
     where dsp_id     = v_dsp
       and station_id = r.station_id
       and date       = r.date
       and status in ('scheduled','completed');

    v_to_add := greatest(0, v_target_cushion - v_existing_cushion);

    for v_index in v_existing_total..(v_existing_total + v_to_add - 1) loop
      v_wave_idx   := v_index % v_wave_count;
      v_wave_start := coalesce(v_settings.waves->v_wave_idx->>'start', '07:00');
      v_starts     := (r.date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone;
      v_ends       := v_starts + (v_settings.default_block_hours || ' hours')::interval;

      insert into public.shifts
        (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index)
      values
        (v_dsp, r.station_id, r.date, v_starts, v_ends, 'scheduled', 'auto', v_settings.default_block_hours, true, v_wave_idx);
      v_added := v_added + 1;
    end loop;
  end loop;

  return v_added;
end;
$$;
grant execute on function public.apply_cushion_to_week(date) to authenticated;


-- ── 4. okami_grid: add filled_by_wave alongside targets_by_wave ──
-- Per-wave coverage breakdown for the schedule view. Existing
-- aggregated columns (target_routes, filled, open_count) keep their
-- (date, station)-level meaning so callers that don't care about
-- waves stay unchanged.
drop function if exists public.okami_grid(date, int);

create or replace function public.okami_grid(p_start date, p_weeks int default 3)
returns table (
  date            date,
  station_id      uuid,
  station_code    text,
  target_routes   int,
  targets_by_wave jsonb,
  filled_by_wave  jsonb,
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
  demand as (
    select
      od.date,
      od.station_id,
      sum(od.target_routes)::int as total_routes,
      jsonb_agg(
        jsonb_build_object(
          'wave_index',    od.wave_index,
          'target_routes', od.target_routes
        )
        order by od.wave_index
      ) as by_wave
    from public.okami_demand od
    where od.dsp_id = v_dsp
      and od.date between p_start and v_end
    group by od.date, od.station_id
  ),
  filled_per_wave as (
    select sh.date, sh.station_id, sh.wave_index, count(*)::int as n
    from public.shifts sh
    where sh.dsp_id = v_dsp
      and sh.date between p_start and v_end
      and sh.status in ('scheduled','completed')
      and sh.driver_id is not null
    group by sh.date, sh.station_id, sh.wave_index
  ),
  filled_agg as (
    select date, station_id,
           sum(n)::int as total_filled,
           jsonb_agg(jsonb_build_object('wave_index', wave_index, 'filled', n) order by wave_index) as by_wave
    from filled_per_wave
    group by date, station_id
  )
  select
    c.date,
    c.station_id,
    c.station_code,
    coalesce(d.total_routes, 0)              as target_routes,
    coalesce(d.by_wave, '[]'::jsonb)         as targets_by_wave,
    coalesce(fa.by_wave, '[]'::jsonb)        as filled_by_wave,
    v_cushion                                 as cushion_pct,
    coalesce(d.total_routes, 0)              as needed,
    coalesce(fa.total_filled, 0)             as filled,
    greatest(0, coalesce(d.total_routes, 0) - coalesce(fa.total_filled, 0)) as open_count
  from cells c
  left join demand     d  on d.date  = c.date and d.station_id  = c.station_id
  left join filled_agg fa on fa.date = c.date and fa.station_id = c.station_id
  order by c.date, c.station_code;
end;
$$;
grant execute on function public.okami_grid(date, int) to authenticated;


-- ── 5. schedule_grid: include wave_index on each shift ──
-- Lets the schedule view sort drivers by which wave they're on without
-- a second round-trip.
create or replace function public.schedule_grid(p_start date, p_weeks int default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_end date := p_start + (p_weeks * 7 - 1);
  v_grid jsonb;
  v_shifts jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
    into v_grid
  from public.okami_grid(p_start, p_weeks) g;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', sh.id, 'date', sh.date, 'station_id', sh.station_id,
    'driver_id', sh.driver_id, 'driver_name', d.full_name,
    'route_code', sh.route_code, 'status', sh.status,
    'starts_at', sh.starts_at, 'ends_at', sh.ends_at,
    'block_hours', sh.block_hours, 'is_cushion', sh.is_cushion,
    'wave_index', sh.wave_index,
    'notes', sh.notes
  ) order by sh.date, sh.station_id, sh.wave_index, sh.starts_at), '[]'::jsonb)
    into v_shifts
  from public.shifts sh
  left join public.drivers d on d.id = sh.driver_id
  where sh.dsp_id = v_dsp
    and sh.date between p_start and v_end;

  return jsonb_build_object('coverage', v_grid, 'shifts', v_shifts,
                            'start', p_start, 'weeks', p_weeks);
end;
$$;
grant execute on function public.schedule_grid(date, int) to authenticated;
