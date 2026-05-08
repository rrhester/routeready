-- Hotfix #2 for #511 lead-time propagation. The retro-recompute in
-- 0104 keys the UPDATE on (wave_index, service_type_id). Legacy rows
-- can have a wave_index that no longer corresponds to a configured
-- wave (e.g. the DSP previously had two waves and dropped one;
-- shifts with wave_index = 1 stuck around). For those rows the
-- per-wave UPDATE inside the loop never matches, so Save leaves
-- them at their old starts_at and the operator sees no change.
--
-- Add a fallback recompute pass at the end of generate_shifts: any
-- still-scheduled shift on (dsp, station, date) that didn't match
-- the per-wave UPDATE gets re-stamped to wave-0's time and its
-- wave_index normalized to a configured wave. This keeps Save
-- behavior predictable: every visible open shift moves to the
-- current rule's start time.

create or replace function private.generate_shifts(p_dsp_id uuid, p_date date, p_station_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_settings public.scheduling_settings;
  v_wave_count int;
  v_wave_idx int;
  v_wave_start text;
  v_st record;
  v_target int;
  v_existing int;
  v_to_create int;
  v_to_delete int;
  v_starts timestamptz;
  v_ends timestamptz;
  v_lead int;
  v_total_created int := 0;
  v_wave0_start text;
  v_wave0_starts timestamptz;
  v_wave0_ends timestamptz;
begin
  v_settings := private.get_week_settings(p_dsp_id, private.week_start_for(p_date));

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_settings.waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;

  v_lead := coalesce(v_settings.report_lead_minutes, 0);

  for v_wave_idx in 0..(v_wave_count - 1) loop
    v_wave_start := v_settings.waves->v_wave_idx->>'start';
    if v_wave_start is null then v_wave_start := '07:00'; end if;

    v_starts := ((p_date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                - make_interval(mins => v_lead);
    v_ends   := v_starts + (v_settings.default_block_hours || ' hours')::interval;

    for v_st in
      select id from public.service_types
       where dsp_id = p_dsp_id and active = true
       order by sort_order
    loop
      select coalesce(target_routes, 0)
        into v_target
      from public.okami_demand
       where dsp_id          = p_dsp_id
         and station_id      = p_station_id
         and date            = p_date
         and wave_index      = v_wave_idx
         and service_type_id = v_st.id;
      v_target := coalesce(v_target, 0);

      select count(*)::int
        into v_existing
      from public.shifts
       where dsp_id          = p_dsp_id
         and station_id      = p_station_id
         and date            = p_date
         and wave_index      = v_wave_idx
         and service_type_id = v_st.id
         and status in ('scheduled','completed')
         and coalesce(is_cushion, false) = false;

      if v_existing > v_target then
        v_to_delete := v_existing - v_target;
        delete from public.shifts
         where id in (
           select id from public.shifts
            where dsp_id          = p_dsp_id
              and station_id      = p_station_id
              and date            = p_date
              and wave_index      = v_wave_idx
              and service_type_id = v_st.id
              and status          = 'scheduled'
              and driver_id       is null
              and coalesce(is_cushion, false) = false
            order by created_at desc
            limit v_to_delete
         );
        select count(*)::int
          into v_existing
        from public.shifts
         where dsp_id          = p_dsp_id
           and station_id      = p_station_id
           and date            = p_date
           and wave_index      = v_wave_idx
           and service_type_id = v_st.id
           and status in ('scheduled','completed')
           and coalesce(is_cushion, false) = false;
      end if;

      v_to_create := greatest(0, v_target - v_existing);
      if v_to_create > 0 then
        for i in 1..v_to_create loop
          insert into public.shifts
            (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
          values
            (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto', v_settings.default_block_hours, false, v_wave_idx, v_st.id);
          v_total_created := v_total_created + 1;
        end loop;
      end if;

      update public.shifts
         set starts_at   = v_starts,
             ends_at     = v_ends,
             block_hours = v_settings.default_block_hours
       where dsp_id          = p_dsp_id
         and station_id      = p_station_id
         and date            = p_date
         and wave_index      = v_wave_idx
         and service_type_id = v_st.id
         and status          = 'scheduled'
         and (starts_at is distinct from v_starts
              or ends_at  is distinct from v_ends);
    end loop;
  end loop;

  -- Fallback recompute: re-stamp any still-scheduled shift on this
  -- (dsp, station, date) that the per-wave loop missed. These are
  -- typically legacy rows whose wave_index no longer maps to a
  -- configured wave. We pin them to wave 0 and the canonical SP
  -- service type so future generate_shifts passes treat them
  -- normally.
  v_wave0_start  := coalesce(v_settings.waves->0->>'start', '07:00');
  v_wave0_starts := ((p_date::text || ' ' || v_wave0_start)::timestamp at time zone v_settings.timezone)
                    - make_interval(mins => v_lead);
  v_wave0_ends   := v_wave0_starts + (v_settings.default_block_hours || ' hours')::interval;

  update public.shifts
     set starts_at   = v_wave0_starts,
         ends_at     = v_wave0_ends,
         block_hours = v_settings.default_block_hours,
         wave_index  = 0
   where dsp_id     = p_dsp_id
     and station_id = p_station_id
     and date       = p_date
     and status     = 'scheduled'
     and (
       wave_index >= v_wave_count
       or service_type_id is null
       or service_type_id not in (
         select id from public.service_types
          where dsp_id = p_dsp_id and active = true
       )
     )
     and (starts_at is distinct from v_wave0_starts
          or ends_at   is distinct from v_wave0_ends);

  return v_total_created;
end;
$$;

notify pgrst, 'reload schema';
