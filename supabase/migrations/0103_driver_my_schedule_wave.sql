-- Surface the wave-start time alongside the report time on the
-- driver app. Pairs with #511 (DSP-wide report-lead rule). Without
-- this, the app showed "10:00 AM – 8:00 PM" for a 10:20 wave with
-- a 20-min lead — the driver couldn't tell when the route actually
-- departed vs when they had to be on site.
--
-- Add wave_starts_at to driver_my_schedule's per-shift payload,
-- computed as starts_at + report_lead_minutes from the
-- scheduling_settings row for that shift's week. Falls back to the
-- shift's own starts_at when no lead is set (or no week row
-- exists), so older shifts and DSPs that haven't enabled the rule
-- behave exactly as before.

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
      'status',            sh.status,
      'block_hours',       sh.block_hours,
      'wave_index',        sh.wave_index,
      'service_type_code', st.code,
      'service_type_color',st.color,
      'is_cushion',        sh.is_cushion,
      'route_code',        sh.route_code,
      'notes',             sh.notes
    ) order by sh.date, sh.starts_at), '[]'::jsonb)
    into v_shifts
  from public.shifts sh
  left join public.stations     s  on s.id  = sh.station_id
  left join public.service_types st on st.id = sh.service_type_id
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


-- driver_checkin_status: surface wave_starts_at + report_lead_minutes
-- on the today shift sub-payload so the Profile page check-in card
-- can show "Clock in for 10:20 AM wave" when the DSP has set a lead.
create or replace function public.driver_checkin_status(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv     public.drivers;
  v_shift   public.shifts;
  v_station public.stations;
  v_chk     public.driver_checkins;
  v_set     public.scheduling_settings;
  v_week_set public.scheduling_settings;
  v_lead    int;
  v_report_lead int;
  v_wave_starts_at timestamptz;
  v_now     timestamptz := now();
  v_window_open timestamptz;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_shift from public.shifts
   where driver_id = v_drv.id and date = current_date
     and status in ('scheduled','completed')
   order by starts_at nulls last limit 1;
  if v_shift.id is null then
    return jsonb_build_object('shift', null);
  end if;

  select * into v_station from public.stations where id = v_shift.station_id;
  select * into v_chk     from public.driver_checkins where shift_id = v_shift.id;
  select * into v_set     from public.scheduling_settings
   where dsp_id = v_drv.dsp_id and week_start is null;
  v_lead := coalesce(v_set.checkin_lead_minutes, 15);
  v_window_open := v_shift.starts_at - make_interval(mins => v_lead);

  -- Pull report_lead_minutes from the shift's actual week row (not
  -- the IS NULL pattern, which never matches given the schema).
  select * into v_week_set from public.scheduling_settings
   where dsp_id = v_drv.dsp_id
     and week_start = private.week_start_for(v_shift.date);
  v_report_lead := coalesce(v_week_set.report_lead_minutes, 0);
  v_wave_starts_at := v_shift.starts_at + make_interval(mins => v_report_lead);

  return jsonb_build_object(
    'shift', jsonb_build_object(
      'id',                  v_shift.id,
      'starts_at',           to_jsonb(v_shift.starts_at),
      'ends_at',             to_jsonb(v_shift.ends_at),
      'wave_starts_at',      to_jsonb(v_wave_starts_at),
      'report_lead_minutes', v_report_lead,
      'station_code',        v_station.code,
      'has_geofence',        v_station.latitude is not null and v_station.longitude is not null,
      'window_open_at',      to_jsonb(v_window_open),
      'checkin_lead_minutes', v_lead
    ),
    'checkin', case when v_chk.id is null then null else jsonb_build_object(
      'checked_in_at',     to_jsonb(v_chk.checked_in_at),
      'checked_out_at',    to_jsonb(v_chk.checked_out_at),
      'missed_reported_at',to_jsonb(v_chk.missed_reported_at),
      'missed_reason',     v_chk.missed_reason,
      'distance_meters',   v_chk.distance_meters,
      'outcome',           v_chk.outcome
    ) end,
    'can_checkin_now', v_chk.id is null or v_chk.checked_in_at is null,
    'window_is_open',  v_now >= v_window_open
  );
end;
$$;
grant execute on function public.driver_checkin_status(text) to anon, authenticated;


notify pgrst, 'reload schema';
