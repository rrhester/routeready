-- ─────────────────────────────────────────────────────────────────────────
-- pgTAP test · attendance event flow
-- Asserts that record_attendance is idempotent on (driver, date, type),
-- that drivers can read their own events, that 'present' clears prior
-- same-day disruptions, and that mark_attendance_exempt works.
-- ─────────────────────────────────────────────────────────────────────────

begin;
select plan(12);

create extension if not exists pgtap;

-- ─── Setup ────────────────────────────────────────────────────────────

insert into public.dsps (id, name, slug)
values ('aacc0000-0000-0000-0000-000000000001', 'Att Test DSP', 'att-test-dsp');

insert into public.stations (id, dsp_id, code, name)
values ('aacc0000-0000-0000-0000-000000001000',
        'aacc0000-0000-0000-0000-000000000001', 'Y1', 'Station Y1');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('aacc0000-0000-0000-0000-aaaaaaaaaaaa',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'att-ops@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('aacc0000-0000-0000-0000-cccccccccccc',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'att-dispatch@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('aacc0000-0000-0000-0000-dddddddddddd',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'att-driver@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.app_users (id, dsp_id, role, email) values
  ('aacc0000-0000-0000-0000-aaaaaaaaaaaa',
   'aacc0000-0000-0000-0000-000000000001', 'ops',        'att-ops@test.test'),
  ('aacc0000-0000-0000-0000-cccccccccccc',
   'aacc0000-0000-0000-0000-000000000001', 'dispatcher', 'att-dispatch@test.test');

insert into public.drivers (id, dsp_id, station_id, full_name, status) values
  ('aacc0000-dddd-0000-0000-000000000001',
   'aacc0000-0000-0000-0000-000000000001',
   'aacc0000-0000-0000-0000-000000001000',
   'Att Driver', 'active');

-- Link driver app_user to the driver
insert into public.app_users (id, dsp_id, role, driver_id, email) values
  ('aacc0000-0000-0000-0000-dddddddddddd',
   'aacc0000-0000-0000-0000-000000000001', 'driver',
   'aacc0000-dddd-0000-0000-000000000001', 'att-driver@test.test');

insert into public.attendance_policies (dsp_id) values
  ('aacc0000-0000-0000-0000-000000000001');

-- Helpers
create or replace function pg_temp.act_as_dispatcher()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', 'aacc0000-0000-0000-0000-cccccccccccc',
                       'dsp_id', 'aacc0000-0000-0000-0000-000000000001',
                       'role', 'dispatcher')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_ops()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', 'aacc0000-0000-0000-0000-aaaaaaaaaaaa',
                       'dsp_id', 'aacc0000-0000-0000-0000-000000000001',
                       'role', 'ops')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_driver()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', 'aacc0000-0000-0000-0000-dddddddddddd',
                       'dsp_id', 'aacc0000-0000-0000-0000-000000000001',
                       'role', 'driver',
                       'driver_id', 'aacc0000-dddd-0000-0000-000000000001')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- ─── record_attendance basic insert ──────────────────────────────────

select pg_temp.act_as_dispatcher();

-- 1. Dispatcher can record a callout
select isnt(
  (public.record_attendance(
    'aacc0000-dddd-0000-0000-000000000001'::uuid,
    'callout', current_date, 'sick'
  ))->>'event_id',
  null,
  'Dispatcher can record a callout');

-- 2. Re-recording the same day same type with replace=true → was_replaced=true
select is(
  (public.record_attendance(
    'aacc0000-dddd-0000-0000-000000000001'::uuid,
    'callout', current_date, 'still sick'
  ))->>'was_replaced',
  'true',
  'record_attendance with replace_today=true reports was_replaced=true');

-- 3. Only one row should exist
select is(
  (select count(*) from public.attendance_events
    where driver_id = 'aacc0000-dddd-0000-0000-000000000001'
      and event_date = current_date),
  1::bigint,
  'Only one same-day disruption row exists after replace');

