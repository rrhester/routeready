-- 0317_fleet_bridge_email.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · DSP email system foundation
--
-- Tables are prefixed fb_* because public.email_messages already
-- exists (legacy transactional-email log used by booking / screening
-- migrations). All four are RLS-scoped via private.current_dsp_id():
--
--   public.fb_folders     · system + custom folders per DSP
--   public.fb_messages    · inbound + outbound messages
--   public.fb_attachments · file refs (storage paths)
--   public.fb_settings    · linked Gmail + Fleet Bridge slug
--
-- Storage:
--   fleet-bridge-attachments  · private bucket, DSP-scoped by path
--
-- Realtime:
--   fb_messages + fb_folders join the supabase_realtime publication
--   so the dashboard can subscribe for live inbox updates.
--
-- The migration is fully idempotent (drop if exists / create if not
-- exists / exception-wrapped trigger creation), so it can be re-run
-- safely after a partial apply.
-- ════════════════════════════════════════════════════════════════════

set search_path = public, pg_temp;


-- ─── One-time cleanup ────────────────────────────────────────────
-- A previous run of this migration created public.email_folders
-- before the public.email_messages collision halted execution. That
-- table is brand-new and never carried data, so we drop it here.
-- Idempotent: no-op on a fresh apply where it never existed.
drop table if exists public.email_folders cascade;


-- ─── fb_folders ──────────────────────────────────────────────────
create table if not exists public.fb_folders (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  name        text not null,
  kind        text not null default 'custom'
                check (kind in ('inbox','drafts','sent','archive','trash','custom')),
  position    int not null default 100,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists fb_folders_dsp_idx on public.fb_folders(dsp_id);
create unique index if not exists fb_folders_system_uniq
  on public.fb_folders(dsp_id, kind) where kind <> 'custom';
create unique index if not exists fb_folders_name_uniq
  on public.fb_folders(dsp_id, lower(name));

alter table public.fb_folders enable row level security;
drop policy if exists fb_folders_select on public.fb_folders;
create policy fb_folders_select on public.fb_folders for select
  using (dsp_id = private.current_dsp_id());
drop policy if exists fb_folders_insert on public.fb_folders;
create policy fb_folders_insert on public.fb_folders for insert
  with check (dsp_id = private.current_dsp_id());
drop policy if exists fb_folders_update on public.fb_folders;
create policy fb_folders_update on public.fb_folders for update
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
drop policy if exists fb_folders_delete on public.fb_folders;
create policy fb_folders_delete on public.fb_folders for delete
  using (dsp_id = private.current_dsp_id() and kind = 'custom');


-- ─── fb_messages ─────────────────────────────────────────────────
create table if not exists public.fb_messages (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  folder_id     uuid references public.fb_folders(id) on delete set null,
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
create index if not exists fb_messages_dsp_idx       on public.fb_messages(dsp_id);
create index if not exists fb_messages_folder_idx    on public.fb_messages(folder_id);
create index if not exists fb_messages_received_idx  on public.fb_messages(dsp_id, received_at desc);
create index if not exists fb_messages_thread_idx    on public.fb_messages(dsp_id, thread_id);
create unique index if not exists fb_messages_msgid_uniq
  on public.fb_messages(dsp_id, message_id) where message_id is not null;

alter table public.fb_messages enable row level security;
drop policy if exists fb_messages_select on public.fb_messages;
create policy fb_messages_select on public.fb_messages for select
  using (dsp_id = private.current_dsp_id());
drop policy if exists fb_messages_insert on public.fb_messages;
create policy fb_messages_insert on public.fb_messages for insert
  with check (dsp_id = private.current_dsp_id());
drop policy if exists fb_messages_update on public.fb_messages;
create policy fb_messages_update on public.fb_messages for update
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
drop policy if exists fb_messages_delete on public.fb_messages;
create policy fb_messages_delete on public.fb_messages for delete
  using (dsp_id = private.current_dsp_id());


-- ─── fb_attachments ──────────────────────────────────────────────
create table if not exists public.fb_attachments (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references public.fb_messages(id) on delete cascade,
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  filename     text not null,
  mime_type    text,
  size_bytes   bigint,
  storage_path text not null,   -- inside fleet-bridge-attachments bucket
  created_at   timestamptz not null default now()
);
create index if not exists fb_attachments_message_idx on public.fb_attachments(message_id);
create index if not exists fb_attachments_dsp_idx     on public.fb_attachments(dsp_id);

alter table public.fb_attachments enable row level security;
drop policy if exists fb_attachments_select on public.fb_attachments;
create policy fb_attachments_select on public.fb_attachments for select
  using (dsp_id = private.current_dsp_id());
drop policy if exists fb_attachments_insert on public.fb_attachments;
create policy fb_attachments_insert on public.fb_attachments for insert
  with check (dsp_id = private.current_dsp_id());
drop policy if exists fb_attachments_delete on public.fb_attachments;
create policy fb_attachments_delete on public.fb_attachments for delete
  using (dsp_id = private.current_dsp_id());


-- ─── fb_settings ─────────────────────────────────────────────────
create table if not exists public.fb_settings (
  dsp_id         uuid primary key references public.dsps(id) on delete cascade,
  slug           text,           -- local-part of <slug>@routeready.com
  linked_gmail   text,           -- forwarding target
  inbound_secret text,           -- SendGrid inbound-parse webhook secret
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.fb_settings enable row level security;
drop policy if exists fb_settings_select on public.fb_settings;
create policy fb_settings_select on public.fb_settings for select
  using (dsp_id = private.current_dsp_id());
drop policy if exists fb_settings_insert on public.fb_settings;
create policy fb_settings_insert on public.fb_settings for insert
  with check (dsp_id = private.current_dsp_id());
drop policy if exists fb_settings_update on public.fb_settings;
create policy fb_settings_update on public.fb_settings for update
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
  create trigger trg_fb_folders_touch  before update on public.fb_folders
    for each row execute function public.fb_touch_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger trg_fb_messages_touch before update on public.fb_messages
    for each row execute function public.fb_touch_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger trg_fb_settings_touch before update on public.fb_settings
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
  insert into public.fb_folders(dsp_id, name, kind, position) values
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

-- DSP-scoped storage policies. Objects must live under '<dsp_id>/...'
-- so the policy can derive the owning DSP from the first path segment.
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
  alter publication supabase_realtime add table public.fb_messages;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.fb_folders;
exception when duplicate_object then null; end $$;
