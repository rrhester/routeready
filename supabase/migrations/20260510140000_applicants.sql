-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510140000 · applicants + screening
-- The hiring funnel. Applicants enter from Indeed (XML poller),
-- referrals (driver-attributed), walk-ins (manual entry), or job fairs.
-- Screening questions are configurable per DSP. Responses score the
-- applicant; hard-filter answers immediately mark them filtered.
-- ─────────────────────────────────────────────────────────────────────────

create type public.applicant_stage as enum (
  'new',         -- just landed in the funnel
  'screening',   -- responding to screening questions
  'passed',      -- passed screening, awaiting interview booking
  'booked',      -- interview booked on Cal.com
  'hired',       -- offer accepted, become a driver
  'rejected',    -- rejected after interview
  'filtered',    -- auto-filtered by hard-filter screening answers
  'no_show'      -- booked but didn't show up to interview
);

-- ─── Applicants ──────────────────────────────────────────────────────────

create table public.applicants (
  id                  uuid                    primary key default gen_random_uuid(),
  dsp_id              uuid                    not null references public.dsps(id) on delete cascade,
  station_id          uuid                    references public.stations(id) on delete set null,
  full_name           text                    not null,
  email               text,
  phone               text,
  source              text,                                       -- 'indeed','referral','walkin','jobfair','ziprecruiter','other'
  source_ref          text,                                       -- Indeed apply id, etc. — for dedup
  referrer_driver_id  uuid                    references public.drivers(id) on delete set null,
  stage               public.applicant_stage  not null default 'new',
  score               int,                                        -- computed from screening_responses
  screening_data      jsonb,                                      -- raw responses for audit
  video_urls          text[],                                     -- Storage paths for video screening
  cal_event_id        text,                                       -- Cal.com booking id
  interview_at        timestamptz,
  notes               text,
  hired_driver_id     uuid                    references public.drivers(id) on delete set null,
  no_show_at          timestamptz,
  created_at          timestamptz             not null default now(),
  updated_at          timestamptz             not null default now(),
  created_by          uuid                    references public.app_users(id),

  -- Phone normalized (loose check — Edge Functions and RPCs do strict E.164)
  constraint applicants_phone_basic check (phone is null or length(phone) >= 10)
);

-- Dedup applicants by source_ref within a DSP
create unique index applicants_source_ref_unique
  on public.applicants (dsp_id, source_ref) where source_ref is not null;

create index applicants_dsp_stage_idx
  on public.applicants (dsp_id, stage);
create index applicants_dsp_source_idx
  on public.applicants (dsp_id, source);
create index applicants_dsp_interview_at_idx
  on public.applicants (dsp_id, interview_at)
  where interview_at is not null and stage in ('booked','passed');
create index applicants_referrer_idx
  on public.applicants (referrer_driver_id) where referrer_driver_id is not null;
create index applicants_dsp_score_idx
  on public.applicants (dsp_id, score desc nulls last);
create index applicants_phone_trgm_idx
  on public.applicants using gin (phone gin_trgm_ops) where phone is not null;
create index applicants_full_name_trgm_idx
  on public.applicants using gin (full_name gin_trgm_ops);

create trigger trg_applicants_updated_at
  before update on public.applicants
  for each row execute function moddatetime(updated_at);

comment on table public.applicants is
  'Hiring funnel — the entry point of the flywheel. Stage transitions ' ||
  'are gated by RPCs (advance_applicant_stage). On hire, a drivers row ' ||
  'is auto-created via trigger.';

-- ─── RLS on applicants ──────────────────────────────────────────────────

alter table public.applicants enable row level security;

-- Read: staff in DSP. Drivers cannot see applicants (they may know
-- specific candidates but the applicant pool is staff-only by default).
-- Exception: a driver who referred someone can see THEIR referral's
-- progress (added below).
create policy "applicants_staff_select"
  on public.applicants for select
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
  );

create policy "applicants_referrer_select"
  on public.applicants for select
  using (
    dsp_id = private.current_dsp_id()
    and referrer_driver_id = private.current_driver_id()
  );

-- Insert / update: dispatcher+ (manual entry). The Indeed poller and
-- record.html submission go through Edge Functions with the service role,
-- bypassing RLS.
create policy "applicants_dispatcher_insert"
  on public.applicants for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
  );

create policy "applicants_dispatcher_update"
  on public.applicants for update
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

-- Delete: ops only (rare; usually flip stage to 'rejected')
create policy "applicants_ops_delete"
  on public.applicants for delete
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update, delete on public.applicants to authenticated;

-- ─── Screening questions (per-DSP catalog) ──────────────────────────────

create table public.screening_questions (
  id            uuid        primary key default gen_random_uuid(),
  dsp_id        uuid        not null references public.dsps(id) on delete cascade,
  prompt        text        not null,
  field_type    text        not null
                check (field_type in ('yes_no','single','multi','text','number','date')),
  options       jsonb,                                          -- e.g. ["Yes","No","Maybe"]
  required      boolean     not null default true,
  hard_filter   jsonb,                                          -- e.g. { "answer": "No" } → auto-fail
  scoring       jsonb,                                          -- e.g. { "Yes": 3, "Maybe": 1, "No": 0 }
  display_order int         not null default 0,
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index screening_questions_dsp_active_idx
  on public.screening_questions (dsp_id, display_order)
  where active = true;

create trigger trg_screening_questions_updated_at
  before update on public.screening_questions
  for each row execute function moddatetime(updated_at);

alter table public.screening_questions enable row level security;

create policy "screening_q_tenant_select"
  on public.screening_questions for select
  using (dsp_id = private.current_dsp_id());

create policy "screening_q_owner_write"
  on public.screening_questions for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'));

grant select, insert, update, delete on public.screening_questions to authenticated;

-- ─── Screening responses (one row per applicant × question) ─────────────

create table public.screening_responses (
  id                 uuid        primary key default gen_random_uuid(),
  dsp_id             uuid        not null references public.dsps(id) on delete cascade,
  applicant_id       uuid        not null references public.applicants(id) on delete cascade,
  question_id        uuid        not null references public.screening_questions(id) on delete cascade,
  answer_text        text,
  answer_json        jsonb,
  score_awarded      int,
  hard_filter_failed boolean     not null default false,
  created_at         timestamptz not null default now(),

  constraint screening_responses_unique unique (applicant_id, question_id)
);

create index screening_responses_applicant_idx
  on public.screening_responses (applicant_id);

alter table public.screening_responses enable row level security;

-- Read: dispatcher+ (the applicant's responses are part of the screening
-- pipeline view). Drivers do not see applicant responses.
create policy "screening_r_staff_select"
  on public.screening_responses for select
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
  );

-- Insert / update: dispatcher+ via direct write OR service role via the
-- applicant submission Edge Function. No driver write access.
create policy "screening_r_dispatcher_insert"
  on public.screening_responses for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
  );

create policy "screening_r_dispatcher_update"
  on public.screening_responses for update
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

create policy "screening_r_ops_delete"
  on public.screening_responses for delete
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update, delete on public.screening_responses to authenticated;
