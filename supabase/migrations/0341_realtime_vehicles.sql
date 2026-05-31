-- Migration 0341 · Realtime: vehicles + vehicle_day_assignments
--
-- The schedule week view subscribes to van status changes so the operator
-- gets a live push when a van is grounded / un-grounded or a van-day
-- assignment changes — no need to re-run Assign Vans to discover a van went
-- unavailable. That only works if these tables emit postgres_changes, so add
-- them to the supabase_realtime publication.
--
-- Idempotent: skip a table that's already in the publication (duplicate_object).

do $$
declare
  t text;
  tables text[] := array[
    'vehicles',
    'vehicle_day_assignments'
  ];
begin
  foreach t in array tables loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when undefined_object then null;  -- publication missing (non-Supabase) → skip
    end;
  end loop;
end $$;
