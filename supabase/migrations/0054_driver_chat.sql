-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0054 · Driver ↔ dispatch chat
--
-- One rolling conversation per driver. Either side can post; any
-- dispatcher at the DSP can read and reply (no per-operator assignment).
-- Read state lives on driver_conversations as two timestamps so unread
-- counts are cheap to compute.
--
-- Backend surface:
--   driver-side  (token-scoped, anon-callable):
--     driver_chat_list(token, limit)           → messages + last-read
--     driver_chat_send(token, body)            → insert
--     driver_chat_mark_read(token)             → update driver_last_read_at
--   dispatch-side (auth.uid() scoped, dispatcher role):
--     dispatch_chat_threads()                  → all drivers + unread + last
--     dispatch_chat_thread(driver_id, limit)   → one driver's messages
--     dispatch_chat_send(driver_id, body)      → insert
--     dispatch_chat_mark_read(driver_id)       → update dispatch_last_read_at
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Tables ──
create table if not exists public.driver_conversations (
  driver_id              uuid primary key references public.drivers(id) on delete cascade,
  dsp_id                 uuid not null references public.dsps(id) on delete cascade,
  driver_last_read_at    timestamptz,
  dispatch_last_read_at  timestamptz,
  last_message_at        timestamptz,
  created_at             timestamptz not null default now()
);
create index if not exists driver_conversations_dsp_recent_idx
  on public.driver_conversations(dsp_id, last_message_at desc);

create table if not exists public.driver_messages (
  id              uuid primary key default gen_random_uuid(),
  driver_id       uuid not null references public.drivers(id) on delete cascade,
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  sender_kind     text not null check (sender_kind in ('driver','dispatch')),
  sender_user_id  uuid references auth.users(id),
  body            text not null check (length(trim(body)) > 0 and length(body) <= 2000),
  created_at      timestamptz not null default now()
);
create index if not exists driver_messages_drv_idx on public.driver_messages(driver_id, created_at desc);
create index if not exists driver_messages_dsp_idx on public.driver_messages(dsp_id, created_at desc);

alter table public.driver_conversations enable row level security;
alter table public.driver_messages      enable row level security;

drop policy if exists "driver_conversations_tenant_r" on public.driver_conversations;
create policy "driver_conversations_tenant_r"
  on public.driver_conversations for select
  using (dsp_id = private.current_dsp_id());

drop policy if exists "driver_messages_tenant_r" on public.driver_messages;
create policy "driver_messages_tenant_r"
  on public.driver_messages for select
  using (dsp_id = private.current_dsp_id());

grant select on public.driver_conversations to authenticated;
grant select on public.driver_messages      to authenticated;


-- ── 2. driver_chat_list ──
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


-- ── 3. driver_chat_send ──
create or replace function public.driver_chat_send(p_token text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_body text := trim(coalesce(p_body, ''));
  v_msg public.driver_messages;
begin
  v_drv := private.driver_validate_token(p_token);
  if v_body = '' then raise exception 'empty_body' using errcode = 'P0001'; end if;
  if length(v_body) > 2000 then raise exception 'too_long' using errcode = 'P0001'; end if;

  insert into public.driver_messages (driver_id, dsp_id, sender_kind, body)
  values (v_drv.id, v_drv.dsp_id, 'driver', v_body)
  returning * into v_msg;

  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (v_drv.id, v_drv.dsp_id, v_msg.created_at)
  on conflict (driver_id) do update
    set last_message_at = excluded.last_message_at;

  return jsonb_build_object(
    'id',          v_msg.id,
    'sender_kind', v_msg.sender_kind,
    'body',        v_msg.body,
    'created_at',  v_msg.created_at
  );
end;
$$;
grant execute on function public.driver_chat_send(text, text) to anon, authenticated;


-- ── 4. driver_chat_mark_read ──
create or replace function public.driver_chat_mark_read(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
  insert into public.driver_conversations (driver_id, dsp_id, driver_last_read_at)
  values (v_drv.id, v_drv.dsp_id, now())
  on conflict (driver_id) do update set driver_last_read_at = now();
end;
$$;
grant execute on function public.driver_chat_mark_read(text) to anon, authenticated;


-- ── 5. dispatch_chat_threads — list of all driver threads ──
create or replace function public.dispatch_chat_threads()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(t order by (t->>'last_at') desc nulls last) from (
      select jsonb_build_object(
        'driver_id',   d.id,
        'name',        coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
        'full_name',   d.full_name,
        'station_code', s.code,
        'status',      d.status,
        'last_at',     c.last_message_at,
        'unread',      coalesce((
          select count(*) from public.driver_messages m
           where m.driver_id = d.id
             and m.sender_kind = 'driver'
             and m.created_at > coalesce(c.dispatch_last_read_at, '-infinity'::timestamptz)
        ), 0),
        'last_message', (
          select jsonb_build_object('body', m.body, 'sender_kind', m.sender_kind, 'created_at', m.created_at)
            from public.driver_messages m
           where m.driver_id = d.id
           order by m.created_at desc
           limit 1
        )
      ) as t
      from public.drivers d
      left join public.driver_conversations c on c.driver_id = d.id
      left join public.stations s on s.id = d.station_id
      where d.dsp_id = v_dsp
        and d.status in ('active', 'onboarding')
    ) sub
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.dispatch_chat_threads() to authenticated;


-- ── 6. dispatch_chat_thread — one driver's messages ──
create or replace function public.dispatch_chat_thread(p_driver_id uuid, p_limit int default 100)
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


-- ── 7. dispatch_chat_send ──
create or replace function public.dispatch_chat_send(p_driver_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers;
  v_body text := trim(coalesce(p_body, ''));
  v_msg public.driver_messages;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_body = '' then raise exception 'empty_body' using errcode = 'P0001'; end if;
  if length(v_body) > 2000 then raise exception 'too_long' using errcode = 'P0001'; end if;

  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then raise exception 'driver_not_found' using errcode = 'P0002'; end if;

  insert into public.driver_messages (driver_id, dsp_id, sender_kind, sender_user_id, body)
  values (p_driver_id, v_dsp, 'dispatch', auth.uid(), v_body)
  returning * into v_msg;

  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (p_driver_id, v_dsp, v_msg.created_at)
  on conflict (driver_id) do update
    set last_message_at = excluded.last_message_at;

  return jsonb_build_object(
    'id',          v_msg.id,
    'sender_kind', v_msg.sender_kind,
    'body',        v_msg.body,
    'created_at',  v_msg.created_at
  );
end;
$$;
grant execute on function public.dispatch_chat_send(uuid, text) to authenticated;


-- ── 8. dispatch_chat_mark_read ──
create or replace function public.dispatch_chat_mark_read(p_driver_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.driver_conversations (driver_id, dsp_id, dispatch_last_read_at)
  values (p_driver_id, v_dsp, now())
  on conflict (driver_id) do update set dispatch_last_read_at = now();
end;
$$;
grant execute on function public.dispatch_chat_mark_read(uuid) to authenticated;
