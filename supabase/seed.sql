-- ─────────────────────────────────────────────────────────────────────────
-- Seed data for local development
-- Run via:  supabase db reset
--
-- Creates one DSP ("Cardinal Logistics") with 3 stations, 4 staff users,
-- and the 7 drivers that match the existing mockup-dashboard.html roster.
-- All UUIDs are deterministic so tests can reference them.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── Tenant ──────────────────────────────────────────────────────────────

insert into public.dsps (id, name, slug, amazon_node, cycle, timezone)
values
  ('11111111-1111-1111-1111-111111111111',
   'Cardinal Logistics',
   'cardinal-logistics',
   'KMO1',
   14,
   'America/Chicago')
on conflict (id) do nothing;

-- A second DSP so multi-tenant isolation can be verified by hand in the
-- Studio UI. The pgTAP tests create their own fixture; this is just for
-- eyeball checks.
insert into public.dsps (id, name, slug, amazon_node, cycle)
values
  ('22222222-2222-2222-2222-222222222222',
   'Hudson Routes',
   'hudson-routes',
   'DCA1',
   14)
on conflict (id) do nothing;

-- ─── Stations (Cardinal) ────────────────────────────────────────────────

insert into public.stations (id, dsp_id, code, name, capacity_routes)
values
  ('aaaa1111-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'KMO1', 'Springfield · Main', 45),
  ('aaaa1111-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',
   'KMO2', 'Springfield · West', 30),
  ('aaaa1111-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111',
   'KMO3', 'Joplin', 25)
on conflict (id) do nothing;

-- ─── Auth users + app_users (DSP staff) ─────────────────────────────────
-- For local dev only: insert directly into auth.users. In staging/prod,
-- staff are invited via the dashboard which goes through Supabase Auth.

-- Owner
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at, confirmation_token,
                        recovery_token, email_change_token_new, email_change)
values
  ('11111111-aaaa-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000000',
   'authenticated',
   'authenticated',
   'owner@cardinal.test',
   now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"full_name":"Robin Hester"}'::jsonb,
   now(), now(), '', '', '', '')
on conflict (id) do nothing;

insert into public.app_users (id, dsp_id, role, email, full_name)
values
  ('11111111-aaaa-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'owner', 'owner@cardinal.test', 'Robin Hester')
on conflict (id) do nothing;

-- Ops manager
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at, confirmation_token,
                        recovery_token, email_change_token_new, email_change)
values
  ('11111111-aaaa-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'ops@cardinal.test',
   now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"full_name":"Maya Ortiz"}'::jsonb,
   now(), now(), '', '', '', '')
on conflict (id) do nothing;

insert into public.app_users (id, dsp_id, role, email, full_name)
values
  ('11111111-aaaa-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',
   'ops', 'ops@cardinal.test', 'Maya Ortiz')
on conflict (id) do nothing;

-- Dispatcher
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at, confirmation_token,
                        recovery_token, email_change_token_new, email_change)
values
  ('11111111-aaaa-0000-0000-000000000003',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'dispatch@cardinal.test',
   now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"full_name":"Dee Patel"}'::jsonb,
   now(), now(), '', '', '', '')
on conflict (id) do nothing;

insert into public.app_users (id, dsp_id, role, email, full_name)
values
  ('11111111-aaaa-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111',
   'dispatcher', 'dispatch@cardinal.test', 'Dee Patel')
on conflict (id) do nothing;

-- ─── Drivers (matching mockup roster) ────────────────────────────────────
-- license_expiry seeded relative to today so the renewal feature shows
-- fresh data when someone runs a local instance.

insert into public.drivers
  (id, dsp_id, station_id, full_name, phone, status, hire_date, license_expiry,
   composite_score, attendance_rate_30d)
