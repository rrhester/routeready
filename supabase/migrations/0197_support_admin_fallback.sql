-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0197 · Support RPCs: when an admin omits p_dsp_id, use theirs
--
-- 0196's RPCs took the admin branch the moment private.is_platform_admin()
-- returned true, which raised dsp_id_required for an admin opening their
-- *own* DSP-side Support thread (the inbox call passes no args). Now the
-- branch is determined by whether p_dsp_id was supplied:
--
--   * p_dsp_id set      → reading/writing that DSP's thread. Allowed for
--                         platform admins on any DSP; for everyone else
--                         only on their own.
--   * p_dsp_id omitted  → use the caller's current_dsp_id(). Works for
--                         both DSP dispatchers and admins who also belong
--                         to a DSP.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.support_thread(p_dsp_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp      uuid;
  v_is_admin boolean := private.is_platform_admin();
  v_conv     public.support_conversations;
  v_messages jsonb;
  v_dsp_name text;
  v_dsp_code text;
begin
  if p_dsp_id is not null then
    if not v_is_admin then
      if p_dsp_id <> private.current_dsp_id() or not private.is_staff(p_dsp_id, 'dispatcher') then
        raise exception 'forbidden' using errcode = '42501';
      end if;
    end if;
    v_dsp := p_dsp_id;
  else
    v_dsp := private.current_dsp_id();
    if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
    if not v_is_admin and not private.is_staff(v_dsp, 'dispatcher') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  insert into public.support_conversations (dsp_id) values (v_dsp) on conflict (dsp_id) do nothing;
  select * into v_conv from public.support_conversations where dsp_id = v_dsp;
  select name, short_code into v_dsp_name, v_dsp_code from public.dsps where id = v_dsp;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',          m.id,
    'sender_kind', m.sender_kind,
    'sender_name', case
                     when m.sender_kind = 'support' then 'RouteReady Support'
                     else coalesce(nullif(trim(au.full_name), ''), au.email, 'Team')
                   end,
    'sender_role', au.role::text,
    'body',        m.body,
    'created_at',  m.created_at,
    'is_unread',   case
                     -- An admin reading on the DSP side (no p_dsp_id passed)
                     -- gets the DSP unread treatment; otherwise the admin
                     -- side treatment. Use the call mode, not just the role.
                     when m.sender_kind = 'support' and p_dsp_id is null then m.created_at > coalesce(v_conv.dsp_last_read_at,   '-infinity'::timestamptz)
                     when m.sender_kind = 'dsp'     and p_dsp_id is not null and v_is_admin then m.created_at > coalesce(v_conv.admin_last_read_at, '-infinity'::timestamptz)
                     else false
                   end
  ) order by m.created_at), '[]'::jsonb) into v_messages
  from public.support_messages m
  left join public.app_users   au on au.id = m.sender_user_id
  where m.dsp_id = v_dsp;

  return jsonb_build_object(
    'dsp_id',             v_dsp,
    'dsp_name',           v_dsp_name,
    'dsp_short_code',     v_dsp_code,
    'messages',           v_messages,
    'last_message_at',    v_conv.last_message_at,
    'dsp_last_read_at',   v_conv.dsp_last_read_at,
    'admin_last_read_at', v_conv.admin_last_read_at
  );
end;
$$;
grant execute on function public.support_thread(uuid) to authenticated;


create or replace function public.support_send(p_body text, p_dsp_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid := auth.uid();
  v_dsp      uuid;
  v_kind     text;
  v_body     text := nullif(trim(coalesce(p_body, '')), '');
  v_msg      public.support_messages;
  v_is_admin boolean := private.is_platform_admin();
begin
  if v_body is null        then raise exception 'empty_message' using errcode = '22023'; end if;
  if length(v_body) > 4000 then raise exception 'too_long'      using errcode = '22023'; end if;

  if p_dsp_id is not null then
    -- Admin replying on a specific DSP's thread (or, theoretically, a
    -- dispatcher writing to their own DSP — same row either way).
    if not v_is_admin then
      if p_dsp_id <> private.current_dsp_id() or not private.is_staff(p_dsp_id, 'dispatcher') then
        raise exception 'forbidden' using errcode = '42501';
      end if;
      v_kind := 'dsp';
    else
      v_kind := 'support';
    end if;
    v_dsp := p_dsp_id;
  else
    -- DSP-side send (or admin sending into their own DSP without
    -- supplying p_dsp_id). Always treated as a DSP message.
    v_dsp := private.current_dsp_id();
    if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
    if not v_is_admin and not private.is_staff(v_dsp, 'dispatcher') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    v_kind := 'dsp';
  end if;

  insert into public.support_conversations (dsp_id, last_message_at)
    values (v_dsp, now())
    on conflict (dsp_id) do update set last_message_at = excluded.last_message_at, updated_at = now();
  insert into public.support_messages (dsp_id, sender_kind, sender_user_id, body)
    values (v_dsp, v_kind, v_uid, v_body)
  returning * into v_msg;

  return jsonb_build_object(
    'id', v_msg.id, 'dsp_id', v_msg.dsp_id, 'sender_kind', v_msg.sender_kind,
    'body', v_msg.body, 'created_at', v_msg.created_at
  );
end;
$$;
grant execute on function public.support_send(text, uuid) to authenticated;


create or replace function public.support_mark_read(p_dsp_id uuid default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp      uuid;
  v_is_admin boolean := private.is_platform_admin();
  v_admin_side boolean;
begin
  if p_dsp_id is not null then
    if not v_is_admin then
      if p_dsp_id <> private.current_dsp_id() or not private.is_staff(p_dsp_id, 'dispatcher') then
        raise exception 'forbidden' using errcode = '42501';
      end if;
      v_admin_side := false;
    else
      v_admin_side := true;
    end if;
    v_dsp := p_dsp_id;
  else
    v_dsp := private.current_dsp_id();
    if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
    if not v_is_admin and not private.is_staff(v_dsp, 'dispatcher') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    v_admin_side := false;   -- the DSP-side inbox call always marks the DSP side
  end if;

  if v_admin_side then
    insert into public.support_conversations (dsp_id, admin_last_read_at) values (v_dsp, now())
      on conflict (dsp_id) do update set admin_last_read_at = now(), updated_at = now();
  else
    insert into public.support_conversations (dsp_id, dsp_last_read_at) values (v_dsp, now())
      on conflict (dsp_id) do update set dsp_last_read_at = now(), updated_at = now();
  end if;
end;
$$;
grant execute on function public.support_mark_read(uuid) to authenticated;

notify pgrst, 'reload schema';
