-- supabase/tests/role_gate_compliance_test.sql
--
-- Server-side RLS + RPC regression tests for migration 0453 (intra-tenant
-- role gate on compliance_dismissals). Runs against a fully-migrated DB (the
-- migration-check.yml harness). Drops to the real `authenticated` role so
-- RLS is enforced exactly as PostgREST enforces it in production.
--
-- What it proves:
--   • a role='driver' app_user CANNOT insert compliance_dismissals directly
--     (RLS) and CANNOT dismiss via the compliance_dismiss() RPC (is_staff
--     guard) — the pre-0453 hole on both surfaces;
--   • a role='dispatcher' app_user CAN do both.
--
-- Run locally from the repo root against any migrated DB:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/role_gate_compliance_test.sql
--
-- One transaction, rolled back at the end — no residue.

\set ON_ERROR_STOP on

begin;

set local session_replication_role = replica;  -- skip FK-to-auth.users + triggers

-- ── Fixtures (created as the superuser role — RLS bypassed for us here) ────
insert into public.dsps (id, name, short_code, slug) values
  ('cccc3333-0000-4000-8000-000000000001', 'RR Compliance DSP', 'RRCMP', 'rr-cmp-test');

insert into public.app_users (id, dsp_id, email, full_name, role, active) values
  ('cccc3333-0000-4000-8000-000000000002', 'cccc3333-0000-4000-8000-000000000001',
   'disp@rrcmp.test', 'Dispatcher', 'dispatcher', true),
  ('cccc3333-0000-4000-8000-000000000003', 'cccc3333-0000-4000-8000-000000000001',
   'drv@rrcmp.test',  'Driver',     'driver',     true);

-- ═══ direct-table RLS ═════════════════════════════════════════════════════

-- Driver → direct INSERT must be DENIED by RLS.
select set_config('request.jwt.claim.sub', 'cccc3333-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims',
  '{"sub":"cccc3333-0000-4000-8000-000000000003","role":"authenticated"}', true);
set local role authenticated;
do $$
declare denied boolean := false;
begin
  begin
    insert into public.compliance_dismissals (dsp_id, exception_kind, expires_at)
    values ('cccc3333-0000-4000-8000-000000000001', 'grounded_no_ro', now() + interval '14 days');
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'driver direct INSERT into compliance_dismissals must be blocked by RLS';
end $$;
reset role;

-- Dispatcher → direct INSERT must SUCCEED.
select set_config('request.jwt.claim.sub', 'cccc3333-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims',
  '{"sub":"cccc3333-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
insert into public.compliance_dismissals (dsp_id, exception_kind, object_id, expires_at)
values ('cccc3333-0000-4000-8000-000000000001', 'vendor_stall', 'direct-ok', now() + interval '7 days');
do $$
begin
  assert (select count(*) from public.compliance_dismissals
          where dsp_id = 'cccc3333-0000-4000-8000-000000000001'
            and exception_kind = 'vendor_stall') = 1,
    'dispatcher direct INSERT into compliance_dismissals should succeed';
end $$;
reset role;

-- ═══ RPC (compliance_dismiss) is_staff guard ══════════════════════════════

-- Driver → RPC must raise forbidden (42501 → insufficient_privilege).
select set_config('request.jwt.claim.sub', 'cccc3333-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims',
  '{"sub":"cccc3333-0000-4000-8000-000000000003","role":"authenticated"}', true);
set local role authenticated;
do $$
declare denied boolean := false;
begin
  begin
    perform public.compliance_dismiss('grounded_no_ro',
      'cccc3333-0000-4000-8000-0000000000aa', 14);
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'driver compliance_dismiss() RPC call must be forbidden';
end $$;
reset role;

-- Dispatcher → RPC must succeed and record a dismissal.
select set_config('request.jwt.claim.sub', 'cccc3333-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims',
  '{"sub":"cccc3333-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r public.compliance_dismissals;
begin
  r := public.compliance_dismiss('repair_14bd_overdue',
    'cccc3333-0000-4000-8000-0000000000bb', 30);
  assert r.id is not null, 'dispatcher compliance_dismiss() should return a row';
  assert r.exception_kind = 'repair_14bd_overdue',
    'dispatcher compliance_dismiss() should record the dismissal';
end $$;
reset role;

rollback;
