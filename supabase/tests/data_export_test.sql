-- supabase/tests/data_export_test.sql
--
-- Server-side tests for public.export_my_dsp_data() (migration 0472). Runs
-- against a fully-migrated DB (the migration-check.yml CI harness), dropped to
-- the real `authenticated` role so the function's JWT-based owner + tenant
-- resolution is exercised exactly as PostgREST would.
--
-- What it proves:
--   • An OWNER gets a bundle containing ONLY their own tenant's data.
--   • The export never leaks another tenant's rows.
--   • A dispatcher and a driver are REFUSED (owner-only action).
--
-- One transaction, rolled back — no residue.

\set ON_ERROR_STOP on

begin;

set local session_replication_role = replica;

insert into public.dsps (id, name, short_code, slug) values
  ('a11a0000-0000-4000-8000-000000000001', 'Export Tenant A', 'EXPA', 'export-a'),
  ('b22b0000-0000-4000-8000-000000000001', 'Export Tenant B', 'EXPB', 'export-b');

insert into public.app_users (id, dsp_id, email, full_name, role, active) values
  ('a11a0000-0000-4000-8000-000000000002', 'a11a0000-0000-4000-8000-000000000001',
   'owner@export-a.test', 'Owner A', 'owner', true),
  ('a11a0000-0000-4000-8000-000000000003', 'a11a0000-0000-4000-8000-000000000001',
   'disp@export-a.test',  'Dispatcher A', 'dispatcher', true),
  ('a11a0000-0000-4000-8000-000000000004', 'a11a0000-0000-4000-8000-000000000001',
   'drv@export-a.test',   'Driver A', 'driver', true),
  ('b22b0000-0000-4000-8000-000000000002', 'b22b0000-0000-4000-8000-000000000001',
   'owner@export-b.test', 'Owner B', 'owner', true);

insert into public.drivers (id, dsp_id, full_name) values
  ('a11a0000-0000-4000-8000-000000000005', 'a11a0000-0000-4000-8000-000000000001', 'Alice EXPORT A'),
  ('b22b0000-0000-4000-8000-000000000005', 'b22b0000-0000-4000-8000-000000000001', 'Bob EXPORT B');

-- ═══ Owner of Tenant A → export contains only A's data ═════════════════════
select set_config('request.jwt.claim.sub', 'a11a0000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims',
  '{"sub":"a11a0000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v jsonb;
begin
  v := public.export_my_dsp_data();
  assert (v->>'dsp_id') = 'a11a0000-0000-4000-8000-000000000001',
    'export must be scoped to the caller''s DSP';
  assert v::text like '%Alice EXPORT A%', 'owner export must include OWN driver';
  assert v::text not like '%Bob EXPORT B%', 'owner export must NOT include another tenant''s driver';
  assert jsonb_array_length(v->'drivers') = 1, 'export must contain exactly A''s drivers';
end $$;
reset role;

-- ═══ Dispatcher → refused (owner-only) ═════════════════════════════════════
select set_config('request.jwt.claim.sub', 'a11a0000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims',
  '{"sub":"a11a0000-0000-4000-8000-000000000003","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v jsonb; denied boolean := false;
begin
  begin
    v := public.export_my_dsp_data();
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'a dispatcher must NOT be able to export tenant data';
end $$;
reset role;

-- ═══ Driver → refused ══════════════════════════════════════════════════════
select set_config('request.jwt.claim.sub', 'a11a0000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims',
  '{"sub":"a11a0000-0000-4000-8000-000000000004","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v jsonb; denied boolean := false;
begin
  begin
    v := public.export_my_dsp_data();
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'a driver must NOT be able to export tenant data';
end $$;
reset role;

rollback;

\echo 'data_export_test: PASSED'
