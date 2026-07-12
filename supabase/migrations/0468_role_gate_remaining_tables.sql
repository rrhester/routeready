-- Migration 0468 · Finish intra-tenant role gates on the remaining
-- HR / hiring / compliance / fleet / messaging / config tables.
--
-- WHY
-- ───
-- 0445 role-gated drivers/shifts/time_off; 0452 covered hiring_targets +
-- route_forecasts; 0453 covered compliance dismissals. But ~30 more tables
-- still carried their original
--     for all using (dsp_id = private.current_dsp_id())
-- policies from the early migrations (0002/0013/0021/0038/0227/…). That
-- isolates tenants correctly, but INSIDE a tenant every authenticated
-- app_user — including the role='driver' signup default (0005) — could
-- INSERT/UPDATE/DELETE applicant PII, I-9 / driver documents, coaching
-- (disciplinary) records, DOT / FMCSA compliance rows, the outbound
-- email/SMS queues, and scheduling config. This finishes B7 from the
-- 2026-07 product audit by bringing them all up to the 0445 standard.
--
-- WHAT CHANGES (per table)
-- ────────────────────────
--   · SELECT stays tenant-wide  (any active app_user in the DSP).
--   · INSERT / UPDATE / DELETE now require is_staff(dsp_id,'dispatcher')
--     — dispatcher, ops, or owner. role='driver' app_users become
--     read-only on these tables.
--
-- WHO IS UNAFFECTED
-- ─────────────────
--   · The driver PWA — it holds no Supabase session; every write goes
--     through SECURITY DEFINER RPCs (screening_submit, send_*_link, the
--     attendance/coaching RPCs) or a service-role edge function
--     (upload-driver-photo, send-email, send-sms), all of which bypass RLS.
--   · Applicant screening — screening_load / screening_submit are
--     SECURITY DEFINER and granted to anon; the direct-table policy
--     changed here is not on that path.
--   · Invited team members — the invite flow (0076) grants dispatcher+.
--
-- ⚠ PREFLIGHT — same as 0445: make sure real operators are not stranded at
-- role='driver' (the 0005 default when the email was not a pending_owner):
--
--     select email, role, active from public.app_users
--     where active order by role, email;
--     update public.app_users set role='dispatcher' where email='person@example.com';
--
-- Idempotent: drop policy if exists / create; safe to re-run.

-- ─── applicants ───────────────────────────────────────────────
drop policy if exists "applicants_tenant_rw" on public.applicants;

drop policy if exists "applicants_tenant_select" on public.applicants;
create policy "applicants_tenant_select"
  on public.applicants for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "applicants_staff_insert" on public.applicants;
create policy "applicants_staff_insert"
  on public.applicants for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "applicants_staff_update" on public.applicants;
create policy "applicants_staff_update"
  on public.applicants for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "applicants_staff_delete" on public.applicants;
create policy "applicants_staff_delete"
  on public.applicants for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── applicant_status_changes ───────────────────────────────────────────────
drop policy if exists "applicant_status_changes_tenant_rw" on public.applicant_status_changes;

drop policy if exists "applicant_status_changes_tenant_select" on public.applicant_status_changes;
create policy "applicant_status_changes_tenant_select"
  on public.applicant_status_changes for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "applicant_status_changes_staff_insert" on public.applicant_status_changes;
create policy "applicant_status_changes_staff_insert"
  on public.applicant_status_changes for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "applicant_status_changes_staff_update" on public.applicant_status_changes;
create policy "applicant_status_changes_staff_update"
  on public.applicant_status_changes for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "applicant_status_changes_staff_delete" on public.applicant_status_changes;
create policy "applicant_status_changes_staff_delete"
  on public.applicant_status_changes for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── attendance_decisions ───────────────────────────────────────────────
drop policy if exists "attendance_decisions_tenant_rw" on public.attendance_decisions;

drop policy if exists "attendance_decisions_tenant_select" on public.attendance_decisions;
create policy "attendance_decisions_tenant_select"
  on public.attendance_decisions for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "attendance_decisions_staff_insert" on public.attendance_decisions;
create policy "attendance_decisions_staff_insert"
  on public.attendance_decisions for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "attendance_decisions_staff_update" on public.attendance_decisions;
