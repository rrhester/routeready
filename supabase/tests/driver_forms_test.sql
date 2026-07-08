-- supabase/tests/driver_forms_test.sql
--
-- Server-side regression tests for the driver-forms feature. Runs against a
-- database that already has every migration applied (see the CI harness in
-- .github/workflows/migration-check.yml, which boots a throwaway Supabase,
-- applies all migrations from zero, then runs this file). Nothing here is a
-- mock: it exercises the real security-definer RPC (driver_submit_form) and
-- the real helper functions from migrations 0436 / 0439.
--
-- Run locally from the repo root against any migrated DB:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/driver_forms_test.sql
--
-- Everything runs inside one transaction that is rolled back at the end, so
-- the suite leaves no residue. Any failed ASSERT (or an unexpected error)
-- aborts the transaction and, under ON_ERROR_STOP=1, fails the process.

\set ON_ERROR_STOP on

-- Shared fixture set — the SAME cases the JS validator is checked against in
-- scripts/test-driver-forms.mjs. Loaded from disk so the two suites can never
-- diverge silently. Requires psql's CWD to be the repo root.
\set cases_json `cat tests/driver-forms/validation-cases.json`

begin;

-- Fixture drivers/forms carry unrelated side-effect triggers in the full
-- schema (channel sync, audit-log fan-out, phone normalisation). Those are
-- irrelevant to what we test and can depend on request context (auth.uid())
-- that isn't present here, so disable user + FK triggers for the duration of
-- this transaction. The RPC logic under test (assignment gate, once-per-driver
-- lock, field validation) is plain PL/pgSQL and runs identically regardless.
-- Requires superuser; the CI harness connects as postgres. Auto-restored on
-- rollback because it's SET LOCAL.
set local session_replication_role = replica;

-- ── Fixtures ─────────────────────────────────────────────────────────
-- `slug` is NOT NULL and normally auto-filled by a BEFORE INSERT trigger
-- (dsps_assign_slug_trigger, migration 0318); we disable triggers above, so
-- supply a valid slug explicitly (^[a-z0-9][a-z0-9-]{0,29}$, non-reserved).
insert into public.dsps (id, name, short_code, slug)
values ('11111111-1111-1111-1111-111111111111', 'RR Test DSP', 'RRTEST', 'rr-forms-test');

insert into public.drivers (id, dsp_id, full_name, status, role) values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Driver A', 'active', 'driver'),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Driver B', 'active', 'driver');

insert into public.driver_sessions (token, dsp_id, driver_id) values
  ('tok_test_a', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'),
  ('tok_test_b', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333');

insert into public.forms (id, dsp_id, title, status, fields, settings) values
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'Parity',  'published', '[]'::jsonb, '{}'::jsonb),
  ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'Gated',   'published', '[]'::jsonb, '{}'::jsonb),
  ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'Open',    'published', '[]'::jsonb, '{}'::jsonb),
  ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'OncePer', 'published', '[]'::jsonb, '{"once_per_driver": true}'::jsonb);

-- Gated form is targeted to Driver B only. Driver A must not be able to see
-- or submit it.
insert into public.form_assignments (form_id, driver_id, dsp_id) values
  ('55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111');

