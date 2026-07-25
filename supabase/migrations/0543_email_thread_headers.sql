-- 0543_email_thread_headers.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · send pipeline batch H (Email review EM#76)
--
--   smtp_message_id — the inbound message's RFC 5322 Message-ID,
--     captured by webhook-email-inbound (payload messageId/message_id
--     when it looks like an RFC id, else Resend's API message_id).
--   in_reply_to_id — the row a composed reply targets, stamped by the
--     composer. send-email resolves it to the original's
--     smtp_message_id and passes Resend In-Reply-To/References headers
--     so the VENDOR's mail client threads our reply instead of
--     starting a new conversation. Also the durable foundation for
--     client-side threading (EM#33's subject heuristic can retire).
--
-- Graceful pre-migration: the composer's writeRow drops the column on
-- the reported error, send-email's lookup errors → headerless send,
-- and the webhook retries its insert without the column. Nothing
-- changes until this is applied.
--
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════

set search_path = public, pg_temp;

alter table public.email_messages
  add column if not exists smtp_message_id text;
alter table public.email_messages
  add column if not exists in_reply_to_id uuid references public.email_messages(id) on delete set null;

create index if not exists email_messages_in_reply_to_idx
  on public.email_messages(in_reply_to_id)
  where in_reply_to_id is not null;

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0543_email_thread_headers.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