values
  ('dddd0001-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000001',
   'Marcus Davidson', '+14175550100', 'active',
   current_date - interval '18 months', current_date + 4,
   62.0, 88.0),

  ('dddd0001-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000002',
   'Tasha Reyes', '+14175550142', 'active',
   current_date - interval '9 months', current_date + 28,
   68.0, 92.0),

  ('dddd0001-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000001',
   'Kerwin Whitfield', '+14175550193', 'active',
   current_date - interval '24 months', current_date + 6,
   71.0, 100.0),

  ('dddd0001-0000-0000-0000-000000000004',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000003',
   'Jordan Beckett', '+14175550218', 'active',
   current_date - interval '6 months', current_date + 12,
   73.0, 96.0),

  ('dddd0001-0000-0000-0000-000000000005',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000003',
   'Devon Patterson', '+14175550276', 'active',
   current_date - interval '11 months', current_date + 90,
   79.0, 100.0),

  ('dddd0001-0000-0000-0000-000000000006',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000002',
   'Asha Thornton', '+14175550312', 'active',
   current_date - interval '14 months', current_date + 22,
   74.0, 96.0),

  ('dddd0001-0000-0000-0000-000000000007',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000001',
   'Camille Foster', '+14175550341', 'active',
   current_date - interval '22 months', current_date + 200,
   88.0, 100.0)
on conflict (id) do nothing;

-- Hudson Routes — a single driver in the second DSP, used to verify
-- multi-tenant isolation by eyeball:
insert into public.drivers
  (id, dsp_id, full_name, phone, status, hire_date, composite_score)
values
  ('eeee0001-0000-0000-0000-000000000001',
   '22222222-2222-2222-2222-222222222222',
   'Sasha Underwood', '+12025551234', 'active',
   current_date - interval '4 months',
   78.0)
on conflict (id) do nothing;

-- ─── Sanity output ───────────────────────────────────────────────────────
-- ─── Phase 2: attendance policy + 30 days of events ────────────────────
-- Mirrors the seed events from the mockup so reports show realistic numbers.

insert into public.attendance_policies (dsp_id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222')
on conflict (dsp_id) do nothing;

-- Marcus Davidson: 3 callouts (one becomes a no-show) + 1 late
insert into public.attendance_events
  (dsp_id, driver_id, event_type, event_date, notes, source) values
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000001',
   'callout', current_date - 3,  'Said sick · 6am',                    'check_in'),
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000001',
   'callout', current_date - 11, 'Family emergency',                   'check_in'),
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000001',
   'noshow',  current_date - 19, 'Did not respond to dispatcher',      'check_in'),
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000001',
   'late',    current_date - 26, '+22 min · traffic',                  'check_in')
on conflict do nothing;

-- Tasha Reyes: Mon/Fri pattern + 1 late
insert into public.attendance_events
  (dsp_id, driver_id, event_type, event_date, notes, source) values
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000002',
   'callout', current_date - 4,  'Friday · sick',                      'check_in'),
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000002',
   'callout', current_date - 14, 'Monday · childcare',                 'check_in'),
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000002',
   'late',    current_date - 22, '+18 min',                            'check_in')
on conflict do nothing;

-- Jordan Beckett
insert into public.attendance_events
  (dsp_id, driver_id, event_type, event_date, notes, source) values
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000004',
   'callout', current_date - 7,  'No detail',                          'check_in'),
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000004',
   'late',    current_date - 15, '+14 min',                            'check_in'),
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000004',
   'late',    current_date - 28, '+12 min',                            'check_in')
on conflict do nothing;

-- Asha Thornton: 1 callout (exempt — approved PTO) + 1 late
insert into public.attendance_events
  (dsp_id, driver_id, event_type, event_date, exempt, exempt_category, notes, source) values
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000006',
   'callout', current_date - 9, true, 'Approved PTO',
   'Scheduled time-off · approved',                                     'check_in')
on conflict do nothing;
insert into public.attendance_events
  (dsp_id, driver_id, event_type, event_date, notes, source) values
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000006',
   'late',    current_date - 20, '+11 min',                            'check_in')
on conflict do nothing;

