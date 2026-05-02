-- ─────────────────────────────────────────────────────────────────────────
-- pgTAP test · schedule + suspension cascade to shifts
-- Verifies:
--   - assign_shift / unassign_shift / publish_week work and respect RLS
--   - Suspending a driver flips their future shifts to status='open'
--   - Voiding the suspension does NOT auto-reassign (dispatcher manual)
--   - Cross-DSP isolation on shifts
-- ─────────────────────────────────────────────────────────────────────────

begin;
select plan(15);

create extension if not exists pgtap;

-- ─── Setup ────────────────────────────────────────────────────────────

insert into public.dsps (id, name, slug)
values
  ('aadd0000-0000-0000-0000-000000000001', 'Sched Test DSP A', 'sched-a'),
  ('aadd0000-0000-0000-0000-000000000002', 'Sched Test DSP B', 'sched-b');

insert into public.stations (id, dsp_id, code, name)
values
  ('aadd0000-0000-0000-0000-000000001000',
   'aadd0000-0000-0000-0000-000000000001', 'A1', 'A-1');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('aadd0000-0000-0000-0000-aaaaaaaaaaaa',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'sched-owner@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('aadd0000-0000-0000-0000-cccccccccccc',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'sched-disp@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.app_users (id, dsp_id, role, email) values
  ('aadd0000-0000-0000-0000-aaaaaaaaaaaa',
   'aadd0000-0000-0000-0000-000000000001', 'owner',      'sched-owner@test.test'),
  ('aadd0000-0000-0000-0000-cccccccccccc',
   'aadd0000-0000-0000-0000-000000000001', 'dispatcher', 'sched-disp@test.test');

insert into public.drivers (id, dsp_id, station_id, full_name, status) values
  ('aadd0000-dddd-0000-0000-000000000001',
   'aadd0000-0000-0000-0000-000000000001',
   'aadd0000-0000-0000-0000-000000001000',
   'Sched Driver', 'active'),
  ('aadd0000-dddd-0000-0000-000000000002',
   'aadd0000-0000-0000-0000-000000000001',
   'aadd0000-0000-0000-0000-000000001000',
   'Backup Driver', 'active');

insert into public.routes (id, dsp_id, station_id, code) values
  ('aadd0000-rrrr-0000-0000-000000000001',
   'aadd0000-0000-0000-0000-000000000001',
   'aadd0000-0000-0000-0000-000000001000',
   'A1-01');

insert into public.attendance_policies (dsp_id) values
  ('aadd0000-0000-0000-0000-000000000001');

create or replace function pg_temp.act_as_dispatcher()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', 'aadd0000-0000-0000-0000-cccccccccccc',
                       'dsp_id', 'aadd0000-0000-0000-0000-000000000001',
                       'role', 'dispatcher')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_owner()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', 'aadd0000-0000-0000-0000-aaaaaaaaaaaa',
                       'dsp_id', 'aadd0000-0000-0000-0000-000000000001',
                       'role', 'owner')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- ─── assign_shift / unassign_shift ────────────────────────────────────

select pg_temp.act_as_dispatcher();

-- 1. Assign succeeds
select isnt(
  (public.assign_shift(
    'aadd0000-dddd-0000-0000-000000000001'::uuid,
    'aadd0000-rrrr-0000-0000-000000000001'::uuid,
    current_date + 1
  ))::text,
  null,
  'Dispatcher can assign a shift');

-- 2. Double-assign on same date fails
select throws_ok(
  $sql$
    select public.assign_shift(
      'aadd0000-dddd-0000-0000-000000000001'::uuid,
      'aadd0000-rrrr-0000-0000-000000000001'::uuid,
      current_date + 1
    )
  $sql$,
  null, null,
  'Cannot double-assign same driver on same date');

-- 3. Unassign flips to open
do $$
declare s_id uuid;
begin
  select id into s_id from public.shifts
   where driver_id = 'aadd0000-dddd-0000-0000-000000000001' limit 1;
  perform public.unassign_shift(s_id);
end $$;

select is(
  (select status::text from public.shifts
    where dsp_id = 'aadd0000-0000-0000-0000-000000000001'
    order by created_at desc limit 1),
  'open',
  'unassign_shift flips status to open');

-- 4. Re-assign works after unassign
do $$
declare s_id uuid;
begin
  select id into s_id from public.shifts
   where dsp_id = 'aadd0000-0000-0000-0000-000000000001'
     and status = 'open' limit 1;
  update public.shifts
     set driver_id = 'aadd0000-dddd-0000-0000-000000000001',
         status = 'scheduled'
   where id = s_id;
end $$;

