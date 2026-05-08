-- DSP-wide "drivers report N minutes before wave start" rule.
--
-- Operator: "If a wave time is at 10:20 and a DSP wants them to
-- clock in 20 mins early, then they need to be able to set that in
-- as a rule." We already exposed per-shift edits in #510. This is
-- the rule side: a single number stored on scheduling_settings that
-- private.generate_shifts subtracts from each newly-generated
-- shift's starts_at. Block length stays the same — drivers just
-- start earlier and end at the same earlier-by-N time.
--
-- Per-week storage matches every other scheduling setting
-- (scheduling_settings is already keyed (dsp_id, week_start) and
-- the existing dashboard save loops 4 weeks of upserts). Default 0
-- so DSPs that haven't set it keep current behavior.

alter table public.scheduling_settings
  add column if not exists report_lead_minutes int not null default 0
    check (report_lead_minutes between 0 and 120);


-- ── upsert_scheduling_settings · accept report_lead_minutes ─────────────
create or replace function public.upsert_scheduling_settings(p_payload jsonb)
returns public.scheduling_settings
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_start date := (p_payload->>'week_start')::date;
  v_row public.scheduling_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.scheduling_settings
    (dsp_id, week_start, default_block_hours, cushion_pct, max_days_per_week,
     waves, timezone, allow_availability_override, report_lead_minutes)
  values
    (v_dsp,
     v_week_start,
     coalesce((p_payload->>'default_block_hours')::int, 10),
     coalesce((p_payload->>'cushion_pct')::numeric, 10),
     coalesce((p_payload->>'max_days_per_week')::int, 5),
     coalesce(p_payload->'waves', jsonb_build_array(jsonb_build_object('start','07:00'))),
     coalesce(p_payload->>'timezone', 'UTC'),
     coalesce((p_payload->>'allow_availability_override')::boolean, false),
     greatest(0, least(120, coalesce((p_payload->>'report_lead_minutes')::int, 0))))
  on conflict (dsp_id, week_start) do update
    set default_block_hours          = excluded.default_block_hours,
        cushion_pct                  = excluded.cushion_pct,
        max_days_per_week            = excluded.max_days_per_week,
        waves                        = excluded.waves,
        timezone                     = excluded.timezone,
        allow_availability_override  = excluded.allow_availability_override,
        report_lead_minutes          = excluded.report_lead_minutes,
        updated_at                   = now()
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.upsert_scheduling_settings(jsonb) to authenticated;


-- ── scheduling_settings_for_week · surface report_lead_minutes ──────────
create or replace function public.scheduling_settings_for_week(p_week_start date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_exact public.scheduling_settings;
  v_eff   public.scheduling_settings;
  v_inherited boolean;
begin
  v_eff := private.get_week_settings(v_dsp, p_week_start);
  select * into v_exact from public.scheduling_settings
   where dsp_id = v_dsp and week_start = p_week_start;
  v_inherited := not found;
  return jsonb_build_object(
    'week_start',                   v_eff.week_start,
    'default_block_hours',          v_eff.default_block_hours,
    'cushion_pct',                  v_eff.cushion_pct,
    'max_days_per_week',            v_eff.max_days_per_week,
    'waves',                        v_eff.waves,
    'timezone',                     v_eff.timezone,
    'allow_availability_override',  v_eff.allow_availability_override,
    'report_lead_minutes',          coalesce(v_eff.report_lead_minutes, 0),
    'finalized',                    coalesce(v_exact.finalized, false),
    'is_inherited',                 v_inherited
  );
end;
$$;
grant execute on function public.scheduling_settings_for_week(date) to authenticated;


-- ── private.generate_shifts · apply the lead-time offset ────────────────
-- Identical body to 0050 except v_starts is shifted earlier by
-- v_settings.report_lead_minutes. v_ends stays
-- v_starts + default_block_hours, so the block length is preserved
-- (drivers report earlier, end earlier — operators wanted a clock-in
-- buffer, not a longer paid shift).
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
        v_starts := ((p_date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                    - make_interval(mins => v_lead);
        v_ends   := v_starts + (v_settings.default_block_hours || ' hours')::interval;

        for i in 1..v_to_create loop
          insert into public.shifts
            (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
          values
            (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto', v_settings.default_block_hours, false, v_wave_idx, v_st.id);
          v_total_created := v_total_created + 1;
        end loop;
      end if;
    end loop;
  end loop;

  return v_total_created;
end;
$$;


notify pgrst, 'reload schema';
