-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0390 · dispatch_chat_thread: expose is_auto (automated message)
--
-- Automated RouteReady messages (welcome, schedule notices, attendance
-- points, finalize, etc.) are inserted as sender_kind='dispatch' with a NULL
-- sender_user_id — the convention documented in migration 0266.  Human
-- dispatch replies carry auth.uid().  Surface an `is_auto` flag on each
-- message so the dashboard can tag automated messages with an "Auto" pill.
--
-- Purely additive (adds one field to the existing payload) + idempotent;
-- deploy-safe — older clients simply ignore the new field.
-- ─────────────────────────────────────────────────────────────────────────
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
    'is_auto',               (m.sender_kind = 'dispatch' and m.sender_user_id is null),
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
    select id, sender_kind, sender_user_id, body, edited_at, deleted_at,
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