create policy "attendance_decisions_staff_update"
  on public.attendance_decisions for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "attendance_decisions_staff_delete" on public.attendance_decisions;
create policy "attendance_decisions_staff_delete"
  on public.attendance_decisions for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── availability_settings ───────────────────────────────────────────────
drop policy if exists "availability_settings_tenant_rw" on public.availability_settings;

drop policy if exists "availability_settings_tenant_select" on public.availability_settings;
create policy "availability_settings_tenant_select"
  on public.availability_settings for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "availability_settings_staff_insert" on public.availability_settings;
create policy "availability_settings_staff_insert"
  on public.availability_settings for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "availability_settings_staff_update" on public.availability_settings;
create policy "availability_settings_staff_update"
  on public.availability_settings for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "availability_settings_staff_delete" on public.availability_settings;
create policy "availability_settings_staff_delete"
  on public.availability_settings for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── cal_events ───────────────────────────────────────────────
drop policy if exists "cal_events_tenant_rw" on public.cal_events;

drop policy if exists "cal_events_tenant_select" on public.cal_events;
create policy "cal_events_tenant_select"
  on public.cal_events for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "cal_events_staff_insert" on public.cal_events;
create policy "cal_events_staff_insert"
  on public.cal_events for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "cal_events_staff_update" on public.cal_events;
create policy "cal_events_staff_update"
  on public.cal_events for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "cal_events_staff_delete" on public.cal_events;
create policy "cal_events_staff_delete"
  on public.cal_events for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── calendars ───────────────────────────────────────────────
drop policy if exists "calendars_tenant_rw" on public.calendars;

drop policy if exists "calendars_tenant_select" on public.calendars;
create policy "calendars_tenant_select"
  on public.calendars for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "calendars_staff_insert" on public.calendars;
create policy "calendars_staff_insert"
  on public.calendars for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "calendars_staff_update" on public.calendars;
create policy "calendars_staff_update"
  on public.calendars for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "calendars_staff_delete" on public.calendars;
create policy "calendars_staff_delete"
  on public.calendars for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── coachings ───────────────────────────────────────────────
drop policy if exists "coachings_tenant_rw" on public.coachings;

drop policy if exists "coachings_tenant_select" on public.coachings;
create policy "coachings_tenant_select"
  on public.coachings for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "coachings_staff_insert" on public.coachings;
create policy "coachings_staff_insert"
  on public.coachings for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "coachings_staff_update" on public.coachings;
create policy "coachings_staff_update"
  on public.coachings for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "coachings_staff_delete" on public.coachings;
create policy "coachings_staff_delete"
  on public.coachings for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── compliance_cures ───────────────────────────────────────────────
drop policy if exists "compliance_cures_rw" on public.compliance_cures;

drop policy if exists "compliance_cures_tenant_select" on public.compliance_cures;
create policy "compliance_cures_tenant_select"
  on public.compliance_cures for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "compliance_cures_staff_insert" on public.compliance_cures;
create policy "compliance_cures_staff_insert"
  on public.compliance_cures for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "compliance_cures_staff_update" on public.compliance_cures;
create policy "compliance_cures_staff_update"
  on public.compliance_cures for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "compliance_cures_staff_delete" on public.compliance_cures;
create policy "compliance_cures_staff_delete"
  on public.compliance_cures for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── compliance_documents ───────────────────────────────────────────────
drop policy if exists "compliance_documents_rw" on public.compliance_documents;

drop policy if exists "compliance_documents_tenant_select" on public.compliance_documents;
create policy "compliance_documents_tenant_select"
  on public.compliance_documents for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "compliance_documents_staff_insert" on public.compliance_documents;
create policy "compliance_documents_staff_insert"
  on public.compliance_documents for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "compliance_documents_staff_update" on public.compliance_documents;
create policy "compliance_documents_staff_update"
  on public.compliance_documents for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "compliance_documents_staff_delete" on public.compliance_documents;
create policy "compliance_documents_staff_delete"
  on public.compliance_documents for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── compliance_monitors ───────────────────────────────────────────────
drop policy if exists "compliance_monitors_rw" on public.compliance_monitors;

