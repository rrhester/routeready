-- 0535_email_read_state.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · server-side read state (Email review EM#13)
--
-- Read/unread previously lived ONLY in each browser's localStorage
-- (capped at 5000 ids): a second device showed everything unread, and
-- cap-eviction resurrected "unread" on old mail. is_read lives on the
-- row with team-inbox semantics — any operator reading a message marks
-- it handled for the whole DSP, like a shared mailbox.
--
-- One-shot add + backfill: existing rows start READ so the world starts
-- clean at migration time; only mail arriving afterwards shows as
-- unread. The one-shot guard makes re-runs safe — a re-run after new
-- mail arrived must NOT re-mark that mail read.
--
-- The dashboard degrades gracefully without this migration (localStorage
-- fallback; the first failed probe stops further is_read queries).
-- ════════════════════════════════════════════════════════════════════

set search_path = public, pg_temp;

do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'email_messages'
       and column_name  = 'is_read'
  ) then
    alter table public.email_messages
      add column is_read boolean not null default false;
    update public.email_messages set is_read = true;
  end if;
end $$;

-- Badge/dot probe: unread inbound per folder (and per DSP for the nav
-- indicator). Partial index keeps it tiny — read mail drops out.
create index if not exists email_messages_unread_idx
  on public.email_messages(dsp_id, folder_id)
  where is_read = false and direction = 'inbound';
