-- Migration 0486 · Repair Center — Phase 2 foundation
--
-- The Repair Center manages the full outside-repair lifecycle for vans:
-- report → quote → authorize → track at shop → invoice → return to
-- service.  This migration lays the case spine and its timeline, and
-- wires it into the EXISTING fleet repair stack rather than replacing
-- it:
--
--   · public.repair_orders  (0227/0228) stays the shop work-order
--     ledger — cases link to an RO via repair_cases.repair_order_id so
--     the compliance 2 BD / 14 BD clocks and the roster's Repair
--     status column keep working unchanged.
--   · public.vendors        (0227/0313) stays the shop directory —
--     this migration only adds Repair Center columns (classification,
--     service flags), no parallel "shops" table.
--   · public.vehicle_issues (0213) stays the defect log — issues gain
--     a repair_case_id so a driver report converts into a case without
--     duplicating evidence.
--   · vehicles.operational_status stays THE availability switch; the
--     only mutation path remains vehicle_set_operational_status()
--     (0229/0231/0308).  Repair Center RPCs call it — they never touch
--     vehicles.operational_status directly.
--
-- New tables:  repair_cases, repair_case_issues, repair_case_events,
--              repair_case_attachments, repair_shop_visits
-- New bucket:  repair-attachments (private)
-- New RPCs:    repair_case_create / repair_cases_list / repair_case_get
--              repair_case_set_stage / repair_case_update
--              repair_case_log_event / repair_case_attachment_add
--              repair_case_link_ro / repair_case_return_to_service
--              repair_case_from_issue / repair_center_summary
--
-- Stage model: text + CHECK (not an enum) so later phases can extend
-- without ALTER TYPE.  The allowed-transition map lives in
-- public._repair_stage_next_allowed() and is mirrored in
-- dashboard/repair/repair-engine.js (tests assert the two agree).
--
-- Idempotent: safe to re-run in the SQL Editor.

-- ═══════════════════════════ 1. vendors — Repair Center columns ═════

alter table public.vendors
  add column if not exists preferred_status text not null default 'approved',
  add column if not exists blocked_reason   text,
  add column if not exists website          text,
  add column if not exists hours_note       text,
  add column if not exists mobile_service   boolean not null default false,
  add column if not exists towing_available boolean not null default false,
  add column if not exists after_hours      boolean not null default false,
  add column if not exists service_categories jsonb not null default '[]'::jsonb,
  add column if not exists supported_vehicle_types jsonb not null default '[]'::jsonb;

do $$ begin
  alter table public.vendors
    add constraint vendors_preferred_status_chk
    check (preferred_status in ('preferred','approved','emergency','blocked'));
exception when duplicate_object then null; end $$;


-- ═══════════════════════════ 2. repair_cases ════════════════════════

create table if not exists public.repair_cases (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  vehicle_id    uuid not null references public.vehicles(id) on delete cascade,
  station_id    uuid references public.stations(id) on delete set null,

  -- Bridge into the existing repair stack
  repair_order_id uuid references public.repair_orders(id) on delete set null,
  vendor_id       uuid references public.vendors(id) on delete set null,

  case_number   text not null,                -- 'RC-2026-0001', per DSP per year
  title         text not null,
  description   text,
  category      text not null default 'mechanical',
  component     text,
  severity      text not null default 'medium',
  urgency       text not null default 'normal',

  -- Lifecycle (single controlled field; see _repair_stage_next_allowed)
  stage         text not null default 'reported',

  -- Operational impact.  vehicles.operational_status stays the source
  -- of truth for grounded; `availability` adds the Repair Center
  -- nuance (limited use, at shop, ready) and is kept in sync by the
  -- RPCs below — never written by clients directly.
  availability  text not null default 'in_service',
  safety_status text,                         -- safe | limited | unsafe
  drivable      boolean,
  towing_required        boolean not null default false,
  mobile_repair_preferred boolean not null default false,
  limitation_note text,                       -- shown to dispatch while limited
  route_impact    text,
  replacement_vehicle_id uuid references public.vehicles(id) on delete set null,

  -- Discovery / people
  discovered_at timestamptz,
  reported_at   timestamptz not null default now(),
  reported_by   uuid references auth.users(id) on delete set null,
  reported_via  text not null default 'manual',
  driver_id     uuid references public.drivers(id) on delete set null,
  assigned_to   uuid references auth.users(id) on delete set null,
  current_location text,
  odometer      int,

  -- Clocks (raw timestamps only — durations are always derived)
  required_completion_at         timestamptz,
  requested_return_to_service_at timestamptz,
  estimated_return_to_service_at timestamptz,
  actual_return_to_service_at    timestamptz,

  -- Provenance (issue conversion, DVIC, accident report, …)
  source_type   text not null default 'manual',
  source_id     uuid,

  -- Money rollups (integer cents; written by authorization/invoice
  -- phases — never computed by AI, never floats)
  approved_total_cents  int,
  estimate_total_cents  int,
  invoice_total_cents   int,

  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now(),
  closed_at     timestamptz,
  cancelled_at  timestamptz,
  archived_at   timestamptz
);

do $$ begin
  alter table public.repair_cases
    add constraint repair_cases_stage_chk check (stage in
      ('reported','review','quoting','quotes_in','awaiting_approval',
       'approved','scheduled','at_shop','ready_for_pickup',
       'quality_check','returned','closed','cancelled'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.repair_cases
    add constraint repair_cases_availability_chk check (availability in
      ('in_service','limited','grounded','at_shop','ready_for_pickup','returned'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.repair_cases
    add constraint repair_cases_severity_chk check (severity in
      ('low','medium','high','critical'));
exception when duplicate_object then null; end $$;

create unique index if not exists repair_cases_dsp_number_uq
  on public.repair_cases (dsp_id, case_number);
create index if not exists repair_cases_dsp_open_idx
  on public.repair_cases (dsp_id, stage)
  where stage not in ('closed','cancelled');
create index if not exists repair_cases_vehicle_idx
  on public.repair_cases (vehicle_id, reported_at desc);

alter table public.repair_cases enable row level security;

drop policy if exists "repair_cases_tenant_select" on public.repair_cases;
create policy "repair_cases_tenant_select"
  on public.repair_cases for select to authenticated
  using (dsp_id = private.current_dsp_id());
drop policy if exists "repair_cases_staff_insert" on public.repair_cases;
create policy "repair_cases_staff_insert"
  on public.repair_cases for insert to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));
drop policy if exists "repair_cases_staff_update" on public.repair_cases;
create policy "repair_cases_staff_update"
  on public.repair_cases for update to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));
