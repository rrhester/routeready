-- 0317_fleet_bridge_email.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · DSP email system foundation
--
-- Tables (all RLS-scoped via private.current_dsp_id()):
--   public.email_folders        · system + custom folders per DSP
--   public.email_messages       · inbound + outbound messages
--   public.email_attachments    · file refs (storage paths)
--   public.email_settings       · linked Gmail + Fleet Bridge slug
--
-- Storage:
--   fleet-bridge-attachments    · private bucket, DSP-scoped by path
--
-- Realtime:
--   email_messages + email_folders join the supabase_realtime publication
--   so the dashboard can subscribe for live inbox updates.
--
-- This migration is intentionally idempotent (drop policy if exists,
-- create table if not exists, exception-wrapped trigger creation, etc.)
-- so it can be re-run safely after a partial apply.
-- ════════════════════════════════════════════════════════════════════

set search_path = public, pg_temp;


-- ─── email_folders ────────────────────────────────────────────────
create table if not exists public.email_folders (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  name        text not null,
  kind        text not null default 'custom'
                check (kind in ('inbox','drafts','sent','archive','trash','custom')),
  position    int not null default 100,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists email_folders_dsp_idx on public.email_folders(dsp_id);
-- one system folder per kind per DSP
create unique index if not exists email_folders_system_uniq
  on public.email_folders(dsp_id, kind)
  where kind <> 'custom';
-- unique folder name per DSP (case-insensitive)
create unique index if not exists email_folders_name_uniq
  on public.email_folders(dsp_id, lower(name));

alter table public.email_folders enable row level security;
drop policy if exists email_folders_select on public.email_folders;
create policy email_folders_select on public.email_folders for select
  using (dsp_id = private.current_dsp_id());
drop policy if exists email_folders_insert on public.email_folders;
create policy email_folders_insert on public.email_folders for insert
  with check (dsp_id = private.current_dsp_id());
drop policy if exists email_folders_update on public.email_folders;
create policy email_folders_update on public.email_folders for update
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
drop policy if exists email_folders_delete on public.email_folders;
create policy email_folders_delete on public.email_folders for delete
  using (dsp_id = private.current_dsp_id() and kind = 'custom');


-- ─── email_messages ───────────────────────────────────────────────
create table if not exists public.email_messages (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  folder_id     uuid references public.email_folders(id) on delete set null,
  direction     text not null check (direction in ('inbound','outbound')),
  message_id    text,        -- RFC 5322 Message-ID
  in_reply_to   text,        -- parent Message-ID
  thread_id     text,        -- normalized thread key
  from_email    text,
  from_name     text,
  to_emails     text[] not null default '{}',
  cc_emails     text[] not null default '{}',
  bcc_emails    text[] not null default '{}',
  subject       text,
  body_text     text,
  body_html     text,
  received_at   timestamptz, -- inbound timestamp
  sent_at       timestamptz, -- outbound timestamp
  is_read       boolean not null default false,
  raw_envelope  jsonb,       -- full webhook payload for debugging
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists email_messages_dsp_idx       on public.email_messages(dsp_id);
create index if not exists email_messages_folder_idx    on public.email_messages(folder_id);
create index if not exists email_messages_received_idx  on public.email_messages(dsp_id, received_at desc);
create index if not exists email_messages_thread_idx    on public.email_messages(dsp_id, thread_id);
create unique index if not exists email_messages_msgid_uniq
  on public.email_messages(dsp_id, message_id)
  where message_id is not null;

alter table public.email_messages enable row level security;
drop policy if exists email_messages_select on public.email_messages;
create policy email_messages_select on public.email_messages for select
  using (dsp_id = private.current_dsp_id());
drop policy if exists email_messages_insert on public.email_messages;
create policy email_messages_insert on public.email_messages for insert
  with check (dsp_id = private.current_dsp_id());
drop policy if exists email_messages_update on public.email_messages;
create policy email_messages_update on public.email_messages for update
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
drop policy if exists email_messages_delete on public.email_messages;
create policy email_messages_delete on public.email_messages for delete
  using (dsp_id = private.current_dsp_id());


-- ─── email_attachments ────────────────────────────────────────────
create table if not exists public.email_attachments (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references public.email_messages(id) on delete cascade,
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  filename     text not null,
  mime_type    text,
  size_bytes   bigint,
  storage_path text not null,   -- inside fleet-bridge-attachments bucket
  created_at   timestamptz not null default now()
);
create index if not exists email_attachments_message_idx on public.email_attachments(message_id);
create index if not exists email_attachments_dsp_idx     on public.email_attachments(dsp_id);

alter table public.email_attachments enable row level security;
drop policy if exists email_attachments_select on public.email_attachments;
create policy email_attachments_select on public.email_attachments for select
  using (dsp_id = private.current_dsp_id());
drop policy if exists email_attachments_insert on public.email_attachments;
create policy email_attachments_insert on public.email_attachments for insert
  with check (dsp_id = private.current_dsp_id());
drop policy if exists email_attachments_delete on public.email_attachments;
create policy email_attachments_delete on public.email_attachments for delete
  using (dsp_id = private.current_dsp_id());


-- ─── email_settings ───────────────────────────────────────────────
-- One row per DSP. inbound_secret holds the SendGrid webhook auth
-- secret; it's intentionally readable by DSP members so the dashboard
-- can show "verified" state, but never exposed in the UI form.
create table if not exists public.email_settings (
  dsp_id         uuid primary key references public.dsps(id) on delete cascade,
  slug           text,           -- local-part of <slug>@routeready.com
  linked_gmail   text,           -- forwarding target
  inbound_secret text,           -- SendGrid inbound-parse webhook secret
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.email_settings enable row level security;
drop policy if exists email_settings_select on public.email_settings;
create policy email_settings_select on public.email_settings for select
  using (dsp_id = private.current_dsp_id());
drop policy if exists email_settings_insert on public.email_settings;
create policy email_settings_insert on public.email_settings for insert
  with check (dsp_id = private.current_dsp_id());
drop policy if exists email_settings_update on public.email_settings;
create policy email_settings_update on public.email_settings for update
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());


-- ─── updated_at trigger helper ───────────────────────────────────
create or replace function public.fb_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$ begin
  create trigger trg_email_folders_touch  before update on public.email_folders
    for each row execute function public.fb_touch_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger trg_email_messages_touch before update on public.email_messages
    for each row execute function public.fb_touch_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger trg_email_settings_touch before update on public.email_settings
    for each row execute function public.fb_touch_updated_at();
exception when duplicate_object then null; end $$;


-- ─── Seed system folders (idempotent) ────────────────────────────
create or replace function public.fleet_bridge_ensure_folders()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then return; end if;
  insert into public.email_folders(dsp_id, name, kind, position) values
    (v_dsp, 'Inbox',   'inbox',   1),
    (v_dsp, 'Drafts',  'drafts',  2),
    (v_dsp, 'Sent',    'sent',    3),
    (v_dsp, 'Archive', 'archive', 4),
    (v_dsp, 'Trash',   'trash',   5)
  on conflict do nothing;
end $$;
grant execute on function public.fleet_bridge_ensure_folders() to authenticated;


-- ─── Storage bucket for attachments ──────────────────────────────
insert into storage.buckets (id, name, public)
values ('fleet-bridge-attachments', 'fleet-bridge-attachments', false)
on conflict (id) do nothing;

-- Tenant-staff scoped storage policies on this bucket. Objects must
-- live under the path '<dsp_id>/...' so the policy can derive the
-- owning DSP from the first folder segment.
drop policy if exists fb_attachments_select on storage.objects;
create policy fb_attachments_select on storage.objects for select to authenticated using (
  bucket_id = 'fleet-bridge-attachments'
  and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
);
drop policy if exists fb_attachments_insert on storage.objects;
create policy fb_attachments_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'fleet-bridge-attachments'
  and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
);
drop policy if exists fb_attachments_delete on storage.objects;
create policy fb_attachments_delete on storage.objects for delete to authenticated using (
  bucket_id = 'fleet-bridge-attachments'
  and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
);


-- ─── Realtime · so the dashboard can subscribe to live updates ──
do $$ begin
  alter publication supabase_realtime add table public.email_messages;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.email_folders;
exception when duplicate_object then null; end $$;
