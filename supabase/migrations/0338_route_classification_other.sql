-- ── shifts.route_classification — allow 'other' ────────────────────────
--
-- The Add/Edit shift route-type picker was trimmed to Standard / Rescue /
-- Nursery + a catch-all "Other". 'other' isn't in the 0332 CHECK, so
-- saving it would fail. Widen the constraint to accept 'other'.
--
-- The retired types (reduction / cycle_1 / cycle_2 / backup) stay in the
-- allowed set so any shift already tagged with one remains valid — they're
-- just no longer offered in the picker.
--
-- Idempotent: drop the existing constraint if present, then re-add the
-- widened one (also guarded so a re-run doesn't double-add).

alter table public.shifts
  drop constraint if exists shifts_route_classification_chk;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shifts_route_classification_chk') then
    alter table public.shifts
      add constraint shifts_route_classification_chk
      check (route_classification is null or route_classification in (
        'standard',
        'rescue',
        'nursery',
        'other',
        'reduction',
        'cycle_1',
        'cycle_2',
        'backup'
      ));
  end if;
end $$;

notify pgrst, 'reload schema';
