-- Migration 0144 · Drop the ride-along training-shift mechanic
--
-- We're keeping drivers.is_trainer (the designation, surfaced on the
-- driver record and as a badge on the schedule grid) but dropping the
-- "attach a trainer to a specific shift" feature that 0143 added:
-- shifts.trainer_driver_id and the shift_set_trainer RPC.

drop function if exists public.shift_set_trainer(uuid, uuid);
drop index if exists public.shifts_trainer_idx;
alter table public.shifts drop column if exists trainer_driver_id;

notify pgrst, 'reload schema';