drop policy if exists "repair_cases_staff_delete" on public.repair_cases;
create policy "repair_cases_staff_delete"
  on public.repair_cases for delete to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));
grant select, insert, update, delete on public.repair_cases to authenticated;


-- ═══════════════════════════ 3. repair_case_issues ══════════════════
-- A case can bundle several defects (e.g. brake grind + wiper streak).

create table if not exists public.repair_case_issues (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  repair_case_id  uuid not null references public.repair_cases(id) on delete cascade,
  vehicle_issue_id uuid references public.vehicle_issues(id) on delete set null,
  issue_type      text,
  component       text,
  description     text not null,
  severity        text not null default 'medium',
  safety_critical boolean not null default false,
  requested_action text,
  diagnosis       text,
  resolution      text,
  status          text not null default 'open',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists repair_case_issues_case_idx
  on public.repair_case_issues (repair_case_id);

alter table public.repair_case_issues enable row level security;
drop policy if exists "repair_case_issues_tenant_select" on public.repair_case_issues;
create policy "repair_case_issues_tenant_select"
  on public.repair_case_issues for select to authenticated
  using (dsp_id = private.current_dsp_id());
drop policy if exists "repair_case_issues_staff_insert" on public.repair_case_issues;
create policy "repair_case_issues_staff_insert"
  on public.repair_case_issues for insert to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));
drop policy if exists "repair_case_issues_staff_update" on public.repair_case_issues;
create policy "repair_case_issues_staff_update"
  on public.repair_case_issues for update to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));
drop policy if exists "repair_case_issues_staff_delete" on public.repair_case_issues;
create policy "repair_case_issues_staff_delete"
  on public.repair_case_issues for delete to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));
grant select, insert, update, delete on public.repair_case_issues to authenticated;


-- ═══════════════════════════ 4. repair_case_events ══════════════════
-- One unified timeline per case.  Every subsystem (quoting, shop
-- portal, email intake, invoicing) appends here — no parallel
-- timelines.  visible_to_shop gates what later shop-facing surfaces
-- may render; DSP-internal notes default to hidden.

create table if not exists public.repair_case_events (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  repair_case_id  uuid not null references public.repair_cases(id) on delete cascade,
  kind            text not null,              -- created | stage_changed | note |
                                              -- shop_update | grounded | ungrounded |
                                              -- attachment_added | ro_linked | …
  message         text,
  previous_value  text,
  new_value       text,
  source          text not null default 'dsp',
  actor_id        uuid references auth.users(id) on delete set null,
  actor_label     text,                       -- display name fallback (shop, driver)
  visible_to_shop boolean not null default false,
  system_generated boolean not null default false,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

do $$ begin
  alter table public.repair_case_events
    add constraint repair_case_events_source_chk check (source in
      ('dsp','shop_link','email','phone','system','driver'));
exception when duplicate_object then null; end $$;

create index if not exists repair_case_events_case_idx
  on public.repair_case_events (repair_case_id, created_at desc);

alter table public.repair_case_events enable row level security;
drop policy if exists "repair_case_events_tenant_select" on public.repair_case_events;
create policy "repair_case_events_tenant_select"
  on public.repair_case_events for select to authenticated
  using (dsp_id = private.current_dsp_id());
drop policy if exists "repair_case_events_staff_insert" on public.repair_case_events;
create policy "repair_case_events_staff_insert"
  on public.repair_case_events for insert to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));
-- Timeline rows are append-only from the client's perspective: no
-- update/delete policies (corrections are new events).
grant select, insert on public.repair_case_events to authenticated;


-- ═══════════════════════════ 5. repair_case_attachments ═════════════
-- Evidence: damage photos, estimates, invoices, driver statements.
-- Files live in the private repair-attachments bucket under
-- <dsp_id>/<case_id>/<filename>; rows are the index over them.

insert into storage.buckets (id, name, public, file_size_limit)
values ('repair-attachments', 'repair-attachments', false, 104857600)
on conflict (id) do nothing;

create table if not exists public.repair_case_attachments (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  repair_case_id  uuid not null references public.repair_cases(id) on delete cascade,
  storage_bucket  text not null default 'repair-attachments',
  storage_path    text not null,
  file_name       text not null,
  mime_type       text,
  byte_size       bigint,
  attachment_type text not null default 'other',
  source          text not null default 'dsp',
  shop_visible    boolean not null default false,
  uploaded_by     uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

do $$ begin
  alter table public.repair_case_attachments
    add constraint repair_case_attachments_type_chk check (attachment_type in
      ('damage_photo','inspection_photo','video','driver_statement',
       'diagnostic_report','estimate','revised_estimate','work_order',
       'repair_order','invoice','receipt','warranty','authorization',
       'parts_document','completion_photo','other'));
exception when duplicate_object then null; end $$;

create index if not exists repair_case_attachments_case_idx
  on public.repair_case_attachments (repair_case_id, created_at desc);

alter table public.repair_case_attachments enable row level security;
drop policy if exists "repair_case_attachments_tenant_select" on public.repair_case_attachments;
create policy "repair_case_attachments_tenant_select"
  on public.repair_case_attachments for select to authenticated
  using (dsp_id = private.current_dsp_id());
drop policy if exists "repair_case_attachments_staff_insert" on public.repair_case_attachments;
create policy "repair_case_attachments_staff_insert"
  on public.repair_case_attachments for insert to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));
drop policy if exists "repair_case_attachments_staff_delete" on public.repair_case_attachments;
create policy "repair_case_attachments_staff_delete"
  on public.repair_case_attachments for delete to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));
grant select, insert, delete on public.repair_case_attachments to authenticated;

-- Storage policies: tenant-prefixed reads/writes for staff via the
-- dashboard client (path <dsp_id>/...); shop-side uploads in later
-- phases go through a service-role edge function, which bypasses RLS.
drop policy if exists "repair_attachments_staff_read" on storage.objects;
create policy "repair_attachments_staff_read"
  on storage.objects for select to authenticated
  using (bucket_id = 'repair-attachments'
         and (storage.foldername(name))[1]::uuid = private.current_dsp_id());
drop policy if exists "repair_attachments_staff_write" on storage.objects;
create policy "repair_attachments_staff_write"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'repair-attachments'
              and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
              and private.is_staff(private.current_dsp_id(), 'dispatcher'));
drop policy if exists "repair_attachments_staff_delete" on storage.objects;
create policy "repair_attachments_staff_delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'repair-attachments'
         and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
         and private.is_staff(private.current_dsp_id(), 'dispatcher'));


