-- Migration 0265 · Backfill trainer columns missed by 0143
--
-- Operator hit this error trying to activate a paired trainee:
--   "column trainer_driver_id of relation shifts does not exist"
--
-- Root cause: migration 0143 (which adds drivers.is_trainer +
-- shifts.trainer_driver_id) never ran on production — likely a manual-
-- migration-flow gap. 0264 was written assuming those columns exist;
-- without them, activate_driver_with_pairing fails on the insert.
--
-- Idempotent guard so it's safe to re-apply.

alter table public.drivers
  add column if not exists is_trainer boolean not null default false;

alter table public.shifts
  add column if not exists trainer_driver_id uuid
    references public.drivers(id) on delete set null;

create index if not exists shifts_trainer_idx
  on public.shifts(trainer_driver_id)
  where trainer_driver_id is not null;

notify pgrst, 'reload schema';
