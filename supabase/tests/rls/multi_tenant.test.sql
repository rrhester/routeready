-- ─────────────────────────────────────────────────────────────────────────
-- pgTAP test · multi-tenant isolation
-- Run via:  supabase test db
--
-- Creates 3 crossing DSPs, simulates a JWT for a user in DSP A, and
-- asserts that:
--   1. SELECT on every protected table only returns rows from DSP A
--   2. INSERT into another DSP fails
--   3. UPDATE of another DSP's row fails
-- This is the THE single most important test in the system. If this
-- breaks, customers see each other's data — every other test failure
-- is recoverable, this one is not.
-- ─────────────────────────────────────────────────────────────────────────

begin;
select plan(15);

create extension if not exists pgtap;

-- ─── Setup: 3 DSPs ────────────────────────────────────────────────────

insert into public.dsps (id, name, slug)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'DSP Alpha', 'dsp-alpha'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'DSP Bravo', 'dsp-bravo'),
  ('cccccccc-0000-0000-0000-000000000003', 'DSP Charlie', 'dsp-charlie');

insert into public.stations (id, dsp_id, code, name)
values
  ('aa000000-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001', 'A1', 'Alpha-1'),
  ('bb000000-0000-0000-0000-000000000002',
   'bbbbbbbb-0000-0000-0000-000000000002', 'B1', 'Bravo-1'),
  ('cc000000-0000-0000-0000-000000000003',
   'cccccccc-0000-0000-0000-000000000003', 'C1', 'Charlie-1');

-- 3 staff users — one per DSP. We create the auth.users rows minimally.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('aa000000-0000-0000-0000-aaaaaaaaaaaa',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'alpha@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('bb000000-0000-0000-0000-bbbbbbbbbbbb',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'bravo@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('cc000000-0000-0000-0000-cccccccccccc',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'charlie@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.app_users (id, dsp_id, role, email, full_name) values
  ('aa000000-0000-0000-0000-aaaaaaaaaaaa',
   'aaaaaaaa-0000-0000-0000-000000000001', 'owner', 'alpha@test.test', 'Alpha Owner'),
  ('bb000000-0000-0000-0000-bbbbbbbbbbbb',
   'bbbbbbbb-0000-0000-0000-000000000002', 'owner', 'bravo@test.test', 'Bravo Owner'),
  ('cc000000-0000-0000-0000-cccccccccccc',
   'cccccccc-0000-0000-0000-000000000003', 'owner', 'charlie@test.test', 'Charlie Owner');

-- 1 driver per DSP
insert into public.drivers (id, dsp_id, station_id, full_name, status) values
  ('aa000000-dddd-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001',
   'aa000000-0000-0000-0000-000000000001', 'Alpha Driver', 'active'),
  ('bb000000-dddd-0000-0000-000000000002',
   'bbbbbbbb-0000-0000-0000-000000000002',
   'bb000000-0000-0000-0000-000000000002', 'Bravo Driver', 'active'),
  ('cc000000-dddd-0000-0000-000000000003',
   'cccccccc-0000-0000-0000-000000000003',
   'cc000000-0000-0000-0000-000000000003', 'Charlie Driver', 'active');

-- ─── Helper: simulate a JWT for the given user ────────────────────────

create or replace function pg_temp.act_as(p_user uuid, p_dsp uuid, p_role text)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',     p_user::text,
      'dsp_id',  p_dsp::text,
      'role',    p_role
    )::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}'::text, true);
  perform set_config('role', 'service_role', true);
end $$;

-- ─── Test: cross-DSP reads should be invisible ────────────────────────

select pg_temp.act_as(
  'aa000000-0000-0000-0000-aaaaaaaaaaaa',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'owner');

select is(
  (select count(*) from public.dsps),
  1::bigint,
  'Alpha owner sees exactly 1 DSP (their own)');

select is(
  (select count(*) from public.stations),
  1::bigint,
  'Alpha owner sees exactly 1 station (their own)');

select is(
  (select count(*) from public.drivers),
  1::bigint,
  'Alpha owner sees exactly 1 driver (their own)');

