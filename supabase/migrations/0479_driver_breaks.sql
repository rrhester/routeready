-- 0479_driver_breaks.sql
--
-- Break tracking for the Driver App's active-shift screen (approved
-- redesign follow-up): one break per shift, driver-initiated, recorded
-- on the existing driver_checkins row.
--
--   · driver_break_start(p_token) — stamps break_started_at. Requires an
--     active shift (checked in, not checked out) and no break yet.
--   · driver_break_end(p_token)   — stamps break_ended_at. Requires a
--     started, un-ended break on today's active shift.
--   · driver_checkin_status       — rebuilt to carry the break stamps in
--     checkin{}, and to RESTORE wave_starts_at + report_lead_minutes in
--     shift{} (added in 0103, accidentally dropped by 0477's rewrite)
--     alongside 0477's geofence geometry and 0300's window close.
--
-- v1 scope is deliberately small: a single break, no server-enforced
-- duration, no dispatch alerting. The app hides the break row entirely
-- when these keys are absent, so deploying the app before running this
-- migration is safe (and vice versa).
--
-- Idempotent: add column if not exists + create or replace only.

alter table public.driver_checkins
  add column if not exists break_started_at timestamptz,
  add column if not exists break_ended_at   timestamptz;

-- ── Start the break ─────────────────────────────────────────────────
create or replace function public.driver_break_start(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv   public.drivers;
  v_shift public.shifts;
  v_chk   public.driver_checkins;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_shift from public.shifts
   where driver_id = v_drv.id and date = current_date
     and status in ('scheduled','completed')
   order by starts_at nulls last limit 1;
  if v_shift.id is null then
    raise exception 'no_shift_today';
  end if;
  select * into v_chk from public.driver_checkins where shift_id = v_shift.id;
  if v_chk.id is null or v_chk.checked_in_at is null then
    raise exception 'not_checked_in';
  end if;
  if v_chk.checked_out_at is not null then
    raise exception 'already_checked_out';
  end if;
  if v_chk.break_started_at is not null then
    raise exception 'break_already_started';
  end if;

  update public.driver_checkins
     set break_started_at = now()
   where id = v_chk.id;

  return jsonb_build_object('break_started_at', to_jsonb(now()));
end;
$$;
grant execute on function public.driver_break_start(text) to anon, authenticated;

-- ── End the break ───────────────────────────────────────────────────
create or replace function public.driver_break_end(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv   public.drivers;
  v_shift public.shifts;
  v_chk   public.driver_checkins;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_shift from public.shifts
   where driver_id = v_drv.id and date = current_date
     and status in ('scheduled','completed')
   order by starts_at nulls last limit 1;
  if v_shift.id is null then
    raise exception 'no_shift_today';
  end if;
  select * into v_chk from public.driver_checkins where shift_id = v_shift.id;
  if v_chk.id is null or v_chk.break_started_at is null then
    raise exception 'no_break_to_end';
  end if;
  if v_chk.break_ended_at is not null then
    raise exception 'break_already_ended';
  end if;
  -- Attendance data is frozen once the shift is over — a completed
  -- shift's open break is closed by driver_checkout below, never by a
  -- late client call (Codex review on #3847).
  if v_chk.checked_out_at is not null then
    raise exception 'already_checked_out';
  end if;

  update public.driver_checkins
     set break_ended_at = now()
   where id = v_chk.id;

  return jsonb_build_object('break_ended_at', to_jsonb(now()));
end;
$$;
grant execute on function public.driver_break_end(text) to anon, authenticated;

-- ── driver_checkout · auto-close an open break ──────────────────────
-- Body = 0066 plus one rule: checking out while on break stamps
-- break_ended_at with the same moment. Without this, a driver who
-- taps Check out mid-break strands break_started_at with no end and
-- no in-app way to fix it (Codex review on #3847).
create or replace function public.driver_checkout(
  p_token    text,
  p_lat      numeric default null,
  p_lng      numeric default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv  public.drivers;
  v_chk  public.driver_checkins;
  v_today date := current_date;
begin
  v_drv := private.driver_validate_token(p_token);
  select c.* into v_chk from public.driver_checkins c
    join public.shifts s on s.id = c.shift_id
   where c.driver_id = v_drv.id and s.date = v_today
     and c.checked_in_at is not null
   order by c.checked_in_at desc nulls last limit 1;
  if v_chk.id is null then
    raise exception 'not_checked_in' using errcode = 'P0001';
  end if;
  if v_chk.checked_out_at is not null then
    return jsonb_build_object('already_checked_out', true,
      'checked_out_at', to_jsonb(v_chk.checked_out_at));
  end if;
  update public.driver_checkins
     set checked_out_at = now(), checkout_lat = p_lat, checkout_lng = p_lng,
         break_ended_at = coalesce(break_ended_at,
           case when break_started_at is not null then now() end)
   where id = v_chk.id
   returning * into v_chk;
  return jsonb_build_object(
    'already_checked_out', false,
    'checked_out_at',       to_jsonb(v_chk.checked_out_at)
  );
end;
$$;
grant execute on function public.driver_checkout(text, numeric, numeric) to anon, authenticated;

-- ── driver_checkin_status · breaks + restored wave fields ───────────
-- Body = 0477 (geofence geometry, window close) + 0103's wave lookup
-- (per-week scheduling_settings row) + the two break stamps.
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
  v_ncns    int;
  v_report_lead int;
  v_wave_starts_at timestamptz;
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

  -- report_lead comes from the shift's actual week row (0103).
  select * into v_week_set from public.scheduling_settings
   where dsp_id = v_drv.dsp_id
     and week_start = private.week_start_for(v_shift.date);
  v_report_lead := coalesce(v_week_set.report_lead_minutes, 0);
  v_wave_starts_at := v_shift.starts_at + make_interval(mins => v_report_lead);

  if v_shift.starts_at is null then
    v_window_open  := null;
    v_window_close := null;
    v_is_open      := false;
    v_wave_starts_at := null;
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
      'wave_starts_at',   to_jsonb(v_wave_starts_at),
      'report_lead_minutes', v_report_lead,
      'station_code',     v_station.code,
      'has_geofence',     v_station.latitude is not null and v_station.longitude is not null,
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
      'outcome',           v_chk.outcome,
      'break_started_at',  to_jsonb(v_chk.break_started_at),
      'break_ended_at',    to_jsonb(v_chk.break_ended_at)
    ) end,
    'can_checkin_now', v_chk.id is null or v_chk.checked_in_at is null,
    'window_is_open',  v_is_open
  );
end;
$$;
grant execute on function public.driver_checkin_status(text) to anon, authenticated;

notify pgrst, 'reload schema';
