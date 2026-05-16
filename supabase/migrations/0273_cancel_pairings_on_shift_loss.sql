-- Migration 0273 · A pairing can't outlive its training shifts
--
-- A training_pairings row in status='materialized' means three real
-- shifts exist for the trainee — Day 1 + Day 2 (shift_kind='training')
-- on training_start_date+0/1, and Day 3 (shift_kind='ride_along') on
-- ride_along_date pointing at the trainer via trainer_driver_id.
--
-- If any of those shifts is deleted (Smart Fill from before #1047 had
-- this bug; a manual delete will too), the pairing keeps reading
-- "materialized" even though the training is no longer on the books.
-- The eligibility RPC then keeps blocking the trainer from being
-- re-used for a different trainee on the same day — a "ghost pairing"
-- — and the schedule UI shows nothing because the shifts that would
-- carry the badges are gone.
--
-- This migration:
--   1. Cleans up any currently-materialized pairings whose Day-3
--      ride-along shift no longer exists.
--   2. Adds an AFTER DELETE trigger on shifts that flips any matching
--      materialized pairing to 'cancelled' (with a repair_reason
--      explaining what disappeared) the moment one of its constituent
--      shifts goes away.
--
-- Idempotent.

-- 1. Backfill cleanup — cancel ghost pairings that exist right now.
update public.training_pairings tp
   set status = 'cancelled',
       repair_reason = 'underlying training/ride-along shift no longer exists',
       updated_at = now()
 where tp.status = 'materialized'
   and not exists (
     select 1 from public.shifts s
      where s.driver_id  = tp.trainee_id
        and s.dsp_id     = tp.dsp_id
        and s.date       = tp.ride_along_date
        and s.shift_kind = 'ride_along'
   );


-- 2. Going forward · cancel a pairing the moment its training Day 1+2
--    or ride-along Day 3 shift gets deleted.
create or replace function private.tg_shifts_cancel_pairing_on_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if OLD.shift_kind not in ('training', 'ride_along') then
    return OLD;
  end if;
  if OLD.driver_id is null then
    return OLD;
  end if;

  update public.training_pairings
     set status = 'cancelled',
         repair_reason = 'underlying ' || OLD.shift_kind::text
                         || ' shift on ' || OLD.date
                         || ' was deleted',
         updated_at = now()
   where trainee_id = OLD.driver_id
     and dsp_id     = OLD.dsp_id
     and status     in ('materialized', 'proposed', 'needs_repair')
     and (
       (OLD.shift_kind = 'ride_along' and ride_along_date = OLD.date)
       or
       (OLD.shift_kind = 'training' and
        (training_start_date = OLD.date or training_start_date + 1 = OLD.date))
     );

  return OLD;
end;
$$;

drop trigger if exists trg_shifts_cancel_pairing_on_delete on public.shifts;
create trigger trg_shifts_cancel_pairing_on_delete
  after delete on public.shifts
  for each row execute function private.tg_shifts_cancel_pairing_on_delete();


notify pgrst, 'reload schema';
