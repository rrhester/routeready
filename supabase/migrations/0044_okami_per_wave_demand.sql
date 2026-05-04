-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0044 · OKAMI demand per wave
--
-- Until now okami_demand stored one target_routes per (dsp, station, date)
-- and shift generation round-robined that single number across whatever
-- waves the week's scheduling_settings had configured. There was no way
-- for the operator to plan "5 routes in wave 1, 3 routes in wave 2".
--
-- This migration adds a wave_index dimension to okami_demand so each
-- (date, station, wave_index) gets its own target_routes. A week with
-- one wave still produces exactly one row per (date, station) at
-- wave_index=0 — identical to today's data. A week with two waves can
-- now have two rows per day (wave_index 0 and 1).
--
-- okami_grid keeps the same one-row-per-(date,station) shape that
-- existing callers (schedule_grid → virtual chips, schedule view header,
-- 13-week strip, etc.) expect: target_routes is the SUM across waves.
-- A new targets_by_wave jsonb column carries the per-wave breakdown for
-- the OKAMI plan UI to render one input row per wave.
--
-- Shift-generation logic (private.generate_shifts / apply_cushion_to_week)
-- is intentionally NOT redesigned here — that's the next conversation.
-- The functions are updated to sum target_routes across waves so the
-- existing round-robin allocation keeps producing the same shift count
-- a single-wave week would have produced.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Schema: add wave_index, replace unique constraint ──
alter table public.okami_demand
  add column if not exists wave_index int not null default 0;

alter table public.okami_demand
  drop constraint if exists okami_demand_unique;

alter table public.okami_demand
  add constraint okami_demand_unique
  unique (dsp_id, station_id, date, wave_index);


-- ── 2. okami_set_target: add p_wave_index (default 0) ──
-- Drop the old 3-arg signature so PostgREST routes unambiguously to the
-- new function. Existing JS callers that don't pass a wave just get
-- wave_index=0 — same row they were writing before.
drop function if exists public.okami_set_target(date, uuid, int);

create or replace function public.okami_set_target(
  p_date date,
  p_station_id uuid,
  p_target int,
  p_wave_index int default 0
)
returns public.okami_demand
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.okami_demand;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.okami_demand
    (dsp_id, station_id, date, wave_index, target_routes, created_by)
  values
    (v_dsp, p_station_id, p_date, greatest(0, p_wave_index), greatest(0, p_target), auth.uid())
  on conflict (dsp_id, station_id, date, wave_index) do update
    set target_routes = excluded.target_routes,
        updated_at    = now()
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.okami_set_target(date, uuid, int, int) to authenticated;


-- ── 3. okami_grid: add targets_by_wave, keep one row per (date, station) ──
-- target_routes is the SUM across waves so existing callers (schedule_grid
-- coverage, virtual chips, schedule strips) keep working unchanged.
-- targets_by_wave is the new jsonb breakdown the OKAMI panel uses.
drop function if exists public.okami_grid(date, int);

create or replace function public.okami_grid(p_start date, p_weeks int default 3)
returns table (
  date            date,
  station_id      uuid,
  station_code    text,
  target_routes   int,
  targets_by_wave jsonb,
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
    coalesce(d.total_routes, 0)              as target_routes,
    coalesce(d.by_wave, '[]'::jsonb)         as targets_by_wave,
    v_cushion                                 as cushion_pct,
    coalesce(d.total_routes, 0)              as needed,
    coalesce(f.n, 0)                          as filled,
    greatest(0, coalesce(d.total_routes, 0) - coalesce(f.n, 0)) as open_count
  from cells c
  left join demand d on d.date = c.date and d.station_id = c.station_id
  left join filled f on f.date = c.date and f.station_id = c.station_id
  order by c.date, c.station_code;
end;
$$;
grant execute on function public.okami_grid(date, int) to authenticated;


-- ── 4. set_okami_week_demand: still writes wave 0 ──
-- The "Routes (max)" weekly bulk setter writes the value to wave 0 only,
-- leaving other waves' demand untouched. Operators editing per-wave
-- numbers do it from the daily panel after expanding the week. Updated
-- the conflict target to match the new unique constraint.
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
    insert into public.okami_demand (dsp_id, station_id, date, wave_index, target_routes)
    select v_dsp, r.id, d, 0, p_target_routes
      from generate_series(p_week_start, v_week_end, interval '1 day') d
    on conflict (dsp_id, station_id, date, wave_index) do update
      set target_routes = excluded.target_routes;
    v_count := v_count + 7;
  end loop;
  return v_count;
end;
$$;
grant execute on function public.set_okami_week_demand(date, int) to authenticated;


-- ── 5. generate_shifts: read SUM(target_routes) so behavior matches today ──
-- Now that okami_demand can have multiple rows per (date, station), the
-- old `select coalesce(target_routes, 0) into v_target` would either
-- raise (multiple rows) or silently pick one. Sum across waves so the
-- day's total demand drives the existing round-robin allocation —
-- identical output to a single-wave week. Per-wave allocation comes in
-- a later migration once the operator workflow is settled.
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
  select coalesce(sum(target_routes), 0)::int
    into v_target
  from public.okami_demand
   where dsp_id     = p_dsp_id
     and station_id = p_station_id
     and date       = p_date;
  v_target := coalesce(v_target, 0);

  v_settings := private.get_week_settings(p_dsp_id, private.week_start_for(p_date));

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_settings.waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;

  select count(*)::int
    into v_existing
  from public.shifts
   where dsp_id     = p_dsp_id
     and station_id = p_station_id
     and date       = p_date
     and status in ('scheduled','completed')
     and coalesce(is_cushion, false) = false;

  if v_existing > v_target then
    v_to_delete := v_existing - v_target;
    delete from public.shifts
     where id in (
       select id from public.shifts
        where dsp_id     = p_dsp_id
          and station_id = p_station_id
          and date       = p_date
          and status     = 'scheduled'
          and driver_id  is null
          and coalesce(is_cushion, false) = false
        order by starts_at desc
        limit v_to_delete
     );
    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id     = p_dsp_id
       and station_id = p_station_id
       and date       = p_date
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


-- ── 6. apply_cushion_to_week: aggregate to (date, station) totals ──
-- Same multi-row concern: the per-row loop must aggregate across waves
-- to compute one cushion bucket per (date, station). Keeps current
-- cushion behavior intact for single-wave DSPs and produces the right
-- total cushion count for multi-wave ones.
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
