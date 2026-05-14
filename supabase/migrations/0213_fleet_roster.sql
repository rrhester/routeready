-- Migration 0213 · Fleet roster + record
--
-- Builds on the standing van-assignments work (0186) to give the Fleet
-- page a real roster and a per-van record drawer, mirroring the shape
-- of the Drivers page.  Adds the descriptive + compliance columns the
-- record drawer wants (year/make/model, plate, VIN, mileage, station,
-- registration + insurance + DOT-inspection dates, photo), a small
-- service-log table for the Service tab, and the read/write RPCs the
-- dashboard calls.
--
-- Idempotent: re-running this migration after a partial apply is safe.

-- ── 1. Vehicles · descriptive + compliance columns ──────────────────
-- Shape mirrors the Amazon Logistics Fleet portal (logistics.amazon.com
-- /fleet-management) so an operator who knows that surface can map
-- 1:1.  Year/make/model + ownership + operational_status drive the
-- "My vehicles" roster; the date columns drive the Issues + Inspections
-- panels; mileage_updated_at is the GeoTab-style "last reading" stamp.
alter table public.vehicles
  add column if not exists nickname               text,
  add column if not exists year                   int,
  add column if not exists make                   text,
  add column if not exists model                  text,
  add column if not exists trim_level             text,
  add column if not exists color                  text,
  add column if not exists vin                    text,
  add column if not exists plate                  text,
  add column if not exists plate_state            text,
  add column if not exists mileage                int,
  add column if not exists mileage_updated_at     timestamptz,
  add column if not exists station_id             uuid references public.stations(id) on delete set null,
  add column if not exists photo_path             text,
  add column if not exists ownership              text default 'dsp_owned',  -- amazon_owned | dsp_owned | rental | leased
  add column if not exists operational_status     text default 'operational', -- operational | grounded
  add column if not exists ownership_status       text default 'active',     -- active | inactive | retired
  add column if not exists last_route_completed_at timestamptz,
  add column if not exists in_service_on          date,
  add column if not exists last_service_at        date,
  add column if not exists last_service_note      text,
  add column if not exists next_service_due_at    date,
  add column if not exists dot_inspection_at      date,
  add column if not exists registration_expires_on date,
  add column if not exists insurance_expires_on   date;

create index if not exists vehicles_station_idx on public.vehicles (dsp_id, station_id);


-- ── 2. Vehicle service log ──────────────────────────────────────────
-- Free-form entries an operator logs against a van: oil change, tire
-- rotation, accident, DOT inspection, etc.  The Service tab on the
-- record drawer lists these in reverse-chron.
create table if not exists public.vehicle_service_logs (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  vehicle_id   uuid not null references public.vehicles(id) on delete cascade,
  occurred_at  date not null default current_date,
  kind         text not null default 'service',   -- service | inspection | accident | repair | note
  summary      text,
  notes        text,
  cost_cents   int,
  vendor       text,
  mileage      int,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists vehicle_service_logs_vehicle_idx on public.vehicle_service_logs (vehicle_id, occurred_at desc);

alter table public.vehicle_service_logs enable row level security;

drop policy if exists "vehicle_service_logs_rw" on public.vehicle_service_logs;
create policy "vehicle_service_logs_rw" on public.vehicle_service_logs
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

grant select, insert, update, delete on public.vehicle_service_logs to authenticated;


-- ── 2b. Vehicle issues (table only — RPCs come later) ───────────────
-- The table needs to exist before vehicles_roster references it.  The
-- save/delete/list RPCs are defined in section 11 below.
create table if not exists public.vehicle_issues (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  vehicle_id   uuid not null references public.vehicles(id) on delete cascade,
  reported_at  timestamptz not null default now(),
  due_at       date,
  severity     text not null default 'medium',
  category     text not null default 'mechanical',
  title        text not null,
  description  text,
  status       text not null default 'open',
  resolution   text,
  resolution_note text,
  resolved_at  timestamptz,
  work_order   text,
  cost_cents   int,
  source       text default 'dsp',
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists vehicle_issues_vehicle_idx on public.vehicle_issues (vehicle_id, status, reported_at desc);
create index if not exists vehicle_issues_dsp_open_idx on public.vehicle_issues (dsp_id, status) where status <> 'completed';

alter table public.vehicle_issues enable row level security;
drop policy if exists "vehicle_issues_rw" on public.vehicle_issues;
create policy "vehicle_issues_rw" on public.vehicle_issues
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));
grant select, insert, update, delete on public.vehicle_issues to authenticated;


