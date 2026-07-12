-- supabase/tests/cross_tenant_isolation_test.sql
--
-- The single most important guarantee RouteReady makes to a paying DSP:
-- "your data is yours — no other tenant can read or write it." This test
-- PROVES that end-to-end with TWO live tenants, exactly the way PostgREST
-- enforces RLS for a logged-in dashboard user. It is the pre-flight for
-- customer #1 and a permanent regression guard against a future migration
-- quietly re-opening a cross-tenant hole.
--
-- Runs against a database with every migration applied (the migration-check.yml
-- CI harness). It drops to the real `authenticated` role so row-level security
-- is actually enforced (superusers bypass RLS, so a test run as superuser would
-- prove nothing).
--
-- What it proves, acting as Tenant A's owner against Tenant B's data, across a
-- representative cross-section of sensitive tables (driver PII, I-9 documents,
-- applicant PII, coaching/HR records, the SMS queue):
--   • READ isolation  — B's rows are invisible; A sees only its own.
--   • INSERT denial    — A cannot create rows in tenant B (with-check violation).
--   • UPDATE/DELETE isolation — A's writes against B's rows affect 0 rows.
--   • No false lock-out — A CAN still write its own tenant (so a passing test
--     means isolation WITHOUT breaking the product).
-- Then a symmetric spot-check proves B cannot see A.
--
-- Run locally from the repo root against any migrated DB:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/cross_tenant_isolation_test.sql
--
-- Everything runs in one transaction rolled back at the end — no residue.

\set ON_ERROR_STOP on

begin;

-- Skip FK enforcement to auth.users and side-effect / seed triggers while we
-- build fixtures as the superuser role. SET LOCAL — auto-restored on rollback.
-- RLS (the thing under test) is unaffected: it is enforced by role, not trigger,
-- and we exercise it only after dropping to `authenticated`.
set local session_replication_role = replica;

-- ── Two tenants, each with an owner + a full slice of sensitive data ────────
insert into public.dsps (id, name, short_code, slug) values
  ('aaaa1111-0000-4000-8000-000000000001', 'Tenant A', 'TENA', 'tenant-a-iso'),
  ('bbbb1111-0000-4000-8000-000000000001', 'Tenant B', 'TENB', 'tenant-b-iso');

insert into public.app_users (id, dsp_id, email, full_name, role, active) values
  ('aaaa1111-0000-4000-8000-000000000002', 'aaaa1111-0000-4000-8000-000000000001',
   'owner@tenant-a.test', 'Owner A', 'owner', true),
  ('bbbb1111-0000-4000-8000-000000000002', 'bbbb1111-0000-4000-8000-000000000001',
   'owner@tenant-b.test', 'Owner B', 'owner', true);

insert into public.drivers (id, dsp_id, full_name) values
  ('aaaa1111-0000-4000-8000-000000000003', 'aaaa1111-0000-4000-8000-000000000001', 'Alice · Tenant A driver'),
  ('bbbb1111-0000-4000-8000-000000000003', 'bbbb1111-0000-4000-8000-000000000001', 'Bob · Tenant B driver');

insert into public.driver_documents (id, dsp_id, driver_id, kind, label) values
  ('aaaa1111-0000-4000-8000-000000000004', 'aaaa1111-0000-4000-8000-000000000001',
   'aaaa1111-0000-4000-8000-000000000003', 'i9', 'Tenant A I-9'),
  ('bbbb1111-0000-4000-8000-000000000004', 'bbbb1111-0000-4000-8000-000000000001',
   'bbbb1111-0000-4000-8000-000000000003', 'i9', 'Tenant B I-9');

insert into public.applicants (id, dsp_id, full_name) values
  ('aaaa1111-0000-4000-8000-000000000005', 'aaaa1111-0000-4000-8000-000000000001', 'Applicant · Tenant A'),
  ('bbbb1111-0000-4000-8000-000000000005', 'bbbb1111-0000-4000-8000-000000000001', 'Applicant · Tenant B');

insert into public.coachings (id, dsp_id, driver_id) values
  ('aaaa1111-0000-4000-8000-000000000006', 'aaaa1111-0000-4000-8000-000000000001',
   'aaaa1111-0000-4000-8000-000000000003'),
  ('bbbb1111-0000-4000-8000-000000000006', 'bbbb1111-0000-4000-8000-000000000001',
   'bbbb1111-0000-4000-8000-000000000003');

insert into public.sms_messages (id, dsp_id, direction, to_phone, body) values
  ('aaaa1111-0000-4000-8000-000000000007', 'aaaa1111-0000-4000-8000-000000000001',
   'outbound', '+15550000001', 'Tenant A private message'),
  ('bbbb1111-0000-4000-8000-000000000007', 'bbbb1111-0000-4000-8000-000000000001',
   'outbound', '+15550000002', 'Tenant B private message');

