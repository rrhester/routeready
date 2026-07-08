-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0444 · Remove the checklist flag-resolution queue + analytics
--
-- Reverts migrations 0441 (flag resolution) and 0442 (compliance analytics)
-- — the ⚑ Flags queue and 📊 Insights dashboard were pulled from the UI, so
-- their backend objects are dropped too.
--
-- KEPT (unchanged): checklist_answers.failed_flag (the flag itself),
-- checklist_submissions.failed_count, the realtime flag-alert toast, and the
-- ⚑ markers in the Responses tab. Only the *resolution* state + the flags/
-- analytics RPCs go away.
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ── RPCs (0441 flag resolution + 0442 analytics) ──────────────────────
drop function if exists public.checklist_flags_open_count();
drop function if exists public.checklist_flags_list(boolean, int, int);
drop function if exists public.checklist_flag_resolve(uuid, text, text);
drop function if exists public.checklist_flag_reopen(uuid);
drop function if exists public.checklist_analytics(int);

-- ── Resolution index + columns (0441) ────────────────────────────────
drop index if exists public.clf_answers_open_flags_idx;

alter table public.checklist_answers drop column if exists flag_resolved_at;
alter table public.checklist_answers drop column if exists flag_resolved_by;
alter table public.checklist_answers drop column if exists flag_disposition;
alter table public.checklist_answers drop column if exists flag_note;

notify pgrst, 'reload schema';
