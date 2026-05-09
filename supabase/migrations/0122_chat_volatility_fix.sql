-- Hotfix · Restore volatility on dispatch_chat_thread.
--
-- 0121 unintentionally re-introduced STABLE on dispatch_chat_thread.
-- The function lazily upserts driver_conversations on first read, and
-- Postgres rejects INSERT in a non-volatile function with:
--   "INSERT is not allowed in a non-volatile function"
-- which surfaces in the dashboard the moment a dispatcher opens a
-- thread.  This is the same regression 0055 originally fixed.
--
-- Drop STABLE.  Keep all of 0121's fields (peer_last_read_at +
-- attachment columns) intact.

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
    'messages',          v_messages,
    'last_read_at',      v_conv.dispatch_last_read_at,
    'peer_last_read_at', v_conv.driver_last_read_at
  );
end;
$$;
grant execute on function public.dispatch_chat_thread(uuid, int) to authenticated;

notify pgrst, 'reload schema';
