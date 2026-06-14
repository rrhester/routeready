-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0389 · Message likes (👍) for the driver ↔ dispatch 1:1 chat
--
-- Two-way reactions: both the dispatcher (dashboard, auth.uid()-scoped) and
-- the driver (app, token-scoped) can like a message and see each other's
-- likes.  Kept deliberately separate from the message-fetch RPCs — likes
-- live in their own table and are read via dedicated reaction RPCs, so the
-- auth-critical chat send/fetch functions are untouched.
--
-- Scope: driver_messages (the 1:1 chat) only.  Group/HR/Broadcast channel
-- likes are a follow-up (a parallel table on driver_channel_messages).
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Table ──
create table if not exists public.driver_message_reactions (
  id                uuid primary key default gen_random_uuid(),
  message_id        uuid not null references public.driver_messages(id) on delete cascade,
  dsp_id            uuid not null references public.dsps(id) on delete cascade,
  reactor_kind      text not null check (reactor_kind in ('driver','dispatch')),
  reactor_driver_id uuid references public.drivers(id) on delete cascade,
  reactor_user_id   uuid references auth.users(id) on delete cascade,
  emoji             text not null default '👍',
  created_at        timestamptz not null default now(),
  check (
    (reactor_kind = 'driver'   and reactor_driver_id is not null and reactor_user_id is null)
    or
    (reactor_kind = 'dispatch' and reactor_user_id is not null and reactor_driver_id is null)
  )
);
-- One like per actor per message (partial uniques — the nullable actor
-- columns can't share a composite PK).
create unique index if not exists driver_message_reactions_dispatch_uq
  on public.driver_message_reactions (message_id, reactor_user_id) where reactor_kind = 'dispatch';
create unique index if not exists driver_message_reactions_driver_uq
  on public.driver_message_reactions (message_id, reactor_driver_id) where reactor_kind = 'driver';
create index if not exists driver_message_reactions_msg_idx
  on public.driver_message_reactions (message_id);
create index if not exists driver_message_reactions_dsp_idx
  on public.driver_message_reactions (dsp_id);


-- ── 2. RLS ──  Direct reads are dispatch-only; drivers go through RPCs.
alter table public.driver_message_reactions enable row level security;
drop policy if exists "driver_message_reactions_tenant_r" on public.driver_message_reactions;
create policy "driver_message_reactions_tenant_r"
  on public.driver_message_reactions for select
  using (dsp_id = private.current_dsp_id());
grant select on public.driver_message_reactions to authenticated;


-- ── 3. Realtime ──  Both ends listen so likes appear live.
do $$ begin
  alter publication supabase_realtime add table public.driver_message_reactions;
exception when duplicate_object then null; end $$;


-- ── 4. Dispatcher RPCs ──

-- 4a. Toggle the calling dispatcher's like on a message.
create or replace function public.dispatch_message_react(p_message_id uuid, p_on boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_uid   uuid := auth.uid();
  v_msg   public.driver_messages;
  v_count int;
  v_mine  boolean;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_msg from public.driver_messages where id = p_message_id and dsp_id = v_dsp;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;

  if coalesce(p_on, true) then
    if not exists (
      select 1 from public.driver_message_reactions
       where message_id = p_message_id and reactor_kind = 'dispatch' and reactor_user_id = v_uid
    ) then
      insert into public.driver_message_reactions (message_id, dsp_id, reactor_kind, reactor_user_id)
      values (p_message_id, v_dsp, 'dispatch', v_uid);
    end if;
  else
    delete from public.driver_message_reactions
     where message_id = p_message_id and reactor_kind = 'dispatch' and reactor_user_id = v_uid;
  end if;

  select count(*) into v_count from public.driver_message_reactions where message_id = p_message_id;
  select exists (
    select 1 from public.driver_message_reactions
     where message_id = p_message_id and reactor_kind = 'dispatch' and reactor_user_id = v_uid
  ) into v_mine;
  return jsonb_build_object('message_id', p_message_id, 'like_count', v_count, 'liked_by_me', v_mine);
end;
$$;
grant execute on function public.dispatch_message_react(uuid, boolean) to authenticated;

-- 4b. Like counts + my-like for a whole thread (one driver).
create or replace function public.dispatch_chat_reactions(p_driver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_uid  uuid := auth.uid();
  v_rows jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'message_id',  t.message_id,
    'like_count',  t.like_count,
    'liked_by_me', t.liked_by_me
  )), '[]'::jsonb) into v_rows
  from (
    select r.message_id,
           count(*)::int as like_count,
           bool_or(r.reactor_kind = 'dispatch' and r.reactor_user_id = v_uid) as liked_by_me
      from public.driver_message_reactions r
      join public.driver_messages m on m.id = r.message_id
     where m.driver_id = p_driver_id and m.dsp_id = v_dsp
     group by r.message_id
  ) t;
  return jsonb_build_object('reactions', v_rows);
end;
$$;
grant execute on function public.dispatch_chat_reactions(uuid) to authenticated;


-- ── 5. Driver RPCs (token-scoped) ──

-- 5a. Toggle the calling driver's like on a message in their own thread.
create or replace function public.driver_message_react(p_token text, p_message_id uuid, p_on boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv   public.drivers;
  v_msg   public.driver_messages;
  v_count int;
  v_mine  boolean;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_msg from public.driver_messages where id = p_message_id and driver_id = v_drv.id;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;

  if coalesce(p_on, true) then
    if not exists (
      select 1 from public.driver_message_reactions
       where message_id = p_message_id and reactor_kind = 'driver' and reactor_driver_id = v_drv.id
    ) then
      insert into public.driver_message_reactions (message_id, dsp_id, reactor_kind, reactor_driver_id)
      values (p_message_id, v_drv.dsp_id, 'driver', v_drv.id);
    end if;
  else
    delete from public.driver_message_reactions
     where message_id = p_message_id and reactor_kind = 'driver' and reactor_driver_id = v_drv.id;
  end if;

  select count(*) into v_count from public.driver_message_reactions where message_id = p_message_id;
  select exists (
    select 1 from public.driver_message_reactions
     where message_id = p_message_id and reactor_kind = 'driver' and reactor_driver_id = v_drv.id
  ) into v_mine;
  return jsonb_build_object('message_id', p_message_id, 'like_count', v_count, 'liked_by_me', v_mine);
end;
$$;
grant execute on function public.driver_message_react(text, uuid, boolean) to anon, authenticated;

-- 5b. Like counts + my-like for the driver's own thread.
create or replace function public.driver_chat_reactions(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv  public.drivers;
  v_rows jsonb;
begin
  v_drv := private.driver_validate_token(p_token);
  select coalesce(jsonb_agg(jsonb_build_object(
    'message_id',  t.message_id,
    'like_count',  t.like_count,
    'liked_by_me', t.liked_by_me
  )), '[]'::jsonb) into v_rows
  from (
    select r.message_id,
           count(*)::int as like_count,
           bool_or(r.reactor_kind = 'driver' and r.reactor_driver_id = v_drv.id) as liked_by_me
      from public.driver_message_reactions r
      join public.driver_messages m on m.id = r.message_id
     where m.driver_id = v_drv.id
     group by r.message_id
  ) t;
  return jsonb_build_object('reactions', v_rows);
end;
$$;
grant execute on function public.driver_chat_reactions(text) to anon, authenticated;

notify pgrst, 'reload schema';
