-- 0544_email_inbound_hardening.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · inbound pipeline & server hardening batch I
-- (Email review EM#79/81/82/84/86)
--
--   1. email_dead_letters (EM#79/81) — unmatched inbound mail (typo'd
--      team address) and rate-limited overflow stop vanishing without
--      trace. Service-role writes only; deliberately NO authenticated
--      policies (unknown-recipient rows have no tenant) — the platform
--      admin reads via SQL:
--        select date_trunc('day', created_at) d, reason, count(*)
--          from public.email_dead_letters group by 1, 2 order by 1 desc;
--   2. fb_folders 'junk' kind (EM#82) — webhook-email-inbound routes
--      mail that FAILS its sender-auth verdict (spf/dkim/dmarc fail,
--      explicit spam flag/score) to a per-DSP Junk system folder it
--      creates on first use.
--   3. email_messages client-write tightening (EM#84) — UPDATE drops
--      to a column allowlist (the columns the dashboard actually
--      writes; provider/provider_message_id/smtp_message_id/sent_at/
--      delivered_at/error_* become server-only), and the staff
--      insert/update policies verify folder_id and in_reply_to_id
--      belong to the row's own DSP. NOTE for future client code: a new
--      client-written column must be added to the grant below or the
--      update 42501s.
--   4. Drops public.fb_settings (EM#86) — the last 0317-era dead table
--      (fb_messages/fb_attachments fell in 0318); slug lives on dsps,
--      inbound auth in edge-function secrets. Never adopted, no code
--      references.
--
-- Column re-asserts up top: the grant + policies reference the
-- 0535–0543 columns; re-adding keeps this applicable on a partial
-- chain (same guard pattern as 0541).
--
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════

set search_path = public, pg_temp;

alter table public.email_messages add column if not exists cc_emails text[];
alter table public.email_messages add column if not exists is_read boolean not null default false;
alter table public.email_messages add column if not exists is_starred boolean not null default false;
alter table public.email_messages add column if not exists snoozed_until timestamptz;
alter table public.email_messages add column if not exists from_name text;
alter table public.email_messages add column if not exists has_attachments boolean not null default false;
alter table public.email_messages add column if not exists bcc_emails text[];
alter table public.email_messages add column if not exists send_after timestamptz;
alter table public.email_messages add column if not exists importance text
  check (importance is null or importance in ('high'));
alter table public.email_messages add column if not exists smtp_message_id text;
alter table public.email_messages add column if not exists in_reply_to_id uuid
  references public.email_messages(id) on delete set null;

-- ─── 1 · email_dead_letters ──────────────────────────────────────
create table if not exists public.email_dead_letters (
  id           uuid primary key default gen_random_uuid(),
  reason       text not null check (reason in ('unknown_recipient','rate_limited','oversize','error')),
  dsp_id       uuid references public.dsps(id) on delete cascade,
  to_email     text,
  from_email   text,
  subject      text,
  body_excerpt text,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists email_dead_letters_created_idx
  on public.email_dead_letters(created_at desc);
alter table public.email_dead_letters enable row level security;
revoke all on public.email_dead_letters from authenticated, anon;

-- ─── 2 · Junk system-folder kind ─────────────────────────────────
alter table public.fb_folders drop constraint if exists fb_folders_kind_check;
alter table public.fb_folders add constraint fb_folders_kind_check
  check (kind in ('inbox','drafts','sent','archive','trash','custom','junk'));

-- ─── 3 · email_messages client-write tightening ──────────────────
-- Same-tenant row check without re-entering email_messages policies.
create or replace function private.email_row_dsp_ok(p_id uuid, p_dsp uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.email_messages m
     where m.id = p_id and m.dsp_id = p_dsp
  );
$$;

revoke update on public.email_messages from authenticated;
grant update (
  dsp_id, direction, folder_id, status,
  is_read, is_starred, snoozed_until,
  subject, body_text, body_html,
  to_email, cc_emails, bcc_emails,
  attachments, importance, send_after, in_reply_to_id,
  applicant_id, template_id, has_attachments
) on public.email_messages to authenticated;

drop policy if exists "email_messages_staff_insert" on public.email_messages;
create policy "email_messages_staff_insert"
  on public.email_messages for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher')
              and (folder_id is null or exists (
                    select 1 from public.fb_folders f
                     where f.id = folder_id and f.dsp_id = email_messages.dsp_id))
              and (in_reply_to_id is null
                   or private.email_row_dsp_ok(in_reply_to_id, email_messages.dsp_id)));

drop policy if exists "email_messages_staff_update" on public.email_messages;
create policy "email_messages_staff_update"
  on public.email_messages for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher')
              and (folder_id is null or exists (
                    select 1 from public.fb_folders f
                     where f.id = folder_id and f.dsp_id = email_messages.dsp_id))
              and (in_reply_to_id is null
                   or private.email_row_dsp_ok(in_reply_to_id, email_messages.dsp_id)));

-- ─── 4 · Retire fb_settings ──────────────────────────────────────
drop table if exists public.fb_settings cascade;

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0544_email_inbound_hardening.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
