-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510030000 · drivers + bulk import RPC
-- The driver entity at the center of the operational flywheel. Phase 1
-- ships the table + RLS + a bulk-import RPC for CSV-paste onboarding.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── Driver status enum ──────────────────────────────────────────────────

create type public.driver_status as enum (
  'active',         -- normal active driver
  'onboarding',     -- hired but not yet running routes
  'suspended',      -- temporary removal (HR file event drives this)
  'inactive',       -- voluntary leave / paused
  'terminated'      -- final
);

-- ─── Drivers table ───────────────────────────────────────────────────────

create table public.drivers (
  id                       uuid        primary key default gen_random_uuid(),
  dsp_id                   uuid        not null references public.dsps(id) on delete cascade,
  station_id               uuid        references public.stations(id) on delete set null,
  full_name                text        not null,
  phone                    text,
  email                    text,
  status                   public.driver_status not null default 'onboarding',
  hire_date                date,
  termination_date         date,
  termination_reason       text,
  license_number           text,
  license_expiry           date,
  dot_medical_card_expiry  date,
  emergency_contact        jsonb,
  notes                    text,

  -- Computed/materialized fields. Recomputed nightly by the score-recompute
  -- Edge Function, plus on relevant event triggers in later phases.
  composite_score          numeric(5,2),
  attendance_rate_30d      numeric(5,2),
  retention_risk           numeric(5,2),

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid references public.app_users(id),

  -- Phone is normalized to E.164 by the bulk-import RPC + a check at insert.
  -- We DO accept null here because some DSPs onboard before getting the phone.
  constraint drivers_phone_e164 check (phone is null or phone ~ '^\+[1-9]\d{6,14}$')
);

-- Now backfill the FK on app_users.driver_id (created in migration 020000)
alter table public.app_users
  add constraint app_users_driver_fk
  foreign key (driver_id) references public.drivers(id) on delete set null;

-- ─── Indexes ─────────────────────────────────────────────────────────────

create index drivers_dsp_status_idx
  on public.drivers (dsp_id, status);
create index drivers_dsp_station_active_idx
  on public.drivers (dsp_id, station_id) where status = 'active';
create index drivers_license_expiry_idx
  on public.drivers (dsp_id, license_expiry)
  where license_expiry is not null and status = 'active';
create index drivers_score_idx
  on public.drivers (dsp_id, composite_score desc) where status = 'active';
create index drivers_full_name_trgm_idx
  on public.drivers using gin (full_name gin_trgm_ops);

-- ─── Triggers ────────────────────────────────────────────────────────────

create trigger trg_drivers_updated_at
  before update on public.drivers
  for each row execute function moddatetime(updated_at);

-- ─── RLS ─────────────────────────────────────────────────────────────────

alter table public.drivers enable row level security;

create policy "drivers_tenant_select"
  on public.drivers for select
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or id = private.current_driver_id()       -- driver sees own record
    )
  );

create policy "drivers_staff_insert"
  on public.drivers for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'ops')
  );

-- Staff (ops+) can update everything; a driver can only update specific
-- self-service columns (phone, emergency_contact). Two policies because
-- RLS does not have a per-column gate by default.
create policy "drivers_staff_update"
  on public.drivers for update
  using  (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

create policy "drivers_self_update"
  on public.drivers for update
  using (id = private.current_driver_id())
  with check (id = private.current_driver_id());
-- Column-level guarding for self_update is enforced by a trigger below.

-- DELETE is owner-only and rare. Termination flips status to 'terminated';
-- it doesn't drop the row, because HR records reference it.
create policy "drivers_owner_delete"
  on public.drivers for delete
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'owner')
  );

grant select, insert, update, delete on public.drivers to authenticated;

-- Trigger that prevents a driver from updating columns they shouldn't.
-- Staff updates bypass this trigger because the row's writer is staff.
create or replace function private.drivers_self_update_guard()
returns trigger language plpgsql as $$
begin
  -- If the updater is staff, allow anything.
  if private.is_staff(new.dsp_id, 'ops') then
    return new;
  end if;

  -- Otherwise, only phone, email, emergency_contact may change.
  if  new.full_name           is distinct from old.full_name
   or new.station_id          is distinct from old.station_id
   or new.status              is distinct from old.status
   or new.hire_date           is distinct from old.hire_date
   or new.termination_date    is distinct from old.termination_date
   or new.termination_reason  is distinct from old.termination_reason
   or new.license_number      is distinct from old.license_number
   or new.license_expiry      is distinct from old.license_expiry
   or new.notes               is distinct from old.notes
   or new.composite_score     is distinct from old.composite_score
   or new.attendance_rate_30d is distinct from old.attendance_rate_30d
   or new.retention_risk      is distinct from old.retention_risk
  then
    raise exception 'drivers: only phone, email, emergency_contact can be updated by self';
  end if;

  return new;
