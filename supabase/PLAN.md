# RouteReady · Supabase Backend Plan

**Status:** Foundation document. Build target.
**Owner:** Engineering
**Last revised:** May 2, 2026
**Replaces:** Existing `supabase/functions/*` and `migration/*.py` scripts (treat as legacy reference; do not extend).

---

## 0. The flywheel this backend powers

```
        Hiring pipeline
           ↓ feeds
        Active drivers ←──────────────────────┐
           ↓ generate                         │
   Attendance · scoring · coaching            │
           ↓ informs                          │
   Suspensions · terminations · HR file       │
           ↓ creates                          │
        Open shifts                           │
           ↓ surface in                       │
        OKAMI demand · Schedule               │
           ↓ drives                           │
   Pipeline targets · Indeed inflow ──────────┘
```

Every screen in the mockup is a participant in this loop. The backend's job is to **maintain consistent state across the loop**, not to be a CRUD app with screens. Practically that means:

- **Single source of truth** for every entity (driver, applicant, shift, attendance event, HR record). No duplicated state across tables.
- **Deterministic computed views** for derived data (driver score, attendance status, OKAMI demand). Compute on read where possible; materialize on write only where performance forces it.
- **Event-driven cascades** for state changes that touch multiple surfaces (suspending a driver should fan out to schedule, check-in, attendance, HR file in one transaction).
- **Append-only audit log** for HR-significant events. Once a suspension is recorded, it is never modified — it is voided with reason and superseded.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Database | **Postgres 15+** via Supabase | All entities are highly relational. Postgres for ACID, JSONB for flexible config, generated columns for derived fields. |
| Auth | **Supabase Auth** | Email + magic link + phone OTP for drivers. Custom JWT claims for `dsp_id` and `role`. |
| API | **Supabase auto-generated REST + RPC** for CRUD; **Edge Functions** for integrations | Skip writing CRUD. Use functions only for Twilio/Indeed/Stripe/AI work. |
| Realtime | **Supabase Realtime** | Live check-in counts, schedule status, messages, presence. |
| Storage | **Supabase Storage** | Driver license photos, inspection photos/videos, HR file PDF exports, invoice PDFs. |
| Background jobs | **pg_cron** + **Trigger.dev** (or Inngest) | pg_cron for daily/nightly sweeps. Trigger.dev for fan-out and external webhook fan-in. |
| SMS | **Twilio Programmable Messaging** | Already mocked. TCPA-compliant from day 1. |
| Booking | **Cal.com** (self-host or hosted) | Already mocked in screening flow. |
| Payments | **Stripe** | Subscription billing + add-on services. |
| Email | **Resend** or **Postmark** | Transactional only — daily digest, alerts, password reset. |
| Search | **Postgres FTS** initially; **Meilisearch** if it stops being enough | Topbar search across drivers / applicants / vehicles. |
| Frontend hosting | **Vercel** | Static HTML mockup → Next.js migration later. |
| Backend hosting | **Supabase** | Hosted Postgres + functions + storage in one. |
| Observability | **Supabase logs + Logflare** + **Sentry** | Sentry for client errors; Supabase for SQL/function logs. |

---

## 2. Project layout

```
/supabase
  /migrations               -- Versioned SQL migrations (timestamped)
    20260510000000_init.sql
    20260510010000_drivers.sql
    20260510020000_attendance.sql
    ...
  /functions                -- Edge Functions (TypeScript, Deno runtime)
    /_shared
      cors.ts
      supabase-admin.ts
      twilio.ts
      indeed.ts
      claude.ts
    /webhook-twilio          -- Twilio inbound SMS / status callbacks
    /webhook-stripe          -- Stripe billing events
    /webhook-cal             -- Cal.com booking events
    /webhook-indeed          -- Indeed Apply Apply XML poller (cron-triggered)
    /run-daily               -- Nightly cron orchestrator
    /run-license-reminders   -- License expiry SMS sweep
    /run-score-recompute     -- Driver score nightly refresh
    /smart-drop-extract      -- AI-powered file ingestion
    /export-hr-file          -- PDF generation for personnel file
    /export-attendance-csv   -- Attendance report download
    /generate-coaching-sms   -- AI-drafted coaching message
  /seed                     -- Seed data SQL for local dev + staging
    01_dsps.sql
    02_users.sql
    03_drivers.sql
    04_applicants.sql
    05_attendance.sql
  /tests                    -- pgTAP tests for RLS + business logic
    rls/multi_tenant.sql
    business/attendance_compute.sql
  config.toml               -- Project config
  PLAN.md                   -- This file
  RLS.md                    -- RLS policy catalog (lives alongside)
  SCHEMA.md                 -- Generated from migrations; do not hand-edit
```

**Conventions:**