-- ── 3. Storage · public photo bucket ────────────────────────────────
-- Same pattern as driver-photos (0064) — reads are public so an <img>
-- tag against the public URL just works; uploads are done via the
-- authenticated client (RLS handled below).
insert into storage.buckets (id, name, public)
values ('vehicle-photos', 'vehicle-photos', true)
on conflict (id) do nothing;

-- Allow dispatchers to upload / replace / delete photos for their DSP's
-- vans.  Path convention: "<vehicle_id>/<filename>"; we only require
-- the vehicle exists on the caller's DSP.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'vehicle_photos_write'
  ) then
    create policy "vehicle_photos_write" on storage.objects
      for all to authenticated
      using (
        bucket_id = 'vehicle-photos'
        and exists (
          select 1 from public.vehicles v
          where v.id::text = split_part(storage.objects.name, '/', 1)
            and v.dsp_id = private.current_dsp_id()
            and private.is_staff(v.dsp_id, 'dispatcher')
        )
      )
      with check (
        bucket_id = 'vehicle-photos'
        and exists (
          select 1 from public.vehicles v
          where v.id::text = split_part(storage.objects.name, '/', 1)
            and v.dsp_id = private.current_dsp_id()
            and private.is_staff(v.dsp_id, 'dispatcher')
        )
      );
  end if;
end $$;


-- ── 4. RPC · vehicles_roster ────────────────────────────────────────
-- Compact list for the roster table.  Returns one row per non-archived
-- vehicle for the caller's DSP, decorated with the primary driver's
-- display name + id (rank 0) and the station code.  Ordered by name
-- (natural-ish — vans are usually numeric).
create or replace function public.vehicles_roster()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(v order by v->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',                 vh.id,
      'name',               vh.name,
      'nickname',           vh.nickname,
      'kind',               vh.kind,
      'status',             vh.status,
      'ownership',          vh.ownership,
      'operational_status', vh.operational_status,
      'year',               vh.year,
      'make',               vh.make,
      'model',              vh.model,
      'trim_level',         vh.trim_level,
      'color',              vh.color,
      'plate',              vh.plate,
      'plate_state',        vh.plate_state,
      'vin',                vh.vin,
      'mileage',            vh.mileage,
      'mileage_updated_at', vh.mileage_updated_at,
      'last_route_completed_at', vh.last_route_completed_at,
      'photo_path',         vh.photo_path,
      'station_id',         vh.station_id,
      'station_code',       st.code,
      'last_service_at',    vh.last_service_at,
      'next_service_due_at',vh.next_service_due_at,
      'dot_inspection_at',  vh.dot_inspection_at,
      'registration_expires_on', vh.registration_expires_on,
      'insurance_expires_on',    vh.insurance_expires_on,
      'updated_at',         vh.updated_at,
      'primary_driver_id',  pri.driver_id,
      'primary_driver_name',pri.name,
      'backup_count',       coalesce(ch.backup_count, 0),
      'open_issue_count',   coalesce(oi.cnt, 0)
    ) v
    from public.vehicles vh
    left join public.stations st on st.id = vh.station_id
    left join lateral (
      select a.driver_id,
             coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver') as name
      from public.vehicle_driver_assignments a
      join public.drivers d on d.id = a.driver_id
      where a.vehicle_id = vh.id and a.rank = 0
      limit 1
    ) pri on true
    left join lateral (
      select greatest(count(*)::int - 1, 0) as backup_count
      from public.vehicle_driver_assignments
      where vehicle_id = vh.id
    ) ch on true
    left join lateral (
      select count(*)::int as cnt
      from public.vehicle_issues
      where vehicle_id = vh.id and status <> 'completed'
    ) oi on true
    where vh.dsp_id = private.current_dsp_id()
      and vh.archived_at is null
      and private.is_staff(vh.dsp_id, 'dispatcher')
  ) t;
$$;
grant execute on function public.vehicles_roster() to authenticated;


