-- ─────────────────────────────────────────────────────────────────────────
-- pgTAP test · applicants + screening + hire flow
-- Verifies:
--   - create_applicant + dedup by source_ref
--   - record_screening_response computes score + flips stage
--   - Hard-filter answer flips stage to 'filtered'
--   - advance_applicant_stage enforces allowed transitions
--   - hire_applicant creates a drivers row + referral payouts
--   - Driver's hire_applicant cannot bypass via direct UPDATE
-- ─────────────────────────────────────────────────────────────────────────

begin;
select plan(15);

create extension if not exists pgtap;

-- ─── Setup ────────────────────────────────────────────────────────────

insert into public.dsps (id, name, slug)
values ('aaff0000-0000-0000-0000-000000000001', 'Apply Test DSP', 'apply-test');

insert into public.stations (id, dsp_id, code, name) values
  ('aaff0000-0000-0000-0000-000000001000',
   'aaff0000-0000-0000-0000-000000000001', 'A1', 'A-1');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('aaff0000-0000-0000-0000-aaaaaaaaaaaa',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'apply-owner@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('aaff0000-0000-0000-0000-cccccccccccc',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'apply-disp@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.app_users (id, dsp_id, role, email) values
  ('aaff0000-0000-0000-0000-aaaaaaaaaaaa',
   'aaff0000-0000-0000-0000-000000000001', 'owner',      'apply-owner@test.test'),
  ('aaff0000-0000-0000-0000-cccccccccccc',
   'aaff0000-0000-0000-0000-000000000001', 'dispatcher', 'apply-disp@test.test');

-- A referrer driver
insert into public.drivers (id, dsp_id, station_id, full_name, status) values
  ('aaff0000-dddd-0000-0000-000000000001',
   'aaff0000-0000-0000-0000-000000000001',
   'aaff0000-0000-0000-0000-000000001000',
   'Referrer Driver', 'active');

-- Two screening questions: one normal (yields points), one hard-filter
insert into public.screening_questions
  (id, dsp_id, prompt, field_type, options, hard_filter, scoring, display_order)
values
  ('aaff0000-qqqq-0000-0000-000000000001',
   'aaff0000-0000-0000-0000-000000000001',
   'When can you start?', 'single',
   '["This week","Next week","1 month+"]'::jsonb, null,
   '{"This week":3,"Next week":2,"1 month+":0}'::jsonb, 1),
  ('aaff0000-qqqq-0000-0000-000000000002',
   'aaff0000-0000-0000-0000-000000000001',
   'Are you authorized to work in the US?', 'yes_no',
   '["Yes","No"]'::jsonb,
   '{"answer":"No"}'::jsonb,
   '{"Yes":0,"No":0}'::jsonb, 2);

-- Helpers
create or replace function pg_temp.act_as_owner()
returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', 'aaff0000-0000-0000-0000-aaaaaaaaaaaa',
                       'dsp_id', 'aaff0000-0000-0000-0000-000000000001',
                       'role', 'owner')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_dispatcher()
returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', 'aaff0000-0000-0000-0000-cccccccccccc',
                       'dsp_id', 'aaff0000-0000-0000-0000-000000000001',
                       'role', 'dispatcher')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- ─── create_applicant ─────────────────────────────────────────────────

select pg_temp.act_as_dispatcher();

-- 1. Basic create
select isnt(
  (public.create_applicant(
    'Test Applicant', 'a@test.test', '417-555-0001', 'manual'
  ))::text,
  null,
  'create_applicant returns an applicant id');

-- 2. Phone normalized to E.164
select is(
  (select phone from public.applicants where full_name = 'Test Applicant'),
  '+14175550001',
  'Phone normalized to +14175550001');

-- 3. Indeed dedup via source_ref
do $$ begin
  perform public.create_applicant(
    'Duplicate One', 'd1@test.test', '417-555-0002', 'indeed', 'in-001'
  );
  perform public.create_applicant(
    'Duplicate One', 'd1-newer@test.test', '417-555-0003', 'indeed', 'in-001'
  );
end $$;

select is(
  (select count(*) from public.applicants
    where source = 'indeed' and source_ref = 'in-001'),
  1::bigint,
  'Indeed source_ref deduplicated');

-- ─── record_screening_response → score + stage ────────────────────────

do $$
declare v_app_id uuid;
begin
  v_app_id := public.create_applicant(
    'Score Test', 'score@test.test', '417-555-0010', 'manual'
  );

  -- Answer the points question with "This week" (3 points)
  perform public.record_screening_response(
    v_app_id,
    'aaff0000-qqqq-0000-0000-000000000001',
    'This week'
  );
end $$;

-- 4. Score recomputed (applicant now has score=3)
select is(
  (select score from public.applicants where full_name = 'Score Test'),
  3,
  'Score recomputed after screening response (3 points)');

-- 5. Stage auto-advanced new → screening
select is(
  (select stage::text from public.applicants where full_name = 'Score Test'),
  'screening',
  'Stage auto-advanced new → screening on first response');