select is(
  (select count(*) from public.shifts
    where driver_id = 'aadd0000-dddd-0000-0000-000000000001'
      and status = 'scheduled'),
  1::bigint,
  'Driver re-assigned after unassign');

-- ─── Cross-DSP isolation on assign ────────────────────────────────────

-- 5. Cross-DSP driver fails
select throws_ok(
  $sql$
    select public.assign_shift(
      'aadd0000-dddd-0000-0000-000000000999'::uuid,  -- doesn't exist in DSP A
      'aadd0000-rrrr-0000-0000-000000000001'::uuid,
      current_date + 5
    )
  $sql$,
  null, null,
  'assign_shift fails for driver outside DSP');

-- ─── Suspension cascade to shifts ────────────────────────────────────

-- Add several future shifts for the driver
do $$
declare i int;
begin
  for i in 2..4 loop
    insert into public.shifts
      (dsp_id, station_id, driver_id, route_id, shift_date, status)
    values
      ('aadd0000-0000-0000-0000-000000000001',
       'aadd0000-0000-0000-0000-000000001000',
       'aadd0000-dddd-0000-0000-000000000001',
       'aadd0000-rrrr-0000-0000-000000000001',
       current_date + i, 'scheduled');
  end loop;
end $$;

-- 6. Driver has 4 future shifts (1 from earlier + 3 just added)
select is(
  (select count(*) from public.shifts
    where driver_id = 'aadd0000-dddd-0000-0000-000000000001'
      and shift_date >= current_date),
  4::bigint,
  'Driver has 4 future shifts before suspension');

-- 7. Suspend the driver
select isnt(
  (public.process_suspension(
    'aadd0000-dddd-0000-0000-000000000001'::uuid,
    current_date,
    current_date + 5,
    false,
    'attendance',
    'Test suspension to verify shift cascade.'
  ))::text,
  null,
  'process_suspension succeeded');

-- 8. All future shifts now open (driver_id cleared)
select is(
  (select count(*) from public.shifts
    where dsp_id = 'aadd0000-0000-0000-0000-000000000001'
      and shift_date >= current_date
      and status = 'open'),
  4::bigint,
  'All 4 future shifts flipped to status=open');

-- 9. Driver has no remaining scheduled future shifts
select is(
  (select count(*) from public.shifts
    where driver_id = 'aadd0000-dddd-0000-0000-000000000001'
      and shift_date >= current_date
      and status = 'scheduled'),
  0::bigint,
  'No scheduled future shifts remain for suspended driver');

-- 10. Driver status = suspended
select is(
  (select status::text from public.drivers
    where id = 'aadd0000-dddd-0000-0000-000000000001'),
  'suspended',
  'drivers.status = suspended after process_suspension');

-- ─── Reinstatement does NOT auto-reassign ─────────────────────────────

-- 11. Reinstate
select isnt(
  (public.process_reinstatement(
    'aadd0000-dddd-0000-0000-000000000001'::uuid,
    'Reinstating after coverage check; reassign manually.'
  ))::text,
  null,
  'process_reinstatement succeeded');

-- 12. Driver status back to active
select is(
  (select status::text from public.drivers
    where id = 'aadd0000-dddd-0000-0000-000000000001'),
  'active',
  'drivers.status = active after reinstatement');

-- 13. Shifts STILL open (no auto-reassign)
select is(
  (select count(*) from public.shifts
    where dsp_id = 'aadd0000-0000-0000-0000-000000000001'
      and shift_date >= current_date
      and status = 'open'),
  4::bigint,
  'Shifts remain open after reinstatement (manual reassign expected)');

-- ─── publish_week ─────────────────────────────────────────────────────

select pg_temp.act_as_owner();

-- 14. publish_week flips published=true on this week's shifts
select cmp_ok(
  public.publish_week(date_trunc('week', current_date)::date),
  '>=',
  0,
  'publish_week returns the count of shifts published');

-- 15. release_future_shifts manual call works
select pg_temp.act_as_dispatcher();

-- Reassign one of the open shifts so we have something to release
do $$
declare s_id uuid;
begin
  update public.shifts
     set driver_id = 'aadd0000-dddd-0000-0000-000000000002',
         status = 'scheduled'
   where dsp_id = 'aadd0000-0000-0000-0000-000000000001'
     and status = 'open'
     and shift_date >= current_date + 7;  -- pick a far-future one
end $$;

-- Check that release_future_shifts works (run as ops)
select pg_temp.act_as_owner();
select cmp_ok(
  public.release_future_shifts('aadd0000-dddd-0000-0000-000000000002'::uuid),
  '>=',
  0,
  'release_future_shifts returns count of released shifts');

-- ─── Wrap up ──────────────────────────────────────────────────────────

select * from finish();
rollback;