-- VTO events on top performers (over-scheduled days)
insert into public.attendance_events
  (dsp_id, driver_id, event_type, event_date, notes, source) values
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000007', -- Camille Foster
   'vto', current_date - 6,  'Light Sat — accepted VTO',                'check_in'),
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000005', -- Devon Patterson
   'vto', current_date - 13, 'Sun overage — accepted VTO',              'check_in'),
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000003', -- Kerwin Whitfield
   'vto', current_date - 20, 'Sun overage — accepted VTO',              'check_in')
on conflict do nothing;

-- ─── Phase 2: HR file fixture — one written warning, one prior void ───
-- Marcus Davidson has a written warning on file (matches mockup state).

insert into public.hr_events
  (id, dsp_id, driver_id, event_type, severity, effective_date,
   reason_category, reason_detail, evidence_refs, initiated_by)
values
  ('99990001-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000001',
   'written_warning', 'major', current_date - 12,
   'attendance',
   'Written warning issued after 2 callouts in 7 days. Driver acknowledged ' ||
   'verbally; attendance points were 4.5 at issue (above written threshold). ' ||
   'Coaching plan: 1:1 every Monday morning for 4 weeks.',
   jsonb_build_object('attendance_event_count', 4),
   '11111111-aaaa-0000-0000-000000000001')
on conflict (id) do nothing;

-- A coaching event tied to the HR event
insert into public.coaching_events
  (dsp_id, driver_id, category, channel, context_summary, related_hr_event_id, initiated_by)
values
  ('11111111-1111-1111-1111-111111111111',
   'dddd0001-0000-0000-0000-000000000001',
   'attendance', 'in_person',
   'Written warning · 4.5 attendance points, multiple Monday callouts',
   '99990001-0000-0000-0000-000000000001',
   '11111111-aaaa-0000-0000-000000000001')
on conflict do nothing;

-- ─── Phase 3: routes + 1 week of shifts + OKAMI W19 ─────────────────

insert into public.routes (id, dsp_id, station_id, code, start_time, end_time)
values
  ('rrrr0001-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000001',
   'KMO1-14B', '07:00', '18:00'),
  ('rrrr0001-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000001',
   'KMO1-09A', '07:00', '18:00'),
  ('rrrr0001-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000001',
   'KMO1-03B', '07:00', '18:00'),
  ('rrrr0001-0000-0000-0000-000000000004',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000002',
   'KMO2-08C', '07:00', '18:00'),
  ('rrrr0001-0000-0000-0000-000000000005',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000003',
   'KMO3-04D', '07:00', '18:00'),
  ('rrrr0001-0000-0000-0000-000000000006',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000003',
   'KMO3-12B', '07:00', '18:00')
on conflict (id) do nothing;

-- Shifts for the next 7 days, matching the mockup grid (Marcus on KMO1-14B
-- Tue-Sat, Tasha on KMO2-08C Tue-Fri + swap, Kerwin on KMO1-09A Tue-Sun, etc.)
do $$
declare
  v_drivers uuid[] := array[
    'dddd0001-0000-0000-0000-000000000001'::uuid,    -- Marcus
    'dddd0001-0000-0000-0000-000000000002',          -- Tasha
    'dddd0001-0000-0000-0000-000000000003',          -- Kerwin
    'dddd0001-0000-0000-0000-000000000004',          -- Jordan
    'dddd0001-0000-0000-0000-000000000005',          -- Devon
    'dddd0001-0000-0000-0000-000000000007'           -- Camille
  ];
  v_routes uuid[] := array[
    'rrrr0001-0000-0000-0000-000000000001'::uuid,   -- KMO1-14B
    'rrrr0001-0000-0000-0000-000000000004',         -- KMO2-08C
    'rrrr0001-0000-0000-0000-000000000002',         -- KMO1-09A
    'rrrr0001-0000-0000-0000-000000000005',         -- KMO3-04D
    'rrrr0001-0000-0000-0000-000000000006',         -- KMO3-12B
    'rrrr0001-0000-0000-0000-000000000003'          -- KMO1-03B
  ];
  v_stations uuid[] := array[
    'aaaa1111-0000-0000-0000-000000000001'::uuid,   -- KMO1
    'aaaa1111-0000-0000-0000-000000000002',         -- KMO2
    'aaaa1111-0000-0000-0000-000000000001',         -- KMO1
    'aaaa1111-0000-0000-0000-000000000003',         -- KMO3
    'aaaa1111-0000-0000-0000-000000000003',         -- KMO3
    'aaaa1111-0000-0000-0000-000000000001'          -- KMO1
  ];
  v_d  date;
  v_dow int;
  i    int;