-- ═══════════════════════════ 6. repair_shop_visits ══════════════════
-- One row per physical stay at a shop (a case can have several — e.g.
-- a comeback).  Phase 2 records the basics; the In-Shop Tracker phase
-- fills the rest.  Work-order identity lives here AND mirrors into the
-- linked repair_orders row so the compliance clocks keep ticking.

create table if not exists public.repair_shop_visits (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  repair_case_id  uuid not null references public.repair_cases(id) on delete cascade,
  vendor_id       uuid references public.vendors(id) on delete set null,
  repair_order_id uuid references public.repair_orders(id) on delete set null,

  shop_status     text not null default 'awaiting_dropoff',
  appointment_at  timestamptz,
  dropped_off_at  timestamptz,
  checked_in_at   timestamptz,
  diagnosis_expected_at timestamptz,
  diagnosis_received_at timestamptz,
  repair_started_at     timestamptz,
  promised_completion_at timestamptz,
  revised_completion_at  timestamptz,
  completed_at          timestamptz,
  ready_for_pickup_at   timestamptz,
  picked_up_at          timestamptz,

  shop_work_order_number  text,
  shop_repair_order_number text,
  service_advisor  text,
  tow_provider     text,
  tow_reference    text,
  current_delay_reason text,
  notes            text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

do $$ begin
  alter table public.repair_shop_visits
    add constraint repair_shop_visits_status_chk check (shop_status in
      ('awaiting_dropoff','checked_in','diagnosing','awaiting_authorization',
       'parts_hold','in_repair','delayed','ready','picked_up'));
exception when duplicate_object then null; end $$;

create index if not exists repair_shop_visits_case_idx
  on public.repair_shop_visits (repair_case_id, created_at desc);
create index if not exists repair_shop_visits_open_idx
  on public.repair_shop_visits (dsp_id)
  where picked_up_at is null;

alter table public.repair_shop_visits enable row level security;
drop policy if exists "repair_shop_visits_tenant_select" on public.repair_shop_visits;
create policy "repair_shop_visits_tenant_select"
  on public.repair_shop_visits for select to authenticated
  using (dsp_id = private.current_dsp_id());
drop policy if exists "repair_shop_visits_staff_insert" on public.repair_shop_visits;
create policy "repair_shop_visits_staff_insert"
  on public.repair_shop_visits for insert to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));
drop policy if exists "repair_shop_visits_staff_update" on public.repair_shop_visits;
create policy "repair_shop_visits_staff_update"
  on public.repair_shop_visits for update to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));
drop policy if exists "repair_shop_visits_staff_delete" on public.repair_shop_visits;
create policy "repair_shop_visits_staff_delete"
  on public.repair_shop_visits for delete to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));
grant select, insert, update, delete on public.repair_shop_visits to authenticated;


-- ═══════════════════════════ 7. vehicle_issues bridge ═══════════════

alter table public.vehicle_issues
  add column if not exists repair_case_id uuid references public.repair_cases(id) on delete set null;


-- ═══════════════════════════ 8. Helpers ═════════════════════════════

-- Case-number generator · 'RC-2026-0001', per DSP per year (twin of
-- _next_ro_code from 0228).
create or replace function public._next_repair_case_number(p_dsp_id uuid)
returns text
language sql
stable
as $$
  select 'RC-' || to_char(now(),'YYYY') || '-' ||
         lpad(((coalesce(max(substring(case_number from '\d+$')::int), 0)) + 1)::text, 4, '0')
  from public.repair_cases
  where dsp_id = p_dsp_id
    and case_number like 'RC-' || to_char(now(),'YYYY') || '-%';
$$;

-- Allowed stage transitions.  Mirrored in
-- dashboard/repair/repair-engine.js (STAGE_TRANSITIONS) — keep in sync;
-- scripts/test-repair-engine.mjs pins the JS copy with fixtures.
create or replace function public._repair_stage_next_allowed(p_from text)
returns text[]
language sql
immutable
as $$
  select case p_from
    when 'reported'          then array['review','quoting','scheduled','at_shop','cancelled']
    when 'review'            then array['reported','quoting','scheduled','at_shop','cancelled']
    when 'quoting'           then array['quotes_in','awaiting_approval','cancelled']
    when 'quotes_in'         then array['quoting','awaiting_approval','cancelled']
    when 'awaiting_approval' then array['approved','quoting','cancelled']
    when 'approved'          then array['scheduled','at_shop','quoting','cancelled']
    when 'scheduled'         then array['at_shop','approved','cancelled']
    when 'at_shop'           then array['ready_for_pickup','cancelled']
    when 'ready_for_pickup'  then array['quality_check','at_shop']
    when 'quality_check'     then array['returned','at_shop']
    when 'returned'          then array['closed']
    else array[]::text[]      -- closed / cancelled are terminal
  end;
$$;

-- Availability implied by a stage move (null = leave unchanged).
create or replace function public._repair_stage_availability(p_stage text)
returns text
language sql
immutable
as $$
  select case p_stage
    when 'at_shop'          then 'at_shop'
    when 'ready_for_pickup' then 'ready_for_pickup'
    when 'quality_check'    then 'ready_for_pickup'
    when 'returned'         then 'returned'
    when 'closed'           then 'returned'
    else null
  end;
$$;

-- Internal event writer (used by every RPC below; not granted).
create or replace function private.repair_case_event(
  p_dsp uuid, p_case uuid, p_kind text, p_message text,
  p_prev text default null, p_new text default null,
  p_source text default 'dsp', p_visible_to_shop boolean default false,
  p_system boolean default false, p_payload jsonb default '{}'::jsonb
) returns void
language sql
security definer set search_path = ''
as $$
  insert into public.repair_case_events
    (dsp_id, repair_case_id, kind, message, previous_value, new_value,
     source, actor_id, visible_to_shop, system_generated, payload)
  values (p_dsp, p_case, p_kind, p_message, p_prev, p_new,
          p_source, auth.uid(), p_visible_to_shop, p_system, coalesce(p_payload, '{}'::jsonb));
$$;


-- ═══════════════════════════ 9. RPCs ════════════════════════════════

