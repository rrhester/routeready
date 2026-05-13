-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0196 · RouteReady Support messaging
--
-- A direct line between every DSP and RouteReady's own support team, using
-- the same chat surface DSPs already use for drivers. One conversation per
-- DSP. The DSP side calls these RPCs scoped to current_dsp_id(); the
-- platform-admin side passes p_dsp_id and is allowed to read / write any
-- DSP's thread.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.support_conversations (
  dsp_id             uuid primary key references public.dsps(id) on delete cascade,
  last_message_at    timestamptz,
  dsp_last_read_at   timestamptz,
  admin_last_read_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.support_messages (
  id             uuid primary key default gen_random_uuid(),
  dsp_id         uuid not null references public.dsps(id) on delete cascade,
  sender_kind    text not null check (sender_kind in ('dsp','support')),
  sender_user_id uuid references auth.users(id) on delete set null,
  body           text not null check (length(trim(body)) > 0 and length(body) <= 4000),
  created_at     timestamptz not null default now()
);
create index if not exists support_messages_dsp_idx on public.support_messages (dsp_id, created_at desc);

alter table public.support_conversations enable row level security;
alter table public.support_messages      enable row level security;

drop policy if exists support_conversations_r on public.support_conversations;
create policy support_conversations_r on public.support_conversations for select
  using (private.is_platform_admin() or (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher')));

drop policy if exists support_messages_r on public.support_messages;
create policy support_messages_r on public.support_messages for select
  using (private.is_platform_admin() or (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher')));

grant select on public.support_conversations to authenticated;
grant select on public.support_messages      to authenticated;

-- ── Thread read RPC. With no arg, returns the caller DSP's thread.
-- A platform admin passes p_dsp_id to read any specific DSP's thread.
create or replace function public.support_thread(p_dsp_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid    := auth.uid();
  v_dsp      uuid;
  v_is_admin boolean := private.is_platform_admin();
  v_conv     public.support_conversations;
  v_messages jsonb;
  v_dsp_name text;
  v_dsp_code text;
begin
  if v_is_admin then
    if p_dsp_id is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
    v_dsp := p_dsp_id;
  else
    v_dsp := private.current_dsp_id();
    if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  end if;

  -- Lazy-seed the conversation row so the first call from either side works.
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
                     when m.sender_kind = 'support' and v_is_admin = false then m.created_at > coalesce(v_conv.dsp_last_read_at,   '-infinity'::timestamptz)
                     when m.sender_kind = 'dsp'     and v_is_admin = true  then m.created_at > coalesce(v_conv.admin_last_read_at, '-infinity'::timestamptz)
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

-- Send a message. DSP side omits p_dsp_id; admin side supplies it.
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
  if v_body is null            then raise exception 'empty_message' using errcode = '22023'; end if;
  if length(v_body) > 4000     then raise exception 'too_long'      using errcode = '22023'; end if;
  if v_is_admin then
    if p_dsp_id is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
    v_dsp := p_dsp_id; v_kind := 'support';
  else
    v_dsp := private.current_dsp_id();
    if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
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
begin
  if v_is_admin then
    if p_dsp_id is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
    v_dsp := p_dsp_id;
    insert into public.support_conversations (dsp_id, admin_last_read_at) values (v_dsp, now())
      on conflict (dsp_id) do update set admin_last_read_at = now(), updated_at = now();
  else
    v_dsp := private.current_dsp_id();
    if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
    insert into public.support_conversations (dsp_id, dsp_last_read_at) values (v_dsp, now())
      on conflict (dsp_id) do update set dsp_last_read_at = now(), updated_at = now();
  end if;
end;
$$;
grant execute on function public.support_mark_read(uuid) to authenticated;

-- Admin-only: list every DSP's support thread (for the centralized inbox).
create or replace function public.support_threads_admin()
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(t order by (t->>'last_message_at') desc nulls last) from (
      select jsonb_build_object(
        'dsp_id',          c.dsp_id,
        'dsp_name',        d.name,
        'dsp_short_code',  d.short_code,
        'last_message_at', c.last_message_at,
        'last_message',    (select jsonb_build_object(
                              'body',         m.body,
                              'sender_kind',  m.sender_kind,
                              'sender_name',  case when m.sender_kind = 'support' then 'RouteReady Support'
                                                   else coalesce(nullif(trim(au.full_name), ''), au.email, 'Team') end,
                              'sender_role',  au.role::text,
                              'created_at',   m.created_at)
                            from public.support_messages m
                            left join public.app_users au on au.id = m.sender_user_id
                            where m.dsp_id = c.dsp_id
                            order by m.created_at desc limit 1),
        'unread',          coalesce((select count(*) from public.support_messages m
                                       where m.dsp_id = c.dsp_id
                                         and m.sender_kind = 'dsp'
                                         and m.created_at > coalesce(c.admin_last_read_at, '-infinity'::timestamptz)), 0)
      ) as t
      from public.support_conversations c
      join public.dsps d on d.id = c.dsp_id
    ) sub
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.support_threads_admin() to authenticated;

-- DSP-side unread count (for an inbox badge / sidebar dot).
create or replace function public.support_unread_count()
returns int
language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_n int := 0;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then return 0; end if;
  select count(*) into v_n
    from public.support_messages m
    left join public.support_conversations c on c.dsp_id = m.dsp_id
   where m.dsp_id = v_dsp
     and m.sender_kind = 'support'
     and m.created_at > coalesce(c.dsp_last_read_at, '-infinity'::timestamptz);
  return v_n;
end;
$$;
grant execute on function public.support_unread_count() to authenticated;

-- Realtime so both ends update instantly.
do $$ begin
  begin execute 'alter publication supabase_realtime add table public.support_messages';      exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.support_conversations'; exception when duplicate_object then null; end;
end $$;

notify pgrst, 'reload schema';
