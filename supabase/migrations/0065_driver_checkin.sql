-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0065 · Driver shift check-in (geofenced)
--
-- Adds a "Check in" button to the driver app's Profile page. When the
-- driver taps it, the PWA grabs their lat/lng and POSTs to
-- driver_checkin. The RPC:
--   1. Confirms the driver has a scheduled shift today.
--   2. Looks up that shift's station and its geofence pin/radius.
--   3. Computes distance from the supplied coords to the pin
--      (haversine).
--   4. Rejects if outside the radius; otherwise records a row in
--      driver_checkins.
--
-- One check-in per driver per shift. Re-tapping returns the existing
-- row idempotently so the operator's view never sees duplicates.
--
-- Stations get three new columns to hold the pin:
--   latitude, longitude (numeric · null = no pin set, check-ins
--                        will report "geofence_not_configured")
--   geofence_radius_meters int default 150
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Schema ──
alter table public.stations
  add column if not exists latitude               numeric,
  add column if not exists longitude              numeric,
  add column if not exists geofence_radius_meters int not null default 150;


create table if not exists public.driver_checkins (
  id              uuid primary key default gen_random_uuid(),
  driver_id       uuid not null references public.drivers(id) on delete cascade,
  dsp_id          uuid not null references public.dsps(id)    on delete cascade,
  shift_id        uuid references public.shifts(id) on delete set null,
  station_id      uuid references public.stations(id) on delete set null,
  checked_in_at   timestamptz not null default now(),
  lat             numeric,
  lng             numeric,
  accuracy_meters numeric,
  distance_meters numeric
);

-- One check-in row per shift; re-tapping the button is idempotent.
create unique index if not exists driver_checkins_one_per_shift
  on public.driver_checkins(shift_id) where shift_id is not null;
create index if not exists driver_checkins_driver_idx
  on public.driver_checkins(driver_id, checked_in_at desc);

alter table public.driver_checkins enable row level security;

drop policy if exists "driver_checkins_tenant_r" on public.driver_checkins;
create policy "driver_checkins_tenant_r"
  on public.driver_checkins for select
  using (dsp_id = private.current_dsp_id());

grant select on public.driver_checkins to authenticated;


-- ── 2. Haversine helper · meters ──
create or replace function private.haversine_m(
  lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric
) returns numeric
language sql immutable
as $$
  select 2 * 6371000 * asin(
    sqrt(
      sin(radians((lat2 - lat1) / 2))^2
      + cos(radians(lat1)) * cos(radians(lat2))
      * sin(radians((lng2 - lng1) / 2))^2
    )
  );
$$;


-- ── 3. driver_checkin · the main RPC ──
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
begin
  v_drv := private.driver_validate_token(p_token);

  if p_lat is null or p_lng is null then
    raise exception 'location_required' using errcode = 'P0001';
  end if;

  -- Find today's shift for this driver. If they have multiple, pick
  -- the one starting earliest that's still scheduled or completed.
  select * into v_shift
    from public.shifts
   where driver_id = v_drv.id
     and date      = v_today
     and status    in ('scheduled', 'completed')
   order by starts_at nulls last
   limit 1;
  if v_shift.id is null then
    raise exception 'no_shift_today' using errcode = 'P0001';
  end if;

  -- Already checked in? Idempotent — return the existing row.
  select * into v_existing from public.driver_checkins
   where shift_id = v_shift.id;
  if v_existing.id is not null then
    return jsonb_build_object(
      'already_checked_in', true,
      'checked_in_at',      to_jsonb(v_existing.checked_in_at),
      'distance_meters',    v_existing.distance_meters,
      'shift_id',           v_existing.shift_id
    );
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

  insert into public.driver_checkins
    (driver_id, dsp_id, shift_id, station_id,
     checked_in_at, lat, lng, accuracy_meters, distance_meters)
  values
    (v_drv.id, v_drv.dsp_id, v_shift.id, v_station.id,
     now(), p_lat, p_lng, p_accuracy, round(v_distance))
  returning * into v_existing;

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


-- ── 4. driver_checkin_status · what does the button show? ──
-- Returns the today's-shift snapshot the app needs to render the
-- right state: "Check in for shift", "Checked in at HH:MM", or
-- "No shift today".
create or replace function public.driver_checkin_status(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv     public.drivers;
  v_shift   public.shifts;
  v_station public.stations;
  v_chk     public.driver_checkins;
begin
  v_drv := private.driver_validate_token(p_token);

  select * into v_shift
    from public.shifts
   where driver_id = v_drv.id
     and date      = current_date
     and status    in ('scheduled', 'completed')
   order by starts_at nulls last
   limit 1;
  if v_shift.id is null then
    return jsonb_build_object('shift', null);
  end if;

  select * into v_station from public.stations where id = v_shift.station_id;
  select * into v_chk     from public.driver_checkins where shift_id = v_shift.id;

  return jsonb_build_object(
    'shift', jsonb_build_object(
      'id',           v_shift.id,
      'starts_at',    to_jsonb(v_shift.starts_at),
      'station_code', v_station.code,
      'has_geofence', v_station.latitude is not null and v_station.longitude is not null
    ),
    'checkin', case when v_chk.id is null then null else jsonb_build_object(
      'checked_in_at',   to_jsonb(v_chk.checked_in_at),
      'distance_meters', v_chk.distance_meters
    ) end
  );
end;
$$;
grant execute on function public.driver_checkin_status(text) to anon, authenticated;


-- ── 5. Dispatcher: configure the geofence pin per station ──
create or replace function public.station_set_geofence(
  p_station_id uuid,
  p_latitude   numeric,
  p_longitude  numeric,
  p_radius_m   int
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.stations
     set latitude               = p_latitude,
         longitude              = p_longitude,
         geofence_radius_meters = greatest(25, least(2000, coalesce(p_radius_m, 150))),
         updated_at             = now()
   where id = p_station_id and dsp_id = v_dsp;
end;
$$;
grant execute on function public.station_set_geofence(uuid, numeric, numeric, int) to authenticated;

create or replace function public.stations_with_geofence()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',                     s.id,
      'code',                   s.code,
      'name',                   s.name,
      'latitude',               s.latitude,
      'longitude',              s.longitude,
      'geofence_radius_meters', s.geofence_radius_meters
    ) order by s.code)
      from public.stations s
     where s.dsp_id = v_dsp and s.active = true
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.stations_with_geofence() to authenticated;


notify pgrst, 'reload schema';
