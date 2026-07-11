-- supabase/tests/role_gate_planning_test.sql
--
-- Server-side RLS regression tests for migration 0452 (intra-tenant role
-- gates on hiring_targets + route_forecasts). Runs against a database with
-- every migration applied (the CI harness in migration-check.yml). Unlike
-- the RPC tests, this one drops to the real `authenticated` role so the
-- row-level security policies are actually enforced — exactly the way
-- PostgREST enforces them for a logged-in dashboard user.
--
-- What it proves:
--   • a role='driver' app_user CANNOT INSERT hiring_targets / route_forecasts
--     (the pre-0451 hole: any tenant member could write these directly);
--   • a role='dispatcher' app_user CAN.
--
-- Run locally from the repo root against any migrated DB:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/role_gate_planning_test.sql
--
-- Everything runs in one transaction rolled back at the end — no residue.

\set ON_ERROR_STOP on

begin;

-- Skip FK enforcement to auth.users (app_users.created_by / app_users.id) and
-- side-effect triggers; the RLS policy logic under test is unaffected.
-- SET LOCAL — auto-restored on rollback. (Requires superuser, which the
-- migration/test role is; we drop to `authenticated` only for the writes.)
set local session_replication_role = replica;

-- ── Fixtures (created as the superuser role — RLS is bypassed for us here) ─
insert into public.dsps (id, name, short_code, slug) values
  ('bbbb2222-0000-4000-8000-000000000001', 'RR RoleGate DSP', 'RRGATE', 'rr-gate-test');

insert into public.app_users (id, dsp_id, email, full_name, role, active) values
  ('bbbb2222-0000-4000-8000-000000000002', 'bbbb2222-0000-4000-8000-000000000001',
   'disp@rrgate.test', 'Dispatcher', 'dispatcher', true),
  ('bbbb2222-0000-4000-8000-000000000003', 'bbbb2222-0000-4000-8000-000000000001',
   'drv@rrgate.test',  'Driver',     'driver',     true);

-- Acting as a given app_user under the `authenticated` role means:
--   1. set the JWT sub (both carriers, matching the other tests) so
--      private.current_dsp_id()/is_staff() resolve via auth.uid();
--   2. `set local role authenticated` so RLS is enforced.

-- ═══ hiring_targets ═══════════════════════════════════════════════════════

-- Driver → INSERT must be DENIED (RLS row-security violation = 42501).
select set_config('request.jwt.claim.sub', 'bbbb2222-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims',
  '{"sub":"bbbb2222-0000-4000-8000-000000000003","role":"authenticated"}', true);
set local role authenticated;
do $$
declare denied boolean := false;
begin
  begin
    insert into public.hiring_targets (dsp_id, label, needed_count)
    values ('bbbb2222-0000-4000-8000-000000000001', 'driver-should-fail', 1);
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'driver INSERT into hiring_targets must be blocked by RLS';
end $$;
reset role;

-- Dispatcher → INSERT must SUCCEED.
select set_config('request.jwt.claim.sub', 'bbbb2222-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims',
  '{"sub":"bbbb2222-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
insert into public.hiring_targets (dsp_id, label, needed_count)
values ('bbbb2222-0000-4000-8000-000000000001', 'dispatcher-ok', 2);
do $$
begin
  assert (select count(*) from public.hiring_targets
          where dsp_id = 'bbbb2222-0000-4000-8000-000000000001'
            and label = 'dispatcher-ok') = 1,
    'dispatcher INSERT into hiring_targets should succeed';
end $$;
reset role;

-- ═══ route_forecasts ══════════════════════════════════════════════════════

-- Driver → INSERT must be DENIED.
select set_config('request.jwt.claim.sub', 'bbbb2222-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims',
  '{"sub":"bbbb2222-0000-4000-8000-000000000003","role":"authenticated"}', true);
set local role authenticated;
do $$
declare denied boolean := false;
begin
  begin
    insert into public.route_forecasts (dsp_id, week_start, route_slots)
    values ('bbbb2222-0000-4000-8000-000000000001', date '2026-01-05', 10);
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'driver INSERT into route_forecasts must be blocked by RLS';
end $$;
reset role;

-- Dispatcher → INSERT must SUCCEED.
select set_config('request.jwt.claim.sub', 'bbbb2222-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims',
  '{"sub":"bbbb2222-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
insert into public.route_forecasts (dsp_id, week_start, route_slots)
values ('bbbb2222-0000-4000-8000-000000000001', date '2026-01-12', 20);
do $$
begin
  assert (select count(*) from public.route_forecasts
          where dsp_id = 'bbbb2222-0000-4000-8000-000000000001'
            and week_start = date '2026-01-12') = 1,
    'dispatcher INSERT into route_forecasts should succeed';
end $$;
reset role;

rollback;
