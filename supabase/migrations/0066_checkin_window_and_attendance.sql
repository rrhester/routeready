-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0066 · Check-in window, check-out, missed-day, attendance
--
-- Builds out the closed-loop attendance flow on top of 0065's
-- driver_checkins table. The driver app gets:
--   1. Check-in is gated by the DSP's "minutes before shift" window.
--   2. After checking in, the same button checks them out.
--   3. A separate "Report missed day" button records a call-out before
--      the shift starts (so the dispatcher knows in advance).
--
-- Server-side outcome math runs in driver_attendance_today() so the
-- dispatcher can see who's present / tardy / NCNS in one query.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. DSP-level settings (per-week + dsp default) ──
alter table public.scheduling_settings
  add column if not exists checkin_lead_minutes  int  not null default 15,
  add column if not exists tardy_grace_minutes   int  not null default 10,
  add column if not exists ncns_after_minutes    int  not null default 60;


-- ── 2. driver_checkins: check-out + outcome + missed-day ──
alter table public.driver_checkins
  add column if not exists checked_out_at      timestamptz,
  add column if not exists checkout_lat        numeric,
  add column if not exists checkout_lng        numeric,
  add column if not exists missed_reported_at  timestamptz,
  add column if not exists missed_reason       text,
  add column if not exists outcome             text not null default 'pending';

-- outcome values: pending | present | tardy | ncns | missed_reported | excused
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'driver_checkins_outcome_chk'
  ) then
    alter table public.driver_checkins
      add constraint driver_checkins_outcome_chk
      check (outcome in ('pending','present','tardy','ncns','missed_reported','excused'));
  end if;
end $$;


-- ── 3. driver_attendance_settings · what the app displays ──
-- Public values the driver PWA pulls so it can show the right windows
-- and the policy text on the Tasks → Attendance screen.
create or replace function public.driver_attendance_settings(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_set public.scheduling_settings;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_set from public.scheduling_settings
   where dsp_id = v_drv.dsp_id and week_start is null;
  return jsonb_build_object(
    'checkin_lead_minutes', coalesce(v_set.checkin_lead_minutes, 15),
    'tardy_grace_minutes',  coalesce(v_set.tardy_grace_minutes,  10),
    'ncns_after_minutes',   coalesce(v_set.ncns_after_minutes,   60)
  );
end;
$$;
grant execute on function public.driver_attendance_settings(text) to anon, authenticated;


-- ── 4. Replace driver_checkin to enforce the lead-time window ──
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
  v_starts   timestamptz;
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

  -- Existing row? Idempotent return.
  select * into v_existing from public.driver_checkins where shift_id = v_shift.id;
  if v_existing.id is not null and v_existing.checked_in_at is not null then
    return jsonb_build_object(
      'already_checked_in', true,
      'checked_in_at',      to_jsonb(v_existing.checked_in_at),
      'distance_meters',    v_existing.distance_meters,
      'shift_id',           v_existing.shift_id
    );
  end if;

  -- Lead-time window: only allow check-in within N minutes of shift start.
  select coalesce(checkin_lead_minutes, 15) into v_lead
    from public.scheduling_settings
   where dsp_id = v_drv.dsp_id and week_start is null;
  v_lead := coalesce(v_lead, 15);
  v_starts := v_shift.starts_at;
  if v_starts is not null and now() < v_starts - make_interval(mins => v_lead) then
    raise exception 'too_early_to_checkin: opens % min before shift start', v_lead
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

  -- Insert OR replace any existing missed-report so an updated check-in
  -- supersedes a stale "I'm out" entry.
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


-- ── 5. driver_checkout ──
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
     set checked_out_at = now(), checkout_lat = p_lat, checkout_lng = p_lng
   where id = v_chk.id
   returning * into v_chk;
  return jsonb_build_object(
    'already_checked_out', false,
    'checked_out_at',       to_jsonb(v_chk.checked_out_at)
  );
end;
$$;
grant execute on function public.driver_checkout(text, numeric, numeric) to anon, authenticated;


-- ── 6. driver_report_missed_day ──
-- Driver hits the "Report missed day" button before the shift. We
-- record it so the dispatcher's Today's attendance shows them as
-- excused (vs an undeclared NCNS later in the day).
create or replace function public.driver_report_missed_day(
  p_token  text,
  p_reason text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv  public.drivers;
  v_shift public.shifts;
  v_existing public.driver_checkins;
  v_clean_reason text;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_shift from public.shifts
   where driver_id = v_drv.id and date = current_date
     and status in ('scheduled','completed')
   order by starts_at nulls last limit 1;
  if v_shift.id is null then
    raise exception 'no_shift_today' using errcode = 'P0001';
  end if;

  v_clean_reason := nullif(trim(coalesce(p_reason, '')), '');

  select * into v_existing from public.driver_checkins where shift_id = v_shift.id;
  if v_existing.id is not null then
    if v_existing.checked_in_at is not null then
      raise exception 'already_checked_in' using errcode = 'P0001';
    end if;
    update public.driver_checkins
       set missed_reported_at = now(),
           missed_reason      = v_clean_reason,
           outcome            = 'missed_reported'
     where id = v_existing.id
     returning * into v_existing;
  else
    insert into public.driver_checkins
      (driver_id, dsp_id, shift_id, station_id,
       missed_reported_at, missed_reason, outcome)
    values
      (v_drv.id, v_drv.dsp_id, v_shift.id, v_shift.station_id,
       now(), v_clean_reason, 'missed_reported')
    returning * into v_existing;
  end if;
  return jsonb_build_object(
    'missed_reported_at', to_jsonb(v_existing.missed_reported_at),
    'reason',             v_existing.missed_reason
  );
end;
$$;
grant execute on function public.driver_report_missed_day(text, text) to anon, authenticated;


-- ── 7. driver_checkin_status: extended with check-out + missed state ──
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

  return jsonb_build_object(
    'shift', jsonb_build_object(
      'id',               v_shift.id,
      'starts_at',        to_jsonb(v_shift.starts_at),
      'ends_at',          to_jsonb(v_shift.ends_at),
      'station_code',     v_station.code,
      'has_geofence',     v_station.latitude is not null and v_station.longitude is not null,
      'window_open_at',   to_jsonb(v_window_open),
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