-- ═══ Act as Tenant A's owner ═══════════════════════════════════════════════
-- Set the JWT sub (both carriers, matching the other RLS tests) so
-- private.current_dsp_id()/is_staff() resolve via auth.uid(), then drop to the
-- `authenticated` role so RLS is enforced.
select set_config('request.jwt.claim.sub', 'aaaa1111-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims',
  '{"sub":"aaaa1111-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  rc      int;
  denied  boolean;
begin
  -- ── READ isolation: B invisible, A visible ──────────────────────────────
  assert (select count(*) from public.drivers          where id = 'bbbb1111-0000-4000-8000-000000000003') = 0,
    'A must NOT see tenant B driver';
  assert (select count(*) from public.driver_documents where id = 'bbbb1111-0000-4000-8000-000000000004') = 0,
    'A must NOT see tenant B I-9 document';
  assert (select count(*) from public.applicants       where id = 'bbbb1111-0000-4000-8000-000000000005') = 0,
    'A must NOT see tenant B applicant';
  assert (select count(*) from public.coachings        where id = 'bbbb1111-0000-4000-8000-000000000006') = 0,
    'A must NOT see tenant B coaching record';
  assert (select count(*) from public.sms_messages     where id = 'bbbb1111-0000-4000-8000-000000000007') = 0,
    'A must NOT see tenant B SMS';

  -- Unqualified reads return ONLY A's rows (no accidental global visibility).
  assert (select count(*) from public.drivers)          = 1, 'A sees exactly its own drivers';
  assert (select count(*) from public.driver_documents) = 1, 'A sees exactly its own documents';

  -- Sanity: A DOES see its own data (guards against a false pass from an
  -- over-restrictive policy that hides everything).
  assert (select count(*) from public.drivers where id = 'aaaa1111-0000-4000-8000-000000000003') = 1,
    'A must see its OWN driver';

  -- ── INSERT denial: A cannot create rows in tenant B ─────────────────────
  denied := false;
  begin
    insert into public.drivers (dsp_id, full_name)
    values ('bbbb1111-0000-4000-8000-000000000001', 'cross-tenant driver (should fail)');
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'A INSERT into tenant B (drivers) must be blocked by RLS';

  denied := false;
  begin
    insert into public.sms_messages (dsp_id, direction, to_phone, body)
    values ('bbbb1111-0000-4000-8000-000000000001', 'outbound', '+15559999999', 'spoofed from A');
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'A INSERT into tenant B (sms_messages) must be blocked by RLS';

  -- ── UPDATE / DELETE of B's rows affect 0 rows (filtered out by RLS) ──────
  update public.drivers set full_name = 'tampered by A' where id = 'bbbb1111-0000-4000-8000-000000000003';
  get diagnostics rc = row_count;
  assert rc = 0, 'A UPDATE of tenant B driver must affect 0 rows';

  delete from public.driver_documents where id = 'bbbb1111-0000-4000-8000-000000000004';
  get diagnostics rc = row_count;
  assert rc = 0, 'A DELETE of tenant B I-9 document must affect 0 rows';

  -- ── No false lock-out: A CAN still write its OWN tenant ──────────────────
  insert into public.drivers (dsp_id, full_name)
  values ('aaaa1111-0000-4000-8000-000000000001', 'A legitimate new driver');
  get diagnostics rc = row_count;
  assert rc = 1, 'A must be able to INSERT into its OWN tenant';
end $$;
reset role;

-- ═══ Symmetric spot-check: Tenant B cannot see Tenant A ════════════════════
select set_config('request.jwt.claim.sub', 'bbbb1111-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims',
  '{"sub":"bbbb1111-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;

do $$
begin
  assert (select count(*) from public.drivers          where id = 'aaaa1111-0000-4000-8000-000000000003') = 0,
    'B must NOT see tenant A driver';
  assert (select count(*) from public.driver_documents where id = 'aaaa1111-0000-4000-8000-000000000004') = 0,
    'B must NOT see tenant A I-9 document';
  assert (select count(*) from public.sms_messages     where id = 'aaaa1111-0000-4000-8000-000000000007') = 0,
    'B must NOT see tenant A SMS';
  -- B still sees its own (proves the check above isn't a blanket empty read).
  assert (select count(*) from public.drivers where id = 'bbbb1111-0000-4000-8000-000000000003') = 1,
    'B must see its OWN driver';
end $$;
reset role;

rollback;

\echo 'cross_tenant_isolation_test: PASSED'
