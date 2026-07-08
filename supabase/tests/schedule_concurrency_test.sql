-- supabase/tests/schedule_concurrency_test.sql
--
-- Server-side regression tests for migration 0446 (schedule concurrency):
-- the optimistic assign_shift and the realtime publication membership.
-- Runs against a database with every migration applied (see the CI harness
-- in .github/workflows/migration-check.yml). Exercises the REAL
-- security-definer RPC — no mocks.
--
-- Run locally from the repo root against any migrated DB:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/schedule_concurrency_test.sql
--
-- Everything runs in one transaction rolled back at the end — no residue.

\set ON_ERROR_STOP on

begin;

-- Side-effect triggers on shifts/drivers (audit fan-out, updated_at touch,
-- channel sync) are irrelevant here and can depend on request context that
-- a psql session doesn't have; FK enforcement to auth.users likewise. The
-- RPC logic under test is plain PL/pgSQL and runs identically. SET LOCAL —
-- auto-restored on rollback.
set local session_replication_role = replica;

-- ── Fixtures ─────────────────────────────────────────────────────────
insert into public.dsps (id, name, short_code, slug)
values ('aaaa1111-0000-4000-8000-000000000001', 'RR Concurrency DSP', 'RRCONC', 'rr-conc-test');

-- Dispatcher whose JWT we simulate below. FK to auth.users skipped (replica).
insert into public.app_users (id, dsp_id, email, full_name, role, active)
values ('aaaa1111-0000-4000-8000-000000000002', 'aaaa1111-0000-4000-8000-000000000001',
        'dispatch@rrconc.test', 'Dispatcher', 'owner', true);

insert into public.drivers (id, dsp_id, full_name, status) values
  ('aaaa1111-0000-4000-8000-000000000003', 'aaaa1111-0000-4000-8000-000000000001', 'Driver A', 'active'),
  ('aaaa1111-0000-4000-8000-000000000004', 'aaaa1111-0000-4000-8000-000000000001', 'Driver B', 'active');

-- station_id is NOT NULL; the FK to stations is skipped under replica mode.
insert into public.shifts (id, dsp_id, station_id, driver_id, date) values
  ('aaaa1111-0000-4000-8000-000000000005', 'aaaa1111-0000-4000-8000-000000000001',
   'aaaa1111-0000-4000-8000-00000000000f', null, current_date);

-- Simulate the dispatcher's authenticated request context so
-- private.current_dsp_id() / private.is_staff() resolve. Set both claim
-- carriers to cover either auth.uid() implementation.
select set_config('request.jwt.claim.sub',  'aaaa1111-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims',
  '{"sub":"aaaa1111-0000-4000-8000-000000000002","role":"authenticated"}', true);

-- ── 1. Legacy call shape (no expectation) still assigns ──────────────
do $$
declare v public.shifts;
begin
  v := public.assign_shift(
    'aaaa1111-0000-4000-8000-000000000005'::uuid,
    'aaaa1111-0000-4000-8000-000000000003'::uuid);
  assert v.driver_id = 'aaaa1111-0000-4000-8000-000000000003'::uuid,
    'legacy assign should set Driver A';
end $$;

-- ── 2. Stale expectation refuses with shift_conflict, no write ───────
do $$
declare v public.shifts; caught boolean := false; d text;
begin
  begin
    -- Caller believes the shift is still OPEN, but Driver A holds it.
    v := public.assign_shift(
      'aaaa1111-0000-4000-8000-000000000005'::uuid,
      'aaaa1111-0000-4000-8000-000000000004'::uuid,
      null, true);
  exception when others then
    caught := sqlerrm like '%shift_conflict%';
    get stacked diagnostics d = pg_exception_detail;
  end;
  assert caught, 'stale expectation must raise shift_conflict';
  assert d = 'aaaa1111-0000-4000-8000-000000000003',
    'conflict DETAIL must carry the current holder, got: ' || coalesce(d, '<null>');
  assert (select driver_id from public.shifts
           where id = 'aaaa1111-0000-4000-8000-000000000005')
         = 'aaaa1111-0000-4000-8000-000000000003'::uuid,
    'conflicting write must not change the row';
end $$;

-- ── 3. Correct expectation assigns ───────────────────────────────────
do $$
declare v public.shifts;
begin
  v := public.assign_shift(
    'aaaa1111-0000-4000-8000-000000000005'::uuid,
    'aaaa1111-0000-4000-8000-000000000004'::uuid,
    'aaaa1111-0000-4000-8000-000000000003'::uuid, true);
  assert v.driver_id = 'aaaa1111-0000-4000-8000-000000000004'::uuid,
    'matching expectation should reassign to Driver B';
end $$;

-- ── 4. Expected-null works for a genuinely open shift ────────────────
do $$
declare v public.shifts;
begin
  update public.shifts set driver_id = null
   where id = 'aaaa1111-0000-4000-8000-000000000005';
  v := public.assign_shift(
    'aaaa1111-0000-4000-8000-000000000005'::uuid,
    'aaaa1111-0000-4000-8000-000000000003'::uuid,
    null, true);
  assert v.driver_id = 'aaaa1111-0000-4000-8000-000000000003'::uuid,
    'expected-null on an open shift should assign';
end $$;

-- ── 5. Unknown shift still raises shift_not_found (both modes) ───────
do $$
declare v public.shifts; caught boolean := false;
begin
  begin
    v := public.assign_shift(
      'aaaa1111-0000-4000-8000-0000000000ee'::uuid,
      'aaaa1111-0000-4000-8000-000000000003'::uuid,
      null, true);
  exception when others then
    caught := sqlerrm like '%shift_not_found%';
  end;
  assert caught, 'unknown shift must raise shift_not_found, not shift_conflict';
end $$;

-- ── 6. Realtime publication carries the schedule tables ──────────────
do $$
begin
  assert (select count(*) from pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'public'
             and tablename in ('shifts', 'shift_offers', 'driver_checkins')) = 3,
    'supabase_realtime must include shifts, shift_offers, driver_checkins';
end $$;

select 'schedule-concurrency: all assertions passed' as result;

rollback;
