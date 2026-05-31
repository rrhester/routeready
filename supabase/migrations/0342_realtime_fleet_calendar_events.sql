-- Migration 0342 · Realtime: fleet_calendar_events
--
-- The schedule week view now flags any driver whose assigned van is booked
-- for service on the Fleet calendar that day (red van chip + Van assignments
-- KPI). For that flag to appear the instant a service event is added/removed
-- — without re-running Assign Vans — fleet_calendar_events must emit
-- postgres_changes, so add it to the supabase_realtime publication.
--
-- Idempotent: skip if it's already in the publication (duplicate_object).

do $$
begin
  begin
    alter publication supabase_realtime add table public.fleet_calendar_events;
  exception
    when duplicate_object then null;
    when undefined_object then null;  -- publication missing (non-Supabase) → skip
  end;
end $$;
