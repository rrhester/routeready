-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0035 · Attendance — add 'late' shift status
--
-- Today's check-in lets the operator mark each driver as Present, Late,
-- Callout, or No-show. The shift_status enum had every value except
-- 'late' — adding it now so check-in clicks can write directly to the
-- shifts row without overflow into a separate attendance_events table.
-- ─────────────────────────────────────────────────────────────────────────

alter type public.shift_status add value if not exists 'late';
