-- ─────────────────────────────────────────────────────────────────────────
-- pgTAP test · HR file immutability + suspension cascade
-- The HR file is the legally-significant core of Performance Management.
-- Every assertion in this file must pass before any change to hr_events
-- or its triggers ships. If any one of these fails, the platform's
-- defensible-documentation claim is broken.
-- ─────────────────────────────────────────────────────────────────────────

begin;
select plan(20);

create extension if not exists pgtap;

-- ─── Setup ────────────────────────────────────────────────────────────

insert into public.dsps (id, name, slug)
values ('aabb0000-0000-0000-0000-000000000001', 'HR Test DSP', 'hr-test-dsp');

insert into public.stations (id, dsp_id, code, name)
values ('aabb0000-0000-0000-0000-000000001000',
        'aabb0000-0000-0000-0000-000000000001', 'X1', 'Station X1');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('aabb0000-0000-0000-0000-aaaaaaaaaaaa',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'hr-owner@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('aabb0000-0000-0000-0000-bbbbbbbbbbbb',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'hr-ops@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.app_users (id, dsp_id, role, email) values
  ('aabb0000-0000-0000-0000-aaaaaaaaaaaa',
   'aabb0000-0000-0000-0000-000000000001', 'owner', 'hr-owner@test.test'),
  ('aabb0000-0000-0000-0000-bbbbbbbbbbbb',
   'aabb0000-0000-0000-0000-000000000001', 'ops',   'hr-ops@test.test');

insert into public.drivers (id, dsp_id, station_id, full_name, status) values
  ('aabb0000-dddd-0000-0000-000000000001',
   'aabb0000-0000-0000-0000-000000000001',
   'aabb0000-0000-0000-0000-000000001000',
   'Test Driver', 'active');

-- Helpers — copied from multi_tenant.test.sql; pgTAP runs each test file
-- in its own transaction so we redefine here.
create or replace function pg_temp.act_as_owner()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', 'aabb0000-0000-0000-0000-aaaaaaaaaaaa',
                       'dsp_id', 'aabb0000-0000-0000-0000-000000000001',
                       'role', 'owner')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_ops()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', 'aabb0000-0000-0000-0000-bbbbbbbbbbbb',
                       'dsp_id', 'aabb0000-0000-0000-0000-000000000001',
                       'role', 'ops')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}'::text, true);
  perform set_config('role', 'service_role', true);
end $$;

-- ─── HR event immutability ────────────────────────────────────────────

select pg_temp.act_as_ops();

-- 1. Ops can insert
select lives_ok(
  $sql$
    insert into public.hr_events
      (dsp_id, driver_id, event_type, severity, effective_date, reason_detail)
    values
      ('aabb0000-0000-0000-0000-000000000001',
       'aabb0000-dddd-0000-0000-000000000001',
       'verbal_warning', 'minor', current_date,
       'Test verbal warning for unit test fixture')
  $sql$,
  'Ops can INSERT into hr_events');

-- 2. UPDATE is denied (no policy → blocked)
select throws_ok(
  $sql$
    update public.hr_events set reason_detail = 'tampered' where event_type = 'verbal_warning'
  $sql$,
  null, null,
  'UPDATE on hr_events is denied (no RLS policy)');

-- 3. DELETE is denied
select throws_ok(
  $sql$ delete from public.hr_events where event_type = 'verbal_warning' $sql$,
  null, null,
  'DELETE on hr_events is denied (no RLS policy)');

-- ─── Suspension cascade ───────────────────────────────────────────────

-- 4. process_suspension creates HR + coaching rows and flips driver status
select is(
  (public.process_suspension(
     'aabb0000-dddd-0000-0000-000000000001'::uuid,
     current_date,                                 -- effective today
     current_date + 5,                             -- return in 5 days
     false,                                        -- not pending term
     'attendance',
     'Suspension test fixture: driver exceeded attendance threshold last 30 days.'
  ))->>'message'),
  'Driver suspended; HR record created and driver status flipped.',
  'process_suspension returns a structured success response');

-- 5. Driver status auto-flipped
select is(
  (select status::text from public.drivers
    where id = 'aabb0000-dddd-0000-0000-000000000001'),
  'suspended',
  'drivers.status = suspended after process_suspension');

-- 6. Active suspension visible in the view
select is(
  (select count(*) from public.active_suspensions
    where driver_id = 'aabb0000-dddd-0000-0000-000000000001'),
  1::bigint,
  'active_suspensions view shows the new suspension');

-- 7. HR event row exists with correct type and severity
select is(
  (select event_type::text from public.hr_events
    where driver_id = 'aabb0000-dddd-0000-0000-000000000001'
      and event_type = 'suspension'),
  'suspension',
  'hr_events row created with type=suspension');

