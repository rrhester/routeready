-- Operator: "still not working." Coverage 0/55 with 48 open shifts —
-- a 7-shift gap between okami_demand totals and the shifts table.
--
-- Root cause: okami_grid's demand CTE sums target_routes from every
-- okami_demand row regardless of whether the row's service_type is
-- still active. private.generate_shifts only loops active service
-- types, so demand pinned to a deactivated type stays in
-- okami_demand and gets counted toward `needed`, but never
-- materializes as a shift. Result: needed > shifts in table, gap
-- the operator can't close from any UI.
--
-- Fix: the demand CTE inner-joins service_types and filters to
-- active = true. Now `needed` reflects only demand that
-- generate_shifts will actually stage, so:
--   shifts in table = needed (when in sync)
--   open = needed - filled (no phantom gap)
--
-- Same idea applies to filled_per_bucket — filter to active types
-- so the breakdown lines up with what the schedule view renders.

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
          'wave_index',         od.wave_index,
          'service_type_id',    od.service_type_id,
          'service_type_code',  st.code,
          'target_routes',      od.target_routes
        )
        order by od.wave_index, st.sort_order
      ) as by_wave
    from public.okami_demand od
    join public.service_types st
      on st.id = od.service_type_id
     and st.active = true
    where od.dsp_id = v_dsp
      and od.date between p_start and v_end
    group by od.date, od.station_id
  ),
  filled_per_bucket as (
    select sh.date as date, sh.station_id as station_id,
           sh.wave_index as wave_index, sh.service_type_id as service_type_id,
           count(*)::int as n
    from public.shifts sh
    join public.service_types st
      on st.id = sh.service_type_id
     and st.active = true
    where sh.dsp_id = v_dsp
      and sh.date between p_start and v_end
      and sh.status in ('scheduled','completed')
      and sh.driver_id is not null
    group by sh.date, sh.station_id, sh.wave_index, sh.service_type_id
  ),
  filled_agg as (
    select fpb.date as date, fpb.station_id as station_id,
           sum(fpb.n)::int as total_filled,
           jsonb_agg(
             jsonb_build_object(
               'wave_index',      fpb.wave_index,
               'service_type_id', fpb.service_type_id,
               'service_type_code', st.code,
               'filled',          fpb.n
             )
             order by fpb.wave_index, st.sort_order
           ) as by_wave
    from filled_per_bucket fpb
    left join public.service_types st on st.id = fpb.service_type_id
    group by fpb.date, fpb.station_id
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

notify pgrst, 'reload schema';
