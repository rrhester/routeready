-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0288 · Surface station coordinates on driver_my_schedule
--
-- The driver app needs per-shift station lat/lng so it can pull a local
-- NWS forecast for the upcoming-shift cards (weather chip + temperature
-- on the Home "Up next" card and on each Schedule row). Without this
-- the driver app has no way to know where a shift's station is on a
-- map — `driver_checkin_status` only exposes lat/lng for *today's*
-- shift, not future ones.
--
-- Re-emits driver_my_schedule with two extra fields per shift:
--   station_latitude  (numeric)
--   station_longitude (numeric)
-- Everything else is unchanged from 0269.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.driver_my_schedule(p_token text, p_weeks int default 2)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_start date := private.week_start_for(current_date);
  v_end date;
  v_shifts jsonb;
begin
  v_drv := private.driver_validate_token(p_token);
  v_end := v_start + (greatest(1, least(8, coalesce(p_weeks, 2))) * 7) - 1;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id',                sh.id,
      'date',              sh.date,
      'starts_at',         sh.starts_at,
      'ends_at',           sh.ends_at,
      'wave_starts_at',    sh.starts_at + make_interval(mins => coalesce((
        select ss.report_lead_minutes
          from public.scheduling_settings ss
         where ss.dsp_id = sh.dsp_id
           and ss.week_start = private.week_start_for(sh.date)
      ), 0)),
      'report_lead_minutes', coalesce((
        select ss.report_lead_minutes
          from public.scheduling_settings ss
         where ss.dsp_id = sh.dsp_id
           and ss.week_start = private.week_start_for(sh.date)
      ), 0),
      'station_id',        sh.station_id,
      'station_code',      s.code,
      'station_latitude',  s.latitude,
      'station_longitude', s.longitude,
      'status',            sh.status,
      'block_hours',       sh.block_hours,
      'wave_index',        sh.wave_index,
      'service_type_code', st.code,
      'service_type_color',st.color,
      'is_cushion',        sh.is_cushion,
      'route_code',        sh.route_code,
      'shift_kind',        sh.shift_kind,
      'trainer_driver_id', sh.trainer_driver_id,
      'trainer_name',      tr.full_name,
      'notes',             sh.notes
    ) order by sh.date, sh.starts_at), '[]'::jsonb)
    into v_shifts
  from public.shifts sh
  left join public.stations     s  on s.id  = sh.station_id
  left join public.service_types st on st.id = sh.service_type_id
  left join public.drivers      tr on tr.id = sh.trainer_driver_id
  where sh.driver_id = v_drv.id
    and sh.date between v_start and v_end;

  return jsonb_build_object(
    'driver', jsonb_build_object(
      'id',        v_drv.id,
      'full_name', v_drv.full_name,
      'name',      coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name)
    ),
    'shifts', v_shifts,
    'start',  v_start,
    'end',    v_end
  );
end;
$$;
grant execute on function public.driver_my_schedule(text, int) to anon, authenticated;


notify pgrst, 'reload schema';
