-- Migration 0300 · Close the check-in window
--
-- Two bugs in driver_checkin / driver_checkin_status (from 0066):
--
--   1. The check-in window had no upper bound.  Once it opened
--      (now() >= starts_at - lead_minutes) a driver could check in
--      any time the rest of the day — including hours after the
--      shift had ended.
--
--   2. When shifts.starts_at was NULL, the early-check was skipped
--      ("v_starts is not null and ..."), so check-in was unbounded
--      in BOTH directions for shifts created without a scheduled
--      start time.  A driver scheduled for 9am Monday could check
--      themselves in at 11:25 PM Sunday because the Sunday-night
--      tap landed inside Monday's row (UTC date boundary), starts_at
--      was null, and there was no window to enforce.
--
-- Fix:
--   * Require shifts.starts_at to be present.  Without a scheduled
--     start there is no DSP-designated window — so check-in is
--     refused with no_checkin_window instead of silently allowed.
--   * Reuse the existing scheduling_settings.ncns_after_minutes
--     (default 60) as the upper bound — past that, the driver is
--     officially NCNS and check-in is closed.
--   * driver_checkin raises too_early_to_checkin / too_late_to_checkin
--     / no_checkin_window as appropriate.
--   * driver_checkin_status exposes window_close_at and reports
--     window_is_open as false whenever starts_at is null OR the
--     current time isn't between [open, close].  The driver app
--     reads that flag to keep the CTA off-screen outside the window.
--
-- Doesn't touch driver_checkout, driver_report_missed_day, or any of
-- the dashboard / attendance functions — same flow downstream.


create or replace function public.driver_checkin(
  p_token    text,
  p_lat      numeric,
  p_lng      numeric,
  p_accuracy numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv      public.drivers;
  v_today    date := current_date;
  v_shift    public.shifts;
  v_station  public.stations;
  v_existing public.driver_checkins;
  v_distance numeric;
  v_radius   numeric;
  v_lead     int;
  v_ncns     int;
  v_starts   timestamptz;
  v_closes   timestamptz;
begin
  v_drv := private.driver_validate_token(p_token);
  if p_lat is null or p_lng is null then
    raise exception 'location_required' using errcode = 'P0001';
  end if;

  select * into v_shift
    from public.shifts
   where driver_id = v_drv.id and date = v_today
     and status in ('scheduled','completed')
   order by starts_at nulls last
   limit 1;
  if v_shift.id is null then
    raise exception 'no_shift_today' using errcode = 'P0001';
  end if;

  -- Idempotent return for an existing check-in.
  select * into v_existing from public.driver_checkins where shift_id = v_shift.id;
  if v_existing.id is not null and v_existing.checked_in_at is not null then
    return jsonb_build_object(
      'already_checked_in', true,
      'checked_in_at',      to_jsonb(v_existing.checked_in_at),
      'distance_meters',    v_existing.distance_meters,
      'shift_id',           v_existing.shift_id
    );
  end if;

  -- Lead-time + NCNS-cutoff window.  Both bounds key off starts_at,
  -- so a shift without a scheduled start time has no DSP-designated
  -- window — we refuse rather than silently let the driver in.
  select coalesce(checkin_lead_minutes, 15),
         coalesce(ncns_after_minutes,   60)
    into v_lead, v_ncns
    from public.scheduling_settings
   where dsp_id = v_drv.dsp_id and week_start is null;
  v_lead := coalesce(v_lead, 15);
  v_ncns := coalesce(v_ncns, 60);

  v_starts := v_shift.starts_at;
  if v_starts is null then
    raise exception 'no_checkin_window: shift has no scheduled start time — contact dispatch'
      using errcode = 'P0001';
  end if;
  v_closes := v_starts + make_interval(mins => v_ncns);

  if now() < v_starts - make_interval(mins => v_lead) then
    raise exception 'too_early_to_checkin: opens % min before shift start', v_lead
      using errcode = 'P0001';
  end if;
  if now() > v_closes then
    raise exception 'too_late_to_checkin: window closed % min after shift start', v_ncns
      using errcode = 'P0001';
  end if;

  select * into v_station from public.stations where id = v_shift.station_id;
  if v_station.id is null then
    raise exception 'no_station_on_shift' using errcode = 'P0001';
  end if;
  if v_station.latitude is null or v_station.longitude is null then
    raise exception 'geofence_not_configured: %', v_station.code
      using errcode = 'P0001';
  end if;

  v_distance := private.haversine_m(p_lat, p_lng, v_station.latitude, v_station.longitude);
  v_radius   := coalesce(v_station.geofence_radius_meters, 150);
  if v_distance > v_radius then
    raise exception 'out_of_geofence: % m from % (radius % m)',
      round(v_distance), v_station.code, v_radius
      using errcode = 'P0001';
  end if;

  if v_existing.id is not null then
    update public.driver_checkins
       set checked_in_at   = now(),
           lat             = p_lat,
           lng             = p_lng,
           accuracy_meters = p_accuracy,
           distance_meters = round(v_distance),
           outcome         = 'present',
           missed_reported_at = null,
           missed_reason   = null
     where id = v_existing.id
     returning * into v_existing;
  else
    insert into public.driver_checkins
      (driver_id, dsp_id, shift_id, station_id,
       checked_in_at, lat, lng, accuracy_meters, distance_meters, outcome)
    values
      (v_drv.id, v_drv.dsp_id, v_shift.id, v_station.id,
       now(), p_lat, p_lng, p_accuracy, round(v_distance), 'present')
    returning * into v_existing;
  end if;

  return jsonb_build_object(
    'already_checked_in', false,
    'checked_in_at',      to_jsonb(v_existing.checked_in_at),
    'distance_meters',    v_existing.distance_meters,
    'shift_id',           v_existing.shift_id,
    'station_code',       v_station.code
  );
end;
$$;
grant execute on function public.driver_checkin(text, numeric, numeric, numeric) to anon, authenticated;


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
    -- No scheduled start = no DSP-designated window = check-in is
    -- not allowed.  The driver app reads window_is_open = false and
    -- renders the "contact dispatch" copy.
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
