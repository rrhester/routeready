-- supabase/tests/usage_events_test.sql
--
-- RLS tests for public.usage_events (migration 0473). Runs against a fully
-- migrated DB (migration-check.yml), dropped to the real `authenticated` role.
--
-- Proves:
--   • a staff user can INSERT a self-bound event (own dsp_id + own user_id);
--   • INSERT is refused when dsp_id is another tenant, or user_id another user;
--   • SELECT is tenant-scoped — A's staff never sees B's events;
--   • a non-staff (driver) sees no events.
--
-- One transaction, rolled back.

\set ON_ERROR_STOP on

begin;
set local session_replication_role = replica;

insert into public.dsps (id, name, short_code, slug) values
  ('e11e0000-0000-4000-8000-000000000001', 'Usage Tenant A', 'USEA', 'usage-a'),
  ('f22f0000-0000-4000-8000-000000000001', 'Usage Tenant B', 'USEB', 'usage-b');

insert into public.app_users (id, dsp_id, email, full_name, role, active) values
  ('e11e0000-0000-4000-8000-000000000002', 'e11e0000-0000-4000-8000-000000000001',
   'disp@usage-a.test', 'Dispatcher A', 'dispatcher', true),
  ('e11e0000-0000-4000-8000-000000000003', 'e11e0000-0000-4000-8000-000000000001',
   'drv@usage-a.test',  'Driver A', 'driver', true),
  ('f22f0000-0000-4000-8000-000000000002', 'f22f0000-0000-4000-8000-000000000001',
   'disp@usage-b.test', 'Dispatcher B', 'dispatcher', true);

-- Seed one event per tenant (as superuser; RLS bypassed here).
insert into public.usage_events (dsp_id, user_id, event) values
  ('e11e0000-0000-4000-8000-000000000001', 'e11e0000-0000-4000-8000-000000000002', 'seed_a'),
  ('f22f0000-0000-4000-8000-000000000001', 'f22f0000-0000-4000-8000-000000000002', 'seed_b');

-- ═══ Dispatcher A ══════════════════════════════════════════════════════════
select set_config('request.jwt.claim.sub', 'e11e0000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims',
  '{"sub":"e11e0000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
do $$
declare denied boolean;
begin
  -- self-bound insert OK
  insert into public.usage_events (dsp_id, user_id, event, props)
  values ('e11e0000-0000-4000-8000-000000000001', 'e11e0000-0000-4000-8000-000000000002',
          'view_open', '{"view":"schedule"}'::jsonb);

  -- cross-TENANT insert denied
  denied := false;
  begin
    insert into public.usage_events (dsp_id, user_id, event)
    values ('f22f0000-0000-4000-8000-000000000001', 'e11e0000-0000-4000-8000-000000000002', 'evil');
  exception when insufficient_privilege then denied := true; end;
  assert denied, 'cross-tenant usage_events insert must be blocked';

  -- cross-USER insert denied
  denied := false;
  begin
    insert into public.usage_events (dsp_id, user_id, event)
    values ('e11e0000-0000-4000-8000-000000000001', 'f22f0000-0000-4000-8000-000000000002', 'evil');
  exception when insufficient_privilege then denied := true; end;
  assert denied, 'cross-user usage_events insert must be blocked';

  -- SELECT is tenant-scoped
  assert (select count(*) from public.usage_events where event = 'seed_b') = 0,
    'A staff must NOT see tenant B events';
  assert (select count(*) from public.usage_events where event = 'seed_a') = 1,
    'A staff must see its own tenant events';
end $$;
reset role;

-- ═══ Driver A (non-staff) → sees nothing ═══════════════════════════════════
select set_config('request.jwt.claim.sub', 'e11e0000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims',
  '{"sub":"e11e0000-0000-4000-8000-000000000003","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  assert (select count(*) from public.usage_events) = 0,
    'a non-staff (driver) must not see usage events';
end $$;
reset role;

rollback;

\echo 'usage_events_test: PASSED'