drop policy if exists "compliance_monitors_tenant_select" on public.compliance_monitors;
create policy "compliance_monitors_tenant_select"
  on public.compliance_monitors for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "compliance_monitors_staff_insert" on public.compliance_monitors;
create policy "compliance_monitors_staff_insert"
  on public.compliance_monitors for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "compliance_monitors_staff_update" on public.compliance_monitors;
create policy "compliance_monitors_staff_update"
  on public.compliance_monitors for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "compliance_monitors_staff_delete" on public.compliance_monitors;
create policy "compliance_monitors_staff_delete"
  on public.compliance_monitors for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── drive_documents ───────────────────────────────────────────────
drop policy if exists "drive_documents_tenant_rw" on public.drive_documents;

drop policy if exists "drive_documents_tenant_select" on public.drive_documents;
create policy "drive_documents_tenant_select"
  on public.drive_documents for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "drive_documents_staff_insert" on public.drive_documents;
create policy "drive_documents_staff_insert"
  on public.drive_documents for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "drive_documents_staff_update" on public.drive_documents;
create policy "drive_documents_staff_update"
  on public.drive_documents for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "drive_documents_staff_delete" on public.drive_documents;
create policy "drive_documents_staff_delete"
  on public.drive_documents for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── drive_folders ───────────────────────────────────────────────
drop policy if exists "drive_folders_tenant_rw" on public.drive_folders;

drop policy if exists "drive_folders_tenant_select" on public.drive_folders;
create policy "drive_folders_tenant_select"
  on public.drive_folders for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "drive_folders_staff_insert" on public.drive_folders;
create policy "drive_folders_staff_insert"
  on public.drive_folders for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "drive_folders_staff_update" on public.drive_folders;
create policy "drive_folders_staff_update"
  on public.drive_folders for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "drive_folders_staff_delete" on public.drive_folders;
create policy "drive_folders_staff_delete"
  on public.drive_folders for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── driver_documents ───────────────────────────────────────────────
drop policy if exists "driver_documents_tenant_rw" on public.driver_documents;

drop policy if exists "driver_documents_tenant_select" on public.driver_documents;
create policy "driver_documents_tenant_select"
  on public.driver_documents for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "driver_documents_staff_insert" on public.driver_documents;
create policy "driver_documents_staff_insert"
  on public.driver_documents for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "driver_documents_staff_update" on public.driver_documents;
create policy "driver_documents_staff_update"
  on public.driver_documents for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "driver_documents_staff_delete" on public.driver_documents;
create policy "driver_documents_staff_delete"
  on public.driver_documents for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── dsp_hiring_settings ───────────────────────────────────────────────
drop policy if exists "dsp_hiring_settings_tenant_rw" on public.dsp_hiring_settings;

drop policy if exists "dsp_hiring_settings_tenant_select" on public.dsp_hiring_settings;
create policy "dsp_hiring_settings_tenant_select"
  on public.dsp_hiring_settings for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "dsp_hiring_settings_staff_insert" on public.dsp_hiring_settings;
create policy "dsp_hiring_settings_staff_insert"
  on public.dsp_hiring_settings for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "dsp_hiring_settings_staff_update" on public.dsp_hiring_settings;
create policy "dsp_hiring_settings_staff_update"
  on public.dsp_hiring_settings for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "dsp_hiring_settings_staff_delete" on public.dsp_hiring_settings;
create policy "dsp_hiring_settings_staff_delete"
  on public.dsp_hiring_settings for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── email_messages ───────────────────────────────────────────────
drop policy if exists "email_messages_tenant_rw" on public.email_messages;

drop policy if exists "email_messages_tenant_select" on public.email_messages;
create policy "email_messages_tenant_select"
  on public.email_messages for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "email_messages_staff_insert" on public.email_messages;
create policy "email_messages_staff_insert"
  on public.email_messages for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "email_messages_staff_update" on public.email_messages;
create policy "email_messages_staff_update"
  on public.email_messages for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "email_messages_staff_delete" on public.email_messages;
create policy "email_messages_staff_delete"
  on public.email_messages for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── fmcsa_records ───────────────────────────────────────────────
drop policy if exists "fmcsa_records_rw" on public.fmcsa_records;