-- Vehicles for the DVIC / Vehicle-Concern side-effect branches. Distinct so
-- each concern_van string below resolves to exactly one van (the RPC requires
-- a unique match). Van D is the standing (rank-0) van for Driver A, which the
-- DVIC branch resolves via private.driver_resolve_today_van.
insert into public.vehicles (id, dsp_id, name, nickname, plate, status) values
  ('a0000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'Van 7',    null,      null,     'active'),
  ('a0000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'V0099',    'Thunder', null,     'active'),
  ('a0000000-0000-0000-0000-0000000000a3', '11111111-1111-1111-1111-111111111111', 'V0100',    null,      'XYZ789', 'active'),
  ('a0000000-0000-0000-0000-0000000000a4', '11111111-1111-1111-1111-111111111111', 'DVIC Van', null,      null,     'active');

insert into public.vehicle_driver_assignments (dsp_id, vehicle_id, driver_id, rank) values
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-0000000000a4', '22222222-2222-2222-2222-222222222222', 0);

-- Vehicle-Concern form (opens a vehicle_issues ticket) and DVIC form (writes a
-- vehicle_inspections row with derived pass/fail). Empty `fields` so no field
-- validation runs; the branches read their answers by well-known keys. DVIC
-- fields carry flag_on rules so a matching answer flips the result to failed.
insert into public.forms (id, dsp_id, title, status, fields, settings) values
  ('88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 'Concern', 'published', '[]'::jsonb, '{"is_vehicle_concern": true}'::jsonb),
  ('99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', 'DVIC',    'published',
     '[{"id":"brakes","type":"yes_no","flag_on":"fail"},{"id":"lights","type":"yes_no","flag_on":"fail"}]'::jsonb,
     '{"is_dvic": true}'::jsonb);

-- Conditional-logic form: `details` is REQUIRED, but only VISIBLE when the
-- earlier yes/no `has_issue` is answered "yes". Exercises the interaction of
-- private.form_field_visible with the required check inside driver_submit_form.
insert into public.forms (id, dsp_id, title, status, fields, settings) values
  ('b0000000-0000-0000-0000-0000000000b1', '11111111-1111-1111-1111-111111111111', 'Conditional', 'published',
     '[{"id":"has_issue","type":"yes_no","required":false},
       {"id":"details","type":"short_text","required":true,"condition":{"fieldId":"has_issue","op":"eq","value":"yes"}}]'::jsonb,
     '{}'::jsonb);


-- ── 1. private.form_answer_flagged (DVIC pass/fail core, migration 0436) ──
do $$
begin
  -- scalar answer vs scalar flag, case-insensitive
  assert private.form_answer_flagged('"Fail"'::jsonb, '"fail"'::jsonb) is true,  'flag: scalar case-insensitive match';
  assert private.form_answer_flagged('"Pass"'::jsonb, '"fail"'::jsonb) is false, 'flag: scalar non-match';
  -- scalar answer vs array of flag values
  assert private.form_answer_flagged('"b"'::jsonb, '["a","b"]'::jsonb) is true,  'flag: scalar in flag array';
  assert private.form_answer_flagged('"z"'::jsonb, '["a","b"]'::jsonb) is false, 'flag: scalar not in flag array';
  -- array answer vs scalar flag
  assert private.form_answer_flagged('["x","y"]'::jsonb, '"y"'::jsonb) is true,  'flag: array answer contains scalar flag';
  -- array answer vs array flag (intersection)
  assert private.form_answer_flagged('["p","q"]'::jsonb, '["q","r"]'::jsonb) is true,  'flag: array/array intersect';
  assert private.form_answer_flagged('["p"]'::jsonb,     '["q","r"]'::jsonb) is false, 'flag: array/array disjoint';
  -- null-safety
  assert private.form_answer_flagged(null, '"fail"'::jsonb) is false, 'flag: null answer';
  assert private.form_answer_flagged('"fail"'::jsonb, null) is false, 'flag: null flag';
  raise notice '✓ form_answer_flagged';
end $$;


-- ── 2. private.form_field_visible (conditional visibility, migration 0439) ──
do $$
declare
  fields jsonb := '[
    {"id":"t","type":"yes_no"},
    {"id":"c","type":"short_text","condition":{"fieldId":"t","op":"eq","value":"yes"}},
    {"id":"n","type":"short_text","condition":{"fieldId":"t","op":"neq","value":"yes"}},
    {"id":"bad","type":"short_text","condition":{"fieldId":"tt","op":"eq","value":"yes"}}
  ]'::jsonb;
  ftext  jsonb := '{"id":"noc","type":"short_text"}'::jsonb;
  fcond  jsonb := (fields->1);
  fncond jsonb := (fields->2);
  fbad   jsonb := (fields->3);
  -- ineligible trigger: trigger "s" is a short_text (not a discrete type)
  fields2 jsonb := '[
    {"id":"s","type":"short_text"},
    {"id":"c2","type":"short_text","condition":{"fieldId":"s","op":"eq","value":"yes"}}
  ]'::jsonb;
