-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0072 · Driver ↔ dispatch chat attachments
--
-- Drivers and dispatchers can attach photos and documents to chat
-- messages.  Use cases the operator called out:
--   - Driver snaps a photo of vehicle damage from the road.
--   - Dispatcher sends a route map / scorecard PDF.
--   - Driver attaches a doctor's note to a callout.
--
-- Schema additions (driver_messages):
--   attachment_path        text — storage path inside driver-chat-attachments
--   attachment_mime        text — MIME for the in-bubble preview
--   attachment_name        text — original filename for the file pill
--   attachment_size_bytes  int  — for the file-size suffix
--
-- The body NOT-NULL/length check is loosened so a message can be
-- attachment-only (no caption).  At least one of body or attachment
-- must be present — enforced by a CHECK constraint.
--
-- New bucket `driver-chat-attachments` is private; reads are RLS-
-- gated to the matching DSP for dispatchers and to the matching
-- driver for token-scoped access.  Driver-side reads use a signed
-- URL minted by the existing edge function pattern; dispatcher-side
-- reads use the standard authenticated-storage policy.
-- ─────────────────────────────────────────────────────────────────────────


alter table public.driver_messages
  add column if not exists attachment_path        text,
  add column if not exists attachment_mime        text,
  add column if not exists attachment_name        text,
  add column if not exists attachment_size_bytes  int;

-- Drop the old "body must be non-empty" check and replace with one
-- that allows attachment-only messages.  Old rows that have a body
-- continue to satisfy the new constraint.
do $$ begin
  if exists (
    select 1 from information_schema.table_constraints
     where table_schema = 'public'
       and table_name   = 'driver_messages'
       and constraint_type = 'CHECK'
  ) then
    -- Best-effort drop — different deployments may have named the
    -- check differently; we re-create explicitly below.
    null;
  end if;
end $$;

alter table public.driver_messages
  drop constraint if exists driver_messages_body_check;
alter table public.driver_messages
  alter column body drop not null;
alter table public.driver_messages
  add constraint driver_messages_body_or_attachment_chk
  check (
    (body is not null and length(trim(body)) > 0 and length(body) <= 2000)
    or attachment_path is not null
  );


-- ── Storage bucket (private; dispatchers + drivers via signed URL) ──
insert into storage.buckets (id, name, public)
values ('driver-chat-attachments', 'driver-chat-attachments', false)
on conflict (id) do nothing;

-- Dispatchers (auth.uid() bound to a DSP) can read every attachment
-- in their tenant's path tree.  Path layout: <dsp_id>/<driver_id>/<msg_id>-<filename>.
drop policy if exists "chat_attachments_tenant_read" on storage.objects;
create policy "chat_attachments_tenant_read"
  on storage.objects for select
  using (
    bucket_id = 'driver-chat-attachments'
    and (storage.foldername(name))[1] = private.current_dsp_id()::text
  );

-- Dispatchers can upload to their tenant's path tree.  (Drivers
-- upload via an edge function with the service role, same pattern
-- as driver-photos, so no driver-side RLS needed here.)
drop policy if exists "chat_attachments_tenant_write" on storage.objects;
create policy "chat_attachments_tenant_write"
  on storage.objects for insert
  with check (
    bucket_id = 'driver-chat-attachments'
    and (storage.foldername(name))[1] = private.current_dsp_id()::text
  );


-- ── driver_chat_send · accept attachment params ──
drop function if exists public.driver_chat_send(text, text);

