-- ─────────────────────────────────────────────────────────────────────────
-- pgTAP test · SMS opt-out enforcement + referral payout flow
-- ─────────────────────────────────────────────────────────────────────────

begin;
select plan(12);

create extension if not exists pgtap;

-- ─── Setup ────────────────────────────────────────────────────────────

insert into public.dsps (id, name, slug)
values ('bbaa0000-0000-0000-0000-000000000001', 'SMS Test DSP', 'sms-test');

insert into public.stations (id, dsp_id, code, name) values
  ('bbaa0000-0000-0000-0000-000000001000',
   'bbaa0000-0000-0000-0000-000000000001', 'A1', 'A-1');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('bbaa0000-0000-0000-0000-aaaaaaaaaaaa',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'sms-ops@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.app_users (id, dsp_id, role, email) values
  ('bbaa0000-0000-0000-0000-aaaaaaaaaaaa',
   'bbaa0000-0000-0000-0000-000000000001', 'ops', 'sms-ops@test.test');

insert into public.drivers (id, dsp_id, station_id, full_name, phone, status) values
  ('bbaa0000-dddd-0000-0000-000000000001',
   'bbaa0000-0000-0000-0000-000000000001',
   'bbaa0000-0000-0000-0000-000000001000',
   'SMS Driver', '+14175558888', 'active');

create or replace function pg_temp.act_as_ops()
returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', 'bbaa0000-0000-0000-0000-aaaaaaaaaaaa',
                       'dsp_id', 'bbaa0000-0000-0000-0000-000000000001',
                       'role', 'ops')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- ─── enqueue_sms basic ───────────────────────────────────────────────

select pg_temp.act_as_ops();

-- 1. Enqueue an SMS to a driver
select isnt(
  (public.enqueue_sms(
    '+14175558888',
    'Test message',
    'bbaa0000-dddd-0000-0000-000000000001'::uuid,
    null,
    'coaching'
  ))::text,
  null,
  'enqueue_sms returns a message id');

-- 2. Status is 'queued'
select is(
  (select status from public.sms_messages
    where dsp_id = 'bbaa0000-0000-0000-0000-000000000001'
    order by created_at desc limit 1),
  'queued',
  'Outbound SMS row inserted with status=queued');

-- 3. Phone is normalized E.164
select is(
  (select to_phone from public.sms_messages
    where dsp_id = 'bbaa0000-0000-0000-0000-000000000001'
    order by created_at desc limit 1),
  '+14175558888',
  'Outbound to_phone normalized to E.164');

-- 4. Cannot enqueue with both driver and applicant
select throws_ok(
  $sql$
    select public.enqueue_sms(
      '+14175557777', 'Both', 'bbaa0000-dddd-0000-0000-000000000001'::uuid,
      'bbaa0000-aaaa-0000-0000-000000000001'::uuid, 'coaching'
    )
  $sql$,
  null, null,
  'enqueue_sms rejects both driver_id and applicant_id');

-- 5. Cannot enqueue with neither
select throws_ok(
  $sql$
    select public.enqueue_sms('+14175557777', 'Neither', null, null, 'coaching')
  $sql$,
  null, null,
  'enqueue_sms rejects when neither driver_id nor applicant_id given');

-- ─── Opt-out enforcement ─────────────────────────────────────────────

-- 6. handle_opt_out adds to opt-out list and cancels queued messages
do $$ begin
  perform public.handle_opt_out('+14175558888', 'STOP');
end $$;

select is(
  (select count(*) from public.sms_opt_outs
    where dsp_id = 'bbaa0000-0000-0000-0000-000000000001'
      and phone = '+14175558888'),
  1::bigint,
  'handle_opt_out added phone to opt-out list');

-- 7. Queued messages to that phone are now 'opted_out'
select is(
  (select status from public.sms_messages
    where dsp_id = 'bbaa0000-0000-0000-0000-000000000001'
      and to_phone = '+14175558888'
    order by created_at desc limit 1),
  'opted_out',
  'Queued message to opted-out phone status flipped to opted_out');

-- 8. Re-attempting an outbound to the opted-out phone fails
select throws_ok(
  $sql$
    select public.enqueue_sms(
      '+14175558888',
      'Should be blocked',
      'bbaa0000-dddd-0000-0000-000000000001'::uuid,
      null,
      'coaching'
    )
  $sql$,
  null, null,
  'enqueue_sms to opted-out phone is rejected by trigger');

-- ─── Referral payouts ────────────────────────────────────────────────

-- Setup: a referrer driver and an applicant referred by them
insert into public.drivers (id, dsp_id, station_id, full_name, status) values
  ('bbaa0000-dddd-0000-0000-000000000002',
   'bbaa0000-0000-0000-0000-000000000001',
   'bbaa0000-0000-0000-0000-000000001000',
   'Referrer Two', 'active');

do $$
declare v_app_id uuid;
begin
  v_app_id := public.create_applicant(
    'Referred Two', 'r2@test.test', '+14175557777',
    'referral', 'ref-test-2',
    'bbaa0000-dddd-0000-0000-000000000002'::uuid
  );
  perform public.advance_applicant_stage(v_app_id, 'screening');
  perform public.advance_applicant_stage(v_app_id, 'passed');
  perform public.advance_applicant_stage(v_app_id, 'booked');
  perform public.hire_applicant(v_app_id);
end $$;

-- 9. 4 payouts created
select is(
  (select count(*) from public.referral_payouts rp
    join public.applicants a on a.id = rp.applicant_id
    where a.full_name = 'Referred Two'),
  4::bigint,
  '4 referral payouts created on hire');

-- 10. mark_referral_paid sets paid_at
do $$
declare v_payout_id uuid;
begin
  select rp.id into v_payout_id
    from public.referral_payouts rp
    join public.applicants a on a.id = rp.applicant_id
   where a.full_name = 'Referred Two' and rp.milestone = 'hire';
  perform public.mark_referral_paid(v_payout_id, 'gusto', 'Sent on May 5');
end $$;

select isnt(
  (select paid_at::text from public.referral_payouts rp
    join public.applicants a on a.id = rp.applicant_id
    where a.full_name = 'Referred Two' and rp.milestone = 'hire'),
  null,
  'mark_referral_paid set paid_at');

-- 11. paid_via populated
select is(
  (select paid_via from public.referral_payouts rp
    join public.applicants a on a.id = rp.applicant_id
    where a.full_name = 'Referred Two' and rp.milestone = 'hire'),
  'gusto',
  'mark_referral_paid set paid_via');

-- 12. Tenure milestones have correct due dates (30/60/90 days)
select is(
  (select max(due_at) - min(due_at) from public.referral_payouts rp
    join public.applicants a on a.id = rp.applicant_id
    where a.full_name = 'Referred Two'),
  '90 days'::interval,
  'Payouts span 0-90 days as expected');

-- ─── Wrap up ──────────────────────────────────────────────────────────

select * from finish();
rollback;
