-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510200000 · Compliance — license + inspections + checklists
-- Phase 5. License renewals (with auto-SMS at configurable thresholds),
-- DOT inspections via form_templates / form_submissions, recurring
-- checklists. Plugs into the SMS queue from Phase 4.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── License policy (singleton per DSP) ──────────────────────────────────

create table public.license_policies (
  dsp_id            uuid          primary key references public.dsps(id) on delete cascade,
  enabled           boolean       not null default true,
  days_before       int[]         not null default array[30, 14],
                    -- thresholds at which auto-SMS fires
  template          text          not null default
                    'Hi {{name}} — your driver license expires in {{days}} days ({{date}}). ' ||
                    'Please renew ASAP and send a photo of your new license. ' ||
                    'Reply HELP if you need help.',
  notify_owner      boolean       not null default true,
  block_scheduling  boolean       not null default true,
                    -- when true, drivers with expired licenses can't be assigned shifts
  updated_at        timestamptz   not null default now(),
  updated_by        uuid          references public.app_users(id)
);

create trigger trg_license_policies_updated_at
  before update on public.license_policies
  for each row execute function moddatetime(updated_at);

comment on table public.license_policies is
  'Per-DSP config for auto license-renewal SMS reminders. Days_before is ' ||
  'an array of thresholds (e.g. [30,14] means 30 and 14 days before expiry).';

alter table public.license_policies enable row level security;

create policy "license_policy_tenant_select"
  on public.license_policies for select
  using (dsp_id = private.current_dsp_id());

create policy "license_policy_owner_write"
  on public.license_policies for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'));

grant select, insert, update, delete on public.license_policies to authenticated;

-- ─── License reminders log ───────────────────────────────────────────────

create table public.license_reminders (
  id              uuid        primary key default gen_random_uuid(),
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  driver_id       uuid        not null references public.drivers(id) on delete cascade,
  threshold_days  int,                                -- 30, 14, etc; null = manual resend
  expiry_date     date        not null,                -- snapshot of driver's license_expiry at send time
  channel         text        not null default 'sms',
  sent_at         timestamptz not null default now(),
  sms_message_id  uuid        references public.sms_messages(id),
  outcome         text        not null default 'sent'
                  check (outcome in ('sent','delivered','failed','opted_out'))
);

create index license_reminders_driver_idx
  on public.license_reminders (dsp_id, driver_id, expiry_date desc);

comment on table public.license_reminders is
  'Log of every license-renewal reminder fired. Used to dedupe sends ' ||
  '(don''t fire 30d twice for the same expiry) and to render history in UI.';

alter table public.license_reminders enable row level security;

create policy "license_reminders_tenant_select"
  on public.license_reminders for select
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or driver_id = private.current_driver_id()
    )
  );

-- Inserts only via the run-license-reminders Edge Function (service role)
revoke all on public.license_reminders from public, anon, authenticated;
grant select on public.license_reminders to authenticated;

-- ─── Form templates (inspections, incidents, etc.) ───────────────────────

create table public.form_templates (
  id            uuid        primary key default gen_random_uuid(),
  dsp_id        uuid        not null references public.dsps(id) on delete cascade,
  name          text        not null,
  trigger_type  text        check (trigger_type in
                  ('pre_trip','post_trip','incident','maintenance','onboarding','custom')),
  schema        jsonb       not null,
                -- { fields: [{id, label, type, required, options, conditional_logic}, ...] }
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid        references public.app_users(id)
);

create index form_templates_dsp_active_idx
  on public.form_templates (dsp_id, trigger_type) where active = true;

create trigger trg_form_templates_updated_at
  before update on public.form_templates
  for each row execute function moddatetime(updated_at);

alter table public.form_templates enable row level security;

create policy "form_templates_tenant_select"
  on public.form_templates for select
  using (dsp_id = private.current_dsp_id());

create policy "form_templates_ops_write"
  on public.form_templates for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update, delete on public.form_templates to authenticated;