-- ── repair_case_create ───────────────────────────────────────────────
-- Creates a case (+ optional grounding through the sanctioned Fleet
-- path, + optional link to an existing vehicle_issue).
create or replace function public.repair_case_create(
  p_vehicle_id   uuid,
  p_title        text,
  p_description  text default null,
  p_category     text default 'mechanical',
  p_component    text default null,
  p_severity     text default 'medium',
  p_urgency      text default 'normal',
  p_safety_status text default null,
  p_drivable     boolean default null,
  p_ground       boolean default false,
  p_ground_category text default 'other',
  p_limitation_note text default null,
  p_towing_required boolean default false,
  p_mobile_repair_preferred boolean default false,
  p_odometer     int default null,
  p_current_location text default null,
  p_required_completion_at timestamptz default null,
  p_driver_id    uuid default null,
  p_reported_via text default 'manual',
  p_source_type  text default 'manual',
  p_source_id    uuid default null,
  p_vehicle_issue_id uuid default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_vehicle public.vehicles;
  v_case public.repair_cases;
  v_availability text := 'in_service';
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(btrim(p_title), '') = '' then
    raise exception 'title_required' using errcode = '22023';
  end if;

  select * into v_vehicle
    from public.vehicles
   where id = p_vehicle_id and dsp_id = v_dsp and archived_at is null;
  if not found then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;

  if p_ground or v_vehicle.operational_status = 'grounded' then
    v_availability := 'grounded';
  elsif coalesce(p_safety_status,'') = 'limited' or p_limitation_note is not null then
    v_availability := 'limited';
  end if;

  insert into public.repair_cases
    (dsp_id, vehicle_id, station_id, case_number, title, description,
     category, component, severity, urgency, stage, availability,
     safety_status, drivable, towing_required, mobile_repair_preferred,
     limitation_note, odometer, current_location,
     required_completion_at, driver_id, reported_via, reported_by,
     source_type, source_id, created_by)
  values
    (v_dsp, p_vehicle_id, v_vehicle.station_id,
     public._next_repair_case_number(v_dsp),
     btrim(p_title), nullif(btrim(coalesce(p_description,'')), ''),
     coalesce(nullif(p_category,''), 'mechanical'), nullif(btrim(coalesce(p_component,'')), ''),
     coalesce(nullif(p_severity,''), 'medium'), coalesce(nullif(p_urgency,''), 'normal'),
     'reported', v_availability,
     p_safety_status, p_drivable, coalesce(p_towing_required,false),
     coalesce(p_mobile_repair_preferred,false),
     nullif(btrim(coalesce(p_limitation_note,'')), ''),
     p_odometer, nullif(btrim(coalesce(p_current_location,'')), ''),
     p_required_completion_at, p_driver_id,
     coalesce(nullif(p_reported_via,''), 'manual'), auth.uid(),
     coalesce(nullif(p_source_type,''), 'manual'), p_source_id, auth.uid())
  returning * into v_case;

  perform private.repair_case_event(
    v_dsp, v_case.id, 'created',
    'Case created · ' || v_case.case_number,
    null, v_case.stage, 'dsp', false, false,
    jsonb_build_object('vehicle_id', p_vehicle_id));

  -- Bundle the initial defect as a case issue
  insert into public.repair_case_issues
    (dsp_id, repair_case_id, vehicle_issue_id, component, description,
     severity, safety_critical)
  values
    (v_dsp, v_case.id, p_vehicle_issue_id,
     nullif(btrim(coalesce(p_component,'')), ''),
     coalesce(nullif(btrim(coalesce(p_description,'')), ''), btrim(p_title)),
     coalesce(nullif(p_severity,''), 'medium'),
     coalesce(p_safety_status,'') = 'unsafe');

  -- Link an originating driver-reported issue
  if p_vehicle_issue_id is not null then
    update public.vehicle_issues
       set repair_case_id = v_case.id, updated_at = now()
     where id = p_vehicle_issue_id and dsp_id = v_dsp;
  end if;

  -- Ground through the sanctioned path (writes the grounding event,
  -- audit row, and keeps FEM/VORR math intact).
  if p_ground and v_vehicle.operational_status is distinct from 'grounded' then
    perform public.vehicle_set_operational_status(
      p_vehicle_id, 'grounded',
      coalesce(nullif(btrim(coalesce(p_description,'')), ''), btrim(p_title)),
      coalesce(nullif(p_ground_category,''), 'other'));
    perform private.repair_case_event(
      v_dsp, v_case.id, 'grounded',
      'Vehicle grounded — ' || coalesce(nullif(btrim(coalesce(p_limitation_note,'')),''), btrim(p_title)),
      'operational', 'grounded', 'dsp', false, false, '{}'::jsonb);
  end if;

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, object_type, object_id)
  values
    (v_dsp, 'user', auth.uid(), 'repair_case_created',
     v_case.case_number || ' · ' || v_case.title
       || ' — ' || coalesce(v_vehicle.nickname, v_vehicle.name, 'vehicle'),
     'repair_case', v_case.id);

  return public.repair_case_get(v_case.id);
end;
$$;