begin
  for i in 1 .. array_length(v_drivers, 1) loop
    for d in 0 .. 6 loop
      v_d := current_date + d;
      v_dow := extract(dow from v_d)::int;  -- 0=Sun..6=Sat
      -- Saturday + Sunday off for everyone except Kerwin (works Sat too)
      if v_dow = 0 then
        -- Sunday: everyone off (we don't insert a row; "off" is implicit)
        continue;
      end if;
      if v_dow = 6 and i <> 3 then  -- only Kerwin (i=3) works Saturday
        continue;
      end if;
      insert into public.shifts
        (dsp_id, station_id, driver_id, route_id, shift_date, status, published)
      values
        ('11111111-1111-1111-1111-111111111111',
         v_stations[i],
         v_drivers[i],
         v_routes[i],
         v_d,
         'scheduled',
         true)
      on conflict do nothing;
    end loop;
  end loop;

  -- 3 open shifts (need backfill) for next Tuesday
  insert into public.shifts
    (dsp_id, station_id, route_id, shift_date, status, published)
  select '11111111-1111-1111-1111-111111111111',
         'aaaa1111-0000-0000-0000-000000000001',
         'rrrr0001-0000-0000-0000-000000000001',
         current_date + d, 'open', true
  from generate_series(1, 3) d
  on conflict do nothing;
end $$;

-- OKAMI W19 (current week)
insert into public.okami_weeks
  (id, dsp_id, iso_year, iso_week, week_start, routes_max, daily_targets,
   cushion_mode, cushion_value, dpr, adw, ot_hours)
values
  ('00aa0019-0000-0000-0000-000000000019',
   '11111111-1111-1111-1111-111111111111',
   extract(isoyear from current_date)::int,
   extract(week    from current_date)::int,
   date_trunc('week', current_date)::date,
   38,
   jsonb_build_object('mon',35,'tue',38,'wed',38,'thu',40,'fri',38,'sat',28,'sun',18),
   'percent', 10, 2.0, 5.0, 0)
on conflict (dsp_id, station_id, iso_year, iso_week) do nothing;

-- ─── Phase 4: screening questions + applicants ─────────────────────

insert into public.screening_questions
  (id, dsp_id, prompt, field_type, options, required, hard_filter, scoring, display_order)
values
  ('q0000001-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'Are you authorized to work in the United States?',
   'yes_no', '["Yes","No"]'::jsonb, true,
   '{"answer":"No"}'::jsonb,
   '{"Yes":0,"No":0}'::jsonb,                       -- hard-filter; no points
   1),
  ('q0000001-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',
   'Do you have a valid driver license?',
   'yes_no', '["Yes","No"]'::jsonb, true,
   '{"answer":"No"}'::jsonb,
   '{"Yes":0,"No":0}'::jsonb, 2),
  ('q0000001-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111',
   'Can you safely lift 50 lbs repeatedly?',
   'yes_no', '["Yes","No"]'::jsonb, true,
   '{"answer":"No"}'::jsonb,
   '{"Yes":0,"No":0}'::jsonb, 3),
  ('q0000001-0000-0000-0000-000000000004',
   '11111111-1111-1111-1111-111111111111',
   'Which days are you available to work?',
   'multi', '["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]'::jsonb, true,
   null,
   '{"Mon":1,"Tue":1,"Wed":1,"Thu":1,"Fri":1,"Sat":1,"Sun":1}'::jsonb,
   4),
  ('q0000001-0000-0000-0000-000000000005',
   '11111111-1111-1111-1111-111111111111',
   'When can you start?',
   'single', '["This week","Next week","2 weeks","1 month+"]'::jsonb, true,
   null,
   '{"This week":3,"Next week":2,"2 weeks":1,"1 month+":0}'::jsonb,
   5),
  ('q0000001-0000-0000-0000-000000000006',
   '11111111-1111-1111-1111-111111111111',
   'Have you had any moving violations in the last 3 years?',
   'yes_no', '["Yes","No"]'::jsonb, false, null,
   '{"Yes":0,"No":2}'::jsonb,
   6),
  ('q0000001-0000-0000-0000-000000000007',
   '11111111-1111-1111-1111-111111111111',
   'Do you have prior delivery experience?',
   'single', '["Amazon DSP","Other delivery","Personal delivery","No"]'::jsonb,
   false, null,
   '{"Amazon DSP":3,"Other delivery":2,"Personal delivery":1,"No":0}'::jsonb,
   7)
on conflict (id) do nothing;

-- A handful of applicants spanning the funnel. Names match mockup pipeline.
insert into public.applicants
  (id, dsp_id, station_id, full_name, email, phone, source, source_ref,
   referrer_driver_id, stage, score, interview_at)
values
  ('aa000001-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000001',
   'Trevor Anders', 'trevor.anders@example.com', '+14175558881',
   'referral', null,
   'dddd0001-0000-0000-0000-000000000003',                 -- Marcus referred Trevor
   'booked', 8,
   current_date + 1 + interval '9 hours'),
  ('aa000001-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000001',
   'Marcus Hill', 'marcus.hill@example.com', '+14175558882',
   'ziprecruiter', 'zr-12345',
   null,
   'booked', 9,
   current_date + 1 + interval '9 hours 30 minutes'),
  ('aa000001-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111',
   null,
   'Lena Whitcomb', 'lena.w@example.com', '+14175558883',
   'indeed', 'in-67890',
   null,
   'passed', 7, null),
  ('aa000001-0000-0000-0000-000000000004',
   '11111111-1111-1111-1111-111111111111',
   null,
   'Sasha Underwood', 'sasha@example.com', '+14175558884',
   'indeed', 'in-67891',
   null,
   'screening', 5, null),
  ('aa000001-0000-0000-0000-000000000005',
   '11111111-1111-1111-1111-111111111111',
   null,
   'Devin Mateo', 'devin@example.com', '+14175558885',
   'walkin', null,
   null,
   'new', null, null)
on conflict (id) do nothing;

-- ─── Phase 5: license policy + form templates + sample inspection ─────

insert into public.license_policies (dsp_id, enabled, days_before, notify_owner, block_scheduling)
values
  ('11111111-1111-1111-1111-111111111111', true, array[30, 14], true, true),
  ('22222222-2222-2222-2222-222222222222', true, array[30, 14], true, true)
on conflict (dsp_id) do nothing;

-- Pre-trip inspection template
insert into public.form_templates (id, dsp_id, name, trigger_type, schema, active) values
  ('ff0000a1-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'Pre-trip vehicle inspection', 'pre_trip',
   '{"fields":[
     {"id":"odometer","label":"Odometer reading","type":"number","required":true},
     {"id":"tires_ok","label":"Tires inflated and undamaged?","type":"yes_no","required":true},
     {"id":"lights_ok","label":"All lights working?","type":"yes_no","required":true},
     {"id":"brakes_ok","label":"Brakes responsive?","type":"yes_no","required":true},
     {"id":"damage_photo","label":"Photo of any damage","type":"photo","required":false},
     {"id":"notes","label":"Notes","type":"text","required":false}
   ]}'::jsonb, true),
  ('ff0000a1-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',
   'Post-trip vehicle inspection', 'post_trip',
   '{"fields":[
     {"id":"odometer","label":"Odometer reading","type":"number","required":true},
     {"id":"damage_new","label":"Any new damage?","type":"yes_no","required":true,
      "conditional_show":{"id":"damage_photo","when":"Yes"}},
     {"id":"damage_photo","label":"Photo of damage","type":"photo","required":false},
     {"id":"trip_notes","label":"Trip notes","type":"text","required":false}
   ]}'::jsonb, true)