-- ── 5. RPC · vehicle_record ─────────────────────────────────────────
-- Full record for a single vehicle: every column + driver chain + the
-- last 50 service-log rows.  Used by the record drawer.
create or replace function public.vehicle_record(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_v public.vehicles;
  v_drivers jsonb;
  v_logs jsonb;
  v_station_code text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_v from public.vehicles where id = p_id and dsp_id = v_dsp;
  if v_v.id is null then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'driver_id', a.driver_id,
           'rank',      a.rank,
           'name',      coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver'),
           'phone',     d.phone,
           'photo_path', d.photo_path
         ) order by a.rank), '[]'::jsonb)
    into v_drivers
    from public.vehicle_driver_assignments a
    join public.drivers d on d.id = a.driver_id
   where a.vehicle_id = v_v.id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',          l.id,
           'occurred_at', l.occurred_at,
           'kind',        l.kind,
           'summary',     l.summary,
           'notes',       l.notes,
           'cost_cents',  l.cost_cents,
           'vendor',      l.vendor,
           'mileage',     l.mileage,
           'created_at',  l.created_at
         ) order by l.occurred_at desc, l.created_at desc), '[]'::jsonb)
    into v_logs
    from (
      select * from public.vehicle_service_logs
       where vehicle_id = v_v.id
       order by occurred_at desc, created_at desc
       limit 50
    ) l;

  select code into v_station_code from public.stations where id = v_v.station_id;

  return jsonb_build_object(
    'vehicle', to_jsonb(v_v) || jsonb_build_object('station_code', v_station_code),
    'drivers', v_drivers,
    'logs',    v_logs
  );
end;
$$;
grant execute on function public.vehicle_record(uuid) to authenticated;


-- ── 6. RPC · vehicle_record_save ────────────────────────────────────
-- One-shot upsert for every editable field on the record drawer.  If
-- p_id is null, creates a new vehicle.  Returns the saved row.
create or replace function public.vehicle_record_save(
  p_id                     uuid    default null,
  p_name                   text    default null,
  p_nickname               text    default null,
  p_kind                   text    default 'van',
  p_status                 text    default 'active',
  p_ownership              text    default 'dsp_owned',
  p_operational_status     text    default 'operational',
  p_year                   int     default null,
  p_make                   text    default null,
  p_model                  text    default null,
  p_trim                   text    default null,
  p_color                  text    default null,
  p_vin                    text    default null,
  p_plate                  text    default null,
  p_plate_state            text    default null,
  p_mileage                int     default null,
  p_station_id             uuid    default null,
  p_in_service_on          date    default null,
  p_last_service_at        date    default null,
  p_last_service_note      text    default null,
  p_next_service_due_at    date    default null,
  p_dot_inspection_at      date    default null,
  p_registration_expires_on date   default null,
  p_insurance_expires_on   date    default null,
  p_notes                  text    default null
) returns public.vehicles
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_v public.vehicles;
  v_mileage_updated timestamptz;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if coalesce(p_status, 'active') not in ('active','spare','out_of_service','retired') then
    raise exception 'bad_status' using errcode = '22023';
  end if;
  if coalesce(p_ownership, 'dsp_owned') not in ('amazon_owned','dsp_owned','rental','leased') then
    raise exception 'bad_ownership' using errcode = '22023';
  end if;
  if coalesce(p_operational_status, 'operational') not in ('operational','grounded') then
    raise exception 'bad_op_status' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.vehicles (
      dsp_id, name, nickname, kind, status, ownership, operational_status,
      year, make, model, trim_level, color, vin, plate, plate_state,
      mileage, mileage_updated_at, station_id, in_service_on,
      last_service_at, last_service_note, next_service_due_at,
      dot_inspection_at, registration_expires_on, insurance_expires_on,
      notes, created_by
    ) values (
      v_dsp,
      trim(p_name),
      nullif(trim(p_nickname), ''),
      coalesce(nullif(trim(p_kind), ''), 'van'),
      coalesce(p_status, 'active'),
      coalesce(p_ownership, 'dsp_owned'),
      coalesce(p_operational_status, 'operational'),
      p_year, nullif(trim(p_make), ''), nullif(trim(p_model), ''),
      nullif(trim(p_trim), ''), nullif(trim(p_color), ''),
      nullif(upper(trim(p_vin)), ''), nullif(upper(trim(p_plate)), ''), nullif(upper(trim(p_plate_state)), ''),
      p_mileage,
      case when p_mileage is not null then now() else null end,
      p_station_id,
      p_in_service_on,
      p_last_service_at, nullif(trim(p_last_service_note), ''), p_next_service_due_at,
      p_dot_inspection_at, p_registration_expires_on, p_insurance_expires_on,
      nullif(trim(p_notes), ''), auth.uid()
    )
    returning * into v_v;
  else
    -- mileage_updated_at bumps only when the mileage actually changed.
    select case when p_mileage is distinct from mileage and p_mileage is not null then now() else mileage_updated_at end
      into v_mileage_updated
      from public.vehicles where id = p_id and dsp_id = v_dsp;

    update public.vehicles set
      name                   = trim(p_name),
      nickname               = nullif(trim(p_nickname), ''),
      kind                   = coalesce(nullif(trim(p_kind), ''), 'van'),
      status                 = coalesce(p_status, 'active'),
      ownership              = coalesce(p_ownership, 'dsp_owned'),
      operational_status     = coalesce(p_operational_status, 'operational'),
      year                   = p_year,
      make                   = nullif(trim(p_make), ''),
      model                  = nullif(trim(p_model), ''),
      trim_level             = nullif(trim(p_trim), ''),
      color                  = nullif(trim(p_color), ''),
      vin                    = nullif(upper(trim(p_vin)), ''),
      plate                  = nullif(upper(trim(p_plate)), ''),
      plate_state            = nullif(upper(trim(p_plate_state)), ''),
      mileage                = p_mileage,
      mileage_updated_at     = v_mileage_updated,
      station_id             = p_station_id,
      in_service_on          = p_in_service_on,
      last_service_at        = p_last_service_at,
      last_service_note      = nullif(trim(p_last_service_note), ''),
      next_service_due_at    = p_next_service_due_at,
      dot_inspection_at      = p_dot_inspection_at,
      registration_expires_on= p_registration_expires_on,
      insurance_expires_on   = p_insurance_expires_on,
      notes                  = nullif(trim(p_notes), ''),
      updated_at             = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_v;
    if v_v.id is null then raise exception 'vehicle_not_found' using errcode = 'P0002'; end if;
  end if;

  return v_v;
