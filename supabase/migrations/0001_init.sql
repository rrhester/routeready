-- ================================================================
-- RouteReady — Supabase schema (multi-tenant)
-- Migration: 0001_init.sql
--
-- Replaces the Google Sheets backend with a real Postgres schema.
-- One Supabase project hosts all DSPs; data is isolated by dsp_id
-- and enforced at the database level by RLS (see 0002_rls.sql).
--
-- Naming: snake_case, plural tables, uuid primary keys.
-- ================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ================================================================
-- TENANT MODEL
-- ================================================================

-- One row per DSP. Every per-DSP table has a dsp_id FK back to here.
create table public.dsps (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique,
  primary_phone text,
  support_email citext,
  status        text not null default 'active'
                check (status in ('active','suspended','trial')),
  created_at    timestamptz not null default now()
);

-- Links a Supabase Auth user to one DSP.
-- (If you later want users in multiple DSPs, swap this for a
-- many-to-many memberships table.)
create table public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  dsp_id     uuid not null references public.dsps(id) on delete cascade,
  full_name  text,
  role       text not null default 'owner' check (role in ('owner','staff')),
  created_at timestamptz not null default now()
);

create index profiles_dsp_idx on public.profiles(dsp_id);

-- Returns the DSP id for the currently logged-in user.
-- Used in every RLS policy. Marked stable so PG can cache per query.
create or replace function public.current_dsp_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select dsp_id from public.profiles where user_id = auth.uid()
$$;

-- ================================================================
-- SETTINGS (key-value, replaces the Settings sheet)
-- ================================================================

create table public.settings (
  dsp_id     uuid not null references public.dsps(id) on delete cascade,
  key        text not null,
  value      text,
  updated_at timestamptz not null default now(),
  primary key (dsp_id, key)
);

-- The old DashboardPasswordHash + DashboardPasswordSalt are gone.
-- Supabase Auth handles login (email + password).

-- ================================================================
-- APPLICANT PIPELINE (replaces Master + Ingest sheets)
-- ================================================================

create type applicant_status as enum (
  'new', 'screening', 'passed', 'failed', 'waitlist',
  'booked', 'hired', 'not_hired', 'no_show', 'filtered', 'promoted'
);

create type priority_tier as enum ('low', 'standard', 'priority');

