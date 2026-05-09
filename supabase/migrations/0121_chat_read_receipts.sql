-- Read receipts visible to sender on driver chat.
--
-- Both halves of the chat (dispatch_chat_thread + driver_chat_list)
-- already returned 'last_read_at' for the calling side — useful for
-- coloring unread messages on the receiver's screen, but blind in the
-- other direction.  The sender (operator or driver) had no way to see
-- "your last message has been read."
--
-- Add a peer_last_read_at field to both responses:
--
--   • dispatch_chat_thread → peer_last_read_at = driver_last_read_at
--     so the dispatcher can render "Read" beside the most recent
--     dispatcher-sent message whose created_at <= peer_last_read_at.
--
--   • driver_chat_list → peer_last_read_at = dispatch_last_read_at
--     same logic, mirrored.
--
-- No schema change — both timestamps already live on
-- public.driver_conversations.  This migration is purely RPC shape
-- evolution.  Existing fields (last_read_at, messages, driver) are
-- preserved so older clients keep working.

create or replace function public.dispatch_chat_thread(p_driver_id uuid, p_limit int default 200)
returns jsonb
language plpgsql
stable
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
    'messages',          v_messages,
    'last_read_at',      v_conv.driver_last_read_at,
    'peer_last_read_at', v_conv.dispatch_last_read_at
  );
end;
$$;
grant execute on function public.driver_chat_list(text, int) to anon, authenticated;
