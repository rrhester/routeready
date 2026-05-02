-- ─────────────────────────────────────────────────────────────────────────
-- pgTAP test · Phase 5 compliance
-- License renewals (manual + policy), inspection submission, and the
-- auto-block-on-expired-license scheduling guard.
-- ─────────────────────────────────────────────────────────────────────────

begin;
select plan(12);

create extension if not exists pgtap;

-- ─── Setup ────────────────────────────────────────────────────────────

insert into public.dsps (id, name, slug)
values ('aacc1100-0000-0000-0000-000000000001', 'Compliance Test DSP', 'comp-test');

insert into public.stations (id, dsp_id, code, name) values
  ('aacc1100-0000-0000-0000-000000001000',
   'aacc1100-0000-0000-0000-000000000001', 'A1', 'A-1');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('aacc1100-0000-0000-0000-aaaaaaaaaaaa',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'comp-owner@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('aacc1100-0000-0000-0000-cccccccccccc',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'comp-disp@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.app_users (id, dsp_id, role, email) values
  ('aacc1100-0000-0000-0000-aaaaaaaaaaaa',
   'aacc1100-0000-0000-0000-000000000001', 'owner', 'comp-owner@test.test'),
  ('aacc1100-0000-0000-0000-cccccccccccc',
   'aacc1100-0000-0000-0000-000000000001', 'dispatcher', 'comp-disp@test.test');

insert into public.drivers (id, dsp_id, station_id, full_name, phone, status, license_expiry) values
  ('aacc1100-dddd-0000-0000-000000000001',
   'aacc1100-0000-0000-0000-000000000001',
   'aacc1100-0000-0000-0000-000000001000',
   'Compliance Driver', '+14175558890', 'active',
   current_date + 5);                         -- expires in 5 days

insert into public.routes (id, dsp_id, station_id, code) values
  ('aacc1100-rrrr-0000-0000-000000000001',
   'aacc1100-0000-0000-0000-000000000001',
   'aacc1100-0000-0000-0000-000000001000', 'A1-01');

insert into public.attendance_policies (dsp_id) values
  ('aacc1100-0000-0000-0000-000000000001');

create or replace function pg_temp.act_as_owner()
returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub','aacc1100-0000-0000-0000-aaaaaaaaaaaa',
                       'dsp_id','aacc1100-0000-0000-0000-000000000001',
                       'role','owner')::text, true);
  perform set_config('role','authenticated', true);
end $$;

create or replace function pg_temp.act_as_dispatcher()
returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub','aacc1100-0000-0000-0000-cccccccccccc',
                       'dsp_id','aacc1100-0000-0000-0000-000000000001',
                       'role','dispatcher')::text, true);
  perform set_config('role','authenticated', true);
end $$;

-- ─── set_license_policy ──────────────────────────────────────────────

select pg_temp.act_as_owner();

-- 1. Owner can set policy
select lives_ok(
  $sql$ select public.set_license_policy(true, array[30, 14, 3], null, true, true) $sql$,
  'Owner can set_license_policy');

-- 2. Days_before persisted
select is(
  (select days_before from public.license_policies
    where dsp_id = 'aacc1100-0000-0000-0000-000000000001'),
  array[30, 14, 3],
  'days_before persisted as [30,14,3]');

-- 3. Dispatcher cannot set policy (owner only)
select pg_temp.act_as_dispatcher();
select throws_ok(
  $sql$ select public.set_license_policy(false, array[7]) $sql$,
  null, null,
  'Dispatcher cannot call set_license_policy');

-- ─── send_license_reminder (manual) ──────────────────────────────────

select pg_temp.act_as_owner();

-- 4. Manual reminder enqueues an SMS + writes license_reminders + hr_events
select isnt(
  (public.send_license_reminder('aacc1100-dddd-0000-0000-000000000001'::uuid))::text,
  null,
  'send_license_reminder returns a reminder id');

-- 5. license_reminders row created
select is(
  (select count(*) from public.license_reminders
    where driver_id = 'aacc1100-dddd-0000-0000-000000000001'),
  1::bigint,
  'License reminder logged');

-- 6. SMS row queued
select is(
  (select count(*) from public.sms_messages
    where driver_id = 'aacc1100-dddd-0000-0000-000000000001'
      and related_kind = 'license_reminder'
      and status = 'queued'),
  1::bigint,
  'License reminder SMS queued');

-- 7. HR file entry created
select is(
  (select count(*) from public.hr_events
    where driver_id = 'aacc1100-dddd-0000-0000-000000000001'
      and event_type = 'license_reminder_sent'),
  1::bigint,
  'HR file entry created for license reminder');

-- ─── mark_license_renewed ───────────────────────────────────────────

-- 8. Renew the license out 365 days
select lives_ok(
  $sql$
    select public.mark_license_renewed(
      'aacc1100-dddd-0000-0000-000000000001'::uuid,
      current_date + 365,
      'CDL-NEW-12345',
      null
    )
  $sql$,
  'mark_license_renewed succeeds with future date');

-- 9. Driver row updated
select is(
  (select license_expiry from public.drivers
    where id = 'aacc1100-dddd-0000-0000-000000000001'),
  current_date + 365,
  'drivers.license_expiry updated');

-- 10. Past-date renewal rejected
select throws_ok(
  $sql$
    select public.mark_license_renewed(
      'aacc1100-dddd-0000-0000-000000000001'::uuid,
      current_date - 1
    )
  $sql$,
  null, null,
  'mark_license_renewed rejects past dates');

-- ─── Auto-block on expired license ───────────────────────────────────

-- Fix the license back to expired for this test
do $$ begin
  update public.drivers
     set license_expiry = current_date - 1
   where id = 'aacc1100-dddd-0000-0000-000000000001';
end $$;

select pg_temp.act_as_dispatcher();

-- 11. Cannot assign expired-license driver to a future shift (DSP policy block_scheduling=true)
select throws_ok(
  $sql$
    select public.assign_shift(
      'aacc1100-dddd-0000-0000-000000000001'::uuid,
      'aacc1100-rrrr-0000-0000-000000000001'::uuid,
      current_date + 1
    )
  $sql$,
  null, null,
  'assign_shift fails when driver license is expired and block_scheduling=true');

-- 12. After disabling block_scheduling, assignment succeeds
select pg_temp.act_as_owner();
do $$ begin
  perform public.set_license_policy(true, array[30,14,3], null, true, false);   -- block_scheduling=false
end $$;

select pg_temp.act_as_dispatcher();
select isnt(
  (public.assign_shift(
    'aacc1100-dddd-0000-0000-000000000001'::uuid,
    'aacc1100-rrrr-0000-0000-000000000001'::uuid,
    current_date + 1
  ))::text,
  null,
  'assign_shift succeeds when block_scheduling=false even with expired license');

-- ─── Wrap up ──────────────────────────────────────────────────────────

select * from finish();
rollback;
