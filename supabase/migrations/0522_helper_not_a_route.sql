-- ── 0522 · Helper seats count as drivers, not routes ───────────────────────
--
-- Operator (2026-07-19): "I don't want the helper counted as an extra route
-- — 9 standard parcel and 1 XL = 11 drivers scheduled, but 10 routes."
--
-- okami_grid's `filled` counter (which drives the Targets "N/M filled",
-- the schedule day headers and the "N/M ROUTES" strip) counts every
-- assigned shift row — since 0518 that includes the XL helper seat, so an
-- XL day read as over-plan (e.g. 38/37, week 266/259). The helper is the
-- second BODY on an XL route, not a second route.
--
-- Fix: okami_grid re-issued verbatim from 0114 with one change — the
-- filled_per_bucket CTE excludes shift_kind 'helper' (compared as ::text so
-- this is safe pre-0518). The dispatcher grid's client-side coverage
-- counter gets the same exclusion in live.js (ships with this migration's
-- PR). Cushion sizing already excluded helpers (0518/0519).
--
-- Idempotent: create or replace. (0114's one-shot purge sections are NOT
-- repeated here — they were one-time data cleanups.)

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
      -- Helper seats are the second body on an XL route, not a second
      -- route — counting them made XL days read over-plan (0522).
      and coalesce(sh.shift_kind::text, 'regular') <> 'helper'
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

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0522_helper_not_a_route.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
