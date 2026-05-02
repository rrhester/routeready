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
do $$
declare
  v_drivers int; v_users int; v_dsps int;
begin
  select count(*) into v_dsps    from public.dsps;
  select count(*) into v_drivers from public.drivers;
  select count(*) into v_users   from public.app_users;
  raise notice 'Seed loaded: % DSPs, % staff users, % drivers',
    v_dsps, v_users, v_drivers;
end $$;
