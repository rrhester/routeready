-- Migration 0346 · shifts.is_locked (Pin feature)
--
-- The schedule Pin feature (📌 on the shift edit card + grid marker, and
-- the Smart Fill "don't move a pinned shift" behavior) reads and writes
-- shifts.is_locked, but the column was never created — so loading a shift
-- to edit it failed with: column shifts.is_locked does not exist. Add it.
--
-- Default false = unpinned. Idempotent.

alter table public.shifts
  add column if not exists is_locked boolean not null default false;

notify pgrst, 'reload schema';