create table public.applicants (
  id                  uuid primary key default gen_random_uuid(),
  dsp_id              uuid not null references public.dsps(id) on delete cascade,

  first_name          text,
  last_name           text,
  phone               text,
  email               citext,

  contacted           text,                       -- 'Sent' | 'Queued' | NULL
  status              applicant_status not null default 'new',
  booking_time        timestamptz,
  score               integer not null default 0,
  priority            priority_tier not null default 'low',

  ingested_at         timestamptz not null default now(),
  attendance          text,                       -- 'Attended' | 'No-Show' | NULL
  source              text,                       -- 'Indeed' | 'Referral: Mike' | etc

  cycle_number        integer,

  -- Video screening fields (replaces VideoStatus..VideoSignals on Master)
  video_status        text,
  video_url           text,                       -- pipe-separated R2 URLs (existing format)
  video_recorded_at   timestamptz,
  video_transcript    text,
  video_score         integer,
  video_signals       jsonb,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index applicants_dsp_email_uniq on public.applicants(dsp_id, email)
  where email is not null;
create unique index applicants_dsp_phone_uniq on public.applicants(dsp_id, phone)
  where phone is not null and phone <> '';
create index applicants_dsp_status_idx on public.applicants(dsp_id, status);
create index applicants_dsp_ingested_idx on public.applicants(dsp_id, ingested_at desc);

-- Per-applicant message log. Replaces the pipe-separated MessageLog cell.
create table public.applicant_messages (
  id           bigserial primary key,
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  applicant_id uuid not null references public.applicants(id) on delete cascade,
  channel      text not null,        -- 'sms' | 'email' | 'manual' | 'videoform' | 'approve' | 'filter'
  label        text not null,        -- one-line summary, like "Cal.com link sent"
  payload      jsonb,                -- structured detail (form answers, etc)
  created_at   timestamptz not null default now()
);

create index applicant_messages_applicant_idx
  on public.applicant_messages(applicant_id, created_at desc);
create index applicant_messages_dsp_idx
  on public.applicant_messages(dsp_id, created_at desc);

-- Tokens used by record.html etc. Each token belongs to one applicant.
create table public.applicant_tokens (
  token        text primary key,                       -- 8-char URL-safe (matches existing format)
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  applicant_id uuid not null references public.applicants(id) on delete cascade,
  purpose      text not null,                          -- 'video_link' | 'screening' | etc
  expires_at   timestamptz not null,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index applicant_tokens_applicant_idx on public.applicant_tokens(applicant_id);

-- ================================================================
-- SCREENING (replaces QuestionBank + ScreeningSelections + Screening sheet)
-- ================================================================

-- GLOBAL question library (no dsp_id — same library for every DSP).
create table public.question_bank (
  id             text primary key,            -- 'q_age21' etc
  category       text not null,
  label          text not null,
  default_filter boolean not null default false,
  amber_warn     text not null default ''
);

-- Per-DSP selection of which questions to ask, in what order.
create table public.screening_selections (
  id              bigserial primary key,
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  slot_order      integer not null check (slot_order between 1 and 8),
  question_id     text,                       -- references question_bank.id when source='library'
  source          text not null check (source in ('library','custom')),
  custom_text     text,
  filter_override boolean,
  updated_at      timestamptz not null default now(),
  unique (dsp_id, slot_order)
);

-- An applicant's actual screening response.
create table public.screening_responses (
  id                 uuid primary key default gen_random_uuid(),
  dsp_id             uuid not null references public.dsps(id) on delete cascade,
  applicant_id       uuid not null references public.applicants(id) on delete cascade,

  authorized         text,
  license            text,
  lift               text,
  violations         text,
  background         text,
  days_available     text,
  start_availability text,
  hours_available    text,
  sms_opt_in         text,

  -- Free-form storage for custom-question answers and any other data
  answers            jsonb,

  result             text,                    -- 'Pass' | 'Fail' | 'Waitlist'
  score              integer,
  submitted_at       timestamptz not null default now()
);

create index screening_responses_applicant_idx on public.screening_responses(applicant_id);
create index screening_responses_dsp_idx
  on public.screening_responses(dsp_id, submitted_at desc);

-- Filtered (failed-immediately) applicants — replaces Filtered sheet.
create table public.filtered_applicants (
  id              bigserial primary key,
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  applicant_id    uuid references public.applicants(id) on delete set null,
  first_name      text,
  last_name       text,
  email           citext,
  phone           text,
  question_id     text,
  question_label  text,
  failed_answer   text,
  fail_if_value   text,
  source          text,                       -- 'client' | 'server'
  form_answers    jsonb,
  created_at      timestamptz not null default now()
);

-- ================================================================
-- WAITLIST + QUEUE + LOGS
-- ================================================================

create table public.waitlist (
  id                 bigserial primary key,
  dsp_id             uuid not null references public.dsps(id) on delete cascade,
  applicant_id       uuid references public.applicants(id) on delete set null,
  first_name         text,
  last_name          text,
  phone              text,
  email              citext,
  score              integer not null default 0,
  start_availability text,
  added_at           timestamptz not null default now()
);

create index waitlist_dsp_score_idx on public.waitlist(dsp_id, score desc);

create table public.message_queue (
  id           bigserial primary key,
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  applicant_id uuid references public.applicants(id) on delete set null,
  recipient    text not null,                  -- phone or email
  channel      text not null check (channel in ('sms','email')),
  subject      text,
  body         text not null,
  status       text not null default 'pending'
               check (status in ('pending','sent','failed')),
  queued_at    timestamptz not null default now(),
  sent_at      timestamptz,
  error        text
);

create index message_queue_pending_idx on public.message_queue(dsp_id)
  where status = 'pending';

create table public.failures (
  id         bigserial primary key,
  dsp_id     uuid not null references public.dsps(id) on delete cascade,
  type       text not null,                    -- 'twilio'|'email'|'masterMatch'|etc
  identifier text,                              -- phone, email, applicant id
  reason     text,
  created_at timestamptz not null default now()
);

create index failures_dsp_idx on public.failures(dsp_id, created_at desc);

create table public.decisions_log (
  id               bigserial primary key,
  dsp_id           uuid not null references public.dsps(id) on delete cascade,
  trigger          text not null,              -- 'Daily 6:45am' | 'Interview Day: hired' | etc
  throttle_mode    text,
  risk_level       text,
  seven_am_preview text,
  indeed_action    text,
  full_payload     jsonb,
  created_at       timestamptz not null default now()
);

create index decisions_log_dsp_idx on public.decisions_log(dsp_id, created_at desc);

create table public.cycle_history (
  id                  bigserial primary key,
  dsp_id              uuid not null references public.dsps(id) on delete cascade,
  cycle_number        integer not null,
  orientation_date    date,
  target              integer,
  applied             integer,
  screened            integer,
  passed              integer,
  booked              integer,
  attended            integer,
  no_showed           integer,
  avg_score_attended  numeric,
  avg_score_no_show   numeric,
  throttle_modes      text,
  notes               text,
  closed_at           timestamptz not null default now()
);

create index cycle_history_dsp_idx on public.cycle_history(dsp_id, cycle_number desc);

-- Snapshot of applicants at cycle close (replaces Archive sheet).
create table public.cycle_archive (
  id                bigserial primary key,
  dsp_id            uuid not null references public.dsps(id) on delete cascade,
  cycle_number      integer not null,
  applicant_snapshot jsonb not null,
  archived_at       timestamptz not null default now()
);

create index cycle_archive_dsp_idx on public.cycle_archive(dsp_id, cycle_number);

-- Stale-booking dismissals (replaces Dismissals sheet).
create table public.dismissals (
  id              bigserial primary key,
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  applicant_id    uuid references public.applicants(id) on delete cascade,
  email           citext,
  dismissed_until timestamptz not null,
  dismissed_at    timestamptz not null default now()
);

create index dismissals_dsp_email_idx on public.dismissals(dsp_id, email);

-- ================================================================
-- REFERRAL PROGRAM
-- ================================================================

create table public.referral_codes (
  code              text primary key,           -- 4-char random (existing format)
  dsp_id            uuid not null references public.dsps(id) on delete cascade,
  applicant_id      uuid references public.applicants(id) on delete set null,
  hire_name         text,
  hire_email        citext,
  hire_phone        text,
  hired_date        date,
  outreach_sent_at  timestamptz,
  outreach_via      text,                       -- 'sms' | 'email'
  created_at        timestamptz not null default now()
);

create index referral_codes_dsp_idx on public.referral_codes(dsp_id);

create type referral_status as enum ('applied','pending','owed','paid','voided');

create table public.referrals (
  id                    text primary key,       -- 'ref_xxxxxxxx' (existing format)
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  referrer_code         text references public.referral_codes(code) on delete set null,
  referrer_name         text,
  referred_applicant_id uuid references public.applicants(id) on delete set null,
  referred_name         text,
  referred_email        citext,
  applied_date          timestamptz not null default now(),
  hired_date            timestamptz,
  status                referral_status not null default 'applied',
  amount                numeric not null default 0,
  payable_date          date,
  paid_date             date,
  note                  text
);

create index referrals_dsp_status_idx on public.referrals(dsp_id, status);

-- ================================================================
-- VIDEO RECORDINGS (audit log of video uploads)
-- ================================================================

create table public.video_recordings (
  id               bigserial primary key,
  dsp_id           uuid not null references public.dsps(id) on delete cascade,
  applicant_id     uuid references public.applicants(id) on delete cascade,
  applicant_email  citext,
  applicant_phone  text,
  video_url        text,                        -- R2 public URL
  duration_seconds integer,
  status           text,                        -- 'Uploaded'|'Transcribing'|'Scoring'|'Complete'|'Failed'
  transcript       text,
  ai_response      jsonb,
  error_log        text,
  user_agent       text,
  created_at       timestamptz not null default now()
);

create index video_recordings_dsp_idx on public.video_recordings(dsp_id, created_at desc);

-- ================================================================
-- MESSAGE TEMPLATES
-- ================================================================

create table public.message_templates (
  dsp_id         uuid not null references public.dsps(id) on delete cascade,
  touchpoint_key text not null,                 -- 'screening' | 'booking' | 'decline' | etc
  sms            text,
  email_subject  text,
  email_body     text,
  updated_at     timestamptz not null default now(),
  primary key (dsp_id, touchpoint_key)
);

-- ================================================================
-- PERFORMANCE / COACHING
-- (replaces SafetyEvents, QualityDaily, DriverRoster, CoachingLog)
-- ================================================================

create type driver_status as enum (
  'pre_onboarding','onboarding','active','inactive','terminated'
);

create table public.driver_roster (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  transporter_id  text not null,
  driver_name     text not null,
  first_seen_date date,
  hire_date       date,
  status          driver_status not null default 'active',
  phone_number    text,
  phone_source    text,                         -- 'master_auto' | 'manual'
  email           citext,
  pipeline_score  integer,
  pipeline_cycle  integer,
  last_updated    timestamptz not null default now(),
  unique (dsp_id, transporter_id)
);

create index driver_roster_dsp_status_idx on public.driver_roster(dsp_id, status);

create table public.safety_events (
  event_id          text primary key,           -- comes from Amazon CSV
  dsp_id            uuid not null references public.dsps(id) on delete cascade,
  driver_roster_id  uuid references public.driver_roster(id) on delete set null,
  transporter_id    text not null,
  driver_name       text,
  vin               text,
  event_date        date not null,
  event_datetime    timestamptz,
  metric_type       text,                       -- 'Speeding'|'Following Distance'|etc
  metric_subtype    text,
  program_impact    text,
  source            text,
  video_link        text,
  review_status     text,
  ingested_at       timestamptz not null default now()
);

create index safety_events_dsp_date_idx on public.safety_events(dsp_id, event_date desc);
create index safety_events_dsp_tid_idx on public.safety_events(dsp_id, transporter_id);

create table public.quality_daily (
  day_id             text primary key,          -- 'YYYY-MM-DD|TID'
  dsp_id             uuid not null references public.dsps(id) on delete cascade,
  driver_roster_id   uuid references public.driver_roster(id) on delete set null,
  transporter_id     text not null,
  driver_name        text,
  event_date         date not null,
  packages_delivered integer,
  routes_completed   integer,
  dcr_pct            numeric(5,2),
  pod_pct            numeric(5,2),
  dsb_count          integer,
  ingested_at        timestamptz not null default now()
);

create index quality_daily_dsp_date_idx on public.quality_daily(dsp_id, event_date desc);
create index quality_daily_dsp_tid_idx on public.quality_daily(dsp_id, transporter_id);

create type coaching_type as enum ('SMS','InPerson','Skipped','StatusChange');

create table public.coaching_log (
  id                    text primary key,       -- 'CL<ts>_<rand>' (existing format)
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  driver_roster_id      uuid references public.driver_roster(id) on delete set null,
  transporter_id        text not null,
  driver_name           text,
  type                  coaching_type not null,
  triggered_by_event_id text,                   -- references safety_events.event_id (loose FK)
  message_body          text,
  guide_attached        text,                   -- JSON string of attachments (R2 URLs)
  sent_by               text,
  created_at            timestamptz not null default now()
);

create index coaching_log_dsp_idx on public.coaching_log(dsp_id, created_at desc);
create index coaching_log_dsp_tid_idx on public.coaching_log(dsp_id, transporter_id);

-- ================================================================
-- updated_at trigger (used by applicants only for now)
-- ================================================================

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger applicants_touch_updated_at
  before update on public.applicants
  for each row execute function public.touch_updated_at();

-- ================================================================
-- SEED: question_bank (the 14 default questions from the old setup)
-- ================================================================

insert into public.question_bank (id, category, label, default_filter, amber_warn) values
  ('q_age21',      'Eligibility',           'Do you meet the 21 years of age minimum requirement?', true,  ''),
  ('q_workauth',   'Eligibility',           'Are you authorized to work in the United States?', true, ''),
  ('q_license',    'Eligibility',           'Do you have a valid driver''s license?', true, ''),
  ('q_license1yr', 'Eligibility',           'Have you held your driver''s license for at least one year?', true, ''),
  ('q_transport',  'Eligibility',           'Do you have reliable transportation to and from work?', true, ''),
  ('q_10hrshift',  'Physical Requirements', 'Are you able to be on and off your feet for a 10-hour shift?', true, ''),
  ('q_lift60',     'Physical Requirements', 'Can you lift and carry packages up to 60 lbs throughout the day?', true, ''),
  ('q_weather',    'Physical Requirements', 'Can you work outdoors in all weather conditions — rain, heat, cold, snow?', false, ''),
  ('q_van',        'Physical Requirements', 'Are you comfortable driving a large cargo van in residential neighborhoods?', false, ''),
  ('q_smartphone', 'Physical Requirements', 'Are you comfortable using a smartphone for navigation and delivery tracking all day?', true, ''),
  ('q_bgcheck',    'Background & History',  'Can you pass a criminal background check?', true, 'Restricted in Ban-the-Box states'),
  ('q_drugscreen', 'Background & History',  'Can you pass a DOT drug screen?', true, 'Check CA, NY, WA marijuana laws'),
  ('q_accidents',  'Background & History',  'Have you had any at-fault motor vehicle accidents in the past 3 years?', false, 'Some states restrict self-disclosure'),
  ('q_violations', 'Background & History',  'Have you had any moving violations in the past 12 months?', false, 'Some states restrict self-disclosure');