drop policy if exists "fmcsa_records_tenant_select" on public.fmcsa_records;
create policy "fmcsa_records_tenant_select"
  on public.fmcsa_records for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "fmcsa_records_staff_insert" on public.fmcsa_records;
create policy "fmcsa_records_staff_insert"
  on public.fmcsa_records for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "fmcsa_records_staff_update" on public.fmcsa_records;
create policy "fmcsa_records_staff_update"
  on public.fmcsa_records for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "fmcsa_records_staff_delete" on public.fmcsa_records;
create policy "fmcsa_records_staff_delete"
  on public.fmcsa_records for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── interview_days ───────────────────────────────────────────────
drop policy if exists "interview_days_tenant_rw" on public.interview_days;

drop policy if exists "interview_days_tenant_select" on public.interview_days;
create policy "interview_days_tenant_select"
  on public.interview_days for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "interview_days_staff_insert" on public.interview_days;
create policy "interview_days_staff_insert"
  on public.interview_days for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "interview_days_staff_update" on public.interview_days;
create policy "interview_days_staff_update"
  on public.interview_days for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "interview_days_staff_delete" on public.interview_days;
create policy "interview_days_staff_delete"
  on public.interview_days for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── interview_outcomes ───────────────────────────────────────────────
drop policy if exists "interview_outcomes_tenant_rw" on public.interview_outcomes;

drop policy if exists "interview_outcomes_tenant_select" on public.interview_outcomes;
create policy "interview_outcomes_tenant_select"
  on public.interview_outcomes for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "interview_outcomes_staff_insert" on public.interview_outcomes;
create policy "interview_outcomes_staff_insert"
  on public.interview_outcomes for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "interview_outcomes_staff_update" on public.interview_outcomes;
create policy "interview_outcomes_staff_update"
  on public.interview_outcomes for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "interview_outcomes_staff_delete" on public.interview_outcomes;
create policy "interview_outcomes_staff_delete"
  on public.interview_outcomes for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── message_templates ───────────────────────────────────────────────
drop policy if exists "message_templates_tenant_rw" on public.message_templates;

drop policy if exists "message_templates_tenant_select" on public.message_templates;
create policy "message_templates_tenant_select"
  on public.message_templates for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "message_templates_staff_insert" on public.message_templates;
create policy "message_templates_staff_insert"
  on public.message_templates for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "message_templates_staff_update" on public.message_templates;
create policy "message_templates_staff_update"
  on public.message_templates for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "message_templates_staff_delete" on public.message_templates;
create policy "message_templates_staff_delete"
  on public.message_templates for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── okami_demand ───────────────────────────────────────────────
drop policy if exists "okami_demand_tenant_rw" on public.okami_demand;

drop policy if exists "okami_demand_tenant_select" on public.okami_demand;
create policy "okami_demand_tenant_select"
  on public.okami_demand for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "okami_demand_staff_insert" on public.okami_demand;
create policy "okami_demand_staff_insert"
  on public.okami_demand for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "okami_demand_staff_update" on public.okami_demand;
create policy "okami_demand_staff_update"
  on public.okami_demand for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "okami_demand_staff_delete" on public.okami_demand;
create policy "okami_demand_staff_delete"
  on public.okami_demand for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── repair_orders ───────────────────────────────────────────────
drop policy if exists "repair_orders_rw" on public.repair_orders;

drop policy if exists "repair_orders_tenant_select" on public.repair_orders;
create policy "repair_orders_tenant_select"
  on public.repair_orders for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "repair_orders_staff_insert" on public.repair_orders;
create policy "repair_orders_staff_insert"
  on public.repair_orders for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "repair_orders_staff_update" on public.repair_orders;
create policy "repair_orders_staff_update"
  on public.repair_orders for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "repair_orders_staff_delete" on public.repair_orders;
create policy "repair_orders_staff_delete"
  on public.repair_orders for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── scheduling_settings ───────────────────────────────────────────────
drop policy if exists "scheduling_settings_tenant_rw" on public.scheduling_settings;

drop policy if exists "scheduling_settings_tenant_select" on public.scheduling_settings;
create policy "scheduling_settings_tenant_select"
  on public.scheduling_settings for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "scheduling_settings_staff_insert" on public.scheduling_settings;
