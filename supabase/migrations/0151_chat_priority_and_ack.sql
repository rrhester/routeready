-- Migration 0151 · Chat: message priority + acknowledgement-required
--
-- The biggest "this is an ops tool" move for the driver↔dispatch chat:
--   • priority: normal / high / urgent — urgent reads with a red accent
--     bar in the thread on both ends.
--   • requires_ack: when set on a dispatch-sent message, the driver sees
--     an Acknowledge button in the bubble; tapping calls driver_ack_message
--     which stamps acked_at = now() so dispatch can see who's acknowledged.
--
-- All defaults preserve current behavior (normal priority, no ack) so
-- existing chat flow is unchanged. Drivers can't send priority/ack
-- messages — those are operator-initiated directives. Realtime
-- (driver_messages already in supabase_realtime publication) carries the
-- INSERT for new urgent messages and the UPDATE on acked_at, so both
-- ends refresh without polling.

create type public.message_priority as enum ('normal', 'high', 'urgent');

alter table public.driver_messages
  add column if not exists priority     public.message_priority not null default 'normal',
  add column if not exists requires_ack boolean                 not null default false,
  add column if not exists acked_at     timestamptz;

create index if not exists driver_messages_pending_ack_idx
  on public.driver_messages (driver_id) where requires_ack and acked_at is null;


-- ── dispatch_chat_send · accept priority + requires_ack ──
drop function if exists public.dispatch_chat_send(uuid, text, text, text, text, int);

create or replace function public.dispatch_chat_send(
  p_driver_id             uuid,
  p_body                  text,
  p_attachment_path       text    default null,
  p_attachment_mime       text    default null,
  p_attachment_name       text    default null,
  p_attachment_size_bytes int     default null,
  p_priority              text    default 'normal',
  p_requires_ack          boolean default false
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
  v_pri public.message_priority := case lower(coalesce(p_priority, 'normal'))
    when 'urgent' then 'urgent'::public.message_priority
    when 'high'   then 'high'::public.message_priority
    else 'normal'::public.message_priority
  end;
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
     attachment_path, attachment_mime, attachment_name, attachment_size_bytes,
     priority, requires_ack)
  values
    (p_driver_id, v_dsp, 'dispatch', auth.uid(), v_body,
     nullif(p_attachment_path, ''), nullif(p_attachment_mime, ''),
     nullif(p_attachment_name, ''), p_attachment_size_bytes,
     v_pri, coalesce(p_requires_ack, false))
  returning * into v_msg;

  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (p_driver_id, v_dsp, v_msg.created_at)
  on conflict (driver_id) do update set last_message_at = excluded.last_message_at;

  return jsonb_build_object(
    'id',                    v_msg.id,
    'sender_kind',           v_msg.sender_kind,
    'body',                  v_msg.body,
    'attachment_path',       v_msg.attachment_path,
    'attachment_mime',       v_msg.attachment_mime,
    'attachment_name',       v_msg.attachment_name,
    'attachment_size_bytes', v_msg.attachment_size_bytes,
    'priority',              v_msg.priority,
    'requires_ack',          v_msg.requires_ack,
    'acked_at',              v_msg.acked_at,
    'created_at',            v_msg.created_at
  );
end;
$$;
grant execute on function public.dispatch_chat_send(uuid, text, text, text, text, int, text, boolean) to authenticated;


-- ── driver_ack_message · stamp acked_at when the driver taps Acknowledge ──
create or replace function public.driver_ack_message(p_token text, p_message_id uuid)
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
  if v_msg.sender_kind <> 'dispatch' then raise exception 'cannot_ack_own_message' using errcode = 'P0001'; end if;
  if not v_msg.requires_ack then raise exception 'ack_not_required' using errcode = 'P0001'; end if;
  if v_msg.acked_at is not null then
    return jsonb_build_object('id', v_msg.id, 'acked_at', v_msg.acked_at, 'already_acked', true);
  end if;
  update public.driver_messages set acked_at = now() where id = p_message_id returning * into v_msg;
  return jsonb_build_object('id', v_msg.id, 'acked_at', v_msg.acked_at);
end;
$$;
grant execute on function public.driver_ack_message(text, uuid) to anon, authenticated;


-- ── driver_chat_list · surface priority/requires_ack/acked_at ──
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
    'priority',              m.priority,
    'requires_ack',          m.requires_ack,
    'acked_at',              m.acked_at,
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
           priority, requires_ack, acked_at, created_at
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


-- ── dispatch_chat_thread · same fields for the operator side ──
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
    'priority',              m.priority,
    'requires_ack',          m.requires_ack,
    'acked_at',              m.acked_at,
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
           priority, requires_ack, acked_at, created_at
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

notify pgrst, 'reload schema';
