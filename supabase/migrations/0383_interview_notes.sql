-- ───────────────────────────────────────────────────────────────────────
-- 0383 · Interview notes
--
-- Free-text notes taken during the in-app embedded video interview, stored
-- per calendar event. Surfaced in the interview room's "Add Notes" panel.
-- cal_events already has tenant RLS, so DSP staff can read/write their own.
-- Idempotent.
-- ───────────────────────────────────────────────────────────────────────

alter table public.cal_events
  add column if not exists interview_notes text;