-- ─── Form submissions (inspections etc.) ────────────────────────────────

create table public.form_submissions (
  id                  uuid        primary key default gen_random_uuid(),
  dsp_id              uuid        not null references public.dsps(id) on delete cascade,
  form_template_id    uuid        not null references public.form_templates(id) on delete cascade,
  driver_id           uuid        references public.drivers(id) on delete set null,
  vehicle_id          uuid,                                       -- FK added in Phase 6 fleet migration
  shift_id            uuid        references public.shifts(id) on delete set null,
  responses           jsonb       not null default '{}'::jsonb,
                      -- { field_id: value, ... }
  attached_files      text[],                                     -- Storage paths
  gps_lat             numeric(10,7),
  gps_lng             numeric(10,7),
  flagged             boolean     not null default false,
                      -- True if any response indicates a problem (e.g. damage)
  reviewed_by         uuid        references public.app_users(id),
  reviewed_at         timestamptz,
  reviewer_notes      text,
  created_at          timestamptz not null default now()
);

create index form_submissions_driver_idx
  on public.form_submissions (dsp_id, driver_id, created_at desc);
create index form_submissions_flagged_idx
  on public.form_submissions (dsp_id, flagged) where flagged = true;
create index form_submissions_unreviewed_idx
  on public.form_submissions (dsp_id, created_at desc) where reviewed_at is null;

comment on table public.form_submissions is
  'Pre-trip / post-trip / incident submissions from drivers. Photos / ' ||
  'videos in attached_files (Storage paths). flagged=true surfaces in ' ||
  'the dashboard action queue for review.';

alter table public.form_submissions enable row level security;

-- Read: dispatcher+ in DSP, OR the submitting driver themselves
create policy "form_subs_tenant_select"
  on public.form_submissions for select
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or driver_id = private.current_driver_id()
    )
  );

-- Insert: dispatcher+ on driver's behalf, OR the driver themselves (mobile app)
create policy "form_subs_driver_or_staff_insert"
  on public.form_submissions for insert
  with check (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or driver_id = private.current_driver_id()
    )
  );

-- Update: ops+ only (review notes, flagged status, etc.)
create policy "form_subs_ops_update"
  on public.form_submissions for update
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update on public.form_submissions to authenticated;

-- ─── Checklists (recurring tasks) ────────────────────────────────────────

create table public.checklist_templates (
  id          uuid        primary key default gen_random_uuid(),
  dsp_id      uuid        not null references public.dsps(id) on delete cascade,
  name        text        not null,
  cadence     text        not null
              check (cadence in ('daily','weekly','monthly','shift_open','shift_close')),
  items       jsonb       not null default '[]'::jsonb,
              -- [{ id, label, required, completion_rule }, ...]
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_checklist_templates_updated_at
  before update on public.checklist_templates
  for each row execute function moddatetime(updated_at);

alter table public.checklist_templates enable row level security;

create policy "checklist_templates_tenant_select"
  on public.checklist_templates for select
  using (dsp_id = private.current_dsp_id());

create policy "checklist_templates_ops_write"
  on public.checklist_templates for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update, delete on public.checklist_templates to authenticated;

create table public.checklist_runs (
  id              uuid        primary key default gen_random_uuid(),
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  template_id     uuid        not null references public.checklist_templates(id) on delete cascade,
  due_date        date        not null,
  completed_at    timestamptz,
  completed_by    uuid        references public.app_users(id),
  responses       jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),

  unique (template_id, due_date)
);

create index checklist_runs_dsp_due_idx
  on public.checklist_runs (dsp_id, due_date desc);
create index checklist_runs_pending_idx
  on public.checklist_runs (dsp_id, due_date) where completed_at is null;

alter table public.checklist_runs enable row level security;

create policy "checklist_runs_tenant_select"
  on public.checklist_runs for select
  using (dsp_id = private.current_dsp_id());

create policy "checklist_runs_dispatcher_write"
  on public.checklist_runs for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

grant select, insert, update, delete on public.checklist_runs to authenticated;
