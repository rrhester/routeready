-- Operator: typed 5 in route plan, got 7,2,7,6,2,2,7 chaos. Diagnostic
-- (debug_okami_demand) revealed why: okami_demand for May 4-10 has TWO
-- rows per day — one for wave_index=0 (varying targets) and one for
-- wave_index=1 (target 2). The DSP currently has wave_count=1 (only
-- one configured wave), but legacy demand for wave 1 lingers from
-- when there were two waves configured.
--
-- private.generate_shifts (from 0114) iterates demand row by row. When
-- both wave_index=0 demand and wave_index=1 demand collapse to wave 0
-- via least(wave_index, wave_count - 1), each iteration handles them
-- independently:
--
--   Iter A (wave 0, target 7): existing=0, create 7 shifts at wave 0.
--   Iter B (wave 1, target 2): clamps to wave 0. Existing now = 7
--                              (from iter A!). target = 2. The branch
--                              "v_existing > target → trim" fires and
--                              DELETES 5 shifts. Final: 2 shifts.
--
-- Order isn't deterministic (no ORDER BY in the SELECT), so per-day
-- results randomly land on either max(wave_0_target) or 2 — exactly
-- the 7,2,7,6,2,2,7 pattern.
--
-- Fix: pre-aggregate demand by (effective_wave_index, service_type_id)
-- before the create/trim logic. Multiple demand rows that clamp to
-- the same wave merge into one (sum target_routes). One iteration per
-- effective bucket means the create/trim math runs against the FULL
-- demand for that bucket, not a partial slice.

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

  -- Pre-aggregate demand: any rows whose wave_index falls outside the
  -- currently configured wave range get clamped to the last valid wave
  -- (wave_count - 1) and their target_routes summed into that bucket.
  -- This prevents the iterate-and-trim race that #517 ran into when
  -- legacy multi-wave demand rolled into a single-wave config.
  for r in
    select
      least(coalesce(od.wave_index, 0), v_wave_count - 1) as eff_wave_index,
      od.service_type_id                                  as service_type_id,
      sum(od.target_routes)::int                          as target_routes
      from public.okami_demand od
      join public.service_types st
        on st.id = od.service_type_id
       and st.active = true
     where od.dsp_id     = p_dsp_id
       and od.date       = p_date
       and od.station_id = p_station_id
       and od.target_routes > 0
     group by 1, 2
  loop
    v_wave_start := coalesce(v_settings.waves->r.eff_wave_index->>'start', '07:00');
    v_starts := ((p_date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                - make_interval(mins => v_lead);
    v_ends := v_starts + (v_settings.default_block_hours || ' hours')::interval;

    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id          = p_dsp_id
       and station_id      = p_station_id
       and date            = p_date
       and wave_index      = r.eff_wave_index
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
            and wave_index      = r.eff_wave_index
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
           v_settings.default_block_hours, false, r.eff_wave_index, r.service_type_id);
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
       and wave_index      = r.eff_wave_index
       and service_type_id = r.service_type_id
       and status          = 'scheduled'
       and (starts_at is distinct from v_starts
            or ends_at  is distinct from v_ends);
  end loop;

  return v_total_created;
end;
$$;

notify pgrst, 'reload schema';
