-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0055 · Fix chat function volatility
--
-- 0054 marked driver_chat_list and dispatch_chat_thread as STABLE, but both
-- lazily upsert the driver_conversations row on first read so the dispatcher
-- sidebar / driver app don't have to seed it explicitly. Postgres rejects
-- INSERT inside a non-volatile function with:
--   "INSERT is not allowed in a non-volatile function"
-- which surfaces in the dashboard the moment a dispatcher opens a thread.
--
-- Drop STABLE so both default to VOLATILE. dispatch_chat_threads (the side
-- list) stays stable — it only reads.
-- ─────────────────────────────────────────────────────────────────────────


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
    'id',          m.id,
    'sender_kind', m.sender_kind,
    'body',        m.body,
    'created_at',  m.created_at,
    'is_unread',   m.sender_kind = 'dispatch'
                   and (v_conv.driver_last_read_at is null
                        or m.created_at > v_conv.driver_last_read_at)
  ) order by m.created_at), '[]'::jsonb)
  into v_messages
  from (
    select id, sender_kind, body, created_at
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


create or replace function public.dispatch_chat_thread(p_driver_id uuid, p_limit int default 100)
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
    'id',          m.id,
    'sender_kind', m.sender_kind,
    'body',        m.body,
    'created_at',  m.created_at,
    'is_unread',   m.sender_kind = 'driver'
                   and (v_conv.dispatch_last_read_at is null
                        or m.created_at > v_conv.dispatch_last_read_at)
  ) order by m.created_at), '[]'::jsonb) into v_messages
  from (
    select id, sender_kind, body, created_at
      from public.driver_messages
     where driver_id = p_driver_id
     order by created_at desc
     limit greatest(1, least(500, coalesce(p_limit, 100)))
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
