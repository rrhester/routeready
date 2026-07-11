-- Migration 0454 · Extend the global audit log to time_off_requests,
-- receipt_uploads, and coachings.
--
-- WHY
-- ───
-- 0433 stood up the append-only audit_events trail but only wired triggers
-- onto drivers / app_users / driver_documents / shifts. The product audit
-- (§I) and the DSP launch audit flagged that time-off decisions, receipt
-- submissions/reconciliation, and coaching records — all HR/compliance
-- sensitive, all the kind of thing an owner gets asked about in a dispute —
-- are not captured. This closes that gap.
--
-- SAFE BY CONSTRUCTION
-- ────────────────────
-- Reuses the existing private.log_audit_event() (0433) verbatim. That
-- function is fully generic — it derives dsp_id/id from to_jsonb(row), skips
-- updated_at/created_at-only touches, and is FAIL-OPEN (any error in the
-- audit path RAISE WARNINGs and returns, so it can never roll back the real
-- write). All three target tables have id + dsp_id, so capture works
-- unchanged. This migration only attaches triggers — no schema or data change.
--
-- Unlike shifts (bulk schedule generation → INSERT skipped as noise), these
-- three are low-volume, one-at-a-time records, so INSERT is meaningful and
-- included. Driver-app writes that go through token RPCs have a NULL
-- auth.uid(), which the capture fn already records as actor_type='system'.
--
-- Reads are already covered: public.audit_feed(object_type, …) is generic, so
-- audit_feed('time_off_requests', …) / ('receipt_uploads', …) /
-- ('coachings', …) work with no RPC change.
--
-- Idempotent: drop trigger if exists / create. Safe to re-run.

drop trigger if exists trg_audit_time_off_requests on public.time_off_requests;
create trigger trg_audit_time_off_requests
  after insert or update or delete on public.time_off_requests
  for each row execute function private.log_audit_event();

drop trigger if exists trg_audit_receipt_uploads on public.receipt_uploads;
create trigger trg_audit_receipt_uploads
  after insert or update or delete on public.receipt_uploads
  for each row execute function private.log_audit_event();

drop trigger if exists trg_audit_coachings on public.coachings;
create trigger trg_audit_coachings
  after insert or update or delete on public.coachings
  for each row execute function private.log_audit_event();

notify pgrst, 'reload schema';