-- 8. Coaching event row created and linked to HR event
select is(
  (select count(*) from public.coaching_events ce
    join public.hr_events hr on hr.id = ce.related_hr_event_id
    where ce.driver_id = 'aabb0000-dddd-0000-0000-000000000001'
      and ce.channel = 'suspend'
      and hr.event_type = 'suspension'),
  1::bigint,
  'coaching_events linked to the HR event');

-- ─── Required reason detail ───────────────────────────────────────────

-- 9. Suspension with empty reason rejected
select throws_ok(
  $sql$
    select public.process_suspension(
      'aabb0000-dddd-0000-0000-000000000001'::uuid,
      current_date, current_date + 5, false, 'other', 'short'
    )
  $sql$,
  null, null,
  'process_suspension rejects too-short reason_detail');

-- ─── Reinstatement reverses status ────────────────────────────────────

-- 10. process_reinstatement creates a new HR event
select isnt(
  (public.process_reinstatement(
     'aabb0000-dddd-0000-0000-000000000001'::uuid,
     'Suspension period completed; driver acknowledged policy.'
   ))->>'hr_event_id',
  null,
  'process_reinstatement returns hr_event_id');

-- 11. Driver status flips back to active
select is(
  (select status::text from public.drivers
    where id = 'aabb0000-dddd-0000-0000-000000000001'),
  'active',
  'drivers.status = active after reinstatement');

-- 12. Active suspension cleared from the view
select is(
  (select count(*) from public.active_suspensions
    where driver_id = 'aabb0000-dddd-0000-0000-000000000001'),
  0::bigint,
  'active_suspensions view empty after reinstatement');

-- ─── Reinstatement requires an active suspension ──────────────────────

-- 13. Reinstating a non-suspended driver fails
select throws_ok(
  $sql$
    select public.process_reinstatement(
      'aabb0000-dddd-0000-0000-000000000001'::uuid,
      'Trying to reinstate someone who is not suspended.'
    )
  $sql$,
  null, null,
  'process_reinstatement fails when no active suspension exists');

-- ─── Voiding an HR event ──────────────────────────────────────────────

-- 14. Suspend again so we have something to void
do $$ begin
  perform public.process_suspension(
    'aabb0000-dddd-0000-0000-000000000001'::uuid,
    current_date, current_date + 7, false, 'attendance',
    'Second suspension fixture for void-test purposes only.'
  );
end $$;

-- 15. Ops cannot void (owner only)
select throws_ok(
  $sql$
    select public.void_hr_event(
      (select id from public.hr_events
         where event_type = 'suspension'
           and driver_id = 'aabb0000-dddd-0000-0000-000000000001'
         order by created_at desc limit 1),
      'Trying to void as ops — should fail.'
    )
  $sql$,
  null, null,
  'void_hr_event rejects ops role (owner only)');

-- Switch to owner
select pg_temp.act_as_owner();

-- 16. Owner can void
select isnt(
  (public.void_hr_event(
    (select id from public.hr_events
       where event_type = 'suspension'
         and driver_id = 'aabb0000-dddd-0000-0000-000000000001'
       order by created_at desc limit 1),
    'Voiding the suspension because the underlying attendance events ' ||
    'were later marked exempt due to approved FMLA paperwork.'
  ))::text,
  null,
  'Owner can void a suspension');

-- 17. After void, driver status returns to active
select is(
  (select status::text from public.drivers
    where id = 'aabb0000-dddd-0000-0000-000000000001'),
  'active',
  'drivers.status = active after void');

-- 18. Original suspension row preserved (not deleted)
select cmp_ok(
  (select count(*) from public.hr_events
    where event_type = 'suspension'
      and driver_id = 'aabb0000-dddd-0000-0000-000000000001'),
  '>=',
  2::bigint,
  'Original suspension rows preserved after void');

-- 19. Void event created with superseded_by set
select is(
  (select count(*) from public.hr_events
    where event_type = 'void'
      and superseded_by is not null
      and driver_id = 'aabb0000-dddd-0000-0000-000000000001'),
  1::bigint,
  'Void event has superseded_by reference to original');

-- 20. Cannot double-void
select throws_ok(
  $sql$
    select public.void_hr_event(
      (select superseded_by from public.hr_events
        where event_type = 'void' limit 1),
      'Attempting to void an already-voided event.'
    )
  $sql$,
  null, null,
  'Cannot void an already-voided event');

-- ─── Wrap up ──────────────────────────────────────────────────────────

select * from finish();
rollback;
