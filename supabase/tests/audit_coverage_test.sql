-- supabase/tests/audit_coverage_test.sql
--
-- Regression test for migration 0454 (audit coverage on time_off_requests,
-- receipt_uploads, coachings). Runs against a fully-migrated DB (the
-- migration-check.yml harness).
--
--   1. Structural  — all three audit triggers are wired.
--   2. Behavioral  — an INSERT into time_off_requests actually writes an
--      audit_events row. To fire the audit trigger in isolation (without
--      standing up the whole drivers/app_users FK chain and their own
--      triggers), we run under session_replication_role=replica — which skips
--      FK + ordinary triggers — and mark just the audit trigger ENABLE ALWAYS
--      so it still fires. Both are transaction-local and revert on rollback.
--
-- Run locally from the repo root against any migrated DB:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/audit_coverage_test.sql
--
-- One transaction, rolled back at the end — no residue.

\set ON_ERROR_STOP on

begin;

-- ── 1. Structural: the three triggers exist ───────────────────────────────
do $$
declare missing text;
begin
  select string_agg(x.t, ', ') into missing
  from (select unnest(array['time_off_requests','receipt_uploads','coachings']) as t) x
  where not exists (
    select 1 from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = x.t
      and tg.tgname = 'trg_audit_' || x.t
  );
  assert missing is null, 'missing audit trigger(s) on: ' || coalesce(missing, '');
end $$;

-- ── 2. Behavioral: insert → audit_events row ──────────────────────────────
set local session_replication_role = replica;  -- skip FK + ordinary triggers

insert into public.dsps (id, name, short_code, slug)
values ('dddd4444-0000-4000-8000-000000000001', 'RR Audit DSP', 'RRAUD', 'rr-aud-test');

-- Fire the audit trigger even under replica mode (reverts on rollback).
alter table public.time_off_requests enable always trigger trg_audit_time_off_requests;

insert into public.time_off_requests (dsp_id, driver_id, start_date, end_date, status)
values ('dddd4444-0000-4000-8000-000000000001',
        'dddd4444-0000-4000-8000-000000000002',   -- FK to drivers skipped under replica
        current_date, current_date, 'pending');

do $$
begin
  assert (select count(*) from public.audit_events
          where dsp_id      = 'dddd4444-0000-4000-8000-000000000001'
            and object_type = 'time_off_requests'
            and action      = 'insert') = 1,
    'insert into time_off_requests should write exactly one audit_events row';
end $$;

rollback;
