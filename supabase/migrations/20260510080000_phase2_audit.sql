-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510080000 · Phase 2 audit triggers
-- Attaches the existing private.fn_audit_log() trigger function to the
-- new Phase 2 tables. HR events get an audit row even though the table
-- itself is append-only — the audit_log records WHO inserted what and
-- WHEN, useful for forensic review beyond the hr_events row itself.
-- ─────────────────────────────────────────────────────────────────────────

create trigger trg_audit_attendance_policies
  after insert or update or delete on public.attendance_policies
  for each row execute function private.fn_audit_log();

create trigger trg_audit_attendance_events
  after insert or update or delete on public.attendance_events
  for each row execute function private.fn_audit_log();

create trigger trg_audit_hr_events
  after insert on public.hr_events
  for each row execute function private.fn_audit_log();
-- No update/delete trigger on hr_events because RLS prevents both at the
-- policy level. If somehow they happen (service role), they should fail.

create trigger trg_audit_coaching_events
  after insert or update or delete on public.coaching_events
  for each row execute function private.fn_audit_log();

-- ─── Bonus index: audit log queries by driver ───────────────────────────
-- The HR file modal queries audit_log + hr_events together for a driver.
-- This index makes the join fast.
create index audit_log_driver_record_idx
  on public.audit_log (record_id, table_name, created_at desc)
  where record_id is not null;