create policy "scheduling_settings_staff_insert"
  on public.scheduling_settings for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "scheduling_settings_staff_update" on public.scheduling_settings;
create policy "scheduling_settings_staff_update"
  on public.scheduling_settings for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "scheduling_settings_staff_delete" on public.scheduling_settings;
create policy "scheduling_settings_staff_delete"
  on public.scheduling_settings for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── screening_questions ───────────────────────────────────────────────
drop policy if exists "screening_questions_tenant_rw" on public.screening_questions;

drop policy if exists "screening_questions_tenant_select" on public.screening_questions;
create policy "screening_questions_tenant_select"
  on public.screening_questions for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "screening_questions_staff_insert" on public.screening_questions;
create policy "screening_questions_staff_insert"
  on public.screening_questions for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "screening_questions_staff_update" on public.screening_questions;
create policy "screening_questions_staff_update"
  on public.screening_questions for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "screening_questions_staff_delete" on public.screening_questions;
create policy "screening_questions_staff_delete"
  on public.screening_questions for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── screening_responses ───────────────────────────────────────────────
drop policy if exists "screening_responses_tenant_rw" on public.screening_responses;

drop policy if exists "screening_responses_tenant_select" on public.screening_responses;
create policy "screening_responses_tenant_select"
  on public.screening_responses for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "screening_responses_staff_insert" on public.screening_responses;
create policy "screening_responses_staff_insert"
  on public.screening_responses for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "screening_responses_staff_update" on public.screening_responses;
create policy "screening_responses_staff_update"
  on public.screening_responses for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "screening_responses_staff_delete" on public.screening_responses;
create policy "screening_responses_staff_delete"
  on public.screening_responses for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── service_types ───────────────────────────────────────────────
drop policy if exists "service_types_tenant_rw" on public.service_types;

drop policy if exists "service_types_tenant_select" on public.service_types;
create policy "service_types_tenant_select"
  on public.service_types for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "service_types_staff_insert" on public.service_types;
create policy "service_types_staff_insert"
  on public.service_types for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "service_types_staff_update" on public.service_types;
create policy "service_types_staff_update"
  on public.service_types for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "service_types_staff_delete" on public.service_types;
create policy "service_types_staff_delete"
  on public.service_types for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── sms_messages ───────────────────────────────────────────────
drop policy if exists "sms_messages_tenant_rw" on public.sms_messages;

drop policy if exists "sms_messages_tenant_select" on public.sms_messages;
create policy "sms_messages_tenant_select"
  on public.sms_messages for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "sms_messages_staff_insert" on public.sms_messages;
create policy "sms_messages_staff_insert"
  on public.sms_messages for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "sms_messages_staff_update" on public.sms_messages;
create policy "sms_messages_staff_update"
  on public.sms_messages for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "sms_messages_staff_delete" on public.sms_messages;
create policy "sms_messages_staff_delete"
  on public.sms_messages for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── vehicle_grounding_events ───────────────────────────────────────────────
drop policy if exists "vehicle_grounding_events_rw" on public.vehicle_grounding_events;

drop policy if exists "vehicle_grounding_events_tenant_select" on public.vehicle_grounding_events;
create policy "vehicle_grounding_events_tenant_select"
  on public.vehicle_grounding_events for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "vehicle_grounding_events_staff_insert" on public.vehicle_grounding_events;
create policy "vehicle_grounding_events_staff_insert"
  on public.vehicle_grounding_events for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "vehicle_grounding_events_staff_update" on public.vehicle_grounding_events;
create policy "vehicle_grounding_events_staff_update"
  on public.vehicle_grounding_events for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "vehicle_grounding_events_staff_delete" on public.vehicle_grounding_events;
create policy "vehicle_grounding_events_staff_delete"
  on public.vehicle_grounding_events for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── vendors ───────────────────────────────────────────────
drop policy if exists "vendors_rw" on public.vendors;

drop policy if exists "vendors_tenant_select" on public.vendors;
create policy "vendors_tenant_select"
  on public.vendors for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "vendors_staff_insert" on public.vendors;
create policy "vendors_staff_insert"
  on public.vendors for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "vendors_staff_update" on public.vendors;
create policy "vendors_staff_update"
  on public.vendors for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "vendors_staff_delete" on public.vendors;
