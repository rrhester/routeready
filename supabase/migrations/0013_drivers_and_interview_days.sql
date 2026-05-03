-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0013 · Drivers (employees) + interview-day model
--
-- Three additions:
--   1. driver_status enum + public.drivers table — minimal employee
--      record created when an applicant is hired. Schema is intentionally
--      slim; richer fields (HR file, performance, schedule prefs, etc.)
--      land in later migrations.
--   2. public.interview_days  — one row per interview cohort
--      (DSP + date). DSP "opens" a day, processes booked applicants,
--      then "closes" it which freezes the totals used for KPIs.
--   3. public.interview_outcomes — per-applicant decision recorded
--      during a day (hired | no_hire | no_show). KPI math reads from
--      here; applicants.status is the denormalized terminal state.
--
-- Adds applicant_status value 'not_hired'. Per requirements: both
-- "No Hire" and "No Show" interview-day decisions roll up to
-- not_hired on the applicants master row, while the granular outcome
-- stays on interview_outcomes for show-rate / hire-rate calc.
-- ─────────────────────────────────────────────────────────────────────────

-- Extend applicant_status with 'not_hired' (in_transaction_alteration
-- isn't required since this is the type's first time being modified).
alter type public.applicant_status add value if not exists 'not_hired';

-- ─── Driver enum + table ────────────────────────────────────────────────

create type public.driver_status as enum (
  'onboarding',
  'active',
  'leave',
  'inactive',
  'terminated'
);

create table public.drivers (
  id            uuid                     primary key default gen_random_uuid(),
  dsp_id        uuid                     not null references public.dsps(id) on delete cascade,
  station_id    uuid                     references public.stations(id) on delete set null,
  applicant_id  uuid                     references public.applicants(id) on delete set null,

  first_name    text,
  last_name     text,
  full_name     text                     not null,
  email         text,
  phone         text,

  hire_date     date                     not null default current_date,
  status        public.driver_status     not null default 'onboarding',
  tier          text,
  score         int,

  metadata      jsonb                    not null default '{}'::jsonb,

  created_at    timestamptz              not null default now(),
  updated_at    timestamptz              not null default now()
);

create index drivers_dsp_status_idx
  on public.drivers (dsp_id, status) where status <> 'terminated';

create index drivers_dsp_hire_idx
  on public.drivers (dsp_id, hire_date desc);

create index drivers_email_idx
  on public.drivers (dsp_id, lower(email)) where email is not null;

create index drivers_phone_idx
  on public.drivers (dsp_id, phone) where phone is not null;

create trigger trg_drivers_updated_at
  before update on public.drivers
  for each row execute function private.set_updated_at();

alter table public.drivers enable row level security;

create policy "drivers_tenant_rw"
  on public.drivers for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.drivers to authenticated;


-- ─── Interview day cohort ───────────────────────────────────────────────

create table public.interview_days (
  id          uuid          primary key default gen_random_uuid(),
  dsp_id      uuid          not null references public.dsps(id) on delete cascade,
  station_id  uuid          references public.stations(id) on delete set null,

  -- Local-date of the cohort. We store as date (no tz) since the operator
  -- decides "today" in their tz; matching to cal_events uses (starts_at AT TIME ZONE dsp.timezone)::date.
  date        date          not null,

  opened_at   timestamptz   not null default now(),
  closed_at   timestamptz,
  closed_by   uuid          references public.app_users(id) on delete set null,

  totals_booked   int       not null default 0,
  totals_hired    int       not null default 0,
  totals_no_hire  int       not null default 0,
  totals_no_show  int       not null default 0,

  metadata    jsonb         not null default '{}'::jsonb,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now()
);

-- Only one open day per (dsp, date). Allows reopening a day by closing
-- and creating a new row, but prevents stacking concurrent days.
create unique index interview_days_dsp_date_open_unique
  on public.interview_days (dsp_id, date)
  where closed_at is null;

create index interview_days_dsp_recent_idx
  on public.interview_days (dsp_id, date desc);

create trigger trg_interview_days_updated_at
  before update on public.interview_days
  for each row execute function private.set_updated_at();

alter table public.interview_days enable row level security;

create policy "interview_days_tenant_rw"
  on public.interview_days for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.interview_days to authenticated;


-- ─── Per-applicant outcomes during a day ────────────────────────────────

create type public.interview_outcome as enum (
  'hired',
  'no_hire',
  'no_show'
);

create table public.interview_outcomes (
  id                 uuid                     primary key default gen_random_uuid(),
  dsp_id             uuid                     not null references public.dsps(id) on delete cascade,
  interview_day_id   uuid                     not null references public.interview_days(id) on delete cascade,
  applicant_id       uuid                     not null references public.applicants(id) on delete cascade,

  outcome            public.interview_outcome not null,
  decided_by         uuid                     references public.app_users(id) on delete set null,
  decided_at         timestamptz              not null default now(),
  notes              text,

  created_at         timestamptz              not null default now(),

  -- One outcome per (day, applicant). Re-clicking on a card overwrites.
  constraint interview_outcomes_day_applicant_unique
    unique (interview_day_id, applicant_id)
);

create index interview_outcomes_day_idx
  on public.interview_outcomes (interview_day_id);

create index interview_outcomes_dsp_recent_idx
  on public.interview_outcomes (dsp_id, decided_at desc);

alter table public.interview_outcomes enable row level security;

create policy "interview_outcomes_tenant_rw"
  on public.interview_outcomes for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.interview_outcomes to authenticated;
