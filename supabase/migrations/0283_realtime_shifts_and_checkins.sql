-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0283 · Realtime: shifts + driver_checkins
--
-- Adds the two tables that drive the "Until OT" column on Today's
-- roster to the supabase_realtime publication so the dashboard receives
-- a push the moment a driver checks in / checks out, or a shift status
-- flips (no-show, called-off, VTO, completed). Without this the only
-- update path is the 30-second poll, which leaves the operator looking
-- at a stale headroom value while making replace-or-not calls.
--
-- Existing RLS on both tables already gates the feed by dsp_id, so
-- adding them to the publication doesn't widen access — it only opens
-- the push channel to clients that could already SELECT the rows.
--
-- Idempotent — duplicate_object swallowed.
-- ─────────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
  tables text[] := array[
    'shifts',
    'driver_checkins'
  ];
begin
  foreach t in array tables loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then
      null;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';
