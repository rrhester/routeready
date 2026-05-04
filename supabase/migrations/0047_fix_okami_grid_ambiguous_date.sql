-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0047 · Fix "column reference 'date' is ambiguous" in okami_grid
--
-- 0045 rewrote okami_grid to add filled_by_wave. The new filled_agg CTE
-- referenced `date` and `station_id` unqualified:
--
--   filled_agg as (
--     select date, station_id, sum(n)::int as total_filled, ...
--     from filled_per_wave
--     group by date, station_id
--   )
--
-- Because the function declares OUT parameters named `date` and
-- `station_id`, Postgres can't decide whether `date` refers to the OUT
-- param or the CTE column and raises "column reference 'date' is
-- ambiguous". The OKAMI per-day panel surfaces it as
-- "Failed to load: column reference 'date' is ambiguous"; schedule_grid
-- inherits the failure (it selects from okami_grid) so the schedule's
-- driver rows go blank.
--
-- Fix: alias filled_per_wave inside filled_agg and qualify every column.
-- Behavior is otherwise identical to 0045.
-- ─────────────────────────────────────────────────────────────────────────

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
    select generate_series(p_start, v_end, interval '1 day')::date as d
  ),
  stations as (
    select * from public.stations where dsp_id = v_dsp and active = true
  ),
  cells as (
    select dt.d as date, s.id as station_id, s.code as station_code
    from dates dt cross join stations s
  ),
  demand as (
    select
      od.date          as date,
      od.station_id    as station_id,
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
    select sh.date as date, sh.station_id as station_id, sh.wave_index as wave_index, count(*)::int as n
    from public.shifts sh
    where sh.dsp_id = v_dsp
      and sh.date between p_start and v_end
      and sh.status in ('scheduled','completed')
      and sh.driver_id is not null
    group by sh.date, sh.station_id, sh.wave_index
  ),
  filled_agg as (
    select fpw.date as date, fpw.station_id as station_id,
           sum(fpw.n)::int as total_filled,
           jsonb_agg(jsonb_build_object('wave_index', fpw.wave_index, 'filled', fpw.n) order by fpw.wave_index) as by_wave
    from filled_per_wave fpw
    group by fpw.date, fpw.station_id
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
