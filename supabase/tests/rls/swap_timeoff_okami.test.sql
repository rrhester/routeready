-- ─────────────────────────────────────────────────────────────────────────
-- pgTAP test · swap + time-off + OKAMI
-- Verifies the driver-initiated workflows and OKAMI cushion math /
-- recommendation engine.
-- ─────────────────────────────────────────────────────────────────────────

begin;
select plan(15);

create extension if not exists pgtap;

-- ─── Setup ────────────────────────────────────────────────────────────

insert into public.dsps (id, name, slug)
values ('aaee0000-0000-0000-0000-000000000001', 'Swap Test DSP', 'swap-test');

insert into public.stations (id, dsp_id, code, name)
values ('aaee0000-0000-0000-0000-000000001000',
        'aaee0000-0000-0000-0000-000000000001', 'A1', 'A-1');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('aaee0000-0000-0000-0000-aaaaaaaaaaaa',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'swap-ops@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('aaee0000-0000-0000-0000-d1d1d1d1d1d1',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'swap-driver1@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('aaee0000-0000-0000-0000-d2d2d2d2d2d2',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'swap-driver2@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.drivers (id, dsp_id, station_id, full_name, status) values
  ('aaee0000-dddd-0000-0000-000000000001',
   'aaee0000-0000-0000-0000-000000000001',
   'aaee0000-0000-0000-0000-000000001000',
   'Swap Driver 1', 'active'),
  ('aaee0000-dddd-0000-0000-000000000002',
   'aaee0000-0000-0000-0000-000000000001',
   'aaee0000-0000-0000-0000-000000001000',
   'Swap Driver 2', 'active');

insert into public.app_users (id, dsp_id, role, email) values
  ('aaee0000-0000-0000-0000-aaaaaaaaaaaa',
   'aaee0000-0000-0000-0000-000000000001', 'ops', 'swap-ops@test.test');

insert into public.app_users (id, dsp_id, role, driver_id, email) values
  ('aaee0000-0000-0000-0000-d1d1d1d1d1d1',
   'aaee0000-0000-0000-0000-000000000001', 'driver',
   'aaee0000-dddd-0000-0000-000000000001', 'swap-driver1@test.test'),
  ('aaee0000-0000-0000-0000-d2d2d2d2d2d2',
   'aaee0000-0000-0000-0000-000000000001', 'driver',
   'aaee0000-dddd-0000-0000-000000000002', 'swap-driver2@test.test');

insert into public.routes (id, dsp_id, station_id, code) values
  ('aaee0000-rrrr-0000-0000-000000000001',
   'aaee0000-0000-0000-0000-000000000001',
   'aaee0000-0000-0000-0000-000000001000',
   'A1-01');

insert into public.attendance_policies (dsp_id) values
  ('aaee0000-0000-0000-0000-000000000001');

create or replace function pg_temp.act_as_ops()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', 'aaee0000-0000-0000-0000-aaaaaaaaaaaa',
                       'dsp_id', 'aaee0000-0000-0000-0000-000000000001',
                       'role', 'ops')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_driver(p_user uuid, p_driver uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user::text,
                       'dsp_id', 'aaee0000-0000-0000-0000-000000000001',
                       'role', 'driver',
                       'driver_id', p_driver::text)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- ─── Swap workflow ────────────────────────────────────────────────────

select pg_temp.act_as_ops();

-- Assign a future shift to driver 1
do $$
declare v_id uuid;
begin
  v_id := public.assign_shift(
    'aaee0000-dddd-0000-0000-000000000001'::uuid,
    'aaee0000-rrrr-0000-0000-000000000001'::uuid,
    current_date + 3
  );
end $$;

-- 1. Driver 1 requests a swap with driver 2
select pg_temp.act_as_driver(
  'aaee0000-0000-0000-0000-d1d1d1d1d1d1'::uuid,
  'aaee0000-dddd-0000-0000-000000000001'::uuid);

select isnt(
  (public.request_swap(
    (select id from public.shifts
      where driver_id = 'aaee0000-dddd-0000-0000-000000000001' limit 1),
    'aaee0000-dddd-0000-0000-000000000002'::uuid,
    'Family event'
  ))::text,
  null,
  'Driver 1 can request a directed swap');

-- 2. Shift status flipped to swap_pending
select is(
  (select status::text from public.shifts
    where driver_id = 'aaee0000-dddd-0000-0000-000000000001' limit 1),
  'swap_pending',
  'Shift status = swap_pending after request');

-- 3. Cannot create a second pending swap for the same shift
select throws_ok(
  $sql$
    select public.request_swap(
      (select id from public.shifts
        where driver_id = 'aaee0000-dddd-0000-0000-000000000001' limit 1),
      'aaee0000-dddd-0000-0000-000000000002'::uuid,
      'Another reason'
    )
  $sql$,
  null, null,
  'Cannot have two pending swaps for same shift');

-- 4. Ops approves the swap
select pg_temp.act_as_ops();

select is(
  (public.decide_swap(
    (select id from public.swap_requests where status = 'pending' limit 1),
    true, 'Approved'
  ))->>'approved',
  'true',
  'decide_swap with approve=true returns approved=true');

-- 5. Shift driver_id flipped to driver 2
select is(
  (select driver_id from public.shifts
    where shift_date = current_date + 3
    order by created_at desc limit 1),
  'aaee0000-dddd-0000-0000-000000000002'::uuid,
  'Shift reassigned to driver 2 after approval');

-- 6. Shift status back to scheduled
select is(
  (select status::text from public.shifts
    where shift_date = current_date + 3
    order by created_at desc limit 1),
  'scheduled',
  'Shift status = scheduled after swap approved');

-- ─── Drivers cannot decide swaps ──────────────────────────────────────

-- Set up another swap to test denial path
do $$
declare v_shift uuid;
begin
  -- Reassign another future shift to driver 1
  v_shift := public.assign_shift(
    'aaee0000-dddd-0000-0000-000000000001'::uuid,
    'aaee0000-rrrr-0000-0000-000000000001'::uuid,
    current_date + 5
  );
end $$;

select pg_temp.act_as_driver(
  'aaee0000-0000-0000-0000-d1d1d1d1d1d1'::uuid,
  'aaee0000-dddd-0000-0000-000000000001'::uuid);

do $$ begin
  perform public.request_swap(
    (select id from public.shifts where shift_date = current_date + 5 limit 1),
    'aaee0000-dddd-0000-0000-000000000002'::uuid,
    'second swap'
  );
end $$;

-- 7. Driver cannot call decide_swap
select throws_ok(
  $sql$
    select public.decide_swap(
      (select id from public.swap_requests where status = 'pending' limit 1),
      false, null
    )
  $sql$,
  null, null,
  'Driver cannot call decide_swap (ops only)');

-- ─── Time-off workflow ────────────────────────────────────────────────

select pg_temp.act_as_driver(
  'aaee0000-0000-0000-0000-d2d2d2d2d2d2'::uuid,
  'aaee0000-dddd-0000-0000-000000000002'::uuid);

-- 8. Driver 2 requests time off
select isnt(
  (public.request_time_off(
    'aaee0000-dddd-0000-0000-000000000002'::uuid,
    current_date + 10,
    current_date + 12,
    'pto',
    'Visiting family'
  ))::text,
  null,
  'Driver can request own time off');

-- 9. Driver cannot request time off for another driver
select throws_ok(
  $sql$
    select public.request_time_off(
      'aaee0000-dddd-0000-0000-000000000001'::uuid,
      current_date + 20,
      current_date + 22,
      'pto'
    )
  $sql$,
  null, null,
  'Driver cannot request time off for another driver');

-- 10. Ops approves time off
select pg_temp.act_as_ops();

-- First assign a shift inside the time-off window so we can verify the
-- approval flips it to status='timeoff'.
do $$ begin
  insert into public.shifts
    (dsp_id, station_id, driver_id, route_id, shift_date, status)
  values
    ('aaee0000-0000-0000-0000-000000000001',
     'aaee0000-0000-0000-0000-000000001000',
     'aaee0000-dddd-0000-0000-000000000002',
     'aaee0000-rrrr-0000-0000-000000000001',
     current_date + 11, 'scheduled');
end $$;

select cmp_ok(
  ((public.decide_time_off(
    (select id from public.time_off_requests where status = 'pending' limit 1),
    true, 'Approved'
  ))->>'shifts_flipped_to_timeoff')::int,
  '>=',
  1,
  'decide_time_off flipped at least 1 shift to timeoff');

-- 11. Verify the shift status
select is(
  (select status::text from public.shifts
    where driver_id = 'aaee0000-dddd-0000-0000-000000000002'
      and shift_date = current_date + 11),
  'timeoff',
  'Shift on PTO date now status=timeoff');

-- ─── OKAMI math ───────────────────────────────────────────────────────

-- 12. okami_shifts_needed math (percent mode)
select is(
  public.okami_shifts_needed(38, 'percent', 10),
  42,
  'okami_shifts_needed: 38 routes × 10% cushion = 42 shifts');

-- 13. okami_shifts_needed math (count mode)
select is(
  public.okami_shifts_needed(38, 'count', 5),
  43,
  'okami_shifts_needed: 38 routes + 5 cushion = 43 shifts');

-- 14. set_okami_week upserts
select isnt(
  (public.set_okami_week(
    extract(isoyear from current_date)::int,
    extract(week    from current_date)::int + 5,
    date_trunc('week', current_date)::date + 35,
    50,
    jsonb_build_object('mon', 45, 'tue', 50, 'wed', 50, 'thu', 50, 'fri', 50, 'sat', 30, 'sun', 20),
    'percent', 12
  ))::text,
  null,
  'set_okami_week creates a row');

-- 15. okami_recommend_cushion returns a structured response
select isnt(
  (public.okami_recommend_cushion('aaee0000-0000-0000-0000-000000000001'::uuid))->>'percent',
  null,
  'okami_recommend_cushion returns a percent');

-- ─── Wrap up ──────────────────────────────────────────────────────────

select * from finish();
rollback;
