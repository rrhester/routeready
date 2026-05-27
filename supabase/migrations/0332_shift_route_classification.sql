-- Migration 0332 · Route classification on shifts
--
-- DSPs tag routes by operational purpose so dispatch + reporting can
-- distinguish a standard delivery route from a rescue, nursery, etc.
-- This is separate from `route_type` (vehicle class: step_van/xl/edv)
-- and `shift_kind` (regular/training/ride_along/pto). It's a freeform
-- label the operator picks per shift.
--
-- NULL is the implicit "Standard" — no migration of existing rows.

alter table public.shifts
  add column if not exists route_classification text;

comment on column public.shifts.route_classification is
  'Operator-set route purpose (Rescue, Nursery, Reduction, Cycle 1, Cycle 2, etc.). NULL = Standard.';

-- Optional CHECK to keep the surface manageable. Operators can extend
-- this via a follow-up migration if they need more classifications.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shifts_route_classification_chk') then
    alter table public.shifts
      add constraint shifts_route_classification_chk
      check (route_classification is null or route_classification in (
        'standard',
        'rescue',
        'nursery',
        'reduction',
        'cycle_1',
        'cycle_2',
        'backup'
      ));
  end if;
end $$;
