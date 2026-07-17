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

-- ── 7. Compliance gate (0500): approved PTO blocks, override records ──
-- Triggers are disabled in this session (replica mode), so this
-- exercises exactly the in-function gate: staff_assign_violations →
-- assign_blocked → schedule_overrides.
do $$
declare v public.shifts; caught boolean := false; d text;
begin
  update public.shifts set driver_id = null
   where id = 'aaaa1111-0000-4000-8000-000000000005';

  insert into public.time_off_requests (id, dsp_id, driver_id, start_date, end_date, status)
  values ('aaaa1111-0000-4000-8000-0000000000a1',
          'aaaa1111-0000-4000-8000-000000000001',
          'aaaa1111-0000-4000-8000-000000000003',
          current_date, current_date, 'approved');

  begin
    v := public.assign_shift(
      'aaaa1111-0000-4000-8000-000000000005'::uuid,
      'aaaa1111-0000-4000-8000-000000000003'::uuid);
  exception when others then
    caught := sqlerrm like '%assign_blocked%';
    get stacked diagnostics d = pg_exception_detail;
  end;
  assert caught, 'assigning onto approved PTO must raise assign_blocked';
  assert d like '%approved time off%',
    'assign_blocked DETAIL must name the violation, got: ' || coalesce(d, '<null>');
  assert (select driver_id from public.shifts
           where id = 'aaaa1111-0000-4000-8000-000000000005') is null,
    'a blocked assign must not write';

  -- Explicit override assigns AND leaves a schedule_overrides record.
  v := public.assign_shift(
    'aaaa1111-0000-4000-8000-000000000005'::uuid,
    'aaaa1111-0000-4000-8000-000000000003'::uuid,
    null, false, true, 'coverage emergency (test)');
  assert v.driver_id = 'aaaa1111-0000-4000-8000-000000000003'::uuid,
    'override must assign';
  assert (select count(*) from public.schedule_overrides
           where shift_id = 'aaaa1111-0000-4000-8000-000000000005'
             and 'driver has approved time off covering ' || current_date::text
                 = any(violations)) = 1,
    'override must be recorded in schedule_overrides with the violation text';
end $$;

-- ── 8. Overlap exclusion (0500): second approved range refuses ────────
-- Exclusion constraints are index-enforced, so they hold even with
-- session_replication_role = replica.
do $$
declare caught boolean := false;
begin
  begin
    insert into public.time_off_requests (dsp_id, driver_id, start_date, end_date, status)
    values ('aaaa1111-0000-4000-8000-000000000001',
            'aaaa1111-0000-4000-8000-000000000003',
            current_date, current_date + 1, 'approved');
  exception when exclusion_violation then
    caught := true;
  end;
  assert caught,
    'overlapping approved time off must violate time_off_requests_no_overlap';
end $$;

-- ── 9. Smart Fill undo (0502): snapshot + optimistic revert ───────────
do $$
declare v jsonb; caught boolean := false;
begin
  -- Fixture: a completed run that assigned Driver B onto shift 5.
  insert into public.optimization_runs (id, dsp_id, week_start, trigger_kind, status, input_hash)
  values ('aaaa1111-0000-4000-8000-0000000000b1',
          'aaaa1111-0000-4000-8000-000000000001',
          current_date, 'manual', 'ok', 'undo-test-hash');
  insert into public.optimization_decisions (run_id, shift_id, driver_id, decision)
  values ('aaaa1111-0000-4000-8000-0000000000b1',
          'aaaa1111-0000-4000-8000-000000000005',
          'aaaa1111-0000-4000-8000-000000000004', 'assigned');
  -- Board as the run left it: B holds shift 5 (was open before the run).
  update public.shifts set driver_id = 'aaaa1111-0000-4000-8000-000000000004'
   where id = 'aaaa1111-0000-4000-8000-000000000005';

  perform public.optimization_run_set_snapshot(
    'aaaa1111-0000-4000-8000-0000000000b1',
    jsonb_build_array(jsonb_build_object(
      'shift_id', 'aaaa1111-0000-4000-8000-000000000005',
      'driver_id', null)));

  v := public.revert_optimization_run('aaaa1111-0000-4000-8000-0000000000b1');
  assert (v->>'restored')::int = 1, 'revert must restore the run''s write, got ' || v::text;
  assert (select driver_id from public.shifts
           where id = 'aaaa1111-0000-4000-8000-000000000005') is null,
    'shift must return to its pre-run (open) state';

  -- A second revert must refuse.
  begin
    v := public.revert_optimization_run('aaaa1111-0000-4000-8000-0000000000b1');
  exception when others then
    caught := sqlerrm like '%already_reverted%';
  end;
  assert caught, 'double revert must raise already_reverted';
end $$;

-- ── 10. Revert keeps dispatcher edits made AFTER the run ─────────────
do $$
declare v jsonb;
begin
  insert into public.optimization_runs (id, dsp_id, week_start, trigger_kind, status, input_hash)
  values ('aaaa1111-0000-4000-8000-0000000000b2',
          'aaaa1111-0000-4000-8000-000000000001',
          current_date, 'manual', 'ok', 'undo-test-hash-2');
  insert into public.optimization_decisions (run_id, shift_id, driver_id, decision)
  values ('aaaa1111-0000-4000-8000-0000000000b2',
          'aaaa1111-0000-4000-8000-000000000005',
          'aaaa1111-0000-4000-8000-000000000004', 'assigned');
  -- A dispatcher has since put Driver A on the shift — the run's write
  -- (Driver B) is gone, so the revert must NOT touch it.
  update public.shifts set driver_id = 'aaaa1111-0000-4000-8000-000000000003'
   where id = 'aaaa1111-0000-4000-8000-000000000005';
  perform public.optimization_run_set_snapshot(
    'aaaa1111-0000-4000-8000-0000000000b2',
    jsonb_build_array(jsonb_build_object(
      'shift_id', 'aaaa1111-0000-4000-8000-000000000005',
      'driver_id', null)));
  v := public.revert_optimization_run('aaaa1111-0000-4000-8000-0000000000b2');
  assert (v->>'restored')::int = 0 and (v->>'skipped')::int = 1,
    'edited-since shift must be skipped, got ' || v::text;
  assert (select driver_id from public.shifts
           where id = 'aaaa1111-0000-4000-8000-000000000005')
         = 'aaaa1111-0000-4000-8000-000000000003'::uuid,
    'the dispatcher''s newer edit must be preserved';
end $$;

select 'schedule-concurrency: all assertions passed' as result;

rollback;
