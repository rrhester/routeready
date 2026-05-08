-- The actual reason every previous lead-time fix didn't move the
-- visible chips: regenerate_week_shifts has a "reposition" pass at
-- the end that overwrites every shift's starts_at to the configured
-- wave time without subtracting report_lead_minutes. Save calls
-- regenerate_week_shifts → generate_shifts (which applies the lead
-- correctly, per #511 / #513 / #515) → reposition loop (which strips
-- the lead back out). Net effect on screen: 11:20 stays 11:20.
--
-- Fix: the reposition loop now subtracts the same lead generate_shifts
-- uses. After this migration, Save propagates wave_time - lead to
-- every scheduled shift in the week, including legacy rows the
-- per-bucket UPDATE in #515 missed.

create or replace function public.regenerate_week_shifts(p_week_start date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_settings public.scheduling_settings;
  v_wave_count int;
  v_lead int;
  v_count int := 0;
  r record;
  s record;
  v_pos int;
  v_wave_start text;
  v_starts timestamptz;
  v_week_end date := p_week_start + 6;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_settings := private.get_week_settings(v_dsp, p_week_start);
  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_settings.waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;
  v_lead := coalesce(v_settings.report_lead_minutes, 0);

  -- Wipe unassigned scheduled shifts for this week only.
  delete from public.shifts
   where dsp_id = v_dsp
     and driver_id is null
     and status = 'scheduled'
     and date between p_week_start and v_week_end;

  -- Regenerate from okami_demand for this week.
  for r in
    select date, station_id from public.okami_demand
     where dsp_id = v_dsp and date between p_week_start and v_week_end
  loop
    v_count := v_count + private.generate_shifts(v_dsp, r.date, r.station_id);
  end loop;

  -- Reposition every scheduled shift in this week to the configured
  -- wave time, MINUS the report-lead. This catches legacy rows that
  -- the per-bucket recompute in generate_shifts can't match (stale
  -- wave_index, missing service_type_id, etc.) and ensures the
  -- visible starts_at equals what we actually want drivers to clock
  -- in at.
  for r in
    select distinct date, station_id from public.shifts
     where dsp_id = v_dsp and status = 'scheduled'
       and date between p_week_start and v_week_end
  loop
    v_pos := 0;
    for s in
      select id from public.shifts
       where dsp_id = v_dsp
         and date = r.date
         and station_id = r.station_id
         and status = 'scheduled'
       order by is_cushion asc, created_at asc, id asc
    loop
      v_wave_start := v_settings.waves->(v_pos % v_wave_count)->>'start';
      v_starts := ((r.date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                  - make_interval(mins => v_lead);
      update public.shifts
         set starts_at  = v_starts,
             ends_at    = v_starts + (v_settings.default_block_hours || ' hours')::interval,
             block_hours = v_settings.default_block_hours
       where id = s.id;
      v_pos := v_pos + 1;
    end loop;
  end loop;

  return v_count;
end;
$$;

grant execute on function public.regenerate_week_shifts(date) to authenticated;

notify pgrst, 'reload schema';
