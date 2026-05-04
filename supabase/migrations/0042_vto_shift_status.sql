-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0042 · VTO (Voluntary Time Off) shift status
--
-- Adds 'vto' to the shift_status enum. Today's check-in will offer it as
-- a fifth status next to Present / Late / Callout / No-show. VTO doesn't
-- count against attendance points — it's the operator letting a driver
-- skip a shift willingly when route count is below plan.
-- ─────────────────────────────────────────────────────────────────────────

alter type public.shift_status add value if not exists 'vto';