end;
$$;
grant execute on function public.vehicle_record_save(
  uuid, text, text, text, text, text, text,
  int, text, text, text, text, text, text, text,
  int, uuid, date, date, text, date, date, date, date, text
) to authenticated;


-- ── 7. RPC · vehicle_photo_set ──────────────────────────────────────
-- After the dashboard uploads to vehicle-photos, it calls this to
-- persist the resulting path on the vehicle.  We constrain the path
-- to start with the vehicle's id (same shape as driver_set_photo).
create or replace function public.vehicle_photo_set(p_vehicle_id uuid, p_path text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_path is not null and p_path <> '' and not (p_path like p_vehicle_id::text || '/%') then
    raise exception 'invalid_photo_path' using errcode = '42501';
  end if;
  update public.vehicles set photo_path = nullif(p_path, ''), updated_at = now()
   where id = p_vehicle_id and dsp_id = v_dsp;
  if not found then raise exception 'vehicle_not_found' using errcode = 'P0002'; end if;
end;
$$;
grant execute on function public.vehicle_photo_set(uuid, text) to authenticated;


-- ── 8. RPC · vehicle_service_log_save / _delete ─────────────────────
create or replace function public.vehicle_service_log_save(
  p_id          uuid default null,
  p_vehicle_id  uuid default null,
  p_occurred_at date default null,
  p_kind        text default 'service',
  p_summary     text default null,
  p_notes       text default null,
  p_cost_cents  int  default null,
  p_vendor      text default null,
  p_mileage     int  default null
) returns public.vehicle_service_logs
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vehicle_service_logs;
  v_veh uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  if p_id is null then
    if p_vehicle_id is null then raise exception 'vehicle_id_required' using errcode = '22023'; end if;
    if not exists (select 1 from public.vehicles where id = p_vehicle_id and dsp_id = v_dsp) then
      raise exception 'vehicle_not_found' using errcode = 'P0002';
    end if;
    insert into public.vehicle_service_logs (
      dsp_id, vehicle_id, occurred_at, kind, summary, notes, cost_cents, vendor, mileage, created_by
    ) values (
      v_dsp, p_vehicle_id, coalesce(p_occurred_at, current_date),
      coalesce(nullif(trim(p_kind), ''), 'service'),
      nullif(trim(p_summary), ''), nullif(trim(p_notes), ''),
      p_cost_cents, nullif(trim(p_vendor), ''), p_mileage, auth.uid()
    ) returning * into v_row;
  else
    update public.vehicle_service_logs set
      occurred_at = coalesce(p_occurred_at, occurred_at),
      kind        = coalesce(nullif(trim(p_kind), ''), kind),
      summary     = nullif(trim(p_summary), ''),
      notes       = nullif(trim(p_notes), ''),
      cost_cents  = p_cost_cents,
      vendor      = nullif(trim(p_vendor), ''),
      mileage     = p_mileage,
      updated_at  = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then raise exception 'log_not_found' using errcode = 'P0002'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.vehicle_service_log_save(uuid, uuid, date, text, text, text, int, text, int) to authenticated;

create or replace function public.vehicle_service_log_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.vehicle_service_logs where id = p_id and dsp_id = v_dsp;
  if not found then raise exception 'log_not_found' using errcode = 'P0002'; end if;
end;
$$;
grant execute on function public.vehicle_service_log_delete(uuid) to authenticated;


-- ── 9. Vehicle inspections (DVIC pre/post-trip) ─────────────────────
-- Mirrors the "Inspections" tab in the Amazon Fleet portal.
create table if not exists public.vehicle_inspections (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  vehicle_id    uuid not null references public.vehicles(id) on delete cascade,
  inspector_driver_id uuid references public.drivers(id) on delete set null,
  inspector_name text,
  inspected_at  timestamptz not null default now(),
  kind          text not null default 'pre_trip',    -- pre_trip | post_trip | dvic | dot_annual | other
  result        text not null default 'passed',      -- passed | needs_repair | failed
  defects       jsonb not null default '[]'::jsonb,  -- ["check engine light", "tire wear", ...]
  notes         text,
  photos        jsonb not null default '[]'::jsonb,  -- ["<vehicle_id>/insp/<id>.jpg", ...]
  mileage       int,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists vehicle_inspections_vehicle_idx on public.vehicle_inspections (vehicle_id, inspected_at desc);
create index if not exists vehicle_inspections_dsp_idx     on public.vehicle_inspections (dsp_id, inspected_at desc);

alter table public.vehicle_inspections enable row level security;
drop policy if exists "vehicle_inspections_rw" on public.vehicle_inspections;
create policy "vehicle_inspections_rw" on public.vehicle_inspections
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));
grant select, insert, update, delete on public.vehicle_inspections to authenticated;

