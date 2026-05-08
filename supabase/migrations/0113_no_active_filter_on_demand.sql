-- Operator: "all of it is not working." Final root cause found by
-- agent investigation: my recent migrations 0110 and 0111 inner-
-- joined okami_demand against service_types and filtered to
-- active = true. That silently dropped any demand row whose
-- service_type_id pointed to an inactive type — most commonly XL,
-- HUB, ASU which are seeded inactive by default. The operator's
-- screenshot showed 26 shifts when expectations were higher; the
-- missing shifts were demand for service types that aren't currently
-- active.
--
-- Decision: trust the data in okami_demand. The OKAMI editor only
-- offers active service types when entering NEW demand, but any
-- legacy or operator-edited demand should still produce shifts.
-- Both functions revert to LEFT JOIN (or no join) on service_types
-- so every demand row counts.

-- ── 1. private.generate_shifts: iterate every demand row ──
create or replace function private.generate_shifts(p_dsp_id uuid, p_date date, p_station_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_settings public.scheduling_settings;
  v_wave_count int;
  v_lead int;
  v_total_created int := 0;
  r record;
  v_existing int;
  v_to_create int;
  v_to_delete int;
  v_wave_idx int;
  v_wave_start text;
  v_starts timestamptz;
  v_ends timestamptz;
begin
  v_settings := private.get_week_settings(p_dsp_id, private.week_start_for(p_date));

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_settings.waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;
  v_lead := coalesce(v_settings.report_lead_minutes, 0);

  -- Iterate EVERY okami_demand row for this (date, station). No
  -- service_types JOIN — we trust the demand data and create shifts
  -- regardless of whether the type is currently flagged active.
  for r in
    select wave_index, service_type_id, target_routes
      from public.okami_demand
     where dsp_id     = p_dsp_id
       and date       = p_date
       and station_id = p_station_id
       and target_routes > 0
  loop
    v_wave_idx := least(coalesce(r.wave_index, 0), v_wave_count - 1);
    v_wave_start := coalesce(v_settings.waves->v_wave_idx->>'start', '07:00');
    v_starts := ((p_date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                - make_interval(mins => v_lead);
    v_ends := v_starts + (v_settings.default_block_hours || ' hours')::interval;

    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id          = p_dsp_id
       and station_id      = p_station_id
       and date            = p_date
       and wave_index      = v_wave_idx
       and service_type_id = r.service_type_id
       and status          in ('scheduled', 'completed')
       and coalesce(is_cushion, false) = false;

    if v_existing > r.target_routes then
      v_to_delete := v_existing - r.target_routes;
      delete from public.shifts
       where id in (
         select id from public.shifts
          where dsp_id          = p_dsp_id
            and station_id      = p_station_id
            and date            = p_date
            and wave_index      = v_wave_idx
            and service_type_id = r.service_type_id
            and status          = 'scheduled'
            and driver_id       is null
            and coalesce(is_cushion, false) = false
          order by created_at desc
          limit v_to_delete
       );
      v_existing := r.target_routes;
    end if;

    v_to_create := greatest(0, r.target_routes - v_existing);
    if v_to_create > 0 then
      for i in 1..v_to_create loop
        insert into public.shifts
          (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
        values
          (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto',
           v_settings.default_block_hours, false, v_wave_idx, r.service_type_id);
        v_total_created := v_total_created + 1;
      end loop;
    end if;

    update public.shifts
       set starts_at  = v_starts,
           ends_at    = v_ends,
           block_hours = v_settings.default_block_hours
     where dsp_id          = p_dsp_id
       and station_id      = p_station_id
       and date            = p_date
       and wave_index      = v_wave_idx
       and service_type_id = r.service_type_id
       and status          = 'scheduled'
       and (starts_at is distinct from v_starts
            or ends_at  is distinct from v_ends);
  end loop;

  return v_total_created;
end;
$$;


-- ── 2. public.okami_grid: count every demand row toward needed ──
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
  -- Count EVERY demand row toward needed; left-join service_types
  -- only to surface code/sort_order in the breakdown.
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
        order by od.wave_index, st.sort_order nulls last
      ) as by_wave
    from public.okami_demand od
    left join public.service_types st on st.id = od.service_type_id
    where od.dsp_id = v_dsp
      and od.date between p_start and v_end
    group by od.date, od.station_id
  ),
  filled_per_bucket as (
    select sh.date as date, sh.station_id as station_id,
           sh.wave_index as wave_index, sh.service_type_id as service_type_id,
           count(*)::int as n
    from public.shifts sh
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
             order by fpb.wave_index, st.sort_order nulls last
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
