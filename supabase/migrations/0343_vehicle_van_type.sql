-- Migration 0343 · Vehicle van type
--
-- Adds a physical vehicle-class field to vehicles. EDV / Step Van /
-- Cargo Van / Box Truck were mistakenly modeled as service types; van
-- type is a property of the vehicle, not the route's service type. The
-- Van Info Card (Fleet drawer) reads/writes this; vehicle_record returns
-- the full row via to_jsonb(), so it's exposed automatically. Saves go
-- through a direct dispatcher update (vehicles RLS already allows it),
-- so no RPC change is needed.
--
-- Idempotent: re-running is safe.

alter table public.vehicles
  add column if not exists van_type text;   -- edv | step_van | cargo_van | box_truck | null

notify pgrst, 'reload schema';