create or replace function public.vehicle_inspection_save(
  p_id           uuid default null,
  p_vehicle_id   uuid default null,
  p_inspector_driver_id uuid default null,
  p_inspector_name text default null,
  p_inspected_at timestamptz default null,
  p_kind         text default 'pre_trip',
  p_result       text default 'passed',
  p_defects      jsonb default '[]'::jsonb,
  p_notes        text default null,
  p_mileage      int  default null
) returns public.vehicle_inspections
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vehicle_inspections;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_result, '') not in ('passed','needs_repair','failed') then raise exception 'bad_result' using errcode = '22023'; end if;
  if p_id is null then
    if p_vehicle_id is null then raise exception 'vehicle_id_required' using errcode = '22023'; end if;
    if not exists (select 1 from public.vehicles where id = p_vehicle_id and dsp_id = v_dsp) then
      raise exception 'vehicle_not_found' using errcode = 'P0002';
    end if;
    insert into public.vehicle_inspections (
      dsp_id, vehicle_id, inspector_driver_id, inspector_name, inspected_at,
      kind, result, defects, notes, mileage, created_by
    ) values (
      v_dsp, p_vehicle_id, p_inspector_driver_id, nullif(trim(p_inspector_name), ''),
      coalesce(p_inspected_at, now()),
      coalesce(nullif(trim(p_kind), ''), 'pre_trip'),
      coalesce(p_result, 'passed'),
      coalesce(p_defects, '[]'::jsonb),
      nullif(trim(p_notes), ''),
      p_mileage, auth.uid()
    ) returning * into v_row;
  else
    update public.vehicle_inspections set
      inspector_driver_id = p_inspector_driver_id,
      inspector_name = nullif(trim(p_inspector_name), ''),
      inspected_at   = coalesce(p_inspected_at, inspected_at),
      kind           = coalesce(nullif(trim(p_kind), ''), kind),
      result         = coalesce(p_result, result),
      defects        = coalesce(p_defects, defects),
      notes          = nullif(trim(p_notes), ''),
      mileage        = p_mileage,
      updated_at     = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then raise exception 'inspection_not_found' using errcode = 'P0002'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.vehicle_inspection_save(uuid, uuid, uuid, text, timestamptz, text, text, jsonb, text, int) to authenticated;

