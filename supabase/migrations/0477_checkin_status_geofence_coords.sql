-- 0477_checkin_status_geofence_coords.sql
--
-- Surface the station geofence geometry (lat/lng + radius) in
-- driver_checkin_status so the driver app can show *proactive* location
-- awareness on the home check-in card — "You're at the station" vs
-- "Too far — ~320 m away" — BEFORE the driver taps Check in, instead of
-- only learning they're out of range from the server's rejection toast.
--
-- Purely additive: three new keys inside shift{}. The geofence radius
-- default (150 m) mirrors the server-side check in driver_checkin
-- (0300) so the client's distance verdict matches what the server will
-- actually enforce. The server remains authoritative — the client
-- reading uses these only to hint; check-in still round-trips through
-- driver_checkin, which recomputes the distance itself.
--
-- Idempotent: create or replace only.

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
  v_lead    int;
  v_ncns    int;
  v_now     timestamptz := now();
  v_window_open  timestamptz;
  v_window_close timestamptz;
  v_is_open boolean;
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
  v_ncns := coalesce(v_set.ncns_after_minutes,   60);

  if v_shift.starts_at is null then
    v_window_open  := null;
    v_window_close := null;
    v_is_open      := false;
  else
    v_window_open  := v_shift.starts_at - make_interval(mins => v_lead);
    v_window_close := v_shift.starts_at + make_interval(mins => v_ncns);
    v_is_open      := v_now >= v_window_open and v_now <= v_window_close;
  end if;

  return jsonb_build_object(
    'shift', jsonb_build_object(
      'id',               v_shift.id,
      'starts_at',        to_jsonb(v_shift.starts_at),
      'ends_at',          to_jsonb(v_shift.ends_at),
      'station_code',     v_station.code,
      'has_geofence',     v_station.latitude is not null and v_station.longitude is not null,
      -- Geofence geometry for the app's proactive "am I close enough?"
      -- hint. Null lat/lng ⇒ has_geofence is false and the app hides the
      -- location check entirely. Radius mirrors driver_checkin's default.
      'station_latitude',       v_station.latitude,
      'station_longitude',      v_station.longitude,
      'geofence_radius_meters', coalesce(v_station.geofence_radius_meters, 150),
      'window_open_at',   to_jsonb(v_window_open),
      'window_close_at',  to_jsonb(v_window_close),
      'checkin_lead_minutes', v_lead,
      'ncns_after_minutes',   v_ncns
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
    'window_is_open',  v_is_open
  );
end;
$$;
grant execute on function public.driver_checkin_status(text) to anon, authenticated;

notify pgrst, 'reload schema';