-- ── repair_case_set_stage ────────────────────────────────────────────
create or replace function public.repair_case_set_stage(
  p_id    uuid,
  p_stage text,
  p_note  text default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_case public.repair_cases;
  v_avail text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_case from public.repair_cases
   where id = p_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;

  if p_stage = v_case.stage then
    return public.repair_case_get(p_id);
  end if;
  if not (p_stage = any (public._repair_stage_next_allowed(v_case.stage))) then
    raise exception 'invalid_stage_transition: % -> %', v_case.stage, p_stage
      using errcode = '22023';
  end if;

  v_avail := public._repair_stage_availability(p_stage);

  update public.repair_cases set
    stage = p_stage,
    availability = coalesce(v_avail, availability),
    closed_at    = case when p_stage = 'closed'    then now() else closed_at end,
    cancelled_at = case when p_stage = 'cancelled' then now() else cancelled_at end,
    actual_return_to_service_at =
      case when p_stage = 'returned' and actual_return_to_service_at is null
           then now() else actual_return_to_service_at end,
    updated_at = now()
  where id = p_id;

  perform private.repair_case_event(
    v_dsp, p_id, 'stage_changed',
    coalesce(nullif(btrim(coalesce(p_note,'')), ''), 'Stage changed'),
    v_case.stage, p_stage, 'dsp', false, false, '{}'::jsonb);

  return public.repair_case_get(p_id);
end;
$$;

-- ── repair_case_update ───────────────────────────────────────────────
-- Whitelisted patch of editable fields.  Stage/availability changes go
-- through their dedicated RPCs.
create or replace function public.repair_case_update(
  p_id    uuid,
  p_patch jsonb
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_case public.repair_cases;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_case from public.repair_cases
   where id = p_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;

  update public.repair_cases set
    title       = coalesce(nullif(btrim(coalesce(p_patch->>'title','')), ''), title),
    description = case when p_patch ? 'description' then nullif(btrim(coalesce(p_patch->>'description','')),'') else description end,
    category    = coalesce(nullif(p_patch->>'category',''), category),
    component   = case when p_patch ? 'component' then nullif(btrim(coalesce(p_patch->>'component','')),'') else component end,
    severity    = coalesce(nullif(p_patch->>'severity',''), severity),
    urgency     = coalesce(nullif(p_patch->>'urgency',''), urgency),
    safety_status = case when p_patch ? 'safety_status' then nullif(p_patch->>'safety_status','') else safety_status end,
    drivable    = case when p_patch ? 'drivable' then (p_patch->>'drivable')::boolean else drivable end,
    towing_required = case when p_patch ? 'towing_required' then (p_patch->>'towing_required')::boolean else towing_required end,
    mobile_repair_preferred = case when p_patch ? 'mobile_repair_preferred' then (p_patch->>'mobile_repair_preferred')::boolean else mobile_repair_preferred end,
    limitation_note = case when p_patch ? 'limitation_note' then nullif(btrim(coalesce(p_patch->>'limitation_note','')),'') else limitation_note end,
    current_location = case when p_patch ? 'current_location' then nullif(btrim(coalesce(p_patch->>'current_location','')),'') else current_location end,
    odometer    = case when p_patch ? 'odometer' then nullif(p_patch->>'odometer','')::int else odometer end,
    assigned_to = case when p_patch ? 'assigned_to' then nullif(p_patch->>'assigned_to','')::uuid else assigned_to end,
    vendor_id   = case when p_patch ? 'vendor_id' then nullif(p_patch->>'vendor_id','')::uuid else vendor_id end,
    replacement_vehicle_id = case when p_patch ? 'replacement_vehicle_id' then nullif(p_patch->>'replacement_vehicle_id','')::uuid else replacement_vehicle_id end,
    required_completion_at = case when p_patch ? 'required_completion_at' then nullif(p_patch->>'required_completion_at','')::timestamptz else required_completion_at end,
    estimated_return_to_service_at = case when p_patch ? 'estimated_return_to_service_at' then nullif(p_patch->>'estimated_return_to_service_at','')::timestamptz else estimated_return_to_service_at end,
    updated_at  = now()
  where id = p_id;

  perform private.repair_case_event(
    v_dsp, p_id, 'updated', 'Case details updated',
    null, null, 'dsp', false, false, '{}'::jsonb);

  return public.repair_case_get(p_id);
end;
$$;

-- ── repair_case_log_event ────────────────────────────────────────────
-- Manual timeline entries: phone updates from a shop, notes, etc.
create or replace function public.repair_case_log_event(
  p_case_id uuid,
  p_kind    text default 'note',
  p_message text default null,
  p_source  text default 'dsp',
  p_visible_to_shop boolean default false
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.repair_cases where id = p_case_id and dsp_id = v_dsp) then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if coalesce(btrim(p_message), '') = '' then
    raise exception 'message_required' using errcode = '22023';
  end if;
  if p_source not in ('dsp','phone','email','system','driver','shop_link') then
    raise exception 'bad_source' using errcode = '22023';
  end if;

  perform private.repair_case_event(
    v_dsp, p_case_id, coalesce(nullif(p_kind,''),'note'), btrim(p_message),
    null, null, p_source, coalesce(p_visible_to_shop,false), false, '{}'::jsonb);

  update public.repair_cases set updated_at = now() where id = p_case_id;
  return public.repair_case_get(p_case_id);
end;
$$;

-- ── repair_case_attachment_add ───────────────────────────────────────
-- Records an already-uploaded file (client uploads to
-- repair-attachments/<dsp_id>/<case_id>/<name> first, storage RLS
-- enforces the prefix, then registers it here).
create or replace function public.repair_case_attachment_add(
  p_case_id      uuid,
  p_storage_path text,
  p_file_name    text,
  p_mime_type    text default null,
  p_byte_size    bigint default null,
  p_attachment_type text default 'other',
  p_shop_visible boolean default false
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.repair_case_attachments;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.repair_cases where id = p_case_id and dsp_id = v_dsp) then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  -- The object must live under this tenant's + case's prefix.
  if p_storage_path not like v_dsp::text || '/' || p_case_id::text || '/%' then
    raise exception 'bad_storage_path' using errcode = '22023';
  end if;

  insert into public.repair_case_attachments
    (dsp_id, repair_case_id, storage_path, file_name, mime_type,
     byte_size, attachment_type, shop_visible, uploaded_by)
  values
    (v_dsp, p_case_id, p_storage_path, btrim(p_file_name), p_mime_type,
     p_byte_size, coalesce(nullif(p_attachment_type,''),'other'),
     coalesce(p_shop_visible,false), auth.uid())
  returning * into v_row;

  perform private.repair_case_event(
    v_dsp, p_case_id, 'attachment_added',
    'Attachment added · ' || btrim(p_file_name),
    null, null, 'dsp', coalesce(p_shop_visible,false), false,
    jsonb_build_object('attachment_id', v_row.id));

  update public.repair_cases set updated_at = now() where id = p_case_id;
  return jsonb_build_object('id', v_row.id, 'storage_path', v_row.storage_path);
end;
$$;

-- ── repair_case_link_ro ──────────────────────────────────────────────
-- Find-or-create the repair_orders row for a case so the existing
-- compliance clocks and roster column light up.  Mirrors the vendor
-- and shop WO code both ways.
create or replace function public.repair_case_link_ro(
  p_case_id   uuid,
  p_vendor_id uuid default null,
  p_ro_code   text default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_case public.repair_cases;
  v_ro public.repair_orders;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_case from public.repair_cases
   where id = p_case_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;

  if v_case.repair_order_id is not null then
    select * into v_ro from public.repair_orders where id = v_case.repair_order_id;
  end if;

  if v_ro.id is null then
    -- Reuse the vehicle's open RO if one exists (e.g. created from the
    -- roster's quick RO-code box) rather than opening a duplicate.
    select * into v_ro from public.repair_orders
     where vehicle_id = v_case.vehicle_id and dsp_id = v_dsp
       and status not in ('completed','cancelled')
     order by opened_at desc limit 1;
  end if;

  if v_ro.id is null then
    insert into public.repair_orders
      (dsp_id, vehicle_id, vendor_id, code, summary, status, opened_at, created_by)
    values
      (v_dsp, v_case.vehicle_id, coalesce(p_vendor_id, v_case.vendor_id),
       coalesce(nullif(btrim(coalesce(p_ro_code,'')),''), public._next_ro_code(v_dsp)),
       v_case.case_number || ' · ' || v_case.title,
       'draft', now(), auth.uid())
    returning * into v_ro;
  else
    update public.repair_orders set
      vendor_id  = coalesce(p_vendor_id, v_case.vendor_id, vendor_id),
      code       = coalesce(nullif(btrim(coalesce(p_ro_code,'')),''), code),
      updated_at = now()
    where id = v_ro.id
    returning * into v_ro;
  end if;

  update public.repair_cases set
    repair_order_id = v_ro.id,
    vendor_id  = coalesce(v_case.vendor_id, v_ro.vendor_id),
    updated_at = now()
  where id = p_case_id;

  perform private.repair_case_event(
    v_dsp, p_case_id, 'ro_linked',
    'Repair order linked · ' || coalesce(v_ro.code, 'no code'),
    null, v_ro.code, 'dsp', false, false,
    jsonb_build_object('repair_order_id', v_ro.id));

  return public.repair_case_get(p_case_id);
end;
$$;

-- ── repair_case_return_to_service ────────────────────────────────────
-- The explicit return-to-service action: stage → returned, restore the
-- vehicle through the sanctioned path, record mileage, close out.
create or replace function public.repair_case_return_to_service(
  p_id       uuid,
  p_odometer int default null,
  p_note     text default null,
  p_close    boolean default true
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_case public.repair_cases;
  v_vehicle public.vehicles;
  v_other_open int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_case from public.repair_cases
   where id = p_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if v_case.stage in ('closed','cancelled') then
    raise exception 'case_already_closed' using errcode = '22023';
  end if;

  select * into v_vehicle from public.vehicles
   where id = v_case.vehicle_id and dsp_id = v_dsp;

  update public.repair_cases set
    stage = 'returned',
    availability = 'returned',
    actual_return_to_service_at = coalesce(actual_return_to_service_at, now()),
    odometer = coalesce(p_odometer, odometer),
    updated_at = now()
  where id = p_id;

  perform private.repair_case_event(
    v_dsp, p_id, 'returned_to_service',
    coalesce(nullif(btrim(coalesce(p_note,'')),''), 'Vehicle returned to service'),
    v_case.stage, 'returned', 'dsp', false, false,
    jsonb_build_object('odometer', p_odometer));

  -- Record the mileage reading through the existing log (bumps
  -- vehicles.mileage when higher).
  if p_odometer is not null then
    begin
      perform public.vehicle_mileage_log_save(v_case.vehicle_id, p_odometer, now(), 'service');
    exception when others then null; -- best-effort; older envs may lack the RPC
    end;
  end if;

  -- Unground through the sanctioned path — but only when no OTHER open
  -- case still grounds this vehicle.
  if v_vehicle.operational_status = 'grounded' then
    select count(*)::int into v_other_open
      from public.repair_cases
     where dsp_id = v_dsp and vehicle_id = v_case.vehicle_id
       and id <> p_id
       and stage not in ('returned','closed','cancelled')
       and availability = 'grounded';
    if v_other_open = 0 then
      perform public.vehicle_set_operational_status(
        v_case.vehicle_id, 'operational',
        'Repair complete · ' || v_case.case_number, null);
      perform private.repair_case_event(
        v_dsp, p_id, 'ungrounded', 'Vehicle restored to operational',
        'grounded', 'operational', 'dsp', false, false, '{}'::jsonb);
    end if;
  end if;

  if coalesce(p_close, true) then
    update public.repair_cases set stage = 'closed', closed_at = now(), updated_at = now()
     where id = p_id;
    perform private.repair_case_event(
      v_dsp, p_id, 'stage_changed', 'Case closed',
      'returned', 'closed', 'dsp', false, false, '{}'::jsonb);
    -- Close any linked issues + complete the linked RO
    update public.vehicle_issues
       set status = 'completed', resolved_at = coalesce(resolved_at, now()), updated_at = now()
     where repair_case_id = p_id and dsp_id = v_dsp and status <> 'completed';
    if v_case.repair_order_id is not null then
      update public.repair_orders
         set status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now()
       where id = v_case.repair_order_id and status not in ('completed','cancelled');
    end if;
  end if;

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, object_type, object_id)
  values
    (v_dsp, 'user', auth.uid(), 'repair_case_returned',
     v_case.case_number || ' returned to service', 'repair_case', p_id);

  return public.repair_case_get(p_id);
end;
$$;

-- ── repair_case_from_issue ───────────────────────────────────────────
-- Convert a Fleet → Issues row (driver report, DVIC finding) into a
-- repair case, preserving source linkage — no evidence duplication.
create or replace function public.repair_case_from_issue(
  p_issue_id uuid,
  p_ground   boolean default false
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_issue public.vehicle_issues;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_issue from public.vehicle_issues
   where id = p_issue_id and dsp_id = v_dsp;
  if not found then
    raise exception 'issue_not_found' using errcode = 'P0002';
  end if;
  if v_issue.repair_case_id is not null then
    return public.repair_case_get(v_issue.repair_case_id);
  end if;

  return public.repair_case_create(
    p_vehicle_id       => v_issue.vehicle_id,
    p_title            => v_issue.title,
    p_description      => v_issue.description,
    p_category         => coalesce(v_issue.category, 'mechanical'),
    p_severity         => coalesce(v_issue.severity, 'medium'),
    p_ground           => p_ground,
    p_reported_via     => coalesce(v_issue.source, 'issue'),
    p_source_type      => 'vehicle_issue',
    p_source_id        => v_issue.id,
    p_vehicle_issue_id => v_issue.id);
end;
$$;

-- ── repair_cases_list ────────────────────────────────────────────────
-- The Repair Queue.  Joined with vehicle / station / vendor / RO / the
-- open shop visit; filters are optional.
create or replace function public.repair_cases_list(
  p_open_only  boolean default true,
  p_stage      text default null,
  p_station_id uuid default null,
  p_vendor_id  uuid default null,
  p_vehicle_id uuid default null,
  p_grounded_only boolean default false,
  p_search     text default null
) returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(c order by
           case when c->>'stage' in ('closed','cancelled') then 1 else 0 end,
           c->>'reported_at' desc), '[]'::jsonb)
  from (
    -- Postgres caps calls at 100 arguments (50 jsonb_build_object
    -- pairs) — build the row as concatenated chunks and keep each
    -- chunk comfortably under the cap as later phases add fields.
    select jsonb_build_object(
      'id',              rc.id,
      'case_number',     rc.case_number,
      'title',           rc.title,
      'description',     rc.description,
      'category',        rc.category,
      'component',       rc.component,
      'severity',        rc.severity,
      'urgency',         rc.urgency,
      'stage',           rc.stage,
      'availability',    rc.availability,
      'safety_status',   rc.safety_status,
      'drivable',        rc.drivable,
      'towing_required', rc.towing_required,
      'limitation_note', rc.limitation_note,
      'reported_at',     rc.reported_at,
      'reported_via',    rc.reported_via,
      'required_completion_at', rc.required_completion_at,
      'estimated_return_to_service_at', rc.estimated_return_to_service_at,
      'actual_return_to_service_at',    rc.actual_return_to_service_at,
      'approved_total_cents', rc.approved_total_cents,
      'estimate_total_cents', rc.estimate_total_cents,
      'invoice_total_cents',  rc.invoice_total_cents,
      'updated_at',      rc.updated_at,
      'closed_at',       rc.closed_at,
      'assigned_to',     rc.assigned_to,
      'assigned_to_name', au.full_name
    ) || jsonb_build_object(
      'vehicle_id',      rc.vehicle_id,
      'vehicle_name',    vh.name,
      'vehicle_nickname',vh.nickname,
      'vehicle_year',    vh.year,
      'vehicle_make',    vh.make,
      'vehicle_model',   vh.model,
      'vehicle_vin',     vh.vin,
      'vehicle_plate',   vh.plate,
      'operational_status', vh.operational_status,
      'grounded_since',  ge.grounded_at,
      'station_id',      rc.station_id,
      'station_code',    st.code,
      'vendor_id',       rc.vendor_id,
      'vendor_name',     vn.name,
      'repair_order_id', rc.repair_order_id,
      'ro_code',         ro.code,
      'ro_status',       ro.status
    ) || jsonb_build_object(
      'visit_id',        sv.id,
      'shop_status',     sv.shop_status,
      'appointment_at',  sv.appointment_at,
      'dropped_off_at',  sv.dropped_off_at,
      'promised_completion_at', sv.promised_completion_at,
      'revised_completion_at',  sv.revised_completion_at,
      'ready_for_pickup_at',    sv.ready_for_pickup_at,
      'shop_work_order_number', sv.shop_work_order_number,
      'current_delay_reason',   sv.current_delay_reason
    ) c
    from public.repair_cases rc
    join public.vehicles vh on vh.id = rc.vehicle_id
    left join public.stations st on st.id = rc.station_id
    left join public.vendors  vn on vn.id = rc.vendor_id
    left join public.repair_orders ro on ro.id = rc.repair_order_id
    left join public.app_users au on au.id = rc.assigned_to
    left join lateral (
      select grounded_at from public.vehicle_grounding_events
      where vehicle_id = rc.vehicle_id and ungrounded_at is null
      order by grounded_at desc limit 1
    ) ge on true
    left join lateral (
      select * from public.repair_shop_visits
      where repair_case_id = rc.id and picked_up_at is null
      order by created_at desc limit 1
    ) sv on true
    where rc.dsp_id = private.current_dsp_id()
      and private.is_staff(rc.dsp_id, 'dispatcher')
      and rc.archived_at is null
      and (not coalesce(p_open_only, true) or rc.stage not in ('closed','cancelled'))
      and (p_stage      is null or rc.stage = p_stage)
      and (p_station_id is null or rc.station_id = p_station_id)
      and (p_vendor_id  is null or rc.vendor_id = p_vendor_id)
      and (p_vehicle_id is null or rc.vehicle_id = p_vehicle_id)
      and (not coalesce(p_grounded_only, false) or rc.availability = 'grounded'
           or vh.operational_status = 'grounded')
      and (coalesce(btrim(p_search), '') = ''
           or rc.case_number ilike '%' || btrim(p_search) || '%'
           or rc.title       ilike '%' || btrim(p_search) || '%'
           or vh.name        ilike '%' || btrim(p_search) || '%'
           or vh.nickname    ilike '%' || btrim(p_search) || '%'
           or vh.vin         ilike '%' || btrim(p_search) || '%'
           or vh.plate       ilike '%' || btrim(p_search) || '%')
  ) t;
$$;
grant execute on function public.repair_cases_list(boolean, text, uuid, uuid, uuid, boolean, text) to authenticated;

-- ── repair_case_get ──────────────────────────────────────────────────
create or replace function public.repair_case_get(p_id uuid)
returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  -- Built as concatenated chunks — Postgres caps any call at 100
  -- arguments (50 pairs); keep each chunk small as fields accrue.
  select jsonb_build_object(
    'id',              rc.id,
    'case_number',     rc.case_number,
    'title',           rc.title,
    'description',     rc.description,
    'category',        rc.category,
    'component',       rc.component,
    'severity',        rc.severity,
    'urgency',         rc.urgency,
    'stage',           rc.stage,
    'availability',    rc.availability,
    'safety_status',   rc.safety_status,
    'drivable',        rc.drivable,
    'towing_required', rc.towing_required,
    'mobile_repair_preferred', rc.mobile_repair_preferred,
    'limitation_note', rc.limitation_note,
    'route_impact',    rc.route_impact,
    'replacement_vehicle_id', rc.replacement_vehicle_id,
    'discovered_at',   rc.discovered_at,
    'reported_at',     rc.reported_at,
    'reported_via',    rc.reported_via,
    'driver_id',       rc.driver_id,
    'assigned_to',     rc.assigned_to,
    'current_location',rc.current_location,
    'odometer',        rc.odometer
  ) || jsonb_build_object(
    'required_completion_at', rc.required_completion_at,
    'requested_return_to_service_at', rc.requested_return_to_service_at,
    'estimated_return_to_service_at', rc.estimated_return_to_service_at,
    'actual_return_to_service_at',    rc.actual_return_to_service_at,
    'source_type',     rc.source_type,
    'source_id',       rc.source_id,
    'approved_total_cents', rc.approved_total_cents,
    'estimate_total_cents', rc.estimate_total_cents,
    'invoice_total_cents',  rc.invoice_total_cents,
    'created_at',      rc.created_at,
    'updated_at',      rc.updated_at,
    'closed_at',       rc.closed_at,
    'cancelled_at',    rc.cancelled_at
  ) || jsonb_build_object(
    'vehicle', jsonb_build_object(
      'id', vh.id, 'name', vh.name, 'nickname', vh.nickname,
      'year', vh.year, 'make', vh.make, 'model', vh.model,
      'vin', vh.vin, 'plate', vh.plate, 'mileage', vh.mileage,
      'operational_status', vh.operational_status,
      'station_code', st.code),
    'grounded_since',  ge.grounded_at,
    'vendor', case when vn.id is null then null else jsonb_build_object(
      'id', vn.id, 'name', vn.name, 'kind', vn.kind,
      'contact_name', vn.contact_name, 'contact_phone', vn.contact_phone,
      'contact_email', vn.contact_email, 'preferred_status', vn.preferred_status) end,
    'ro', case when ro.id is null then null else jsonb_build_object(
      'id', ro.id, 'code', ro.code, 'status', ro.status,
      'opened_at', ro.opened_at, 'scheduled_at', ro.scheduled_at,
      'eta_at', ro.eta_at, 'completed_at', ro.completed_at) end,
    'visit', case when sv.id is null then null else jsonb_build_object(
      'id', sv.id, 'shop_status', sv.shop_status,
      'appointment_at', sv.appointment_at, 'dropped_off_at', sv.dropped_off_at,
      'promised_completion_at', sv.promised_completion_at,
      'revised_completion_at', sv.revised_completion_at,
      'ready_for_pickup_at', sv.ready_for_pickup_at,
      'shop_work_order_number', sv.shop_work_order_number,
      'service_advisor', sv.service_advisor,
      'current_delay_reason', sv.current_delay_reason) end,
    'issues', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ci.id, 'component', ci.component, 'description', ci.description,
        'severity', ci.severity, 'safety_critical', ci.safety_critical,
        'diagnosis', ci.diagnosis, 'resolution', ci.resolution,
        'status', ci.status, 'vehicle_issue_id', ci.vehicle_issue_id)
        order by ci.created_at)
      from public.repair_case_issues ci
      where ci.repair_case_id = rc.id), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'storage_bucket', a.storage_bucket,
        'storage_path', a.storage_path, 'file_name', a.file_name,
        'mime_type', a.mime_type, 'byte_size', a.byte_size,
        'attachment_type', a.attachment_type, 'shop_visible', a.shop_visible,
        'created_at', a.created_at)
        order by a.created_at desc)
      from public.repair_case_attachments a
      where a.repair_case_id = rc.id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'kind', e.kind, 'message', e.message,
        'previous_value', e.previous_value, 'new_value', e.new_value,
        'source', e.source, 'actor_id', e.actor_id,
        'actor_name', coalesce(e.actor_label, eu.full_name),
        'visible_to_shop', e.visible_to_shop,
        'system_generated', e.system_generated,
        'created_at', e.created_at)
        order by e.created_at desc)
      from public.repair_case_events e
      left join public.app_users eu on eu.id = e.actor_id
      where e.repair_case_id = rc.id), '[]'::jsonb),
    'allowed_next_stages', to_jsonb(public._repair_stage_next_allowed(rc.stage))
  )
  from public.repair_cases rc
  join public.vehicles vh on vh.id = rc.vehicle_id
  left join public.stations st on st.id = vh.station_id
  left join public.vendors  vn on vn.id = rc.vendor_id
  left join public.repair_orders ro on ro.id = rc.repair_order_id
  left join lateral (
    select grounded_at from public.vehicle_grounding_events
    where vehicle_id = rc.vehicle_id and ungrounded_at is null
    order by grounded_at desc limit 1
  ) ge on true
  left join lateral (
    select * from public.repair_shop_visits
    where repair_case_id = rc.id and picked_up_at is null
    order by created_at desc limit 1
  ) sv on true
  where rc.id = p_id
    and rc.dsp_id = private.current_dsp_id()
    and private.is_staff(rc.dsp_id, 'dispatcher');