create or replace function public.vehicle_inspection_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.vehicle_inspections where id = p_id and dsp_id = v_dsp;
  if not found then raise exception 'inspection_not_found' using errcode = 'P0002'; end if;
end; $$;
grant execute on function public.vehicle_inspection_delete(uuid) to authenticated;


-- ── 10. Vehicle mileage log ─────────────────────────────────────────
-- Mirrors the GeoTab "Mileage history" tab.  Insertion also bumps
-- vehicles.mileage + mileage_updated_at when the new reading is higher.
create table if not exists public.vehicle_mileage_log (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  vehicle_id   uuid not null references public.vehicles(id) on delete cascade,
  reading_at   timestamptz not null default now(),
  mileage      int not null,
  source       text default 'manual',     -- manual | geotab | inspection | service
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists vehicle_mileage_log_vehicle_idx on public.vehicle_mileage_log (vehicle_id, reading_at desc);

alter table public.vehicle_mileage_log enable row level security;
drop policy if exists "vehicle_mileage_log_rw" on public.vehicle_mileage_log;
create policy "vehicle_mileage_log_rw" on public.vehicle_mileage_log
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));
grant select, insert, update, delete on public.vehicle_mileage_log to authenticated;

create or replace function public.vehicle_mileage_log_save(
  p_vehicle_id uuid,
  p_mileage    int,
  p_reading_at timestamptz default null,
  p_source     text default 'manual'
) returns public.vehicle_mileage_log
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vehicle_mileage_log;
  v_cur int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_vehicle_id is null or p_mileage is null then raise exception 'bad_args' using errcode = '22023'; end if;
  if not exists (select 1 from public.vehicles where id = p_vehicle_id and dsp_id = v_dsp) then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;
  insert into public.vehicle_mileage_log (dsp_id, vehicle_id, reading_at, mileage, source, created_by)
  values (v_dsp, p_vehicle_id, coalesce(p_reading_at, now()), p_mileage,
          coalesce(nullif(trim(p_source), ''), 'manual'), auth.uid())
  returning * into v_row;

  select mileage into v_cur from public.vehicles where id = p_vehicle_id;
  if v_cur is null or p_mileage > v_cur then
    update public.vehicles set mileage = p_mileage, mileage_updated_at = now(), updated_at = now()
     where id = p_vehicle_id;
  end if;
  return v_row;
end;
$$;
grant execute on function public.vehicle_mileage_log_save(uuid, int, timestamptz, text) to authenticated;

create or replace function public.vehicle_mileage_log_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.vehicle_mileage_log where id = p_id and dsp_id = v_dsp;
  if not found then raise exception 'log_not_found' using errcode = 'P0002'; end if;
end; $$;
grant execute on function public.vehicle_mileage_log_delete(uuid) to authenticated;


