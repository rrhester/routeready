-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0195 · Realtime broadcast for the driver onboarding hub
--
-- The driver app subscribes to postgres_changes on the tables that back
-- its onboarding hub, so a DSP action on the dashboard (clearing a
-- background check, signing Section 2 of the I-9, sending a document,
-- changing the blueprint, etc.) reaches the driver immediately rather
-- than on the next short poll. RLS still gates what individual rows the
-- subscriber sees; this migration only adds publication membership.
-- ─────────────────────────────────────────────────────────────────────────

do $$
declare
  t      text;
  tables text[] := array[
    'onboarding_progress',
    'driver_onboarding_state',
    'i9_records',
    'document_envelopes',
    'onboarding_blueprint'
  ];
begin
  foreach t in array tables loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then
      null;   -- already a member
    end;
  end loop;
end $$;
