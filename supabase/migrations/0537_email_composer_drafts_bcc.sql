-- 0537_email_composer_drafts_bcc.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · composer batch E1 (Email review EM#44/46)
--
--   1. bcc_emails — the composer's Bcc field (EM#44). Same text[]
--      shape as cc_emails (0319). send-email passes it to Resend.
--   2. 'draft' on public.message_status — real drafts (EM#46): the
--      composer autosaves rows with status='draft' into the Drafts
--      system folder; Send promotes the SAME row to 'queued'. The
--      send-email drain only ever selects status='queued', so drafts
--      can never ship by accident.
--
-- The dashboard degrades gracefully without this migration: Bcc sends
-- fail with a clear "needs migration 0537" message (recipients are
-- never silently dropped), and drafts fall back to the legacy
-- localStorage slot.
--
-- Idempotent: add column if not exists / add value if not exists.
-- ════════════════════════════════════════════════════════════════════

set search_path = public, pg_temp;

alter table public.email_messages
  add column if not exists bcc_emails text[];

alter type public.message_status add value if not exists 'draft';
