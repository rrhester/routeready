-- supabase/tests/cert_gate_test.sql
--
-- Server-side compliance-gate regression tests for migration 0537 (EDV
-- certification + license protection window in the three assignment gates).
-- These are the FIRST automated tests over private.staff_assign_violations /
-- driver_can_take_shift / driver_can_take_shift_after_swap — the audit's
-- root-cause fix for "a whole cert rule drifted out of the SQL gates because
-- nothing tested them." Runs against a fully-migrated DB (migration-check.yml).
--
-- What it proves:
--   • an uncertified driver is BLOCKED from a requires_edv route on all three
--     write paths (dispatcher/Smart Fill, self-pickup, swap);
--   • an edv_certified driver is ALLOWED;
--   • a 'helper' seat on an EDV route is EXEMPT (ride-along body, no cert);
--   • the license PROTECTION WINDOW blocks a shift within N days of expiry
--     when dsps.metadata.scheduling.dl_protection_days > 0;
--   • with no window set (default 0), a not-yet-expired license does NOT
--     block — i.e. 0537 is byte-identical to prior behaviour by default.
--
-- Run locally from the repo root against any migrated DB:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/cert_gate_test.sql
--
-- One transaction, rolled back at the end — no residue.

\set ON_ERROR_STOP on

begin;

set local session_replication_role = replica;  -- skip FK-to-auth + triggers

-- ── Fixtures ──────────────────────────────────────────────────────────────
-- dsp1 carries a 14-day license protection window; dsp2 has none (default 0).
insert into public.dsps (id, name, short_code, metadata) values
  ('ed000000-0000-4000-8000-000000000001', 'EDV Gate DSP', 'EDVG',
     '{"scheduling":{"dl_protection_days":14}}'::jsonb),
  ('ed000000-0000-4000-8000-0000000000a2', 'No-Window DSP', 'NOWIN', '{}'::jsonb);

insert into public.stations (id, dsp_id, code, name, active) values
  ('ed000000-0000-4000-8000-000000000003',
     'ed000000-0000-4000-8000-000000000001', 'EDV1', 'EDV Station', true),
  ('ed000000-0000-4000-8000-0000000000a3',
     'ed000000-0000-4000-8000-0000000000a2', 'NOW1', 'No-Window Station', true);

insert into public.service_types (id, dsp_id, code, label, requires_edv, active) values
  ('ed000000-0000-4000-8000-000000000004',
     'ed000000-0000-4000-8000-000000000001', 'EDV', 'Electric Delivery Van', true, true),
  ('ed000000-0000-4000-8000-0000000000a4',
     'ed000000-0000-4000-8000-0000000000a2', 'EDV', 'Electric Delivery Van', true, true);

-- Drivers (dsp1): uncertified, certified, and certified-but-license-expiring.
insert into public.drivers (id, dsp_id, full_name, status, edv_certified, dl_expires_on) values
  ('ed000000-0000-4000-8000-000000000005',
     'ed000000-0000-4000-8000-000000000001', 'Uma Uncertified', 'active', false, current_date + 400),
  ('ed000000-0000-4000-8000-000000000006',
     'ed000000-0000-4000-8000-000000000001', 'Cyrus Certified',  'active', true,  current_date + 400),
  ('ed000000-0000-4000-8000-000000000007',
     'ed000000-0000-4000-8000-000000000001', 'Ed Expiring',      'active', true,  current_date + 15);
-- Driver (dsp2, no window): certified, license expiring in 15 days.
insert into public.drivers (id, dsp_id, full_name, status, edv_certified, dl_expires_on) values
  ('ed000000-0000-4000-8000-0000000000a7',
     'ed000000-0000-4000-8000-0000000000a2', 'Nora NoWindow', 'active', true, current_date + 15);

-- Shifts: an open EDV driver seat (+10d), a helper seat on an EDV route,
-- and a give-back shift for the swap path. All future + open.
insert into public.shifts (id, dsp_id, station_id, date, status, service_type_id, shift_kind) values
  ('ed000000-0000-4000-8000-000000000008',
     'ed000000-0000-4000-8000-000000000001', 'ed000000-0000-4000-8000-000000000003',
     current_date + 10, 'scheduled', 'ed000000-0000-4000-8000-000000000004', 'regular'),
  ('ed000000-0000-4000-8000-000000000009',
     'ed000000-0000-4000-8000-000000000001', 'ed000000-0000-4000-8000-000000000003',
     current_date + 10, 'scheduled', 'ed000000-0000-4000-8000-000000000004', 'helper'),
  ('ed000000-0000-4000-8000-00000000000a',
     'ed000000-0000-4000-8000-000000000001', 'ed000000-0000-4000-8000-000000000003',
     current_date + 12, 'scheduled', 'ed000000-0000-4000-8000-000000000004', 'regular'),
  ('ed000000-0000-4000-8000-0000000000a8',
     'ed000000-0000-4000-8000-0000000000a2', 'ed000000-0000-4000-8000-0000000000a3',
     current_date + 10, 'scheduled', 'ed000000-0000-4000-8000-0000000000a4', 'regular');