end $$;

create trigger trg_drivers_self_update_guard
  before update on public.drivers
  for each row execute function private.drivers_self_update_guard();

-- ─── Bulk-import RPC ─────────────────────────────────────────────────────
-- Frontend posts a CSV-parsed JSON array of rows. RPC runs in a single
-- transaction with security_definer so it can bypass RLS for batch
-- efficiency (we manually enforce the dsp_id check inside).
--
-- Payload shape (one row per driver):
--   [
--     { "full_name":"Marcus Davidson", "phone":"+14175550100",
--       "station_code":"KMO1", "license_expiry":"2026-05-05", "hire_date":"2024-11-01" },
--     ...
--   ]
--
-- Returns: { inserted: <int>, skipped: <int>, errors: [{row,reason}, ...] }

create or replace function public.bulk_import_drivers(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private, extensions
as $$
declare
  v_dsp        uuid;
  v_caller     uuid;
  rec          jsonb;
  inserted_n   int := 0;
  skipped_n    int := 0;
  errs         jsonb := '[]'::jsonb;
  v_station_id uuid;
  v_phone      text;
  v_full_name  text;
  v_email      text;
  v_license_expiry date;
  v_hire_date  date;
  v_status     public.driver_status;
  i            int := 0;
begin
  v_dsp    := private.current_dsp_id();
  v_caller := auth.uid();

  if v_dsp is null then
    raise exception 'bulk_import_drivers: not authenticated for any DSP';
  end if;

  if not private.is_staff(v_dsp, 'ops') then
    raise exception 'bulk_import_drivers: caller is not staff for DSP %', v_dsp;
  end if;

  if jsonb_typeof(payload) <> 'array' then
    raise exception 'bulk_import_drivers: payload must be a JSON array';
  end if;

  for rec in select * from jsonb_array_elements(payload)
  loop
    i := i + 1;
    begin
      v_full_name := nullif(trim(rec->>'full_name'), '');
      if v_full_name is null then
        skipped_n := skipped_n + 1;
        errs := errs || jsonb_build_object('row', i, 'reason', 'full_name required');
        continue;
      end if;

      -- Normalize phone to E.164 (US default if no leading +)
      v_phone := nullif(regexp_replace(coalesce(rec->>'phone',''), '[^0-9+]', '', 'g'), '');
      if v_phone is not null then
        if v_phone !~ '^\+' then
          if length(v_phone) = 10 then
            v_phone := '+1' || v_phone;
          elsif length(v_phone) = 11 and substring(v_phone from 1 for 1) = '1' then
            v_phone := '+' || v_phone;
          else
            errs := errs || jsonb_build_object('row', i, 'reason', 'phone format unrecognized: ' || v_phone);
            v_phone := null;
          end if;
        end if;
      end if;

      v_email          := nullif(trim(rec->>'email'), '');
      v_license_expiry := nullif(rec->>'license_expiry','')::date;
      v_hire_date      := nullif(rec->>'hire_date','')::date;
      v_status         := coalesce(nullif(rec->>'status','')::public.driver_status,
                                   case when v_hire_date is not null then 'active'::public.driver_status
                                        else 'onboarding'::public.driver_status end);

      v_station_id := null;
      if rec ? 'station_code' and (rec->>'station_code') is not null then
        select id into v_station_id
          from public.stations
         where dsp_id = v_dsp and code = rec->>'station_code'
         limit 1;
        if v_station_id is null then
          errs := errs || jsonb_build_object('row', i, 'reason', 'unknown station_code: ' || (rec->>'station_code'));
        end if;
      end if;

      insert into public.drivers
        (dsp_id, station_id, full_name, phone, email,
         status, hire_date, license_expiry, created_by)
      values
        (v_dsp, v_station_id, v_full_name, v_phone, v_email,
         v_status, v_hire_date, v_license_expiry, v_caller);

      inserted_n := inserted_n + 1;

    exception when others then
      skipped_n := skipped_n + 1;
      errs := errs || jsonb_build_object('row', i, 'reason', sqlerrm);
    end;
  end loop;

  return jsonb_build_object(
    'inserted', inserted_n,
    'skipped',  skipped_n,
    'errors',   errs
  );
end $$;

comment on function public.bulk_import_drivers(jsonb) is
  'Imports an array of driver rows for the caller''s DSP. Validates phone, ' ||
  'resolves station_code, returns per-row errors. Enforces RLS manually.';

-- Grant execute to authenticated; the function checks staff role itself.
revoke execute on function public.bulk_import_drivers(jsonb) from public, anon;
grant  execute on function public.bulk_import_drivers(jsonb) to authenticated;
