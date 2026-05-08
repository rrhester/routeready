-- Hotfix for #511: when an operator sets the report-lead rule, the
-- shifts already on the schedule kept their old starts_at. The
-- rule only applied to new shifts, so existing weeks looked
-- unchanged on save — operator: "the shifts still are not changing
-- start times."
--
-- Extend private.generate_shifts to also recompute starts_at /
-- ends_at on EXISTING scheduled shifts inside the same
-- (date, wave_index, station, service_type) bucket, so a rule
-- change (lead, block_hours, wave time) propagates to the visible
-- schedule immediately. We deliberately skip non-'scheduled' rows
-- (completed, late, no_show, called_off, vto) — those represent
-- worked / decided history and shouldn't be rewritten.
--
-- Per-shift edits via the #510 modal will be overwritten by this
-- pass, which is the correct behavior for a rule change: the rule
-- supersedes one-off nudges. Operators who want to preserve a nudge
-- can re-apply it after Save.

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

    -- Compute the canonical times for this wave once per loop —
    -- both the create path and the recompute pass below use them.
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

      -- Retroactive recompute: every still-scheduled shift in this
      -- bucket (cushion or not, assigned or not) gets its starts_at /
      -- ends_at re-stamped to match the current rule. Skips already
      -- worked / decided rows so history isn't rewritten.
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

  return v_total_created;
end;
$$;


notify pgrst, 'reload schema';
