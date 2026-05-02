-- ─────────────────────────────────────────────────────────────────────────
-- pgTAP test · Phase 6 fleet
-- Vehicles, asset assignments (one-open-at-a-time), maintenance records,
-- bulk import. Cross-DSP isolation.
-- ─────────────────────────────────────────────────────────────────────────

begin;
select plan(11);

create extension if not exists pgtap;

-- ─── Setup ────────────────────────────────────────────────────────────

insert into public.dsps (id, name, slug)
values ('aaff1100-0000-0000-0000-000000000001', 'Fleet Test DSP', 'fleet-test');

insert into public.stations (id, dsp_id, code, name) values
  ('aaff1100-0000-0000-0000-000000001000',
   'aaff1100-0000-0000-0000-000000000001', 'A1', 'A-1');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('aaff1100-0000-0000-0000-aaaaaaaaaaaa',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'fleet-ops@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.app_users (id, dsp_id, role, email) values
  ('aaff1100-0000-0000-0000-aaaaaaaaaaaa',
   'aaff1100-0000-0000-0000-000000000001', 'ops', 'fleet-ops@test.test');

insert into public.drivers (id, dsp_id, station_id, full_name, status) values
  ('aaff1100-dddd-0000-0000-000000000001',
   'aaff1100-0000-0000-0000-000000000001',
   'aaff1100-0000-0000-0000-000000001000',
   'Fleet Driver', 'active');

create or replace function pg_temp.act_as_ops()
returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub','aaff1100-0000-0000-0000-aaaaaaaaaaaa',
                       'dsp_id','aaff1100-0000-0000-0000-000000000001',
                       'role','ops')::text, true);
  perform set_config('role','authenticated', true);
end $$;

-- ─── bulk_import_vehicles ─────────────────────────────────────────────

select pg_temp.act_as_ops();

-- 1. Bulk import 3 vehicles
select is(
  (public.bulk_import_vehicles(
    '[
      {"van_number":"VAN-01","vin":"1FT001","make":"Ford","model":"Transit","year":2022,"station_code":"A1","mileage":42000},
      {"van_number":"VAN-02","make":"Mercedes","model":"Sprinter","year":2023,"station_code":"A1"},
      {"van_number":"VAN-03","make":"Ram","model":"ProMaster","year":2021}
    ]'::jsonb
  ))->>'inserted',
  '3',
  'bulk_import_vehicles inserts 3 vehicles');

-- 2. van_number unique enforced
select throws_ok(
  $sql$
    insert into public.vehicles (dsp_id, van_number)
    values ('aaff1100-0000-0000-0000-000000000001', 'VAN-01')
  $sql$,
  null, null,
  'duplicate van_number rejected');

-- 3. Vehicles visible
select is(
  (select count(*) from public.vehicles
    where dsp_id = 'aaff1100-0000-0000-0000-000000000001'),
  3::bigint,
  '3 vehicles in fleet');

-- ─── Assets + assignments ────────────────────────────────────────────

-- Create a phone asset
insert into public.assets (id, dsp_id, asset_type, identifier, vendor) values
  ('aaff1100-asss-0000-0000-000000000001',
   'aaff1100-0000-0000-0000-000000000001', 'phone', 'IMEI-12345', 'AT&T');

-- 4. Assign phone to driver
select isnt(
  (public.assign_asset(
    'aaff1100-asss-0000-0000-000000000001'::uuid,
    'aaff1100-dddd-0000-0000-000000000001'::uuid
  ))::text,
  null,
  'assign_asset returns assignment id');

-- 5. Driver has 1 open assignment
select is(
  (select count(*) from public.asset_assignments
    where driver_id = 'aaff1100-dddd-0000-0000-000000000001'
      and returned_at is null),
  1::bigint,
  'Driver has 1 open assignment');

-- 6. Re-assigning same asset to a different context auto-closes the prior
do $$
declare v_vehicle_id uuid;
begin
  select id into v_vehicle_id from public.vehicles
   where van_number = 'VAN-01' limit 1;
  perform public.assign_asset(
    'aaff1100-asss-0000-0000-000000000001'::uuid,
    null,
    v_vehicle_id
  );
end $$;

select is(
  (select count(*) from public.asset_assignments
    where asset_id = 'aaff1100-asss-0000-0000-000000000001'
      and returned_at is null),
  1::bigint,
  'Reassign auto-closes prior — still one open assignment');

-- 7. The open assignment is now to the vehicle, not the driver
select isnt(
  (select vehicle_id::text from public.asset_assignments
    where asset_id = 'aaff1100-asss-0000-0000-000000000001'
      and returned_at is null),
  null,
  'New assignment is to a vehicle');

-- 8. return_asset closes the open assignment
do $$
declare v_a uuid;
begin
  select id into v_a from public.asset_assignments
   where asset_id = 'aaff1100-asss-0000-0000-000000000001'
     and returned_at is null;
  perform public.return_asset(v_a, 'good condition', 'Returned at end of shift');
end $$;

select is(
  (select count(*) from public.asset_assignments
    where asset_id = 'aaff1100-asss-0000-0000-000000000001'
      and returned_at is null),
  0::bigint,
  'No open assignments after return_asset');

-- ─── Maintenance ──────────────────────────────────────────────────────

-- 9. record_maintenance writes record + updates mileage
do $$
declare v_v uuid;
begin
  select id into v_v from public.vehicles where van_number = 'VAN-01' limit 1;
  perform public.record_maintenance(
    v_v, 'oil', current_date - 5, 43000, 8500, 'Quick Lube', 'Standard service'
  );
end $$;

select is(
  (select mileage from public.vehicles where van_number = 'VAN-01'),
  43000,
  'Vehicle mileage updated by record_maintenance');

-- 10. DOT inspection updates dot_inspection_at
do $$
declare v_v uuid;
begin
  select id into v_v from public.vehicles where van_number = 'VAN-01';
  perform public.record_maintenance(
    v_v, 'dot_inspection', current_date - 1, 43500, 50000, 'CertCo', 'Annual DOT inspection'
  );
end $$;

select is(
  (select dot_inspection_at from public.vehicles where van_number = 'VAN-01'),
  current_date - 1,
  'DOT inspection date updated by record_maintenance');

-- 11. Cross-DSP isolation: cannot assign asset across DSPs
insert into public.dsps (id, name, slug)
values ('aaff1100-0000-0000-0000-000000000999', 'Other DSP', 'fleet-other');

insert into public.assets (id, dsp_id, asset_type, identifier) values
  ('aaff1100-asss-0000-0000-000000000999',
   'aaff1100-0000-0000-0000-000000000999', 'phone', 'IMEI-OTHER');

select throws_ok(
  $sql$
    select public.assign_asset(
      'aaff1100-asss-0000-0000-000000000999'::uuid,
      'aaff1100-dddd-0000-0000-000000000001'::uuid
    )
  $sql$,
  null, null,
  'assign_asset fails across DSPs');

-- ─── Wrap up ──────────────────────────────────────────────────────────

select * from finish();
rollback;