-- ═══ Assertions ════════════════════════════════════════════════════════════
do $$
declare
  v text[];
begin
  -- 1. EDV block · dispatcher / Smart Fill write path (staff_assign_violations)
  v := private.staff_assign_violations(
    'ed000000-0000-4000-8000-000000000008',  -- EDV driver seat
    'ed000000-0000-4000-8000-000000000005'); -- uncertified driver
  assert 'route requires EDV certification, not on file' = any(v),
    'uncertified driver must be flagged for the EDV cert on assign; got: ' || coalesce(array_to_string(v, ' | '), '(null)');

  -- 2. EDV allow · certified driver has no EDV violation
  v := private.staff_assign_violations(
    'ed000000-0000-4000-8000-000000000008',
    'ed000000-0000-4000-8000-000000000006'); -- certified
  assert not ('route requires EDV certification, not on file' = any(v)),
    'certified driver must NOT be flagged for EDV; got: ' || coalesce(array_to_string(v, ' | '), '(null)');

  -- 3. Helper exemption · uncertified driver on a helper EDV seat is exempt
  v := private.staff_assign_violations(
    'ed000000-0000-4000-8000-000000000009',  -- helper seat
    'ed000000-0000-4000-8000-000000000005'); -- uncertified
  assert not ('route requires EDV certification, not on file' = any(v)),
    'helper seat must be exempt from the EDV cert; got: ' || coalesce(array_to_string(v, ' | '), '(null)');

  -- 4. License protection window · certified driver expiring within 14 days
  v := private.staff_assign_violations(
    'ed000000-0000-4000-8000-000000000008',
    'ed000000-0000-4000-8000-000000000007'); -- expiring in 15d, shift +10d → 5d to expiry ≤ 14
  assert exists (select 1 from unnest(v) e where e like '%protection window%'),
    'driver expiring inside the window must be flagged; got: ' || coalesce(array_to_string(v, ' | '), '(null)');

  -- 5. Backward-safe · same shape on a DSP with no window (default 0) → no window flag
  v := private.staff_assign_violations(
    'ed000000-0000-4000-8000-0000000000a8',
    'ed000000-0000-4000-8000-0000000000a7'); -- expiring in 15d, no dl_protection_days set
  assert not exists (select 1 from unnest(v) e where e like '%protection window%'),
    'with no protection window, a not-yet-expired license must NOT be flagged; got: ' || coalesce(array_to_string(v, ' | '), '(null)');
  assert not exists (select 1 from unnest(v) e where e like '%before the shift date%'),
    'a not-yet-expired license must NOT be flagged as expired; got: ' || coalesce(array_to_string(v, ' | '), '(null)');

  raise notice 'staff_assign_violations EDV + license-window assertions passed';
end $$;

-- 6. driver_can_take_shift (self-pickup) · cert gate flips the boolean
do $$
begin
  assert private.driver_can_take_shift(
    'ed000000-0000-4000-8000-000000000006',   -- certified
    'ed000000-0000-4000-8000-000000000008') = true,
    'certified driver should be able to pick up the open EDV seat';
  assert private.driver_can_take_shift(
    'ed000000-0000-4000-8000-000000000005',   -- uncertified
    'ed000000-0000-4000-8000-000000000008') = false,
    'uncertified driver must NOT be able to pick up the EDV seat';
  -- helper seat: uncertified driver allowed (no cert required)
  assert private.driver_can_take_shift(
    'ed000000-0000-4000-8000-000000000005',   -- uncertified
    'ed000000-0000-4000-8000-000000000009') = true,
    'uncertified driver should be able to pick up the EDV HELPER seat';
  raise notice 'driver_can_take_shift EDV assertions passed';
end $$;

-- 7. driver_can_take_shift_after_swap · cert gate flips the boolean
do $$
begin
  assert private.driver_can_take_shift_after_swap(
    'ed000000-0000-4000-8000-000000000006',   -- certified takes the EDV seat
    'ed000000-0000-4000-8000-000000000008',   -- take: EDV seat
    'ed000000-0000-4000-8000-00000000000a') = true,
    'certified driver should be able to swap into the EDV seat';
  assert private.driver_can_take_shift_after_swap(
    'ed000000-0000-4000-8000-000000000005',   -- uncertified
    'ed000000-0000-4000-8000-000000000008',
    'ed000000-0000-4000-8000-00000000000a') = false,
    'uncertified driver must NOT be able to swap into the EDV seat';
  raise notice 'driver_can_take_shift_after_swap EDV assertions passed';
end $$;

rollback;