-- ── 11. Vehicle issues — save / delete RPCs ─────────────────────────
-- (Table defined in section 2b above so vehicles_roster could reference
-- it.)  Severity legend: low | medium | high | critical.
-- Status legend: open | needs_repair | in_repair | completed.
-- Category: mechanical | electrical | body | safety | recall | self_reported | preventative | other.
create or replace function public.vehicle_issue_save(
  p_id           uuid default null,
  p_vehicle_id   uuid default null,
  p_title        text default null,
  p_description  text default null,
  p_severity     text default 'medium',
  p_category     text default 'mechanical',
  p_status       text default 'open',
  p_due_at       date default null,
  p_reported_at  timestamptz default null,
  p_source       text default 'dsp',
  p_resolution   text default null,
  p_resolution_note text default null,
  p_work_order   text default null,
  p_cost_cents   int  default null
) returns public.vehicle_issues
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vehicle_issues;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_severity, '') not in ('low','medium','high','critical') then raise exception 'bad_severity' using errcode = '22023'; end if;
  if coalesce(p_status, '') not in ('open','needs_repair','in_repair','completed') then raise exception 'bad_status' using errcode = '22023'; end if;

  if p_id is null then
    if p_vehicle_id is null then raise exception 'vehicle_id_required' using errcode = '22023'; end if;
    if coalesce(trim(p_title), '') = '' then raise exception 'title_required' using errcode = '22023'; end if;
    if not exists (select 1 from public.vehicles where id = p_vehicle_id and dsp_id = v_dsp) then
      raise exception 'vehicle_not_found' using errcode = 'P0002';
    end if;
    insert into public.vehicle_issues (
      dsp_id, vehicle_id, reported_at, due_at, severity, category,
      title, description, status, resolution, resolution_note,
      resolved_at, work_order, cost_cents, source, created_by
    ) values (
      v_dsp, p_vehicle_id, coalesce(p_reported_at, now()), p_due_at,
      coalesce(p_severity, 'medium'),
      coalesce(nullif(trim(p_category), ''), 'mechanical'),
      trim(p_title), nullif(trim(p_description), ''),
      coalesce(p_status, 'open'),
      nullif(trim(p_resolution), ''),
      nullif(trim(p_resolution_note), ''),
      case when p_status = 'completed' then now() else null end,
      nullif(trim(p_work_order), ''),
      p_cost_cents,
      coalesce(nullif(trim(p_source), ''), 'dsp'),
      auth.uid()
    ) returning * into v_row;
  else
    update public.vehicle_issues set
      title          = coalesce(nullif(trim(p_title), ''), title),
      description    = nullif(trim(p_description), ''),
      severity       = coalesce(p_severity, severity),
      category       = coalesce(nullif(trim(p_category), ''), category),
      status         = coalesce(p_status, status),
      due_at         = p_due_at,
      reported_at    = coalesce(p_reported_at, reported_at),
      source         = coalesce(nullif(trim(p_source), ''), source),
      resolution     = nullif(trim(p_resolution), ''),
      resolution_note= nullif(trim(p_resolution_note), ''),
      work_order     = nullif(trim(p_work_order), ''),
      cost_cents     = p_cost_cents,
      resolved_at    = case when p_status = 'completed' and resolved_at is null then now()
                            when p_status <> 'completed' then null
                            else resolved_at end,
      updated_at     = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then raise exception 'issue_not_found' using errcode = 'P0002'; end if;
  end if;

  -- A vehicle with any non-completed issue is "grounded" once it
  -- crosses the high/critical threshold or is explicitly needs_repair.
  -- Operators can also flip operational_status from the record drawer.
  return v_row;
end;
$$;
grant execute on function public.vehicle_issue_save(uuid, uuid, text, text, text, text, text, date, timestamptz, text, text, text, text, int) to authenticated;

create or replace function public.vehicle_issue_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.vehicle_issues where id = p_id and dsp_id = v_dsp;
  if not found then raise exception 'issue_not_found' using errcode = 'P0002'; end if;
end; $$;
grant execute on function public.vehicle_issue_delete(uuid) to authenticated;


-- ── 12. RPC · vehicles_issues_list ──────────────────────────────────
-- Issues page list, scoped to the caller's DSP and decorated with the
-- vehicle's name + plate so the dashboard can render a single table.
create or replace function public.vehicles_issues_list(p_status text default 'open')
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(j order by j->>'reported_at' desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',           i.id,
      'vehicle_id',   i.vehicle_id,
      'vehicle_name', v.name,
      'plate',        v.plate,
      'vin',          v.vin,
      'make',         v.make,
      'model',        v.model,
      'reported_at',  i.reported_at,
      'due_at',       i.due_at,
      'severity',     i.severity,
      'category',     i.category,
      'title',        i.title,
      'description',  i.description,
      'status',       i.status,
      'resolution',   i.resolution,
      'work_order',   i.work_order,
      'cost_cents',   i.cost_cents,
      'source',       i.source,
      'resolved_at',  i.resolved_at
    ) j
    from public.vehicle_issues i
    join public.vehicles v on v.id = i.vehicle_id
    where i.dsp_id = private.current_dsp_id()
      and private.is_staff(i.dsp_id, 'dispatcher')
      and (
        p_status is null
        or p_status = 'all'
        or (p_status = 'open' and i.status <> 'completed')
        or (p_status = 'completed' and i.status = 'completed')
      )
    order by i.reported_at desc
    limit 500
  ) t;
$$;
grant execute on function public.vehicles_issues_list(text) to authenticated;