begin
  -- no condition → always visible
  assert private.form_field_visible('{}'::jsonb, ftext, fields) is true, 'visible: no condition fails open';
  -- eq condition met / unmet
  assert private.form_field_visible('{"t":"yes"}'::jsonb, fcond, fields) is true,  'visible: eq met';
  assert private.form_field_visible('{"t":"no"}'::jsonb,  fcond, fields) is false, 'visible: eq unmet';
  assert private.form_field_visible('{}'::jsonb,          fcond, fields) is false, 'visible: eq missing answer';
  -- neq condition
  assert private.form_field_visible('{"t":"no"}'::jsonb,  fncond, fields) is true,  'visible: neq met';
  assert private.form_field_visible('{"t":"yes"}'::jsonb, fncond, fields) is false, 'visible: neq unmet';
  -- trigger id not present among fields → fails open
  assert private.form_field_visible('{"t":"no"}'::jsonb, fbad, fields) is true, 'visible: unknown trigger fails open';
  -- ineligible trigger type → fails open
  assert private.form_field_visible('{"s":"no"}'::jsonb, (fields2->1), fields2) is true, 'visible: ineligible trigger type fails open';
  raise notice '✓ form_field_visible';
end $$;


-- ── 3. Assignment gate (migration 0436 P0-1) ─────────────────────────
do $$
declare v_blocked boolean := false;
begin
  -- Driver A is NOT assigned the gated form → must be rejected as if it
  -- doesn't exist (form_not_found, never a distinguishable 'forbidden').
  begin
    perform public.driver_submit_form('tok_test_a', '55555555-5555-5555-5555-555555555555', '{}'::jsonb);
  exception when others then
    v_blocked := (sqlerrm = 'form_not_found');
  end;
  assert v_blocked, 'gate: unassigned driver A must get form_not_found on a targeted form';

  -- Driver B IS assigned → succeeds.
  perform public.driver_submit_form('tok_test_b', '55555555-5555-5555-5555-555555555555', '{}'::jsonb);

  -- Untargeted (no assignments) form → any driver may submit.
  perform public.driver_submit_form('tok_test_a', '66666666-6666-6666-6666-666666666666', '{}'::jsonb);
  raise notice '✓ assignment gate';
end $$;


-- ── 4. once_per_driver dedupe (migration 0436 P0-2) ──────────────────
do $$
declare v_dupe_blocked boolean := false;
begin
  -- First submission succeeds.
  perform public.driver_submit_form('tok_test_a', '77777777-7777-7777-7777-777777777777', '{}'::jsonb);
  -- Second submission by the same driver must be rejected.
  begin
    perform public.driver_submit_form('tok_test_a', '77777777-7777-7777-7777-777777777777', '{}'::jsonb);
  exception when others then
    v_dupe_blocked := (sqlerrm = 'already_submitted');
  end;
  assert v_dupe_blocked, 'once_per_driver: second submission must raise already_submitted';
  raise notice '✓ once_per_driver dedupe';
end $$;


-- ── 5. Server-side validation parity with the shared fixtures ────────
-- Load each fixture case as its own row.
create temp table _cases(j jsonb) on commit drop;
insert into _cases select value from jsonb_array_elements((:'cases_json')::jsonb -> 'cases');

-- Drive one fixture case through the REAL driver_submit_form: build a
-- single-field form from the case, submit the case's value, and report
-- whether the server accepted it (true) or rejected it as invalid (false).
create function pg_temp.try_case(p_case jsonb) returns boolean
language plpgsql as $$
declare
  v_field   jsonb := p_case->'field';
  v_answers jsonb := jsonb_build_object(v_field->>'id', p_case->'value');
begin
  update public.forms
     set fields = jsonb_build_array(v_field), settings = '{}'::jsonb
   where id = '44444444-4444-4444-4444-444444444444';
  begin
    perform public.driver_submit_form('tok_test_a', '44444444-4444-4444-4444-444444444444', v_answers);
    return true;   -- accepted
  exception when others then
    return false;  -- rejected by server validation
  end;