create policy "vendors_staff_delete"
  on public.vendors for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── weather_snapshots ───────────────────────────────────────────────
drop policy if exists "weather_snapshots_tenant_rw" on public.weather_snapshots;

drop policy if exists "weather_snapshots_tenant_select" on public.weather_snapshots;
create policy "weather_snapshots_tenant_select"
  on public.weather_snapshots for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "weather_snapshots_staff_insert" on public.weather_snapshots;
create policy "weather_snapshots_staff_insert"
  on public.weather_snapshots for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "weather_snapshots_staff_update" on public.weather_snapshots;
create policy "weather_snapshots_staff_update"
  on public.weather_snapshots for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "weather_snapshots_staff_delete" on public.weather_snapshots;
create policy "weather_snapshots_staff_delete"
  on public.weather_snapshots for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── coaching_attachments (scoped via parent coachings) ──────────────
drop policy if exists "coaching_attachments_tenant_rw" on public.coaching_attachments;

drop policy if exists "coaching_attachments_tenant_select" on public.coaching_attachments;
create policy "coaching_attachments_tenant_select"
  on public.coaching_attachments for select
  to authenticated
  using (exists (select 1 from public.coachings c
                  where c.id = coaching_attachments.coaching_id
                    and c.dsp_id = private.current_dsp_id()));

drop policy if exists "coaching_attachments_staff_write" on public.coaching_attachments;
create policy "coaching_attachments_staff_write"
  on public.coaching_attachments for all
  to authenticated
  using (private.is_staff(private.current_dsp_id(), 'dispatcher')
         and exists (select 1 from public.coachings c
                      where c.id = coaching_attachments.coaching_id
                        and c.dsp_id = private.current_dsp_id()))
  with check (private.is_staff(private.current_dsp_id(), 'dispatcher')
              and exists (select 1 from public.coachings c
                           where c.id = coaching_attachments.coaching_id
                             and c.dsp_id = private.current_dsp_id()));

-- ─── compliance_cure_links (scoped via parent compliance_cures) ──────
drop policy if exists "compliance_cure_links_rw" on public.compliance_cure_links;

drop policy if exists "compliance_cure_links_select" on public.compliance_cure_links;
create policy "compliance_cure_links_select"
  on public.compliance_cure_links for select
  to authenticated
  using (exists (select 1 from public.compliance_cures c
                  where c.id = cure_id and c.dsp_id = private.current_dsp_id()));

drop policy if exists "compliance_cure_links_staff_write" on public.compliance_cure_links;
create policy "compliance_cure_links_staff_write"
  on public.compliance_cure_links for all
  to authenticated
  using (private.is_staff(private.current_dsp_id(), 'dispatcher')
         and exists (select 1 from public.compliance_cures c
                      where c.id = cure_id and c.dsp_id = private.current_dsp_id()))
  with check (private.is_staff(private.current_dsp_id(), 'dispatcher')
              and exists (select 1 from public.compliance_cures c
                           where c.id = cure_id and c.dsp_id = private.current_dsp_id()));

-- ─── compliance_cure_steps (scoped via parent compliance_cures) ──────
drop policy if exists "compliance_cure_steps_rw" on public.compliance_cure_steps;

drop policy if exists "compliance_cure_steps_select" on public.compliance_cure_steps;
create policy "compliance_cure_steps_select"
  on public.compliance_cure_steps for select
  to authenticated
  using (exists (select 1 from public.compliance_cures c
                  where c.id = cure_id and c.dsp_id = private.current_dsp_id()));

drop policy if exists "compliance_cure_steps_staff_write" on public.compliance_cure_steps;
create policy "compliance_cure_steps_staff_write"
  on public.compliance_cure_steps for all
  to authenticated
  using (private.is_staff(private.current_dsp_id(), 'dispatcher')
         and exists (select 1 from public.compliance_cures c
                      where c.id = cure_id and c.dsp_id = private.current_dsp_id()))
  with check (private.is_staff(private.current_dsp_id(), 'dispatcher')
              and exists (select 1 from public.compliance_cures c
                           where c.id = cure_id and c.dsp_id = private.current_dsp_id()));

notify pgrst, 'reload schema';
