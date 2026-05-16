-- Migration 0272 · Training/ride-along shifts can't outlive their trainee
--
-- shifts.driver_id is ON DELETE SET NULL, which is the right choice for
-- regular route shifts (history matters even after a driver is removed).
-- But for shift_kind IN ('training', 'ride_along') it leaves orphans
-- that have no meaning standing alone — they're a 3-day onboarding
-- block intrinsic to a specific trainee. Worse, Smart Fill sees them
-- as open shifts and stuffs unrelated active drivers into them.
--
-- This migration:
--   1. Drops any orphan rows currently sitting in the table.
--   2. Adds a BEFORE DELETE trigger on drivers that proactively deletes
--      training + ride-along shifts for that driver, so the FK cascade
--      to NULL never finds any to null in the first place.
--   3. Adds a BEFORE UPDATE trigger on shifts: if a manual unassign
--      transitions driver_id to NULL on a training/ride-along shift,
--      delete the row rather than leave it floating.
--
-- Idempotent.

-- 1. Clean up existing orphans.
delete from public.shifts
 where shift_kind in ('training', 'ride_along')
   and driver_id is null;


-- 2. Driver-deletion path: scrub training + ride-along first.
create or replace function private.tg_drivers_delete_training_shifts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.shifts
   where driver_id = OLD.id
     and shift_kind in ('training', 'ride_along');
  return OLD;
end;
$$;

drop trigger if exists trg_drivers_cleanup_training_shifts on public.drivers;
create trigger trg_drivers_cleanup_training_shifts
  before delete on public.drivers
  for each row execute function private.tg_drivers_delete_training_shifts();


-- 3. Manual-unassign path: drop the row instead of orphaning it.
create or replace function private.tg_shifts_drop_orphan_training()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if NEW.driver_id is null
     and NEW.shift_kind in ('training', 'ride_along')
     and OLD.driver_id is not null then
    delete from public.shifts where id = NEW.id;
    return null;  -- abort the in-flight UPDATE; row no longer exists.
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_shifts_drop_orphan_training on public.shifts;
create trigger trg_shifts_drop_orphan_training
  before update of driver_id on public.shifts
  for each row execute function private.tg_shifts_drop_orphan_training();


notify pgrst, 'reload schema';
