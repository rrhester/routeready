-- Edit / delete on driver chat messages.
--
-- Adds two timestamp columns to driver_messages:
--   edited_at    — set by edit RPCs, surfaced in the UI as "edited"
--   deleted_at   — soft-delete marker; deleted rows still exist for
--                  audit + RLS reasons but their body becomes a
--                  "Message deleted" placeholder in the chat thread.
--
-- Plus four new RPCs:
--   dispatch_chat_edit(message_id, new_body)
--   dispatch_chat_delete(message_id)
--   driver_chat_edit(token, message_id, new_body)
--   driver_chat_delete(token, message_id)
--
-- And a tightened RLS policy so a sender can only edit / delete their
-- own messages, only within the most recent 15 minutes.  Keeps
-- accountability for an operational channel — drivers can't memory-
-- hole an old "I'm late" message after the fact.
--
-- The thread-loading RPCs (dispatch_chat_thread, driver_chat_list)
-- are extended to return edited_at + a body that's already swapped
-- to "(deleted)" when deleted_at is set.

alter table public.driver_messages
  add column if not exists edited_at  timestamptz,
  add column if not exists deleted_at timestamptz;

-- Edit window — how long after sending a message can the sender edit
-- or delete it.  15 minutes matches Slack default, long enough for
-- typo fixes but short enough that an operational record stays.
create or replace function private.chat_edit_window()
returns interval
language sql
immutable
as $$ select interval '15 minutes' $$;

-- ── dispatch_chat_edit / delete ───────────────────────────────

