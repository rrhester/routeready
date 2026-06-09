-- ───────────────────────────────────────────────────────────────────────
-- 0384 · Interview scorecard
--
-- Structured evaluation (per-category star ratings + hiring recommendation)
-- captured in the in-app interview workspace, stored per calendar event next
-- to interview_notes. cal_events already has tenant RLS. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

alter table public.cal_events
  add column if not exists interview_scorecard jsonb;