- Migrations are **timestamped, append-only, never edited after deploy**. Roll back with a new migration.
- One concept per migration (don't mix unrelated changes).
- Edge Functions are **single-responsibility**. One trigger source = one function.
- Shared code in `_shared/` (Supabase ignores `_`-prefixed dirs).
- All SQL types use Postgres-native types (no `varchar` — use `text`; no `numeric` without precision).

---

## 3. Auth & roles

Three principal types. **All authenticate via Supabase Auth, but JWT claims differentiate.**

| Principal | Auth method | Custom claims | Access pattern |
|---|---|---|---|
| **DSP staff** (Owner / Ops Manager / Dispatcher) | Email + magic link | `dsp_id`, `role` ∈ {owner, ops, dispatcher} | Full RLS by `dsp_id`, role-gates within DSP |
| **Driver** | Phone OTP via Twilio Verify | `dsp_id`, `role: 'driver'`, `driver_id` | Read-only on own data + write to own inspections / time-off / swap requests |
| **Applicant** | None during pipeline; phone-confirmed via SMS reply | None (anonymous via signed URL) | Submit answers via `record.html` (already exists), no dashboard access |

JWT claims are populated via a Supabase **auth hook** (`auth.send_email_hook` and `auth.send_phone_hook` on user creation), which writes the relevant claims based on the `users` row.

```sql
-- Custom claims function called by the auth hook
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb language plpgsql security definer as $$
declare
  claims jsonb;
  u record;
begin
  select dsp_id, role, driver_id into u from public.app_users where id = (event->>'user_id')::uuid;
  claims := event->'claims';
  claims := jsonb_set(claims, '{dsp_id}', to_jsonb(u.dsp_id));
  claims := jsonb_set(claims, '{role}', to_jsonb(u.role));
  if u.driver_id is not null then
    claims := jsonb_set(claims, '{driver_id}', to_jsonb(u.driver_id));
  end if;
  return jsonb_set(event, '{claims}', claims);
end $$;
```

In RLS, read claims via `auth.jwt() ->> 'dsp_id'` etc.

**Magic link / passwordless** for staff. SMS OTP for drivers (Twilio Verify, not raw SMS — fewer compliance headaches).

**Service role** key is used only inside Edge Functions for elevated writes (e.g., suspension cascade, score recompute). Never exposed to the browser.

---

## 4. Multi-tenancy: every read is scoped to one DSP

The single most important rule. Every business table has a `dsp_id uuid not null references dsps(id)` column and a matching RLS policy:

```sql
create policy "tenant_read"
  on drivers for select
  using (dsp_id = (auth.jwt() ->> 'dsp_id')::uuid);
create policy "tenant_write"
  on drivers for all
  using (dsp_id = (auth.jwt() ->> 'dsp_id')::uuid)
  with check (dsp_id = (auth.jwt() ->> 'dsp_id')::uuid);
```

A pgTAP test fixture creates **three DSPs with crossing data** and asserts that every API call (auth'd as DSP A) returns zero rows from B and C. This test runs in CI on every migration.

**Multi-station within a DSP** is *not* multi-tenancy. Stations are a column (`station_id`) on `drivers`, `shifts`, `applicants`, etc. — within the same DSP. RLS doesn't filter by station; a station-scoped role is a future feature, not V1.

---

## 5. Schema

Grouped by domain. Every table has these defaults:

- `id uuid primary key default gen_random_uuid()`
- `dsp_id uuid not null references dsps(id) on delete cascade`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- `created_by uuid references app_users(id)` (where applicable)
- An `updated_at` trigger via `moddatetime` extension
- `index (dsp_id)` on every table

Indexes beyond `dsp_id` are listed inline.

### 5.1 Identity & tenancy

```sql
-- DSPs (the tenant)
create table dsps (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique,
  amazon_node   text,                      -- e.g. 'KMO1'
  cycle         int not null default 1,
  timezone      text not null default 'America/Chicago',
  settings      jsonb not null default '{}'::jsonb,
  status        text not null default 'active' check (status in ('active','paused','terminated')),
  stripe_customer_id text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Stations within a DSP
create table stations (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references dsps(id) on delete cascade,
  code          text not null,             -- 'KMO1'
  name          text not null,
  address       text,
  capacity_routes int,
  created_at    timestamptz not null default now(),
  unique (dsp_id, code)
);

-- App users (DSP staff + drivers)
-- Mirrors auth.users but adds business-level fields.
create table app_users (
  id          uuid primary key references auth.users(id) on delete cascade,
  dsp_id      uuid not null references dsps(id) on delete cascade,
  role        text not null check (role in ('owner','ops','dispatcher','driver')),
  driver_id   uuid,                        -- set if role='driver', FK added later
  email       text,
  phone       text,
  full_name   text,
  status      text not null default 'active' check (status in ('active','disabled')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on app_users (dsp_id, role);
```

### 5.2 Drivers

```sql
create type driver_status as enum ('active','onboarding','suspended','inactive','terminated');

create table drivers (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  station_id      uuid references stations(id),
  full_name       text not null,
  phone           text,
  email           text,
  status          driver_status not null default 'onboarding',
  hire_date       date,
  termination_date date,
  termination_reason text,
  license_number  text,
  license_expiry  date,
  dot_medical_card_expiry date,
  emergency_contact jsonb,                  -- { name, phone, relationship }
  notes           text,
  -- Computed score is materialized for query perf, recomputed nightly + on event
  composite_score numeric(5,2),
  attendance_rate_30d numeric(5,2),
  retention_risk numeric(5,2),
  -- Bookkeeping
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references app_users(id)
);
create index on drivers (dsp_id, status);
create index on drivers (dsp_id, station_id) where status = 'active';
create index on drivers (license_expiry) where license_expiry is not null;
create index on drivers (composite_score);
-- Now backfill the FK from app_users.driver_id → drivers.id
alter table app_users add constraint app_users_driver_fk foreign key (driver_id) references drivers(id) on delete set null;
```

### 5.3 Hiring pipeline

```sql
create type applicant_stage as enum ('new','screening','passed','booked','hired','rejected','filtered','no_show');

create table applicants (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  station_id      uuid references stations(id),
  full_name       text not null,
  email           text,
  phone           text,
  source          text,                     -- 'indeed' | 'referral' | 'walkin' | 'jobfair' | 'ziprecruiter' | ...
  source_ref      text,                     -- Indeed apply id, etc.
  referrer_driver_id uuid references drivers(id),
  stage           applicant_stage not null default 'new',
  score           int,                      -- composite from screening_responses
  screening_data  jsonb,                    -- raw responses for audit
  video_urls      text[],                   -- supabase Storage paths
  cal_event_id    text,                     -- Cal.com booking id
  interview_at    timestamptz,
  notes           text,
  hired_driver_id uuid references drivers(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on applicants (dsp_id, stage);
create index on applicants (dsp_id, source);
create index on applicants (dsp_id, interview_at) where interview_at is not null;
create unique index on applicants (dsp_id, source_ref) where source_ref is not null;

-- Screening question definitions (per-DSP)
create table screening_questions (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  prompt          text not null,
  field_type      text not null check (field_type in ('yes_no','single','multi','text','number','date')),
  options         jsonb,                    -- for single/multi
  required        boolean not null default true,
  hard_filter     jsonb,                    -- e.g. { "answer": "No" } → auto-fail
  scoring         jsonb,                    -- map answer → points
  display_order   int not null default 0,
  created_at      timestamptz not null default now()
);

-- One row per applicant × question
create table screening_responses (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  applicant_id    uuid not null references applicants(id) on delete cascade,
  question_id     uuid not null references screening_questions(id),
  answer_text     text,
  answer_json     jsonb,
  score_awarded   int,
  hard_filter_failed boolean default false,
  created_at      timestamptz not null default now()
);

-- Referral payout schedule
create table referral_payouts (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  applicant_id    uuid not null references applicants(id),
  driver_id       uuid not null references drivers(id),         -- the referrer
  milestone       text not null check (milestone in ('hire','tenure_30','tenure_60','tenure_90')),
  amount_cents    int not null,
  due_at          date not null,
  paid_at         date,
  paid_via        text,
  notes           text,
  created_at      timestamptz not null default now()
);
```

### 5.4 Attendance & policy

```sql
create type attendance_event_type as enum ('present','late','callout','noshow','earlyout','vto');

-- Per-DSP attendance policy (singleton row per DSP)
create table attendance_policies (
  dsp_id          uuid primary key references dsps(id) on delete cascade,
  mode            text not null default 'hybrid' check (mode in ('points','occurrence','hybrid')),
  events          jsonb not null,           -- { late: {points:0.5, occurrence:false}, ... }
  callout_window_hours int not null default 4,
  late_grace_minutes int not null default 10,
  decay_days      int not null default 90,
  reset_cadence   text not null default 'rolling' check (reset_cadence in ('rolling','quarter','annual')),
  thresholds      jsonb not null,           -- { verbal:{points:2,occ:2}, written:..., final:..., term:... }
  exempt_categories text[] not null default array['Approved PTO','Jury duty','Bereavement','FMLA','Workplace injury'],
  notify_driver   boolean not null default true,
  notify_owner    boolean not null default true,
  auto_coach      boolean not null default true,
  updated_at      timestamptz not null default now()
);

create table attendance_events (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  driver_id       uuid not null references drivers(id) on delete cascade,
  event_type      attendance_event_type not null,
  event_date      date not null,
  exempt          boolean not null default false,
  exempt_category text,
  notes           text,
  source          text not null default 'check_in' check (source in ('check_in','manual','timeclock_import')),
  shift_id        uuid,                     -- optional FK to shifts (added later)
  created_by      uuid references app_users(id),
  created_at      timestamptz not null default now()
);
create index on attendance_events (dsp_id, driver_id, event_date desc);
create index on attendance_events (dsp_id, event_date desc);
create unique index on attendance_events (dsp_id, driver_id, event_date, event_type)
  where event_type in ('callout','noshow','vto');  -- one per day per type
```

### 5.5 HR file & disciplinary actions

```sql
-- IMMUTABLE. Inserts only. "Voids" are themselves rows with type='void'.
create type hr_event_type as enum (
  'verbal_warning','written_warning','final_warning',
  'suspension','reinstatement','pending_termination','termination',
  'license_reminder_sent','document_signed','exempt_granted','void'
);

create table hr_events (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  driver_id       uuid not null references drivers(id) on delete cascade,
  event_type      hr_event_type not null,
  severity        text not null check (severity in ('info','minor','major','critical')),
  effective_date  date not null,
  return_date     date,                     -- for suspensions
  reason_category text,                     -- 'attendance','safety','conduct','scorecard','theft','other'
  reason_detail   text not null,
  evidence_refs   jsonb,                    -- list of attendance_event_ids, etc.
  attached_files  text[],                   -- Storage paths
  initiated_by    uuid references app_users(id),
  acknowledged_at timestamptz,              -- when driver signed
  acknowledged_by uuid,                     -- driver user id
  superseded_by   uuid references hr_events(id),  -- e.g. void event references the original
  notes           text,
  created_at      timestamptz not null default now()
);
create index on hr_events (dsp_id, driver_id, effective_date desc);
create index on hr_events (dsp_id, event_type);

-- Active suspensions view (computed, no separate table)
create view active_suspensions as
select distinct on (driver_id) *
from hr_events
where event_type = 'suspension'
  and id not in (select superseded_by from hr_events where superseded_by is not null)
  and (return_date is null or return_date >= current_date)
order by driver_id, effective_date desc;
```

The `superseded_by` chain is the audit trail. Voiding a suspension creates a new `void` event referencing the original; the original row never changes. Reinstatement is its own event type.

### 5.6 Coaching (mutable, but logged)

```sql
create table coaching_events (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  driver_id       uuid not null references drivers(id) on delete cascade,
  category        text not null check (category in ('attendance','safety','quality','behavior','license','other')),
  channel         text not null check (channel in ('sms','in_person','pull_route','suspend')),
  message_body    text,                     -- if channel='sms'
  context_summary text,                     -- the 'why' shown in drawer
  evidence_refs   jsonb,
  initiated_by    uuid references app_users(id),
  related_hr_event_id uuid references hr_events(id),
  created_at      timestamptz not null default now()
);
create index on coaching_events (dsp_id, driver_id, created_at desc);
```

### 5.7 Schedule & shifts

```sql
create type shift_status as enum ('scheduled','open','swap_pending','vto','timeoff','off');

create table routes (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  station_id      uuid references stations(id),
  code            text not null,            -- 'KMO1-14B'
  start_time      time,
  end_time        time,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (dsp_id, code)
);

create table shifts (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  station_id      uuid references stations(id),
  driver_id       uuid references drivers(id),
  route_id        uuid references routes(id),
  shift_date      date not null,
  start_at        timestamptz,
  end_at          timestamptz,
  status          shift_status not null default 'scheduled',
  swap_request_id uuid,                     -- optional, FK added later
  notes           text,
  published       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on shifts (dsp_id, shift_date);
create index on shifts (dsp_id, driver_id, shift_date);
create index on shifts (dsp_id, station_id, shift_date) where status = 'open';

create table swap_requests (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  shift_id        uuid not null references shifts(id),
  from_driver_id  uuid not null references drivers(id),
  to_driver_id    uuid references drivers(id),     -- null = open marketplace
  reason          text,
  status          text not null default 'pending' check (status in ('pending','approved','denied','cancelled')),
  decided_by      uuid references app_users(id),
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);

create table time_off_requests (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  driver_id       uuid not null references drivers(id),
  start_date      date not null,
  end_date        date not null,
  reason          text,
  category        text,                     -- 'pto','sick','jury','bereavement','fmla','unpaid'
  status          text not null default 'pending' check (status in ('pending','approved','denied')),
  decided_by      uuid references app_users(id),
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);
```

### 5.8 OKAMI capacity planning

```sql
-- 13-week rolling plan, indexed by ISO week
create table okami_weeks (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  station_id      uuid references stations(id),    -- null = whole DSP
  iso_year        int not null,
  iso_week        int not null,
  week_start      date not null,
  routes_max      int not null,                    -- highest day in the week
  daily_targets   jsonb,                           -- { mon: 35, tue: 38, ... }
  cushion_mode    text not null default 'percent' check (cushion_mode in ('percent','count')),
  cushion_value   numeric(5,2) not null default 10,
  dpr             numeric(4,2) not null default 2.0,
  adw             numeric(4,2) not null default 5.0,
  ot_hours        int not null default 0,
  is_hve          boolean not null default false,
  is_peak         boolean not null default false,
  notes           text,
  updated_at      timestamptz not null default now(),
  unique (dsp_id, station_id, iso_year, iso_week)
);
create index on okami_weeks (dsp_id, week_start);
```

### 5.9 License renewals & compliance

```sql
-- Per-DSP policy
create table license_policies (
  dsp_id          uuid primary key references dsps(id) on delete cascade,
  enabled         boolean not null default true,
  days_before     int[] not null default array[30,14],
  template        text not null,
  notify_owner    boolean not null default true,
  block_scheduling boolean not null default true,
  updated_at      timestamptz not null default now()
);

create table license_reminders (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  driver_id       uuid not null references drivers(id),
  threshold_days  int,                              -- 30, 14, or null for manual
  expiry_date     date not null,                    -- snapshot of driver's license_expiry at send time
  channel         text not null default 'sms',
  sent_at         timestamptz not null default now(),
  twilio_sid      text,
  outcome         text default 'sent' check (outcome in ('sent','delivered','failed','opted_out'))
);
create index on license_reminders (dsp_id, driver_id, expiry_date);
```

### 5.10 Fleet & assets

```sql
create type asset_type as enum ('phone','fuel_card','toll_tag','key_fob','uniform','scanner','other');

create table vehicles (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  station_id      uuid references stations(id),
  vin             text,
  plate           text,
  van_number      text not null,                    -- 'VAN-08'
  make            text,
  model           text,
  year            int,
  status          text not null default 'active' check (status in ('active','maintenance','out_of_service','retired')),
  mileage         int,
  insurance_doc   text,                             -- Storage path
  registration_doc text,
  dot_inspection_at date,
  created_at      timestamptz not null default now(),
  unique (dsp_id, van_number)
);

create table assets (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  asset_type      asset_type not null,
  identifier      text not null,                    -- serial, IMEI, card #, etc.
  vendor          text,
  notes           text,
  created_at      timestamptz not null default now(),
  unique (dsp_id, asset_type, identifier)
);

create table asset_assignments (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  asset_id        uuid not null references assets(id) on delete cascade,
  driver_id       uuid references drivers(id),
  vehicle_id      uuid references vehicles(id),
  assigned_at     timestamptz not null default now(),
  returned_at     timestamptz,
  condition_on_return text,
  notes           text
);
create index on asset_assignments (dsp_id, driver_id) where returned_at is null;

create table maintenance_records (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  vehicle_id      uuid not null references vehicles(id) on delete cascade,
  service_type    text not null,                    -- 'oil','brakes','tires','dot_inspection','damage_repair'
  performed_at    date not null,
  mileage         int,
  cost_cents      int,
  vendor          text,
  notes           text,
  attached_files  text[],
  created_at      timestamptz not null default now()
);
```

### 5.11 Forms / inspections / checklists

```sql
create table form_templates (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  name            text not null,
  schema          jsonb not null,                   -- { fields: [...], conditional_logic: [...] }
  trigger_type    text,                             -- 'pre_trip','post_trip','incident','maintenance','onboarding'
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create table form_submissions (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  form_template_id uuid not null references form_templates(id),
  driver_id       uuid references drivers(id),
  vehicle_id      uuid references vehicles(id),
  shift_id        uuid references shifts(id),
  responses       jsonb not null,
  attached_files  text[],
  gps_lat         numeric(10,7),
  gps_lng         numeric(10,7),
  flagged         boolean not null default false,
  reviewed_by     uuid references app_users(id),
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index on form_submissions (dsp_id, driver_id, created_at desc);
create index on form_submissions (dsp_id, flagged) where flagged = true;

create table checklist_templates (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  name            text not null,
  cadence         text not null check (cadence in ('daily','weekly','monthly','shift_open','shift_close')),
  items           jsonb not null,
  active          boolean not null default true
);

create table checklist_runs (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  template_id     uuid not null references checklist_templates(id),
  due_date        date not null,
  completed_at    timestamptz,
  completed_by    uuid references app_users(id),
  responses       jsonb
);
create index on checklist_runs (dsp_id, due_date);
```

### 5.12 Messaging (Twilio + in-app)

```sql
create table sms_messages (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  driver_id       uuid references drivers(id),
  applicant_id    uuid references applicants(id),
  direction       text not null check (direction in ('outbound','inbound')),
  to_phone        text not null,
  from_phone      text not null,
  body            text not null,
  twilio_sid      text,
  status          text default 'queued' check (status in ('queued','sent','delivered','failed','undelivered')),
  error_code      text,
  delivered_at    timestamptz,
  related_kind    text,                             -- 'screening','interview_confirm','license_reminder','coaching','suspension_notice'
  related_id      uuid,
  created_at      timestamptz not null default now()
);
create index on sms_messages (dsp_id, driver_id, created_at desc);
create index on sms_messages (twilio_sid);

create table sms_opt_outs (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  phone           text not null,
  opted_out_at    timestamptz not null default now(),
  reason          text,
  unique (dsp_id, phone)
);
```

### 5.13 Finances

```sql
create table invoices (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  source          text not null,                    -- 'amazon_variable','amazon_fmp','insurance','rental_3p'
  period_start    date not null,
  period_end      date not null,
  invoice_number  text,
  amount_billed_cents int not null,
  amount_disputed_cents int default 0,
  amount_recovered_cents int default 0,
  status          text not null default 'imported' check (status in ('imported','reviewed','disputed','closed')),
  attached_file   text,                             -- the original PDF/CSV
  raw_data        jsonb,                            -- parsed line items
  created_at      timestamptz not null default now()
);

create table invoice_line_items (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  invoice_id      uuid not null references invoices(id) on delete cascade,
  line_number     int,
  description     text,
  amount_cents    int not null,
  rule_check      jsonb,                            -- { rule: 'scan_compliance', match: false, expected: '...', actual: '...' }
  flagged         boolean not null default false,
  created_at      timestamptz not null default now()
);
create index on invoice_line_items (dsp_id, flagged) where flagged = true;

create table disputes (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references dsps(id) on delete cascade,
  invoice_id      uuid references invoices(id),
  line_item_id    uuid references invoice_line_items(id),
  amount_cents    int not null,
  drafted_letter  text,
  evidence_refs   jsonb,
  submitted_at    timestamptz,
  resolved_at     timestamptz,
  resolution      text check (resolution in ('won','partial','lost','withdrawn')),
  recovered_cents int,
  created_at      timestamptz not null default now()
);
```

### 5.14 Audit log (system-wide)

```sql
-- Every state change to a sensitive table writes a row here.
-- Used for compliance audits, debugging, undo.
create table audit_log (
  id              bigserial primary key,
  dsp_id          uuid references dsps(id),
  actor_id        uuid references app_users(id),
  action          text not null,                    -- 'driver.update','hr_event.insert','suspension.cascade'
  table_name      text not null,
  record_id       uuid,
  before_state    jsonb,
  after_state     jsonb,
  metadata        jsonb,                            -- IP, user-agent, etc.
  created_at      timestamptz not null default now()
);
create index on audit_log (dsp_id, created_at desc);
create index on audit_log (table_name, record_id);
```

A trigger on every "sensitive" table (drivers, hr_events, attendance_events, suspensions, invoices, disputes) writes to this. Implementation:

```sql
create or replace function fn_audit_log()
returns trigger language plpgsql security definer as $$
begin
  insert into audit_log (dsp_id, actor_id, action, table_name, record_id, before_state, after_state)
  values (
    coalesce(new.dsp_id, old.dsp_id),
    auth.uid(),
    tg_op || ':' || tg_table_name,
    tg_table_name,
    coalesce(new.id, old.id),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;
```

---

## 6. RLS policy patterns

A short catalog of patterns used across the schema. Full per-table policies live in `supabase/RLS.md`.

### 6.1 Standard tenant policy (most tables)

```sql
alter table drivers enable row level security;

create policy "tenant_select" on drivers for select
  using (dsp_id = (auth.jwt() ->> 'dsp_id')::uuid);

create policy "tenant_insert" on drivers for insert
  with check (
    dsp_id = (auth.jwt() ->> 'dsp_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner','ops')
  );

create policy "tenant_update" on drivers for update
  using (dsp_id = (auth.jwt() ->> 'dsp_id')::uuid)
  with check (
    dsp_id = (auth.jwt() ->> 'dsp_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner','ops')
  );

create policy "tenant_delete" on drivers for delete
  using (
    dsp_id = (auth.jwt() ->> 'dsp_id')::uuid
    and (auth.jwt() ->> 'role') = 'owner'
  );
```

### 6.2 Driver self-access (for the driver app)

```sql
create policy "driver_self_select" on attendance_events for select
  using (
    dsp_id = (auth.jwt() ->> 'dsp_id')::uuid
    and (
      (auth.jwt() ->> 'role') in ('owner','ops','dispatcher')
      or driver_id = (auth.jwt() ->> 'driver_id')::uuid
    )
  );
```

### 6.3 Append-only HR events

```sql
alter table hr_events enable row level security;

create policy "hr_select" on hr_events for select
  using (
    dsp_id = (auth.jwt() ->> 'dsp_id')::uuid
    and (
      (auth.jwt() ->> 'role') in ('owner','ops')
      or driver_id = (auth.jwt() ->> 'driver_id')::uuid    -- driver sees own file
    )
  );

create policy "hr_insert" on hr_events for insert
  with check (
    dsp_id = (auth.jwt() ->> 'dsp_id')::uuid
    and (auth.jwt() ->> 'role') in ('owner','ops')
  );

-- NO update or delete policies. The table is INSERT-only.
-- "Voiding" an event means inserting a new event with type='void' and superseded_by=<original_id>.
```

### 6.4 Public applicant submission (no JWT)

```sql
-- Used by record.html for the video screening flow. Service role required.
-- We don't expose this table to anon; the Edge Function inserts on behalf of the applicant.
```

---

## 7. Storage buckets

| Bucket | Purpose | Access |
|---|---|---|
| `driver-licenses` | Photos of CDL / DOT medical card | Authenticated; RLS on storage object key contains `dsp_id/driver_id` |
| `inspection-media` | Photos + videos from form submissions | Authenticated; expires after 90 days unless flagged |
| `applicant-videos` | Video screening submissions | Signed URL, 24h, public read for staff |
| `invoice-pdfs` | Original Amazon Variable invoices | Authenticated, owner-only |
| `hr-file-exports` | Generated personnel-file PDFs | Authenticated, signed URL, audit-logged on access |
| `documents` | General DSP documents (insurance, registrations, etc.) | Authenticated |

Storage paths follow the convention: `{bucket}/{dsp_id}/{entity}/{entity_id}/{filename}`. RLS checks the path prefix matches the user's `dsp_id` claim.

---

## 8. Realtime

Tables published to Realtime (subscribed by the dashboard):

| Table | Use case |
|---|---|
| `attendance_events` | Live check-in counts |
| `shifts` | Schedule edits visible across multiple dispatcher tabs |
| `sms_messages` | Inbox / driver thread updates |
| `swap_requests` | Pending swap notifications |
| `time_off_requests` | Approval queue |
| `applicants` | New applicant inflow → pipeline panel updates |
| `hr_events` | Coaching queue + dashboard action card counts |

**Presence channels** (per DSP):
- `presence:dsp:{dsp_id}:checkin` — drivers currently on the route, marker pings
- `presence:dsp:{dsp_id}:dashboard` — which staff are viewing the dashboard

---

## 9. Edge Functions

Each function is single-responsibility. Inputs validated with Zod. Outputs are `{ status, data }` or `{ status: 'error', message, code }`.

### 9.1 Webhooks (inbound)

| Function | Trigger | Responsibility |
|---|---|---|
| `webhook-twilio` | Twilio inbound SMS / status callback | Receive applicant/driver replies, route to `sms_messages`, handle STOP/HELP, fan out to relevant entity (applicant screening response, driver opt-out) |
| `webhook-stripe` | Stripe billing events | Update `dsps.status` on subscription state, log payment events |
| `webhook-cal` | Cal.com booking created/cancelled | Update `applicants.cal_event_id` and `applicants.interview_at`, fire confirmation SMS sequence |

### 9.2 Polling / cron (orchestrators)

| Function | Schedule | Responsibility |
|---|---|---|
| `run-daily` | Daily 03:00 local | Master orchestrator. Calls the others below in sequence, logs run status. |
| `webhook-indeed` | Hourly | Poll Indeed Apply XML feed per DSP, dedupe, insert new `applicants` rows |
| `run-license-reminders` | Daily 06:00 local | Compute days-to-expiry for every active driver, fire SMS for matched thresholds, write `license_reminders` and `hr_events` |
| `run-score-recompute` | Nightly 02:00 local | For each driver, compute composite score from attendance + safety + scorecard tables, write `drivers.composite_score` |
| `run-okami-refresh` | Nightly 04:00 local | Recompute drivers-needed and gap for every `okami_weeks` row. Materialize daily route counts into `daily_route_targets` if needed |
| `run-attendance-policy-actions` | Daily 07:00 local | For every driver, compute current points/occurrences, identify newly-crossed thresholds, create coaching tasks + send SMS |

### 9.3 On-demand (user-invoked)

| Function | Caller | Responsibility |
|---|---|---|
| `smart-drop-extract` | Frontend Smart Drop UI | Accept uploaded file (CSV/Excel/PDF), call Claude API to extract structured data, route to target table per detected schema |
| `export-hr-file` | Roster row HR file button | Generate PDF of immutable HR events for one driver, return signed URL |
| `export-attendance-csv` | Attendance report Export button | Generate CSV of attendance report for current window |
| `generate-coaching-sms` | Coach drawer AI assist | Call Claude with driver context, return drafted message |
| `send-driver-sms` | Coach drawer Send button | Twilio send + write `sms_messages` + log `coaching_event` |
| `send-bulk-sms` | Owner broadcast / interview confirmation sequence | Twilio fan-out with rate limiting |
| `process-suspension` | Coach drawer Suspend button | Single transaction: insert `hr_events`, update `drivers.status`, release future shifts to status=`open`, fire SMS, send notice email |
| `process-reinstatement` | Reinstate modal | Insert `hr_events`, update `drivers.status`, return access |
| `dispute-amazon-invoice` | Finances panel | Reconcile invoice line items against delivery records, draft dispute letter (Claude), insert `disputes` |

### 9.4 Internal helpers (called only by other functions)

| Function | Caller | Responsibility |
|---|---|---|
| `_compute-driver-score` | `run-score-recompute` | Pure compute, given driver_id returns composite score |
| `_render-suspension-pdf` | `process-suspension` | Generate signed acknowledgment PDF |

**No CRUD Edge Functions.** All table reads/writes from the frontend go through Supabase's auto-generated REST API with RLS doing the security work. Edge Functions are reserved for: external integrations, multi-table transactions that benefit from server-side validation, AI calls, file generation.

---

## 10. Background jobs (pg_cron schedule)

```sql
-- All times America/Chicago. Adjust per DSP timezone via Edge Function dispatch logic.
select cron.schedule('run-daily',                     '0 3 * * *',  $$ select net.http_post(url:='https://<project>.functions.supabase.co/run-daily', headers:=jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret'))) $$);
select cron.schedule('run-score-recompute',           '0 2 * * *',  $$ select net.http_post(...) $$);
select cron.schedule('run-license-reminders',         '0 6 * * *',  $$ select net.http_post(...) $$);
select cron.schedule('run-attendance-policy-actions', '0 7 * * *',  $$ select net.http_post(...) $$);
select cron.schedule('run-okami-refresh',             '0 4 * * *',  $$ select net.http_post(...) $$);
select cron.schedule('webhook-indeed',                '0 * * * *',  $$ select net.http_post(...) $$);
select cron.schedule('checklist-due-runs',            '0 5 * * *',  $$ select net.http_post(...) $$);
select cron.schedule('referral-payout-due',           '0 8 * * 1',  $$ select net.http_post(...) $$);  -- weekly Monday
```

`net.http_post` requires the `pg_net` extension. The Edge Function `Authorization` header carries a shared secret stored in `app.cron_secret`; functions reject requests without it.

---

## 11. Seed data

`supabase/seed/*.sql` — runs on `supabase db reset`. Includes:

- 1 DSP "Cardinal Logistics" with 3 stations (KMO1, KMO2, KMO3)
- 4 staff users (1 owner, 1 ops, 2 dispatchers) with magic-link emails
- 78 drivers (matching the mockup roster + extras)
- 48 applicants in pipeline stages (12 new / 14 screening / 8 passed / 7 booked / 7 hired)
- 30 days of attendance events seeded against drivers
- A handful of HR events (1 active suspension, 2 verbal warnings)
- 1 attendance policy and 1 license policy
- 13 OKAMI weeks
- 1 month of shifts
- 5 vehicles + asset inventory

Seed data uses fixed UUIDs (defined as `'00000000-0000-0000-0000-{type}{seq}'`-style) so tests can reference them.

---

## 12. TypeScript codegen

```bash
supabase gen types typescript --project-id <ref> > frontend/src/types/database.ts
```

Generated types include every table, view, and function. Frontend imports them as the source of truth for entity shapes:

```ts
import type { Database } from './types/database';
type Driver = Database['public']['Tables']['drivers']['Row'];
```

Run on every migration via a CI hook so the frontend never drifts.

---

## 13. Local dev workflow

```bash
# One-time
npm install -g supabase
supabase login
supabase link --project-ref <staging-ref>

# Daily
supabase start                          # Local Postgres + Studio + Realtime + Storage
supabase db reset                       # Drop, migrate, seed
supabase migration new <name>           # Create new migration file
# ... edit migration file ...
supabase db push                        # Apply to local
supabase test db                        # Run pgTAP tests
supabase functions serve <name>         # Local function dev server
supabase gen types typescript --local   # Regen types

# Deploy
supabase db push --linked               # Apply migrations to linked project
supabase functions deploy <name>        # Deploy function
```

`.env.local` contains: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_VERIFY_SERVICE_SID`, `INDEED_PUBLISHER_ID`, `CAL_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`.

---

## 14. Deployment

**Three Supabase projects:**

| Env | Purpose | URL |
|---|---|---|
| `routeready-dev` | Local-mirror, throwaway | rrhester (engineer's account) |
| `routeready-staging` | Pre-prod, customer-facing demo | Org-owned |
| `routeready-prod` | Production | Org-owned, paid tier |

Migrations promote dev → staging → prod via CI (GitHub Actions on `main` push). Staging gets the latest migrations on every merge; prod gets them on tagged releases.

**Branch deploys** (Supabase Branching, when GA): each PR gets a throwaway database with seed data + new migrations applied. Frontend Vercel preview points at the branch DB. Allows full PR review of schema changes against real(-ish) data.

---

## 15. Backups & retention

| Concern | Policy |
|---|---|
| **Postgres backups** | Supabase Pro: daily PITR with 7-day window. Critical tables export weekly to S3 cold storage. |
| **HR file retention** | `hr_events` rows are never deleted automatically. Retention is the longer of: (a) 7 years from event date or (b) the duration of any related legal action. Manual delete requires service-role + owner sign-off. |
| **Driver data retention** | When a DSP cancels: 90-day export window during which they can pull their data. After 90 days, drivers + applicants are anonymized (PII zeroed, IDs preserved for invoice/HR record integrity). |
| **SMS message retention** | 24 months. Dropped to summary stats after, per Twilio/TCPA expectations. |
| **Inspection media** | 90 days unless flagged for review (then indefinite until cleared). |
| **Applicant data (rejected/no-show)** | 12 months for re-application matching, then anonymized. |

---

## 16. Indexes & performance

Beyond the per-table indexes above, the following composite indexes are added based on known hot queries from the mockup:

```sql
-- Dashboard "today's check-in" — driver + today
create index on attendance_events (dsp_id, event_date, event_type) where event_date = current_date;

-- Schedule week view
create index on shifts (dsp_id, shift_date, station_id) include (driver_id, route_id, status);

-- Roster table sort by score
create index on drivers (dsp_id, status, composite_score desc) where status = 'active';

-- Pipeline funnel by stage + source
create index on applicants (dsp_id, stage, source);

-- Attendance report: events per driver in last N days
create index on attendance_events (dsp_id, driver_id, event_date desc, event_type);

-- HR file lookup
create index on hr_events (dsp_id, driver_id, effective_date desc, event_type);

-- License renewal scheduler
create index on drivers (license_expiry) where license_expiry is not null and status = 'active';
```

Slow queries get added to `pg_stat_statements` review weekly. Anything over 100ms p95 gets either an index or a materialized view.

**Materialized views to consider in V2:**
- `mv_driver_compliance_score` — joined attendance + safety + scorecard, refreshed nightly
- `mv_okami_demand_per_week` — joined daily targets + cushion + station rules
- `mv_active_pipeline_by_stage` — for dashboard count badges

---

## 17. Realtime architecture concerns

**Subscription scoping.** Every Realtime subscription must be filtered by `dsp_id`. Wrong subscriptions = leaks across tenants. Use Supabase's `filter` parameter:

```ts
supabase.channel('shifts')
  .on('postgres_changes', {
    event: '*', schema: 'public', table: 'shifts',
    filter: `dsp_id=eq.${dspId}`
  }, callback)
  .subscribe();
```

**Presence per DSP** (not per app). Otherwise drivers from DSP A see DSP B's cursors. Channel naming convention: `presence:dsp:{dsp_id}:{feature}`.

**Throttling.** Live status bar polls realtime every 30s per dispatcher. With 100 DSPs × 5 staff × 78 drivers, that's ~40k events/min worst case. Batch updates server-side; debounce client-side; consider a derived `dsp_status_snapshot` table updated every 30s rather than Realtime on raw events.

---

## 18. Build phases

### Phase 1 — Foundation (4–6 weeks · 1–2 engineers)

**Goal:** Drivers + roster + multi-tenancy + auth working end-to-end. No customer-facing features yet.

- Supabase project created (dev / staging / prod)
- Migrations: `dsps`, `stations`, `app_users`, `drivers`, `audit_log`, baseline RLS
- Auth: email magic link for staff, phone OTP for drivers
- Custom JWT claim hook
- pgTAP fixture for multi-tenant isolation
- CSV bulk-import for drivers
- TypeScript types codegen
- Frontend: Roster table reads from real Supabase

**Exit criteria:** A new DSP can be onboarded end-to-end. A staff user logs in, imports drivers, sees the roster, can edit driver records. Cross-tenant isolation tests pass.

### Phase 2 — Hiring + Coaching + HR file (6–8 weeks)

**Goal:** Replace the existing $2,300/mo hiring service with the platform.

- `applicants`, `screening_questions`, `screening_responses`, `referral_payouts`
- `hr_events`, `coaching_events`
- `sms_messages`, `sms_opt_outs`
- Edge Functions: `webhook-twilio`, `webhook-cal`, `webhook-indeed`, `send-driver-sms`, `process-suspension`, `process-reinstatement`, `export-hr-file`
- Cron: `webhook-indeed` (hourly), `run-daily`
- Frontend: Pipeline view live, Coach drawer wired to real DB, HR file modal real
- TCPA opt-in evidence capture in screening flow
- Stripe subscriptions live

**Exit criteria:** A DSP can post a job on Indeed, get applicants in the funnel, screen them via SMS, book interviews, hire on Interview Day, and the new driver flows into the active roster. A coaching SMS sent from the drawer lands as both `sms_messages` and `coaching_events` rows. A suspension creates an immutable `hr_events` row and cascades the driver out of the schedule.

### Phase 3 — Schedule + OKAMI + Attendance (6–8 weeks)

**Goal:** Daily ops live.

- `routes`, `shifts`, `swap_requests`, `time_off_requests`
- `attendance_events`, `attendance_policies`
- `okami_weeks`
- Edge Functions: `run-attendance-policy-actions`, `run-okami-refresh`, `run-score-recompute`
- Cron: nightly score, daily attendance policy, OKAMI refresh
- Realtime subscriptions on shifts + attendance
- Frontend: Schedule week view, Today's check-in, Performance Management, OKAMI

**Exit criteria:** A dispatcher edits the schedule, the change is live for the rest of the team. A driver marked Callout in check-in shows up in the Open Shifts pool. Attendance points cross a threshold → coaching task auto-created → owner is notified.

### Phase 4 — Compliance + Fleet + Forms (4–6 weeks)

**Goal:** Compliance and inspections.

- `license_policies`, `license_reminders`
- `vehicles`, `assets`, `asset_assignments`, `maintenance_records`
- `form_templates`, `form_submissions`, `checklist_templates`, `checklist_runs`
- Cron: `run-license-reminders` (daily)
- Storage buckets: `inspection-media`, `driver-licenses`, `documents`
- Frontend: Settings → License renewals, Drivers → Insights renewals panel, Schedule license flag, Fleet & Assets, Forms / Inspections

**Exit criteria:** A driver whose license expires in 30 days gets an SMS automatically. A pre-trip inspection submission with a flagged answer surfaces in the dashboard action queue. Vehicle maintenance records are tracked.

### Phase 5 — Finance + Smart Drop + AI (open-ended)

- `invoices`, `invoice_line_items`, `disputes`
- Edge Functions: `smart-drop-extract`, `dispute-amazon-invoice`, `generate-coaching-sms`
- Anthropic API integration (already prototyped in `supabase/functions/claude-ai/`)
- Frontend: Finances reconciliation, Smart Drop ingestion, Build-Your-Own-Tool

**Exit criteria:** A DSP can upload a Variable invoice PDF, the system reconciles line items against delivery records, and an auto-drafted dispute is ready for owner review.

### Phase 6+ — Earned features

Per the original audit, defer until 100 paying DSPs:

- AI auto-schedule (constraint solver)
- Retention propensity ML
- Time integrity / cluster pattern detection
- Real-time messaging (in-app DM, presence, read receipts)
- Forms builder UI for arbitrary form authoring
- Multi-station roll-ups for franchise DSPs

---

## 19. Open questions & risks (resolve before Phase 2)

| Risk | Why it matters | Resolution path |
|---|---|---|
| **Amazon Logistics API** does not exist publicly | OKAMI demand, scorecards, route info all come from emailed CSVs / portal exports | Plan CSV ingestion as a permanent interface. Smart Drop is the answer here. Don't promise real-time route tracking. |
| **TCPA exposure** with Twilio auto-SMS to drivers | 1 violation = $500–$1500/recipient | Phase 2 must include opt-in capture, opt-out handling (STOP/HELP), quiet hours, message templates with sender ID, audit log of all sends. Consult counsel before first send. |
| **HR file as legal evidence** | If immutability fails, the feature has negative value | RLS policies above forbid update/delete. pgTAP test must verify. Backups go to immutable cold storage. Soft-delete patterns are NOT acceptable here. |
| **Multi-tenant data leak** | #1 SaaS killer | pgTAP fixture with 3 DSPs runs on every migration. Manual penetration test before Phase 2 GA. |
| **Indeed Apply XML feed** | Only available for paid posters? Rate-limited? | Validate before Phase 2 starts. Fallback: email-based applicant ingestion (parse Indeed alert emails via SES → Edge Function). |
| **Driver app distribution** | The "driver app" referenced in mockup needs an actual install path. Native or PWA? | Recommend a Progressive Web App for V1: bookmark-able, push-notification-capable, no app-store friction. Native app is V3. |
| **Score-as-feedback loop** | Bottom drivers get worse routes → score drops further → terminated. Self-fulfilling. | Bake guardrails in: score is read-only feedback to DSP, never auto-blocks scheduling. Already enforced in mockup logic. Add: score floor decay (small daily uplift) so a single bad week doesn't permanently sink a driver. |
| **Cushion math abuse** | A DSP could set 50% cushion to over-schedule for VTO games (drivers think they have a shift, it's pulled). | Cap cushion at 25% in product. Audit log every cushion change. Display VTO-acceptance rate per driver as a fairness check. |
| **HR vendor integration** | Some DSPs use Bambee / Justworks / Gusto for HR. Should HR events flow to those? | V3. Hold an `hr_events.external_ref` column open from V2 for future linking. |

---

## 20. What to do with the existing supabase/functions/ + migration/ dirs

Treat them as **archived reference**:

- `supabase/functions/claude-ai` → adapt into the new `generate-coaching-sms` (Phase 5)
- `supabase/functions/finalize-application` → adapt into the new `webhook-cal` + applicant insertion logic (Phase 2). The existing flow is correct in shape.
- `supabase/functions/send-sms` → replace with `send-driver-sms` and `webhook-twilio` (Phase 2). Existing one is too anonymous-applicant-coupled to keep as-is.
- `supabase/functions/cal-schedule` → fold into `webhook-cal`
- `supabase/functions/record-config` → keep largely as-is; it serves the public `record.html` page
- `migration/*.py` → delete after Phase 1 starts. Generating SQL from a workbook is not how migrations should be authored. Hand-write migrations going forward.

Move the existing files under `supabase/functions/_archive/` after Phase 1 starts so engineers don't pattern-match against them.

---

## 21. Immediate next step

**This document is the plan.** The first concrete action is to write Phase 1's migrations and pgTAP tests. That's a 1–2 week chunk for one engineer.

Before that work begins, this plan should be reviewed by:

1. The product owner — confirm scope of V1 matches commercial intent
2. A backend engineer — sanity check schema choices, suggest improvements, identify blockers
3. Counsel (or a TCPA-experienced advisor) — review the TCPA/HR file/retention sections specifically

Once approved, mark this document as "Approved · Build" and begin Phase 1.