-- ─── Hard-filter answer flips to 'filtered' ──────────────────────────

do $$
declare v_app_id uuid;
begin
  v_app_id := public.create_applicant(
    'Hard Filter Test', 'hf@test.test', '417-555-0020', 'manual'
  );

  perform public.record_screening_response(
    v_app_id,
    'aaff0000-qqqq-0000-0000-000000000002',
    'No'                    -- the hard-filter answer
  );
end $$;

-- 6. Stage is 'filtered'
select is(
  (select stage::text from public.applicants where full_name = 'Hard Filter Test'),
  'filtered',
  'Hard-filter answer auto-flipped stage to filtered');

-- ─── advance_applicant_stage ─────────────────────────────────────────

-- 7. Illegal transition rejected (filtered → hired)
select throws_ok(
  $sql$
    select public.advance_applicant_stage(
      (select id from public.applicants where full_name = 'Hard Filter Test'),
      'hired'
    )
  $sql$,
  null, null,
  'advance_applicant_stage: filtered → hired rejected');

-- 8. Allowed transition: filtered → screening (re-open)
select lives_ok(
  $sql$
    select public.advance_applicant_stage(
      (select id from public.applicants where full_name = 'Hard Filter Test'),
      'screening'
    )
  $sql$,
  'advance_applicant_stage: filtered → screening allowed (re-open)');

-- ─── hire_applicant flow ─────────────────────────────────────────────

select pg_temp.act_as_owner();

-- Build a fresh applicant referred by the seeded driver, take through stages
do $$
declare v_app_id uuid;
begin
  v_app_id := public.create_applicant(
    'Referred Hire', 'rh@test.test', '417-555-0030',
    'referral', 'ref-001',
    'aaff0000-dddd-0000-0000-000000000001'::uuid
  );
  perform public.record_screening_response(
    v_app_id, 'aaff0000-qqqq-0000-0000-000000000001', 'This week'
  );
  perform public.advance_applicant_stage(v_app_id, 'passed');
  perform public.advance_applicant_stage(v_app_id, 'booked');
end $$;

-- 9. hire_applicant creates a driver row
do $$
declare v_app_id uuid;  v_result jsonb;
begin
  select id into v_app_id from public.applicants where full_name = 'Referred Hire';
  v_result := public.hire_applicant(v_app_id);
  perform set_config('pg_temp.last_hire_result', v_result::text, true);
end $$;

select isnt(
  (current_setting('pg_temp.last_hire_result')::jsonb)->>'driver_id',
  null,
  'hire_applicant returned a driver_id');

-- 10. New driver row exists
select is(
  (select count(*) from public.drivers
    where dsp_id = 'aaff0000-0000-0000-0000-000000000001'
      and full_name = 'Referred Hire'),
  1::bigint,
  'New driver row created on hire');

-- 11. Applicant.stage = hired and hired_driver_id set
select is(
  (select stage::text from public.applicants where full_name = 'Referred Hire'),
  'hired',
  'Applicant stage = hired');

select isnt(
  (select hired_driver_id::text from public.applicants where full_name = 'Referred Hire'),
  null,
  'Applicant.hired_driver_id set');

-- 12. Referral payouts created (4 milestones)
select is(
  (select count(*) from public.referral_payouts rp
    join public.applicants a on a.id = rp.applicant_id
    where a.full_name = 'Referred Hire'),
  4::bigint,
  'Four referral payout rows created on hire (hire/30/60/90)');

-- 13. Direct UPDATE bypass blocked
select pg_temp.act_as_dispatcher();

select throws_ok(
  $sql$
    update public.applicants
       set stage = 'hired'
     where full_name = 'Test Applicant'
  $sql$,
  null, null,
  'Direct UPDATE to stage=hired without hired_driver_id is blocked');

-- ─── RLS: dispatcher can read; drivers cannot ────────────────────────

select is(
  (select count(*) from public.applicants),
  6::bigint,
  'Dispatcher sees all DSP applicants');

-- Switch to driver context (driver of this DSP, no referrals)
do $$ begin
  perform set_config('request.jwt.claims',
    jsonb_build_object(
      'sub', 'aaff0000-dddd-0000-0000-000000000aaa',
      'dsp_id', 'aaff0000-0000-0000-0000-000000000001',
      'role', 'driver',
      'driver_id', 'aaff0000-dddd-0000-0000-000000000001'
    )::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- 14. Driver sees only the applicant they referred
select is(
  (select count(*) from public.applicants),
  1::bigint,
  'Driver sees only their referred applicant');

-- 15. Driver cannot create applicants
select throws_ok(
  $sql$
    select public.create_applicant('Sneaky', 'x@x.test', '417-555-9999', 'manual')
  $sql$,
  null, null,
  'Driver cannot call create_applicant (staff only)');

-- ─── Wrap up ──────────────────────────────────────────────────────────

select * from finish();
rollback;