on conflict (id) do nothing;

-- Daily safety checklist
insert into public.checklist_templates (id, dsp_id, name, cadence, items, active) values
  ('cc0000a1-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'Daily safety checklist', 'daily',
   '[
     {"id":"radio_brief","label":"Morning radio brief delivered"},
     {"id":"weather_check","label":"Weather forecast reviewed"},
     {"id":"yard_walk","label":"Yard walk-around completed"}
   ]'::jsonb, true)
on conflict (id) do nothing;

-- ─── Phase 6: vehicles + assets ───────────────────────────────────────

insert into public.vehicles (id, dsp_id, station_id, van_number, make, model, year, status, mileage, dot_inspection_at)
values
  ('vvvv0001-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000001',
   'VAN-01', 'Ford', 'Transit', 2022, 'active', 45000, current_date - 60),
  ('vvvv0001-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000001',
   'VAN-02', 'Mercedes', 'Sprinter', 2023, 'active', 28000, current_date - 30),
  ('vvvv0001-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000002',
   'VAN-03', 'Ram', 'ProMaster', 2021, 'maintenance', 78000, current_date - 200)
on conflict (id) do nothing;

insert into public.assets (id, dsp_id, asset_type, identifier, vendor) values
  ('aaaa0001-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111', 'phone', 'IMEI-001', 'Verizon'),
  ('aaaa0001-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111', 'fuel_card', 'WEX-1234', 'WEX'),
  ('aaaa0001-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111', 'toll_tag', 'TT-1234', 'TollPass')