end;
$$;

do $$
declare
  r     record;
  got   boolean;
  want  boolean;
  fails int := 0;
  total int;
begin
  for r in select j from _cases loop
    want := (r.j->>'valid')::boolean;
    got  := pg_temp.try_case(r.j);
    if got is distinct from want then
      raise warning 'PARITY MISMATCH [%]: fixture expects %, SQL validator says %',
        r.j->>'name', want, got;
      fails := fails + 1;
    end if;
  end loop;
  select count(*) into total from _cases;
  assert fails = 0, format('%s of %s shared fixtures disagree between the SQL validator and JS/fixtures', fails, total);
  raise notice '✓ server-side validation parity: all % shared fixtures agree', total;
end $$;


-- ── 6. Vehicle-Concern branch (migration 0439) ───────────────────────
-- A concern submission resolves the typed van (by name / nickname / plate),
-- maps the free-text category & severity onto the enums, and opens a
-- vehicle_issues ticket linked back to the submission.
do $$
declare v_res jsonb; v_issue public.vehicle_issues;
begin
  -- Resolve by NAME; 'brakes' → mechanical; 'urgent' → high; title carried.
  v_res := public.driver_submit_form('tok_test_a', '88888888-8888-8888-8888-888888888888',
    '{"concern_van":"Van 7","concern_category":"brakes","concern_severity":"urgent","concern_title":"Grinding noise","concern_description":"Loud when braking"}'::jsonb);
  assert (v_res->>'issue_id') is not null, 'concern: an issue_id is returned';
  assert (v_res->>'vehicle_id') = 'a0000000-0000-0000-0000-0000000000a1', 'concern: resolved van by name';
  select * into v_issue from public.vehicle_issues where id = (v_res->>'issue_id')::uuid;
  assert v_issue.category = 'mechanical',          'concern: brakes → mechanical (got '||v_issue.category||')';
  assert v_issue.severity = 'high',                'concern: urgent → high (got '||v_issue.severity||')';
  assert v_issue.title    = 'Grinding noise',      'concern: title carried through';
  assert v_issue.description = 'Loud when braking','concern: description carried through';
  assert v_issue.status   = 'open',                'concern: ticket opens as open';
  assert v_issue.source   = 'driver_self_report',  'concern: source tagged as driver self-report';

  -- Resolve by NICKNAME; 'damage' → body; 'minor' → low; default title.
  v_res := public.driver_submit_form('tok_test_a', '88888888-8888-8888-8888-888888888888',
    '{"concern_van":"Thunder","concern_category":"damage","concern_severity":"minor"}'::jsonb);
  assert (v_res->>'vehicle_id') = 'a0000000-0000-0000-0000-0000000000a2', 'concern: resolved van by nickname';
  select * into v_issue from public.vehicle_issues where id = (v_res->>'issue_id')::uuid;
  assert v_issue.category = 'body',                       'concern: damage → body';
  assert v_issue.severity = 'low',                        'concern: minor → low';
  assert v_issue.title    = 'Driver-reported concern',    'concern: default title when omitted';

  -- Resolve by PLATE; unknown category → self_reported; empty severity → medium.
  v_res := public.driver_submit_form('tok_test_a', '88888888-8888-8888-8888-888888888888',
    '{"concern_van":"XYZ789","concern_category":"kerfuffle","concern_severity":""}'::jsonb);
  assert (v_res->>'vehicle_id') = 'a0000000-0000-0000-0000-0000000000a3', 'concern: resolved van by plate';
  select * into v_issue from public.vehicle_issues where id = (v_res->>'issue_id')::uuid;
  assert v_issue.category = 'self_reported', 'concern: unrecognised category → self_reported';
  assert v_issue.severity = 'medium',        'concern: empty severity → medium';

  -- Empty category → self_reported (distinct '' code path); 'critical' → critical.
  v_res := public.driver_submit_form('tok_test_a', '88888888-8888-8888-8888-888888888888',
    '{"concern_van":"Van 7","concern_category":"","concern_severity":"critical"}'::jsonb);
  select * into v_issue from public.vehicle_issues where id = (v_res->>'issue_id')::uuid;
  assert v_issue.category = 'self_reported', 'concern: empty category → self_reported';
  assert v_issue.severity = 'critical',      'concern: critical → critical';

  raise notice '✓ vehicle-concern branch (van resolution + category/severity mapping)';
