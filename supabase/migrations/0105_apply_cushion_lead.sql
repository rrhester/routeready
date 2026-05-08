-- Hotfix companion to #513: apply_cushion_to_week was creating
-- cushion shifts at the raw wave time without subtracting the
-- DSP-wide report-lead. After save, generate_shifts (#513) re-stamped
-- existing shifts to the right (lead-subtracted) time, but then
-- apply_cushion_to_week ran after that and inserted brand-new
-- cushion rows at the wave time, leaving the schedule mixed.
--
-- Apply the same lead the rest of the shift-creation paths use, so
-- every newly-inserted shift (cushion or not) lands at
-- wave_time − report_lead_minutes.

create or replace function public.apply_cushion_to_week(p_week_start date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + 6;
  v_cushion_pct numeric;
  v_settings public.scheduling_settings;
  v_sp_id uuid;
  r record;
  v_existing_cushion int;
  v_target_cushion int;
  v_to_add int;
  v_index int;
  v_wave_idx int;
  v_existing_total int;
  v_starts timestamptz;
  v_ends timestamptz;
  v_wave_start text;
  v_wave_count int;
  v_lead int;
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

  v_lead := coalesce(v_settings.report_lead_minutes, 0);

  select id into v_sp_id from public.service_types
   where dsp_id = v_dsp and code = 'SP' limit 1;

  for r in
    select date, station_id, sum(target_routes)::int as target_routes
      from public.okami_demand
     where dsp_id = v_dsp
       and date between p_week_start and v_week_end
     group by date, station_id
    having sum(target_routes) > 0
  loop
    v_target_cushion := round(r.target_routes::numeric * v_cushion_pct / 100)::int;

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
      v_wave_idx   := v_index % v_wave_count;
      v_wave_start := coalesce(v_settings.waves->v_wave_idx->>'start', '07:00');
      v_starts     := ((r.date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                      - make_interval(mins => v_lead);
      v_ends       := v_starts + (v_settings.default_block_hours || ' hours')::interval;

      insert into public.shifts
        (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
      values
        (v_dsp, r.station_id, r.date, v_starts, v_ends, 'scheduled', 'auto', v_settings.default_block_hours, true, v_wave_idx, v_sp_id);
      v_added := v_added + 1;
    end loop;
  end loop;

  return v_added;
end;
$$;

grant execute on function public.apply_cushion_to_week(date) to authenticated;

notify pgrst, 'reload schema';