on conflict (id) do nothing;

-- ─── Sanity output ────────────────────────────────────────────────────

do $$
declare
  v_drivers int; v_users int; v_dsps int;
  v_att int; v_hr int; v_coach int;
  v_routes int; v_shifts int; v_okami int;
  v_applicants int; v_questions int;
  v_license_pol int; v_form_tpl int; v_checklist_tpl int;
  v_vehicles int; v_assets int;
begin
  select count(*) into v_dsps      from public.dsps;
  select count(*) into v_drivers   from public.drivers;
  select count(*) into v_users     from public.app_users;
  select count(*) into v_att       from public.attendance_events;
  select count(*) into v_hr        from public.hr_events;
  select count(*) into v_coach     from public.coaching_events;
  select count(*) into v_routes    from public.routes;
  select count(*) into v_shifts    from public.shifts;
  select count(*) into v_okami     from public.okami_weeks;
  select count(*) into v_applicants from public.applicants;
  select count(*) into v_questions  from public.screening_questions;
  select count(*) into v_license_pol from public.license_policies;
  select count(*) into v_form_tpl    from public.form_templates;
  select count(*) into v_checklist_tpl from public.checklist_templates;
  select count(*) into v_vehicles    from public.vehicles;
  select count(*) into v_assets      from public.assets;
  raise notice
    'Seed loaded: % DSPs, % staff, % drivers, % att, % HR, % coach, % routes, % shifts, % OKAMI, % applicants, % screening Qs, % license policies, % form templates, % checklist templates, % vehicles, % assets',
    v_dsps, v_users, v_drivers, v_att, v_hr, v_coach,
    v_routes, v_shifts, v_okami, v_applicants, v_questions,
    v_license_pol, v_form_tpl, v_checklist_tpl, v_vehicles, v_assets;
end $$;