end $$;


-- ── 7. DVIC branch (migrations 0436 / 0439) ──────────────────────────
-- A DVIC submission resolves the driver's standing (rank-0) van via
-- private.driver_resolve_today_van, derives pass/fail from the per-field
-- flag_on rules, and writes a vehicle_inspections row.
do $$
declare v_res jsonb; v_insp public.vehicle_inspections;
begin
  -- A flagged answer ('fail' matches the brakes flag_on) → failed.
  v_res := public.driver_submit_form('tok_test_a', '99999999-9999-9999-9999-999999999999',
    '{"brakes":"fail","lights":"pass"}'::jsonb);
  assert (v_res->>'inspection_id') is not null, 'dvic: an inspection_id is returned';
  assert (v_res->>'result')     = 'failed', 'dvic: any flagged field → failed (got '||coalesce(v_res->>'result','null')||')';
  assert (v_res->>'vehicle_id') = 'a0000000-0000-0000-0000-0000000000a4', 'dvic: resolved standing rank-0 van';
  select * into v_insp from public.vehicle_inspections where id = (v_res->>'inspection_id')::uuid;
  assert v_insp.kind       = 'dvic',   'dvic: inspection kind is dvic';
  assert v_insp.result     = 'failed', 'dvic: inspection row records failed';
  assert v_insp.vehicle_id = 'a0000000-0000-0000-0000-0000000000a4'::uuid, 'dvic: inspection linked to van';

  -- No flagged answer → passed.
  v_res := public.driver_submit_form('tok_test_a', '99999999-9999-9999-9999-999999999999',
    '{"brakes":"pass","lights":"pass"}'::jsonb);
  assert (v_res->>'result') = 'passed', 'dvic: no flagged field → passed';

  raise notice '✓ dvic branch (standing-van resolution + pass/fail derivation)';
end $$;


-- ── 8. Conditional required × visibility, end-to-end (migration 0439) ─
-- A required field that is currently HIDDEN by an unmet condition must not
-- block submission; once its trigger reveals it, the required check applies.
-- This exercises the private.form_field_visible gate inside the RPC's
-- validation loop, not just the helper in isolation (section 2).
do $$
declare v_blocked boolean;
begin
  -- Trigger says "no" → `details` hidden → its required rule does NOT apply.
  perform public.driver_submit_form('tok_test_a', 'b0000000-0000-0000-0000-0000000000b1',
    '{"has_issue":"no"}'::jsonb);

  -- Trigger unanswered → `details` still hidden → still not required.
  perform public.driver_submit_form('tok_test_a', 'b0000000-0000-0000-0000-0000000000b1',
    '{}'::jsonb);

  -- Trigger "yes" → `details` revealed + required + empty → must be rejected.
  v_blocked := false;
  begin
    perform public.driver_submit_form('tok_test_a', 'b0000000-0000-0000-0000-0000000000b1',
      '{"has_issue":"yes"}'::jsonb);
  exception when others then
    v_blocked := (sqlstate = 'P0002');   -- validation error class
  end;
  assert v_blocked, 'conditional: revealed required field must block when empty';

  -- Trigger "yes" with the answer supplied → accepted.
  perform public.driver_submit_form('tok_test_a', 'b0000000-0000-0000-0000-0000000000b1',
    '{"has_issue":"yes","details":"brake noise"}'::jsonb);

  raise notice '✓ conditional required × visibility (end-to-end through the RPC)';
end $$;

rollback;

\echo '✓ driver_forms_test.sql — all sections passed'
