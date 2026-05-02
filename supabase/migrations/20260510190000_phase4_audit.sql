-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510190000 · Phase 4 audit triggers
-- Attaches the existing private.fn_audit_log() trigger to the new
-- Phase 4 tables. SMS messages get audited on insert + status updates;
-- applicants/screening/referrals on every change.
-- ─────────────────────────────────────────────────────────────────────────

create trigger trg_audit_applicants
  after insert or update or delete on public.applicants
  for each row execute function private.fn_audit_log();

create trigger trg_audit_screening_questions
  after insert or update or delete on public.screening_questions
  for each row execute function private.fn_audit_log();

create trigger trg_audit_screening_responses
  after insert or update or delete on public.screening_responses
  for each row execute function private.fn_audit_log();

create trigger trg_audit_referral_payouts
  after insert or update or delete on public.referral_payouts
  for each row execute function private.fn_audit_log();

create trigger trg_audit_sms_messages
  after insert or update on public.sms_messages
  for each row execute function private.fn_audit_log();

create trigger trg_audit_sms_opt_outs
  after insert or delete on public.sms_opt_outs
  for each row execute function private.fn_audit_log();
