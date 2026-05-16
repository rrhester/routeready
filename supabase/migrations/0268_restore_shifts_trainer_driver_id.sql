-- Migration 0268 · Restore shifts.trainer_driver_id
--
-- 0143 added shifts.trainer_driver_id as the "ride-along trainer on this
-- shift" pointer. 0144 dropped it because the feature was being reworked.
-- 0264_training_pairings.sql brought the mechanic back — its
-- activate_driver_with_pairing RPC and orphaned_ride_alongs RPC both
-- read/write shifts.trainer_driver_id — but the column was never
-- re-added, so activating a driver from the new schedule card raises
-- `column "trainer_driver_id" of relation "shifts" does not exist`.
--
-- This migration restores just the column + index. The
-- shift_set_trainer RPC from 0143 stays gone — the new flow uses
-- activate_driver_with_pairing instead.

alter table public.shifts
  add column if not exists trainer_driver_id uuid
    references public.drivers(id) on delete set null;

create index if not exists shifts_trainer_idx
  on public.shifts(trainer_driver_id)
  where trainer_driver_id is not null;

notify pgrst, 'reload schema';
