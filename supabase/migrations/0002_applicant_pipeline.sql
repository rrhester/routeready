-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0002 · Applicant pipeline
--
-- Hiring funnel schema: applicants, screening, messaging, scheduling,
-- and status history. Multi-tenant by dsp_id with RLS on every table.
--
-- Depends on 0001 for: public.dsps, public.stations, and the helper
-- private.current_dsp_id() that returns the caller's DSP from JWT/session.
--
-- Out of scope (later migrations): triggers, RPCs, edge functions.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── Enums ───────────────────────────────────────────────────────────────

create type public.applicant_status as enum (
  'applied',
  'contacted',
  'screening_started',
  'screening_completed',
  'auto_declined',
  'qualified',
  'review_needed',
  'interview_invited',
  'interview_booked',
  'interview_completed',
  'orientation_invited',
  'orientation_booked',
  'hired',
  'no_show',
  'rejected'
);

create type public.message_channel as enum ('sms', 'email');

create type public.message_direction as enum ('inbound', 'outbound');

create type public.message_status as enum (
  'queued',
  'sending',
  'sent',
  'delivered',
  'failed',
  'received'
);

create type public.cal_event_kind as enum (
  'interview',
  'orientation'
);

create type public.cal_event_status as enum (
  'scheduled',
  'rescheduled',
  'cancelled',
  'completed',
  'no_show'
);


-- ─── applicants ──────────────────────────────────────────────────────────

create table public.applicants (
  id                  uuid                      primary key default gen_random_uuid(),
  dsp_id              uuid                      not null references public.dsps(id) on delete cascade,
  station_id          uuid                      references public.stations(id) on delete set null,

  full_name           text                      not null,
  first_name          text,
  last_name           text,
  email               text,
  phone               text,

  source              text,                                     -- 'indeed','referral','walkin','jobfair','ziprecruiter','other'
  source_ref          text,                                     -- external apply id, for dedup
  referrer_driver_id  uuid,                                     -- FK added in driver migration

  status              public.applicant_status   not null default 'applied',
  score               int,
  screening_completed_at  timestamptz,
  auto_declined_reason    text,

  notes               text,
  metadata            jsonb                     not null default '{}'::jsonb,

  created_at          timestamptz               not null default now(),
  updated_at          timestamptz               not null default now(),

  constraint applicants_phone_basic check (phone is null or length(phone) >= 10)
);

create unique index applicants_source_ref_unique
  on public.applicants (dsp_id, source_ref) where source_ref is not null;

create index applicants_dsp_status_idx
  on public.applicants (dsp_id, status);

create index applicants_dsp_created_idx
  on public.applicants (dsp_id, created_at desc);

create index applicants_dsp_score_idx
  on public.applicants (dsp_id, score desc nulls last);

create index applicants_email_idx
  on public.applicants (dsp_id, lower(email)) where email is not null;

create index applicants_phone_idx
  on public.applicants (dsp_id, phone) where phone is not null;


-- ─── screening_questions ─────────────────────────────────────────────────

create table public.screening_questions (
  id            uuid          primary key default gen_random_uuid(),
  dsp_id        uuid          not null references public.dsps(id) on delete cascade,
  prompt        text          not null,
  field_type    text          not null
                  check (field_type in ('yes_no','single','multi','text','number','date')),
  options       jsonb,                                          -- e.g. ["Yes","No","Maybe"]
  required      boolean       not null default true,
  hard_filter   jsonb,                                          -- e.g. { "answer": "No" } → auto-decline
  scoring       jsonb,                                          -- e.g. { "Yes": 3, "Maybe": 1, "No": 0 }
  display_order int           not null default 0,
  active        boolean       not null default true,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);

create index screening_questions_dsp_active_idx
  on public.screening_questions (dsp_id, display_order)
  where active = true;


-- ─── screening_responses ─────────────────────────────────────────────────