select is(
  (select count(*) from public.app_users where dsp_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  1::bigint,
  'Alpha owner sees their own app_users row');

select is(
  (select count(*) from public.app_users where dsp_id = 'bbbbbbbb-0000-0000-0000-000000000002'),
  0::bigint,
  'Alpha owner CANNOT see Bravo''s app_users');

-- Switch to Bravo
select pg_temp.act_as(
  'bb000000-0000-0000-0000-bbbbbbbbbbbb',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'owner');

select is(
  (select count(*) from public.drivers),
  1::bigint,
  'Bravo owner sees exactly 1 driver');

select is(
  (select full_name from public.drivers limit 1),
  'Bravo Driver',
  'Bravo owner sees Bravo Driver only');

select is(
  (select count(*) from public.drivers where dsp_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0::bigint,
  'Bravo owner CANNOT see Alpha drivers');

-- ─── Test: cross-DSP writes should fail ───────────────────────────────

select throws_ok(
  $sql$
    insert into public.drivers (dsp_id, full_name)
    values ('cccccccc-0000-0000-0000-000000000003', 'Sneaky Driver')
  $sql$,
  '42501',
  null,
  'Bravo owner cannot INSERT into Charlie''s drivers (RLS denies)');

-- Try to UPDATE Alpha's driver while authenticated as Bravo
select throws_ok(
  $sql$
    update public.drivers
       set full_name = 'Hacked'
     where id = 'aa000000-dddd-0000-0000-000000000001'
  $sql$,
  null, null,
  'Bravo owner cannot UPDATE Alpha''s drivers');

-- The update should not have changed anything
select pg_temp.act_as_service();
select is(
  (select full_name from public.drivers
    where id = 'aa000000-dddd-0000-0000-000000000001'),
  'Alpha Driver',
  'Alpha driver name unchanged after Bravo update attempt');

-- ─── Test: dispatcher cannot delete drivers (owner-only) ──────────────

-- Create a dispatcher in Alpha
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('aa000000-0000-0000-0000-bbbbbbbbbbbb',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'alpha-dispatcher@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.app_users (id, dsp_id, role, email, full_name) values
  ('aa000000-0000-0000-0000-bbbbbbbbbbbb',
   'aaaaaaaa-0000-0000-0000-000000000001',
   'dispatcher', 'alpha-dispatcher@test.test', 'Alpha Dispatcher');

select pg_temp.act_as(
  'aa000000-0000-0000-0000-bbbbbbbbbbbb',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'dispatcher');

select throws_ok(
  $sql$
    delete from public.drivers
     where id = 'aa000000-dddd-0000-0000-000000000001'
  $sql$,
  null, null,
  'Alpha dispatcher cannot DELETE drivers (owner-only)');

select throws_ok(
  $sql$
    insert into public.drivers (dsp_id, full_name)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'New Driver')
  $sql$,
  null, null,
  'Alpha dispatcher cannot INSERT drivers (ops+ only)');

-- ─── Test: driver self-update gate ────────────────────────────────────
-- Drivers can update phone but not full_name.

-- Promote Alpha Driver to also be an app_user with role=driver
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('aa000000-dddd-0000-0000-000000000aaa',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'driver-alpha@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.app_users (id, dsp_id, role, driver_id, email, full_name) values
  ('aa000000-dddd-0000-0000-000000000aaa',
   'aaaaaaaa-0000-0000-0000-000000000001',
   'driver',
   'aa000000-dddd-0000-0000-000000000001',
   'driver-alpha@test.test',
   'Alpha Driver Self');

-- Add driver_id claim to JWT
do $$ begin
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub',       'aa000000-dddd-0000-0000-000000000aaa',
      'dsp_id',    'aaaaaaaa-0000-0000-0000-000000000001',
      'role',      'driver',
      'driver_id', 'aa000000-dddd-0000-0000-000000000001'
    )::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select lives_ok(
  $sql$
    update public.drivers
       set phone = '+14175559999'
     where id = 'aa000000-dddd-0000-0000-000000000001'
  $sql$,
  'Driver CAN update own phone');

select throws_ok(
  $sql$
    update public.drivers
       set full_name = 'Renamed by Self'
     where id = 'aa000000-dddd-0000-0000-000000000001'
  $sql$,
  null, null,
  'Driver CANNOT update own full_name (column-level guard)');

-- ─── Test: bulk_import_drivers respects DSP scope ─────────────────────

select pg_temp.act_as(
  'aa000000-0000-0000-0000-aaaaaaaaaaaa',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'owner');

select is(
  (public.bulk_import_drivers('[{"full_name":"Bulk One","phone":"+14175558888"}]'::jsonb))->>'inserted',
  '1',
  'Owner can bulk-import a driver into their own DSP');

select pg_temp.act_as_service();
select is(
  (select count(*) from public.drivers
    where full_name = 'Bulk One'
      and dsp_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  1::bigint,
  'Bulk-imported driver landed in correct DSP');

-- ─── Wrap up ──────────────────────────────────────────────────────────

select * from finish();
rollback;