-- 4. Switching to vto same day replaces the callout
select is(
  (public.record_attendance(
    'aacc0000-dddd-0000-0000-000000000001'::uuid,
    'vto', current_date, 'overscheduled — driver accepted VTO'
  ))->>'was_replaced',
  'true',
  'Switching to vto same day reports was_replaced=true');

-- 5. Marking 'present' clears the same-day vto
select is(
  (public.record_attendance(
    'aacc0000-dddd-0000-0000-000000000001'::uuid,
    'present', current_date
  ))->>'was_replaced',
  'true',
  'Marking present clears the same-day disruption');

-- 6. Zero rows after present
select is(
  (select count(*) from public.attendance_events
    where driver_id = 'aacc0000-dddd-0000-0000-000000000001'
      and event_date = current_date),
  0::bigint,
  'Zero attendance rows after marking present');

-- ─── Cross-DSP isolation on RPCs ─────────────────────────────────────

-- 7. Attempt to record attendance for a driver in a different DSP fails.
-- Re-insert a driver in another DSP (using service role) so we can try.
select pg_temp.act_as_service();
insert into public.dsps (id, name, slug)
values ('aacc0000-0000-0000-0000-000000000999', 'Other DSP', 'att-other-dsp')
on conflict (id) do nothing;
insert into public.drivers (id, dsp_id, full_name, status) values
  ('aacc0000-dddd-0000-0000-000000000999',
   'aacc0000-0000-0000-0000-000000000999', 'Other Driver', 'active');

select pg_temp.act_as_dispatcher();

select throws_ok(
  $sql$
    select public.record_attendance(
      'aacc0000-dddd-0000-0000-000000000999'::uuid,
      'callout', current_date
    )
  $sql$,
  null, null,
  'record_attendance fails for driver in another DSP');

-- ─── Driver self-access ──────────────────────────────────────────────

-- Insert one event for the driver via dispatcher
do $$ begin
  perform public.record_attendance(
    'aacc0000-dddd-0000-0000-000000000001'::uuid,
    'late', current_date, '+15 min'
  );
end $$;

-- 8. Driver can SELECT their own events
select pg_temp.act_as_driver();

select is(
  (select count(*) from public.attendance_events
    where driver_id = 'aacc0000-dddd-0000-0000-000000000001'),
  1::bigint,
  'Driver can read own attendance events');

-- 9. Driver cannot insert events
select throws_ok(
  $sql$
    insert into public.attendance_events
      (dsp_id, driver_id, event_type, event_date)
    values
      ('aacc0000-0000-0000-0000-000000000001',
       'aacc0000-dddd-0000-0000-000000000001',
       'late', current_date - 1)
  $sql$,
  null, null,
  'Driver cannot INSERT attendance events directly');

-- 10. Driver cannot call record_attendance
select throws_ok(
  $sql$
    select public.record_attendance(
      'aacc0000-dddd-0000-0000-000000000001'::uuid,
      'present', current_date
    )
  $sql$,
  null, null,
  'Driver cannot call record_attendance');

-- ─── mark_attendance_exempt ──────────────────────────────────────────

select pg_temp.act_as_ops();

-- 11. Ops can mark an event exempt
do $$
declare e_id uuid;
begin
  select id into e_id from public.attendance_events
   where driver_id = 'aacc0000-dddd-0000-0000-000000000001' limit 1;
  perform public.mark_attendance_exempt(e_id, true, 'FMLA', 'Doctor note received');
end $$;

select is(
  (select exempt from public.attendance_events
    where driver_id = 'aacc0000-dddd-0000-0000-000000000001' limit 1),
  true,
  'Ops can mark attendance event exempt');

-- 12. Dispatcher cannot mark exempt (ops+ only)
select pg_temp.act_as_dispatcher();
select throws_ok(
  $sql$
    select public.mark_attendance_exempt(
      (select id from public.attendance_events
        where driver_id = 'aacc0000-dddd-0000-0000-000000000001' limit 1),
      false, null, null
    )
  $sql$,
  null, null,
  'Dispatcher cannot call mark_attendance_exempt');

-- ─── Wrap up ──────────────────────────────────────────────────────────

select * from finish();
rollback;
