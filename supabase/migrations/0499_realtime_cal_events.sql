-- ─────────────────────────────────────────────────────────────────────────
-- 0499 · Realtime calendar updates (calendar 100-list #91)
--
-- Adds cal_events (and interview_sessions, whose capacity counts feed the
-- same grid) to the supabase_realtime publication so open dashboards get a
-- colleague's booking/cancel/move within ~1s and patch the calendar cache
-- in place — the same mechanism 0446 gave the schedule board. RLS applies
-- to realtime payloads, so each dashboard only ever sees its own DSP's
-- rows. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

do $$ begin
  alter publication supabase_realtime add table public.cal_events;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.interview_sessions;
exception when duplicate_object then null;
end $$;
