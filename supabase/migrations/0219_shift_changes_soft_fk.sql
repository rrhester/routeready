-- Migration 0219 · shift_changes — drop hard FK on shift_id
--
-- The audit-capture trigger (0200) fires AFTER DELETE on shifts and
-- inserts a 'deleted' row into shift_changes with shift_id = old.id.
-- At that point the parent shift is already gone, so the FK
-- (shift_changes.shift_id → shifts.id) is violated and the whole
-- transaction rolls back — which is exactly what bit the user when
-- they tried to add a wave (adding a wave triggers a rebuild of the
-- week's shifts: deletes + re-inserts).
--
-- The FK was also semantically wrong: it had ON DELETE CASCADE, which
-- would wipe the audit trail every time a shift was deleted.  An audit
-- table should survive the lifetime of its source rows.
--
-- Fix: drop the FK.  shift_id stays as a UUID column (indexed via
-- shift_changes_shift_idx, kept) but is a soft reference — the audit
-- log survives parent-row deletes, and the trigger's "deleted" event
-- inserts cleanly.

alter table public.shift_changes
  drop constraint if exists shift_changes_shift_id_fkey;

-- The shift_id NOT NULL constraint stays; the index stays.
-- Existing shift_changes rows are unaffected.

notify pgrst, 'reload schema';
