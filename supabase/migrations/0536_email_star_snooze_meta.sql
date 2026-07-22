-- 0536_email_star_snooze_meta.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · row metadata for the message list (Email review
-- EM#24/25/26/28)
--
--   is_starred       star/flag + the Starred virtual view
--   snoozed_until    hide from the folder until a time (Snoozed view)
--   from_name        sender display name ("Bob at Parts Warehouse",
--                    not ap@parts-warehouse-inc.com) — stamped by
--                    webhook-email-inbound going forward, backfilled
--                    from document_intake.sender_name where we have it
--   has_attachments  cheap paperclip indicator for list rows — stamped
--                    at insert, backfilled from document_intake
--                    (inbound captures) and the attachments jsonb
--                    (outbound composer sends)
--
-- All idempotent; the backfills are guarded so re-runs are no-ops.
-- The dashboard and webhook degrade gracefully without this migration
-- (tiered select fallback client-side; legacy-column insert retry in
-- the webhook).
-- ════════════════════════════════════════════════════════════════════

set search_path = public, pg_temp;

alter table public.email_messages
  add column if not exists is_starred boolean not null default false;
alter table public.email_messages
  add column if not exists snoozed_until timestamptz;
alter table public.email_messages
  add column if not exists from_name text;
alter table public.email_messages
  add column if not exists has_attachments boolean not null default false;

-- Paperclip backfill · inbound rows whose attachments were captured
-- into document_intake, plus outbound rows queued with files.
update public.email_messages m
   set has_attachments = true
 where m.has_attachments = false
   and (
     exists (select 1 from public.document_intake d
              where d.email_message_id = m.id)
     or (m.attachments is not null
         and jsonb_typeof(m.attachments) = 'array'
         and jsonb_array_length(m.attachments) > 0)
   );

-- Sender-name backfill · best effort from the intake capture, which
-- already extracted the display name for attachment provenance.
update public.email_messages m
   set from_name = d.sender_name
  from (
    select distinct on (email_message_id) email_message_id, sender_name
      from public.document_intake
     where sender_name is not null and email_message_id is not null
     order by email_message_id, created_at desc
  ) d
 where d.email_message_id = m.id
   and m.from_name is null;

-- Partial indexes · starred and snoozed sets stay tiny.
create index if not exists email_messages_starred_idx
  on public.email_messages(dsp_id)
  where is_starred = true;
create index if not exists email_messages_snoozed_idx
  on public.email_messages(dsp_id, snoozed_until)
  where snoozed_until is not null;
