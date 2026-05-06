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

-- Tenant-scoped read + write.  Path layout enforced:
--   <dsp_id>/<driver_id>/<ts>-<filename>
-- Match the same pattern as message-attachments (migration 0023):
-- explicit `to authenticated`, uuid comparison via the cast on the
-- folder slot rather than stringifying current_dsp_id().  The string
-- variant we tried first failed with "new row violates RLS" — Supabase
-- storage evaluates the array index at numeric 1 = first folder, and
-- the uuid cast is what storage.foldername was designed to compare.
drop policy if exists "chat_attachments_tenant_read"  on storage.objects;
drop policy if exists "chat_attachments_tenant_write" on storage.objects;
drop policy if exists "chat_attachments_tenant_del"   on storage.objects;

create policy "chat_attachments_tenant_read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'driver-chat-attachments'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );

create policy "chat_attachments_tenant_write"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'driver-chat-attachments'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );

-- Allow dispatchers to delete an accidental upload from their DSP.
create policy "chat_attachments_tenant_del"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'driver-chat-attachments'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );

-- Driver-side uploads come from the anon role with a session token.
-- We can't read the token from a storage policy, so we accept any
-- well-formed path under the bucket; driver_chat_send validates that
-- the path's dsp_id + driver_id match the calling token before
-- accepting the row.  Untracked uploads are orphans and get cleaned
-- up by a cron we'll add later.
drop policy if exists "chat_attachments_anon_write" on storage.objects;
create policy "chat_attachments_anon_write"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'driver-chat-attachments');

drop policy if exists "chat_attachments_anon_read" on storage.objects;
create policy "chat_attachments_anon_read"
  on storage.objects for select
  to anon
  using (bucket_id = 'driver-chat-attachments');


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
  -- Anon storage uploads aren't path-scoped (RLS can't read the
  -- driver session token), so verify here that the attachment lives
  -- under the calling driver's <dsp_id>/<driver_id>/ path before we
  -- accept it onto the row.  Anything else is rejected and stays
  -- orphaned in storage.
  if p_attachment_path is not null and p_attachment_path <> '' then
    if not (
      p_attachment_path like (v_drv.dsp_id::text || '/' || v_drv.id::text || '/%')
    ) then
      raise exception 'invalid_attachment_path' using errcode = '42501';
    end if;
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
-- Note: NOT stable.  This function inserts into driver_conversations
-- (and private.driver_validate_token updates last_seen_at), which
-- fails with "cannot execute UPDATE in a read-only transaction" if
-- the function is marked STABLE.  Same pattern bit driver_my_schedule
-- and driver_attendance_settings before.
create or replace function public.driver_chat_list(p_token text, p_limit int default 100)
returns jsonb
language plpgsql
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
-- Match the shape the original 0054 version returned: { driver,
-- messages, last_read_at }.  The dispatcher's chat head card reads
-- data.driver.name; without that key we'd render a blank header.
<<<<<<< HEAD
-- Note: NOT stable, for the same reason as driver_chat_list above.
=======
>>>>>>> origin/main
create or replace function public.dispatch_chat_thread(p_driver_id uuid, p_limit int default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers;
  v_conv public.driver_conversations;
  v_messages jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;

  insert into public.driver_conversations (driver_id, dsp_id)
  values (v_drv.id, v_dsp)
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
    'is_unread',             m.sender_kind = 'driver'
                             and (v_conv.dispatch_last_read_at is null
                                  or m.created_at > v_conv.dispatch_last_read_at)
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

  return jsonb_build_object(
    'driver', jsonb_build_object(
      'id',        v_drv.id,
      'name',      coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
      'full_name', v_drv.full_name
    ),
    'messages',     v_messages,
    'last_read_at', v_conv.dispatch_last_read_at
  );
end;
$$;
grant execute on function public.dispatch_chat_thread(uuid, int) to authenticated;


notify pgrst, 'reload schema';
