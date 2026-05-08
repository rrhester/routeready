-- Operator typed 5/day in route plan, got 141 shifts (~20/day) instead.
-- 0117's pre-aggregation summed legacy demand for wave_indexes that
-- aren't configured anymore — so a DSP that previously had 4 waves
-- but now has 1 wave got every wave's old demand collapsed onto
-- wave 0. Result: every "5" the operator typed got piled on top of
-- 15+ stale routes from prior wave configurations.
--
-- Fix: filter demand to wave_index < wave_count BEFORE aggregating.
-- Legacy demand for waves the DSP no longer runs is ignored entirely.
-- The okami_demand rows stay in the table (don't want to surprise-
-- delete operator data), but they no longer poison shift counts.
--
-- Also include a one-shot cleanup that drops okami_demand rows where
-- wave_index falls outside the currently-configured wave range for
-- that week (looking up scheduling_settings per row). Operator gets
-- a fresh slate; legacy garbage is gone.

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

  -- Aggregate demand per (wave_index, service_type), but ONLY for
  -- waves currently configured (wave_index < wave_count). Demand
  -- rows for waves the DSP no longer runs are ignored — they used to
  -- get clamped onto the last valid wave and pile up phantom routes.
  for r in
    select
      coalesce(od.wave_index, 0) as wave_index,
      od.service_type_id          as service_type_id,
      sum(od.target_routes)::int  as target_routes
      from public.okami_demand od
      join public.service_types st
        on st.id = od.service_type_id
       and st.active = true
     where od.dsp_id     = p_dsp_id
       and od.date       = p_date
       and od.station_id = p_station_id
       and od.target_routes > 0
       and coalesce(od.wave_index, 0) >= 0
       and coalesce(od.wave_index, 0) < v_wave_count
     group by 1, 2
  loop
    v_wave_start := coalesce(v_settings.waves->r.wave_index->>'start', '07:00');
    v_starts := ((p_date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                - make_interval(mins => v_lead);
    v_ends := v_starts + (v_settings.default_block_hours || ' hours')::interval;

    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id          = p_dsp_id
       and station_id      = p_station_id
       and date            = p_date
       and wave_index      = r.wave_index
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
            and wave_index      = r.wave_index
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
           v_settings.default_block_hours, false, r.wave_index, r.service_type_id);
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
       and wave_index      = r.wave_index
       and service_type_id = r.service_type_id
       and status          = 'scheduled'
       and (starts_at is distinct from v_starts
            or ends_at  is distinct from v_ends);
  end loop;

  return v_total_created;
end;
$$;


-- One-shot purge: drop okami_demand rows where wave_index falls
-- outside the currently-configured wave range for that week. These
-- are legacy values from past wave configurations that the operator
-- can no longer see or edit in the UI (the OKAMI editor only renders
-- inputs for currently-configured waves).
do $$
declare
  rec record;
  v_wave_count int;
begin
  for rec in
    select od.id, od.dsp_id, od.wave_index, od.date
      from public.okami_demand od
  loop
    select jsonb_array_length(coalesce(ss.waves, '[]'::jsonb))
      into v_wave_count
      from public.scheduling_settings ss
     where ss.dsp_id = rec.dsp_id
       and ss.week_start = (
         -- Mirror private.week_start_for: ISO week-start (Mon).
         rec.date - ((extract(isodow from rec.date)::int - 1)) * interval '1 day'
       )::date;
    if v_wave_count is null or v_wave_count = 0 then v_wave_count := 1; end if;
    if rec.wave_index >= v_wave_count then
      delete from public.okami_demand where id = rec.id;
    end if;
  end loop;
end$$;


notify pgrst, 'reload schema';
