-- 0538_email_send_after_importance.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · composer batch E2a (Email review EM#55/58)
--
--   1. send_after — schedule send (EM#58). The send-email drain skips
--      queued rows whose send_after is still in the future; the
--      1-minute cron picks them up once due. NULL = send now
--      (byte-identical to today).
--   2. importance — real priority headers (EM#55). 'high' makes
--      send-email attach X-Priority/Importance headers instead of the
--      old ❗-in-the-subject hack. NULL = normal.
--
-- Graceful pre-migration: a scheduled send FAILS with a clear
-- "needs migration 0538" message (never silently sends now), and the
-- importance flag falls back to the legacy subject prefix.
--
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════

set search_path = public, pg_temp;

alter table public.email_messages
  add column if not exists send_after timestamptz;

alter table public.email_messages
  add column if not exists importance text
    check (importance is null or importance in ('high'));

-- The drain scans queued rows oldest-first; scheduled rows sit queued
-- for a while, so give the scan a matching partial index.
create index if not exists email_messages_queued_idx
  on public.email_messages(created_at)
  where status = 'queued';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0538_email_send_after_importance.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