create table public.screening_responses (
  id                  uuid          primary key default gen_random_uuid(),
  dsp_id              uuid          not null references public.dsps(id) on delete cascade,
  applicant_id        uuid          not null references public.applicants(id) on delete cascade,
  question_id         uuid          not null references public.screening_questions(id) on delete cascade,
  answer_text         text,
  answer_json         jsonb,
  score_awarded       int,
  hard_filter_failed  boolean       not null default false,
  created_at          timestamptz   not null default now(),

  constraint screening_responses_unique unique (applicant_id, question_id)
);

create index screening_responses_applicant_idx
  on public.screening_responses (applicant_id);

create index screening_responses_dsp_idx
  on public.screening_responses (dsp_id);


-- ─── message_templates ───────────────────────────────────────────────────

create table public.message_templates (
  id          uuid                    primary key default gen_random_uuid(),
  dsp_id      uuid                    not null references public.dsps(id) on delete cascade,
  channel     public.message_channel  not null,
  key         text                    not null,                 -- e.g. 'applicant.invite_screening'
  name        text                    not null,
  subject     text,                                             -- email-only
  body        text                    not null,                 -- supports {{tokens}}
  active      boolean                 not null default true,
  created_at  timestamptz             not null default now(),
  updated_at  timestamptz             not null default now(),

  constraint message_templates_key_unique unique (dsp_id, channel, key)
);

create index message_templates_dsp_channel_idx
  on public.message_templates (dsp_id, channel)
  where active = true;


-- ─── sms_messages ────────────────────────────────────────────────────────

create table public.sms_messages (
  id                uuid                      primary key default gen_random_uuid(),
  dsp_id            uuid                      not null references public.dsps(id) on delete cascade,
  applicant_id      uuid                      references public.applicants(id) on delete set null,
  template_id       uuid                      references public.message_templates(id) on delete set null,

  direction         public.message_direction  not null,
  status            public.message_status     not null default 'queued',

  to_phone          text                      not null,
  from_phone        text,
  body              text                      not null,

  provider          text,                                       -- 'twilio', etc.
  provider_sid      text,                                       -- Twilio Message SID
  error_code        text,
  error_message     text,

  sent_at           timestamptz,
  delivered_at      timestamptz,

  created_at        timestamptz               not null default now(),
  updated_at        timestamptz               not null default now()
);

create unique index sms_messages_provider_sid_unique
  on public.sms_messages (provider, provider_sid)
  where provider_sid is not null;

create index sms_messages_dsp_created_idx
  on public.sms_messages (dsp_id, created_at desc);

create index sms_messages_applicant_idx
  on public.sms_messages (applicant_id, created_at desc)
  where applicant_id is not null;

create index sms_messages_dsp_status_idx
  on public.sms_messages (dsp_id, status);


-- ─── email_messages ──────────────────────────────────────────────────────

create table public.email_messages (
  id                uuid                      primary key default gen_random_uuid(),
  dsp_id            uuid                      not null references public.dsps(id) on delete cascade,
  applicant_id      uuid                      references public.applicants(id) on delete set null,
  template_id       uuid                      references public.message_templates(id) on delete set null,

  direction         public.message_direction  not null,
  status            public.message_status     not null default 'queued',

  to_email          text                      not null,
  from_email        text,
  reply_to          text,
  subject           text                      not null,
  body_text         text,
  body_html         text,

  provider          text,                                       -- 'resend','postmark', etc.
  provider_message_id text,
  error_code        text,
  error_message     text,

  sent_at           timestamptz,
  delivered_at      timestamptz,

  created_at        timestamptz               not null default now(),
  updated_at        timestamptz               not null default now()
);

create unique index email_messages_provider_message_id_unique
  on public.email_messages (provider, provider_message_id)
  where provider_message_id is not null;

create index email_messages_dsp_created_idx
  on public.email_messages (dsp_id, created_at desc);

create index email_messages_applicant_idx
  on public.email_messages (applicant_id, created_at desc)
  where applicant_id is not null;

create index email_messages_dsp_status_idx
  on public.email_messages (dsp_id, status);


-- ─── cal_events ──────────────────────────────────────────────────────────

