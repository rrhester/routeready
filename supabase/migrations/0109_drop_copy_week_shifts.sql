-- Drop copy_week_shifts. Operator decided against the feature after
-- it shipped in #527 — preserved driver_id was the desired behavior,
-- but they didn't want the button on the toolbar. Remove the RPC so
-- the surface area shrinks back to what's actually used.

drop function if exists public.copy_week_shifts(date, boolean);

notify pgrst, 'reload schema';