create or replace function public.driver_chat_send(
  p_token text,
  p_body  text,
  p_attachment_path       text default null,
  p_attachment_mime       text default null,
  p_attachment_name       text default null,
  p_attachment_size_bytes int  default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_body text := nullif(trim(coalesce(p_body, '')), '');
  v_msg public.driver_messages;
begin
  v_drv := private.driver_validate_token(p_token);
  if v_body is null and p_attachment_path is null then
    raise exception 'empty_message' using errcode = 'P0001';
  end if;
  if v_body is not null and length(v_body) > 2000 then
    raise exception 'too_long' using errcode = 'P0001';
  end if;

  insert into public.driver_messages
    (driver_id, dsp_id, sender_kind, body,
     attachment_path, attachment_mime, attachment_name, attachment_size_bytes)
  values
    (v_drv.id, v_drv.dsp_id, 'driver', v_body,
     nullif(p_attachment_path, ''), nullif(p_attachment_mime, ''),
     nullif(p_attachment_name, ''), p_attachment_size_bytes)
  returning * into v_msg;

  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (v_drv.id, v_drv.dsp_id, v_msg.created_at)
  on conflict (driver_id) do update
    set last_message_at = excluded.last_message_at;

  return jsonb_build_object(
    'id',                    v_msg.id,
    'sender_kind',           v_msg.sender_kind,
    'body',                  v_msg.body,
    'attachment_path',       v_msg.attachment_path,
    'attachment_mime',       v_msg.attachment_mime,
    'attachment_name',       v_msg.attachment_name,
    'attachment_size_bytes', v_msg.attachment_size_bytes,
    'created_at',            v_msg.created_at
  );
end;
$$;
grant execute on function public.driver_chat_send(text, text, text, text, text, int) to anon, authenticated;


-- ── dispatch_chat_send · accept attachment params ──
drop function if exists public.dispatch_chat_send(uuid, text);

create or replace function public.dispatch_chat_send(
  p_driver_id uuid,
  p_body      text,
  p_attachment_path       text default null,
  p_attachment_mime       text default null,
  p_attachment_name       text default null,
  p_attachment_size_bytes int  default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers;
  v_body text := nullif(trim(coalesce(p_body, '')), '');
  v_msg public.driver_messages;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_body is null and p_attachment_path is null then
    raise exception 'empty_message' using errcode = 'P0001';
  end if;
  if v_body is not null and length(v_body) > 2000 then
    raise exception 'too_long' using errcode = 'P0001';
  end if;

  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then raise exception 'driver_not_found' using errcode = 'P0002'; end if;

  insert into public.driver_messages
    (driver_id, dsp_id, sender_kind, sender_user_id, body,
     attachment_path, attachment_mime, attachment_name, attachment_size_bytes)
  values
    (p_driver_id, v_dsp, 'dispatch', auth.uid(), v_body,
     nullif(p_attachment_path, ''), nullif(p_attachment_mime, ''),
     nullif(p_attachment_name, ''), p_attachment_size_bytes)
  returning * into v_msg;

  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (p_driver_id, v_dsp, v_msg.created_at)
  on conflict (driver_id) do update
    set last_message_at = excluded.last_message_at;

  return jsonb_build_object(
    'id',                    v_msg.id,
    'sender_kind',           v_msg.sender_kind,
    'body',                  v_msg.body,
    'attachment_path',       v_msg.attachment_path,
    'attachment_mime',       v_msg.attachment_mime,
    'attachment_name',       v_msg.attachment_name,
    'attachment_size_bytes', v_msg.attachment_size_bytes,
    'created_at',            v_msg.created_at
  );
end;
$$;
grant execute on function public.dispatch_chat_send(uuid, text, text, text, text, int) to authenticated;


-- ── driver_chat_list · also return attachment fields ──
create or replace function public.driver_chat_list(p_token text, p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_conv public.driver_conversations;
  v_messages jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  insert into public.driver_conversations (driver_id, dsp_id)
  values (v_drv.id, v_drv.dsp_id)
  on conflict (driver_id) do nothing;

  select * into v_conv from public.driver_conversations where driver_id = v_drv.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',                    m.id,
    'sender_kind',           m.sender_kind,
    'body',                  m.body,
    'attachment_path',       m.attachment_path,
    'attachment_mime',       m.attachment_mime,
    'attachment_name',       m.attachment_name,
    'attachment_size_bytes', m.attachment_size_bytes,
    'created_at',            m.created_at,
    'is_unread',             m.sender_kind = 'dispatch'
                             and (v_conv.driver_last_read_at is null
                                  or m.created_at > v_conv.driver_last_read_at)
  ) order by m.created_at), '[]'::jsonb)
  into v_messages
  from (
    select id, sender_kind, body, attachment_path, attachment_mime,
           attachment_name, attachment_size_bytes, created_at
      from public.driver_messages
     where driver_id = v_drv.id
     order by created_at desc
     limit greatest(1, least(500, coalesce(p_limit, 100)))
  ) m;

  return jsonb_build_object(
    'messages',     v_messages,
    'last_read_at', v_conv.driver_last_read_at
  );
end;
$$;
grant execute on function public.driver_chat_list(text, int) to anon, authenticated;


-- ── dispatch_chat_thread · also return attachment fields ──
create or replace function public.dispatch_chat_thread(p_driver_id uuid, p_limit int default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_messages jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',                    m.id,
    'sender_kind',           m.sender_kind,
    'body',                  m.body,
    'attachment_path',       m.attachment_path,
    'attachment_mime',       m.attachment_mime,
    'attachment_name',       m.attachment_name,
    'attachment_size_bytes', m.attachment_size_bytes,
    'created_at',            m.created_at
  ) order by m.created_at), '[]'::jsonb)
  into v_messages
  from (
    select id, sender_kind, body, attachment_path, attachment_mime,
           attachment_name, attachment_size_bytes, created_at
      from public.driver_messages
     where driver_id = p_driver_id and dsp_id = v_dsp
     order by created_at desc
     limit greatest(1, least(1000, coalesce(p_limit, 200)))
  ) m;

  return jsonb_build_object('messages', v_messages);
end;
$$;
grant execute on function public.dispatch_chat_thread(uuid, int) to authenticated;


notify pgrst, 'reload schema';
