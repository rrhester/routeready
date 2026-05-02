-- ─────────────────────────────────────────────────────────────────────────
-- pgTAP test · Phase 8 AI features
-- save_ai_tool, log_ai_tool_run, route_smart_drop, log_ai_usage,
-- RLS isolation.
-- ─────────────────────────────────────────────────────────────────────────

begin;
select plan(10);

create extension if not exists pgtap;

-- ─── Setup ────────────────────────────────────────────────────────────

insert into public.dsps (id, name, slug)
values ('aaff2200-0000-0000-0000-000000000001', 'AI Test DSP', 'ai-test');

insert into public.stations (id, dsp_id, code, name) values
  ('aaff2200-0000-0000-0000-000000001000',
   'aaff2200-0000-0000-0000-000000000001', 'A1', 'A-1');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('aaff2200-0000-0000-0000-aaaaaaaaaaaa',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'ai-owner@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('aaff2200-0000-0000-0000-cccccccccccc',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'ai-disp@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.app_users (id, dsp_id, role, email) values
  ('aaff2200-0000-0000-0000-aaaaaaaaaaaa',
   'aaff2200-0000-0000-0000-000000000001', 'owner', 'ai-owner@test.test'),
  ('aaff2200-0000-0000-0000-cccccccccccc',
   'aaff2200-0000-0000-0000-000000000001', 'dispatcher', 'ai-disp@test.test');

insert into public.drivers (id, dsp_id, station_id, full_name, status) values
  ('aaff2200-dddd-0000-0000-000000000001',
   'aaff2200-0000-0000-0000-000000000001',
   'aaff2200-0000-0000-0000-000000001000',
   'AI Driver', 'active');

insert into public.attendance_policies (dsp_id) values
  ('aaff2200-0000-0000-0000-000000000001');

create or replace function pg_temp.act_as_owner()
returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub','aaff2200-0000-0000-0000-aaaaaaaaaaaa',
                       'dsp_id','aaff2200-0000-0000-0000-000000000001',
                       'role','owner')::text, true);
  perform set_config('role','authenticated', true);
end $$;

create or replace function pg_temp.act_as_dispatcher()
returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub','aaff2200-0000-0000-0000-cccccccccccc',
                       'dsp_id','aaff2200-0000-0000-0000-000000000001',
                       'role','dispatcher')::text, true);
  perform set_config('role','authenticated', true);
end $$;

-- ─── save_ai_tool ─────────────────────────────────────────────────────

select pg_temp.act_as_owner();

-- 1. Owner can save a tool
select isnt(
  (public.save_ai_tool(
    'Time Theft Analyzer',
    'Find drivers who clock out 30+ minutes after their last delivery.',
    '{"metrics":[{"name":"variance_minutes"}],"rules":[{"trigger":"variance_minutes > 30"}]}'::jsonb,
    'Detects payroll padding'
  ))::text,
  null,
  'Owner can save_ai_tool');

-- 2. Tool is visible
select is(
  (select count(*) from public.ai_tools
    where dsp_id = 'aaff2200-0000-0000-0000-000000000001'),
  1::bigint,
  'Tool count = 1');

-- 3. Dispatcher cannot save tools (ops+ only)
select pg_temp.act_as_dispatcher();
select throws_ok(
  $sql$
    select public.save_ai_tool(
      'Bad Tool',
      'should not be allowed',
      '{}'::jsonb
    )
  $sql$,
  null, null,
  'Dispatcher cannot save_ai_tool (ops only)');

-- ─── log_ai_tool_run ──────────────────────────────────────────────────

select pg_temp.act_as_owner();

-- 4. Log a run
select isnt(
  (public.log_ai_tool_run(
    (select id from public.ai_tools limit 1),
    '{"input":"sample"}'::jsonb,
    '{"flagged":[{"driver_id":"aaff2200-dddd-0000-0000-000000000001"}]}'::jsonb,
    1,
    'First run'
  ))::text,
  null,
  'log_ai_tool_run records the run');

-- 5. Run visible
select is(
  (select count(*) from public.ai_tool_runs
    where dsp_id = 'aaff2200-0000-0000-0000-000000000001'),
  1::bigint,
  'Tool run count = 1');

-- ─── route_smart_drop ────────────────────────────────────────────────

-- Pre-populate a smart_drop_uploads row in 'extracted' state
insert into public.smart_drop_uploads
  (id, dsp_id, filename, storage_path, status, detected_kind,
   extracted_rows, uploaded_by)
values
  ('aaff2200-srdr-0000-0000-000000000001',
   'aaff2200-0000-0000-0000-000000000001',
   'attendance_export.csv', 'smart-drop/test.csv',
   'extracted', 'attendance',
   '[
     {"driver_id":"aaff2200-dddd-0000-0000-000000000001","event_type":"callout","event_date":"' || (current_date - 2)::text || '","notes":"From import"}
   ]'::jsonb,
   'aaff2200-0000-0000-0000-aaaaaaaaaaaa');

-- 6. route_smart_drop writes attendance event
select is(
  (public.route_smart_drop(
    'aaff2200-srdr-0000-0000-000000000001'::uuid,
    'attendance_events',
    '[
      {"driver_id":"aaff2200-dddd-0000-0000-000000000001","event_type":"callout","event_date":"' || (current_date - 2)::text || '"}
    ]'::jsonb
  ))->>'inserted',
  '1',
  'route_smart_drop with target=attendance_events inserts 1');

-- 7. Upload status flipped to routed
select is(
  (select status::text from public.smart_drop_uploads
    where id = 'aaff2200-srdr-0000-0000-000000000001'),
  'routed',
  'smart_drop status = routed');

-- 8. Attendance event was actually written
select is(
  (select count(*) from public.attendance_events
    where driver_id = 'aaff2200-dddd-0000-0000-000000000001'),
  1::bigint,
  'attendance_events row created via route_smart_drop');

-- ─── log_ai_usage ─────────────────────────────────────────────────────

-- 9. Log usage
do $$ begin
  perform public.log_ai_usage(
    'generate-coaching-sms', 'claude-opus-4-7',
    1500, 250, 12,
    'coaching', 'aaff2200-dddd-0000-0000-000000000001'::uuid
  );
end $$;

-- Owner can see usage log
select is(
  (select count(*) from public.ai_usage_log
    where dsp_id = 'aaff2200-0000-0000-0000-000000000001'),
  1::bigint,
  'AI usage log row visible to owner');

-- 10. Dispatcher cannot read usage log (owner only)
select pg_temp.act_as_dispatcher();
select is(
  (select count(*) from public.ai_usage_log),
  0::bigint,
  'Dispatcher cannot read ai_usage_log');

-- ─── Wrap up ──────────────────────────────────────────────────────────

select * from finish();
rollback;