-- ── 13. RPC · vehicles_dashboard ────────────────────────────────────
-- KPI rollups for the Fleet Dashboard sub-tab.  One JSON payload to
-- avoid five separate round-trips.
create or replace function public.vehicles_dashboard()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_total int; v_operational int; v_grounded int;
  v_open_issues int; v_high int; v_overdue int;
  v_pm_due int; v_pm_overdue int;
  v_dot_due int; v_dot_overdue int;
  v_insp_today int; v_pre_today int; v_post_today int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  select count(*),
         count(*) filter (where operational_status = 'operational'),
         count(*) filter (where operational_status = 'grounded')
    into v_total, v_operational, v_grounded
    from public.vehicles
   where dsp_id = v_dsp and archived_at is null;

  select count(*),
         count(*) filter (where severity in ('high','critical')),
         count(*) filter (where due_at is not null and due_at < current_date and status <> 'completed')
    into v_open_issues, v_high, v_overdue
    from public.vehicle_issues
   where dsp_id = v_dsp and status <> 'completed';

  select count(*) filter (where next_service_due_at is not null
                              and next_service_due_at <= (current_date + interval '14 days')
                              and next_service_due_at >= current_date),
         count(*) filter (where next_service_due_at is not null and next_service_due_at < current_date)
    into v_pm_due, v_pm_overdue
    from public.vehicles
   where dsp_id = v_dsp and archived_at is null;

  select count(*) filter (where dot_inspection_at is not null
                              and dot_inspection_at + interval '1 year' <= (current_date + interval '30 days')
                              and dot_inspection_at + interval '1 year' >= current_date),
         count(*) filter (where dot_inspection_at is not null and dot_inspection_at + interval '1 year' < current_date)
    into v_dot_due, v_dot_overdue
    from public.vehicles
   where dsp_id = v_dsp and archived_at is null;

  select count(*),
         count(*) filter (where kind = 'pre_trip'),
         count(*) filter (where kind = 'post_trip')
    into v_insp_today, v_pre_today, v_post_today
    from public.vehicle_inspections
   where dsp_id = v_dsp and inspected_at::date = current_date;

  return jsonb_build_object(
    'totals', jsonb_build_object('total', v_total, 'operational', v_operational, 'grounded', v_grounded),
    'issues', jsonb_build_object('open', v_open_issues, 'high', v_high, 'overdue', v_overdue),
    'pm',     jsonb_build_object('due_soon', v_pm_due, 'overdue', v_pm_overdue),
    'dot',    jsonb_build_object('due_soon', v_dot_due, 'overdue', v_dot_overdue),
    'inspections_today', jsonb_build_object('total', v_insp_today, 'pre', v_pre_today, 'post', v_post_today)
  );
end;
$$;
grant execute on function public.vehicles_dashboard() to authenticated;


-- ── 14. RPC · vehicle_history ───────────────────────────────────────
-- Combined timeline (issues + inspections + service logs + mileage)
-- for the per-van "Vehicle history" tab.
create or replace function public.vehicle_history(p_vehicle_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.vehicles where id = p_vehicle_id and dsp_id = v_dsp) then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(j order by at_ts desc), '[]'::jsonb) into v_out
  from (
    select reported_at as at_ts,
           jsonb_build_object(
             'kind','issue','at', reported_at, 'id', id,
             'title', title, 'severity', severity, 'status', status,
             'category', category, 'resolved_at', resolved_at
           ) j
      from public.vehicle_issues where vehicle_id = p_vehicle_id
    union all
    select inspected_at,
           jsonb_build_object(
             'kind','inspection','at', inspected_at, 'id', id,
             'title', initcap(replace(kind,'_',' ')) || ' inspection',
             'result', result, 'inspector', inspector_name
           )
      from public.vehicle_inspections where vehicle_id = p_vehicle_id
    union all
    select occurred_at::timestamptz,
           jsonb_build_object(
             'kind','service','at', occurred_at, 'id', id,
             'title', coalesce(nullif(trim(summary), ''), initcap(kind)),
             'cost_cents', cost_cents, 'vendor', vendor
           )
      from public.vehicle_service_logs where vehicle_id = p_vehicle_id
    union all
    select reading_at,
           jsonb_build_object(
             'kind','mileage','at', reading_at, 'id', id,
             'title', mileage::text || ' mi reading',
             'mileage', mileage, 'source', source
           )
      from public.vehicle_mileage_log where vehicle_id = p_vehicle_id
    order by at_ts desc
    limit 200
  ) t;

  return v_out;
end;
$$;
grant execute on function public.vehicle_history(uuid) to authenticated;


notify pgrst, 'reload schema';