$$;
grant execute on function public.repair_case_get(uuid) to authenticated;

-- ── repair_center_summary ────────────────────────────────────────────
-- Counts for the Overview pills.  Everything derived live; nothing
-- denormalized.
create or replace function public.repair_center_summary()
returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  with open_cases as (
    select rc.*,
           sv.promised_completion_at as v_promised,
           sv.revised_completion_at  as v_revised,
           sv.shop_status            as v_shop_status,
           sv.ready_for_pickup_at    as v_ready_at
    from public.repair_cases rc
    left join lateral (
      select * from public.repair_shop_visits
      where repair_case_id = rc.id and picked_up_at is null
      order by created_at desc limit 1
    ) sv on true
    where rc.dsp_id = private.current_dsp_id()
      and private.is_staff(rc.dsp_id, 'dispatcher')
      and rc.archived_at is null
      and rc.stage not in ('closed','cancelled')
  )
  select jsonb_build_object(
    'open_cases',        (select count(*) from open_cases),
    'grounded',          (select count(*) from open_cases where availability = 'grounded'),
    'needs_review',      (select count(*) from open_cases where stage in ('reported','review')),
    'quoting',           (select count(*) from open_cases where stage in ('quoting','quotes_in')),
    'awaiting_approval', (select count(*) from open_cases where stage = 'awaiting_approval'),
    'scheduled',         (select count(*) from open_cases where stage in ('approved','scheduled')),
    'at_shop',           (select count(*) from open_cases where stage = 'at_shop'),
    'waiting_on_parts',  (select count(*) from open_cases where v_shop_status = 'parts_hold'),
    'past_promise',      (select count(*) from open_cases
                          where stage = 'at_shop'
                            and coalesce(v_revised, v_promised) is not null
                            and coalesce(v_revised, v_promised) < now()
                            and v_ready_at is null),
    'ready_for_pickup',  (select count(*) from open_cases
                          where stage in ('ready_for_pickup','quality_check')),
    'returned_this_week',(select count(*) from public.repair_cases
                          where dsp_id = private.current_dsp_id()
                            and actual_return_to_service_at >= date_trunc('week', now())),
    'approved_total_cents', (select coalesce(sum(approved_total_cents), 0) from open_cases),
    'estimate_total_cents', (select coalesce(sum(estimate_total_cents), 0)
                             from open_cases where approved_total_cents is null),
    'grounded_oldest_at', (select min(ge.grounded_at)
                           from open_cases oc
                           join public.vehicle_grounding_events ge
                             on ge.vehicle_id = oc.vehicle_id and ge.ungrounded_at is null)
  );
$$;
grant execute on function public.repair_center_summary() to authenticated;


-- ── Grants ───────────────────────────────────────────────────────────
grant execute on function public.repair_case_create(uuid, text, text, text, text, text, text, text, boolean, boolean, text, text, boolean, boolean, int, text, timestamptz, uuid, text, text, uuid, uuid) to authenticated;
grant execute on function public.repair_case_set_stage(uuid, text, text) to authenticated;
grant execute on function public.repair_case_update(uuid, jsonb) to authenticated;
grant execute on function public.repair_case_log_event(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.repair_case_attachment_add(uuid, text, text, text, bigint, text, boolean) to authenticated;
grant execute on function public.repair_case_link_ro(uuid, uuid, text) to authenticated;
grant execute on function public.repair_case_return_to_service(uuid, int, text, boolean) to authenticated;
grant execute on function public.repair_case_from_issue(uuid, boolean) to authenticated;


-- ═══════════════════════════ 10. Realtime ═══════════════════════════

do $$ begin
  alter publication supabase_realtime add table public.repair_cases;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.repair_case_events;
exception when duplicate_object then null; end $$;


notify pgrst, 'reload schema';
