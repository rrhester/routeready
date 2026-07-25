-- supabase/tests/rpc_role_gate_test.sql
--
-- Regression test for migration 0543 (role-gate SECURITY DEFINER RPCs that
-- were tenant-only). Runs against a fully-migrated DB (migration-check.yml).
--
-- Proves that a driver-role app_user is refused (errcode 42501) on a
-- representative sample of the newly-gated privileged functions, while a
-- dispatcher passes the guard (reaching a not-found/no-op rather than
-- forbidden). Guards against a future re-issue dropping the role check.
--
-- Run locally from the repo root against any migrated DB:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rpc_role_gate_test.sql
--
-- One transaction, rolled back at the end — no residue.

\set ON_ERROR_STOP on

begin;

set local session_replication_role = replica;  -- skip FK-to-auth + triggers

insert into public.dsps (id, name, short_code, slug) values
  ('cafe0000-0000-4000-8000-000000000001', 'Role Gate DSP', 'RGATE', 'rgate');
insert into public.app_users (id, dsp_id, email, full_name, role, active) values
  ('cafe0000-0000-4000-8000-00000000000d', 'cafe0000-0000-4000-8000-000000000001', 'drv@rgate.test',  'Driver',     'driver',     true),
  ('cafe0000-0000-4000-8000-00000000000e', 'cafe0000-0000-4000-8000-000000000001', 'disp@rgate.test', 'Dispatcher', 'dispatcher', true);

-- ── Driver-role: every sampled function must raise forbidden (42501) ───────
select set_config('request.jwt.claim.sub', 'cafe0000-0000-4000-8000-00000000000d', true);
do $$
declare
  bogus uuid := '00000000-0000-0000-0000-000000000000';
  blocked boolean;
  procedure_call text;
  calls text[] := array[
    'select public.coaching_resolve(''00000000-0000-0000-0000-000000000000''::uuid)',
    'select public.coaching_archive(''00000000-0000-0000-0000-000000000000''::uuid, ''r'')',
    'select public.dispatch_time_off_decide(''00000000-0000-0000-0000-000000000000''::uuid, true, null)',
    'select public.vehicle_set_operational_status(''00000000-0000-0000-0000-000000000000''::uuid, ''grounded'', null, null)',
    'select public.interview_session_remove(''00000000-0000-0000-0000-000000000000''::uuid)',
    'select public.interview_override_remove(current_date)'
  ];
begin
  foreach procedure_call in array calls loop
    blocked := false;
    begin
      execute procedure_call;
    exception
      when insufficient_privilege then blocked := true;   -- 42501
      when others then if sqlstate = '42501' then blocked := true; end if;
    end;
    assert blocked, 'driver must be refused by the role gate: ' || procedure_call;
  end loop;
  raise notice 'role-gate: driver refused on all sampled functions (correct)';
end $$;

-- ── Dispatcher: passes the guard (reaches not-found, not forbidden) ────────
select set_config('request.jwt.claim.sub', 'cafe0000-0000-4000-8000-00000000000e', true);
do $$
declare past_guard boolean := false;
begin
  begin
    perform public.coaching_resolve('00000000-0000-0000-0000-000000000000');
    past_guard := true;
  exception when others then
    past_guard := (sqlstate <> '42501');   -- any non-forbidden error = past the guard
  end;
  assert past_guard, 'dispatcher must pass the role gate on coaching_resolve';
  raise notice 'role-gate: dispatcher passes the guard (correct)';
end $$;

rollback;