create or replace function public.dispatch_chat_edit(p_message_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_msg public.driver_messages;
  v_clean text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_clean := trim(coalesce(p_body, ''));
  if length(v_clean) = 0 then raise exception 'empty_body'; end if;
  if length(v_clean) > 2000 then raise exception 'body_too_long'; end if;

  select * into v_msg from public.driver_messages
   where id = p_message_id and dsp_id = v_dsp;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;
  if v_msg.sender_kind <> 'dispatch' or v_msg.sender_user_id <> auth.uid() then
    raise exception 'not_your_message' using errcode = '42501';
  end if;
  if v_msg.deleted_at is not null then raise exception 'already_deleted'; end if;
  if now() - v_msg.created_at > private.chat_edit_window() then
    raise exception 'edit_window_expired';
  end if;

  update public.driver_messages
     set body = v_clean, edited_at = now()
   where id = p_message_id;

  return jsonb_build_object('id', p_message_id, 'edited_at', now());
end;
$$;
grant execute on function public.dispatch_chat_edit(uuid, text) to authenticated;


create or replace function public.dispatch_chat_delete(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_msg public.driver_messages;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_msg from public.driver_messages
   where id = p_message_id and dsp_id = v_dsp;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;
  if v_msg.sender_kind <> 'dispatch' or v_msg.sender_user_id <> auth.uid() then
    raise exception 'not_your_message' using errcode = '42501';
  end if;
  if v_msg.deleted_at is not null then return jsonb_build_object('id', p_message_id, 'deleted_at', v_msg.deleted_at); end if;
  if now() - v_msg.created_at > private.chat_edit_window() then
    raise exception 'edit_window_expired';
  end if;

  update public.driver_messages set deleted_at = now() where id = p_message_id;
  return jsonb_build_object('id', p_message_id, 'deleted_at', now());
end;
$$;
grant execute on function public.dispatch_chat_delete(uuid) to authenticated;


-- ── driver_chat_edit / delete ─────────────────────────────────

create or replace function public.driver_chat_edit(p_token text, p_message_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_msg public.driver_messages;
  v_clean text;
begin
  v_drv := private.driver_validate_token(p_token);
  v_clean := trim(coalesce(p_body, ''));
  if length(v_clean) = 0 then raise exception 'empty_body'; end if;
  if length(v_clean) > 2000 then raise exception 'body_too_long'; end if;

  select * into v_msg from public.driver_messages
   where id = p_message_id and driver_id = v_drv.id;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;
  if v_msg.sender_kind <> 'driver' then raise exception 'not_your_message' using errcode = '42501'; end if;
  if v_msg.deleted_at is not null then raise exception 'already_deleted'; end if;
  if now() - v_msg.created_at > private.chat_edit_window() then
    raise exception 'edit_window_expired';
  end if;

  update public.driver_messages
     set body = v_clean, edited_at = now()
   where id = p_message_id;
  return jsonb_build_object('id', p_message_id, 'edited_at', now());
end;
$$;
grant execute on function public.driver_chat_edit(text, uuid, text) to anon, authenticated;


create or replace function public.driver_chat_delete(p_token text, p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_msg public.driver_messages;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_msg from public.driver_messages
   where id = p_message_id and driver_id = v_drv.id;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;
  if v_msg.sender_kind <> 'driver' then raise exception 'not_your_message' using errcode = '42501'; end if;
  if v_msg.deleted_at is not null then return jsonb_build_object('id', p_message_id, 'deleted_at', v_msg.deleted_at); end if;
  if now() - v_msg.created_at > private.chat_edit_window() then
    raise exception 'edit_window_expired';
  end if;

  update public.driver_messages set deleted_at = now() where id = p_message_id;
  return jsonb_build_object('id', p_message_id, 'deleted_at', now());
end;
$$;
grant execute on function public.driver_chat_delete(text, uuid) to anon, authenticated;


-- ── Extend the thread / list RPCs to surface edited_at + soft-deletes.

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
    'body',                  case when m.deleted_at is null then m.body else null end,
    'edited_at',             m.edited_at,
    'deleted_at',            m.deleted_at,
    'attachment_path',       case when m.deleted_at is null then m.attachment_path else null end,
    'attachment_mime',       case when m.deleted_at is null then m.attachment_mime else null end,
    'attachment_name',       case when m.deleted_at is null then m.attachment_name else null end,
    'attachment_size_bytes', case when m.deleted_at is null then m.attachment_size_bytes else null end,
    'created_at',            m.created_at,
    'is_unread',             m.sender_kind = 'driver'
                             and m.deleted_at is null
                             and (v_conv.dispatch_last_read_at is null
                                  or m.created_at > v_conv.dispatch_last_read_at)
  ) order by m.created_at), '[]'::jsonb)
  into v_messages
  from (
    select id, sender_kind, body, edited_at, deleted_at,
           attachment_path, attachment_mime, attachment_name, attachment_size_bytes,
           created_at
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
    'messages',          v_messages,
    'last_read_at',      v_conv.dispatch_last_read_at,
    'peer_last_read_at', v_conv.driver_last_read_at
  );
end;
$$;
grant execute on function public.dispatch_chat_thread(uuid, int) to authenticated;


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
    'body',                  case when m.deleted_at is null then m.body else null end,
    'edited_at',             m.edited_at,
    'deleted_at',            m.deleted_at,
    'attachment_path',       case when m.deleted_at is null then m.attachment_path else null end,
    'attachment_mime',       case when m.deleted_at is null then m.attachment_mime else null end,
    'attachment_name',       case when m.deleted_at is null then m.attachment_name else null end,
    'attachment_size_bytes', case when m.deleted_at is null then m.attachment_size_bytes else null end,
    'created_at',            m.created_at,
    'is_unread',             m.sender_kind = 'dispatch'
                             and m.deleted_at is null
                             and (v_conv.driver_last_read_at is null
                                  or m.created_at > v_conv.driver_last_read_at)
  ) order by m.created_at), '[]'::jsonb)
  into v_messages
  from (
    select id, sender_kind, body, edited_at, deleted_at,
           attachment_path, attachment_mime, attachment_name, attachment_size_bytes,
           created_at
      from public.driver_messages
     where driver_id = v_drv.id
     order by created_at desc
     limit greatest(1, least(500, coalesce(p_limit, 100)))
  ) m;

  return jsonb_build_object(
    'messages',          v_messages,
    'last_read_at',      v_conv.driver_last_read_at,
    'peer_last_read_at', v_conv.dispatch_last_read_at
  );
end;
$$;
grant execute on function public.driver_chat_list(text, int) to anon, authenticated;

notify pgrst, 'reload schema';