create table public.cal_events (
  id                  uuid                      primary key default gen_random_uuid(),
  dsp_id              uuid                      not null references public.dsps(id) on delete cascade,
  applicant_id        uuid                      not null references public.applicants(id) on delete cascade,

  kind                public.cal_event_kind     not null,
  status              public.cal_event_status   not null default 'scheduled',

  provider            text                      not null default 'cal.com',
  provider_event_id   text,                                     -- Cal.com booking id
  event_type          text,                                     -- Cal.com event-type slug

  starts_at           timestamptz               not null,
  ends_at             timestamptz,
  timezone            text,
  location            text,                                     -- url or address
  meeting_url         text,

  cancelled_at        timestamptz,
  cancellation_reason text,

  metadata            jsonb                     not null default '{}'::jsonb,

  created_at          timestamptz               not null default now(),
  updated_at          timestamptz               not null default now()
);

create unique index cal_events_provider_event_unique
  on public.cal_events (provider, provider_event_id)
  where provider_event_id is not null;

create index cal_events_dsp_starts_idx
  on public.cal_events (dsp_id, starts_at);

create index cal_events_applicant_idx
  on public.cal_events (applicant_id, starts_at desc);

create index cal_events_dsp_kind_status_idx
  on public.cal_events (dsp_id, kind, status);


-- ─── applicant_status_changes ────────────────────────────────────────────

create table public.applicant_status_changes (
  id              uuid                      primary key default gen_random_uuid(),
  dsp_id          uuid                      not null references public.dsps(id) on delete cascade,
  applicant_id    uuid                      not null references public.applicants(id) on delete cascade,

  from_status     public.applicant_status,
  to_status       public.applicant_status   not null,
  reason          text,
  changed_by      uuid,                                         -- FK to app_users in 0001 (left loose to avoid coupling)
  metadata        jsonb                     not null default '{}'::jsonb,

  created_at      timestamptz               not null default now()
);

create index applicant_status_changes_applicant_idx
  on public.applicant_status_changes (applicant_id, created_at desc);

create index applicant_status_changes_dsp_idx
  on public.applicant_status_changes (dsp_id, created_at desc);

create index applicant_status_changes_to_status_idx
  on public.applicant_status_changes (dsp_id, to_status, created_at desc);


-- ─────────────────────────────────────────────────────────────────────────
-- Row Level Security
--
-- Every table is tenant-scoped by dsp_id. The default policy here is:
--   USING / WITH CHECK: dsp_id = private.current_dsp_id()
-- Role gating (owner vs dispatcher vs driver) is layered in a later
-- migration alongside the RPCs that perform writes.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.applicants                enable row level security;
alter table public.screening_questions       enable row level security;
alter table public.screening_responses       enable row level security;
alter table public.message_templates         enable row level security;
alter table public.sms_messages              enable row level security;
alter table public.email_messages            enable row level security;
alter table public.cal_events                enable row level security;
alter table public.applicant_status_changes  enable row level security;

create policy "applicants_tenant_rw"
  on public.applicants for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

create policy "screening_questions_tenant_rw"
  on public.screening_questions for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

create policy "screening_responses_tenant_rw"
  on public.screening_responses for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

create policy "message_templates_tenant_rw"
  on public.message_templates for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

create policy "sms_messages_tenant_rw"
  on public.sms_messages for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

create policy "email_messages_tenant_rw"
  on public.email_messages for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

create policy "cal_events_tenant_rw"
  on public.cal_events for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

create policy "applicant_status_changes_tenant_rw"
  on public.applicant_status_changes for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.applicants                to authenticated;
grant select, insert, update, delete on public.screening_questions       to authenticated;
grant select, insert, update, delete on public.screening_responses       to authenticated;
grant select, insert, update, delete on public.message_templates         to authenticated;
grant select, insert, update, delete on public.sms_messages              to authenticated;
grant select, insert, update, delete on public.email_messages            to authenticated;
grant select, insert, update, delete on public.cal_events                to authenticated;
grant select, insert, update, delete on public.applicant_status_changes  to authenticated;
