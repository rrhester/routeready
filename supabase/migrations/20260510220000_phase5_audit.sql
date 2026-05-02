-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510220000 · Phase 5 audit triggers
-- ─────────────────────────────────────────────────────────────────────────

create trigger trg_audit_license_policies
  after insert or update or delete on public.license_policies
  for each row execute function private.fn_audit_log();

create trigger trg_audit_license_reminders
  after insert on public.license_reminders
  for each row execute function private.fn_audit_log();

create trigger trg_audit_form_templates
  after insert or update or delete on public.form_templates
  for each row execute function private.fn_audit_log();

create trigger trg_audit_form_submissions
  after insert or update or delete on public.form_submissions
  for each row execute function private.fn_audit_log();

create trigger trg_audit_checklist_templates
  after insert or update or delete on public.checklist_templates
  for each row execute function private.fn_audit_log();

create trigger trg_audit_checklist_runs
  after insert or update or delete on public.checklist_runs
  for each row execute function private.fn_audit_log();
