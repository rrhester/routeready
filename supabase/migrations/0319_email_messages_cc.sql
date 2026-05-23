-- 0319_email_messages_cc.sql
-- ════════════════════════════════════════════════════════════════════
-- Add cc_emails column to email_messages so the Fleet Bridge composer's
-- Cc field can carry through to Resend at send time. Multi-recipient
-- array column (text[]) matches the shape used by fb_messages and the
-- already-shipped to_emails/bcc_emails patterns elsewhere.
--
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════

alter table public.email_messages
  add column if not exists cc_emails text[];
