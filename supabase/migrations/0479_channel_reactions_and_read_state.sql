-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0479 · Channel reactions (multi-emoji) + channel read-state
--
-- Brings the group/HR/broadcast channels (driver_channel_messages, 0073) up
-- to parity with the 1:1 driver chat, which already has 👍 reactions (0389)
-- and read receipts (0121).  Two capabilities:
--
--   1. Reactions — a parallel reaction table on driver_channel_messages,
--      exactly the follow-up flagged in 0389's header.  Unlike the 1:1
--      like (👍 only), channel reactions carry an emoji from a fixed,
--      server-validated allow-list, so both ends stay injection-safe.
--      Two-way: dispatchers (auth.uid()) and drivers (token) both react
--      and see each other's reactions.
--
--   2. Read-state ("Seen by N") — driver_channel_members.last_read_at
--      already records when each member last opened the channel (0073 bumps
--      it on every driver_channel_messages() fetch).  We expose a read-only
--      RPC that returns the member roster's last_read_at so the dashboard
--      can show "Seen by N of M" under a broadcast — confirming the fleet
--      actually saw an urgent notice.  No new write path; purely derived.
--
-- Kept deliberately separate from the auth-critical channel send/fetch RPCs
-- (0073) — reactions live in their own table read via dedicated RPCs.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Table ──
create table if not exists public.driver_channel_message_reactions (
  id                uuid primary key default gen_random_uuid(),
  message_id        uuid not null references public.driver_channel_messages(id) on delete cascade,
  channel_id        uuid not null references public.driver_channels(id) on delete cascade,
  dsp_id            uuid not null references public.dsps(id) on delete cascade,
  reactor_kind      text not null check (reactor_kind in ('driver','dispatch')),
  reactor_driver_id uuid references public.drivers(id) on delete cascade,
  reactor_user_id   uuid references auth.users(id) on delete cascade,
  emoji             text not null,
  created_at        timestamptz not null default now(),
  check (
    (reactor_kind = 'driver'   and reactor_driver_id is not null and reactor_user_id is null)
    or
    (reactor_kind = 'dispatch' and reactor_user_id is not null and reactor_driver_id is null)
  )
);
-- One reaction per actor + emoji per message (a user may add several
-- distinct emojis, but not the same emoji twice).  Partial uniques — the
-- nullable actor columns can't share a composite PK.
create unique index if not exists driver_channel_msg_react_dispatch_uq
  on public.driver_channel_message_reactions (message_id, reactor_user_id, emoji)
  where reactor_kind = 'dispatch';
create unique index if not exists driver_channel_msg_react_driver_uq
  on public.driver_channel_message_reactions (message_id, reactor_driver_id, emoji)
  where reactor_kind = 'driver';
create index if not exists driver_channel_msg_react_msg_idx
  on public.driver_channel_message_reactions (message_id);
create index if not exists driver_channel_msg_react_chan_idx
  on public.driver_channel_message_reactions (channel_id);
create index if not exists driver_channel_msg_react_dsp_idx
  on public.driver_channel_message_reactions (dsp_id);


-- ── 2. RLS ──  Direct reads dispatch-only; drivers go through RPCs.
alter table public.driver_channel_message_reactions enable row level security;
drop policy if exists "driver_channel_msg_react_tenant_r" on public.driver_channel_message_reactions;
create policy "driver_channel_msg_react_tenant_r"
  on public.driver_channel_message_reactions for select
  using (dsp_id = private.current_dsp_id());
grant select on public.driver_channel_message_reactions to authenticated;


-- ── 3. Realtime ──  Both ends listen so reactions appear live.
do $$ begin
  alter publication supabase_realtime add table public.driver_channel_message_reactions;
exception when duplicate_object then null; end $$;


-- ── 4. Allowed-emoji guard ──
-- A small, fixed reaction palette.  Keeping it server-side means a bad
-- client can never store arbitrary text as an "emoji".
create or replace function private.channel_reaction_allowed(p_emoji text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_emoji in ('👍','❤️','✅','👀','😂','🎉','⚠️','🙏');
$$;


-- ── 5. Dispatcher RPCs ──

-- 5a. Toggle the calling dispatcher's reaction (emoji) on a channel message.
create or replace function public.dispatch_channel_message_react(
  p_message_id uuid,
  p_emoji      text default '👍',
  p_on         boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_uid   uuid := auth.uid();
  v_msg   public.driver_channel_messages;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.channel_reaction_allowed(p_emoji) then
    raise exception 'invalid_emoji' using errcode = '22023';
  end if;

  select * into v_msg from public.driver_channel_messages
   where id = p_message_id and dsp_id = v_dsp;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;

  if coalesce(p_on, true) then
    insert into public.driver_channel_message_reactions
      (message_id, channel_id, dsp_id, reactor_kind, reactor_user_id, emoji)
    values (p_message_id, v_msg.channel_id, v_dsp, 'dispatch', v_uid, p_emoji)
    on conflict do nothing;
  else
    delete from public.driver_channel_message_reactions
     where message_id = p_message_id and reactor_kind = 'dispatch'
       and reactor_user_id = v_uid and emoji = p_emoji;
  end if;

  return public.dispatch_channel_reactions(v_msg.channel_id);
end;
$$;
grant execute on function public.dispatch_channel_message_react(uuid, text, boolean) to authenticated;

-- 5b. Reaction aggregates for a whole channel — one row per (message, emoji)
--     with a count and whether the caller is among the reactors.
create or replace function public.dispatch_channel_reactions(p_channel_id uuid)
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
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.driver_channels where id = p_channel_id and dsp_id = v_dsp) then
    raise exception 'not_found' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'message_id', t.message_id,
    'emoji',      t.emoji,
    'count',      t.n,
    'mine',       t.mine
  )), '[]'::jsonb) into v_rows
  from (
    select r.message_id, r.emoji,
           count(*)::int as n,
           bool_or(r.reactor_kind = 'dispatch' and r.reactor_user_id = v_uid) as mine
      from public.driver_channel_message_reactions r
     where r.channel_id = p_channel_id
     group by r.message_id, r.emoji
  ) t;
  return jsonb_build_object('reactions', v_rows);
end;
$$;
grant execute on function public.dispatch_channel_reactions(uuid) to authenticated;

-- 5c. Read-state for a channel — the member roster with last_read_at, so the
--     dashboard can render "Seen by N of M" under a dispatch broadcast.
create or replace function public.dispatch_channel_read_state(p_channel_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_rows jsonb;
  v_n    int;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.driver_channels where id = p_channel_id and dsp_id = v_dsp) then
    raise exception 'not_found' using errcode = '42501';
  end if;

  select count(*)::int into v_n
    from public.driver_channel_members m where m.channel_id = p_channel_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'driver_id',    d.id,
    'full_name',    d.full_name,
    'last_read_at', m.last_read_at
  ) order by d.full_name), '[]'::jsonb) into v_rows
    from public.driver_channel_members m
    join public.drivers d on d.id = m.driver_id
   where m.channel_id = p_channel_id;

  return jsonb_build_object('member_count', v_n, 'readers', v_rows);
end;
$$;
grant execute on function public.dispatch_channel_read_state(uuid) to authenticated;


-- ── 6. Driver RPCs (token-scoped) ──

-- 6a. Toggle the calling driver's reaction on a message in a channel they're in.
create or replace function public.driver_channel_message_react(
  p_token      text,
  p_message_id uuid,
  p_emoji      text default '👍',
  p_on         boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_msg public.driver_channel_messages;
begin
  v_drv := private.driver_validate_token(p_token);
  if not private.channel_reaction_allowed(p_emoji) then
    raise exception 'invalid_emoji' using errcode = '22023';
  end if;

  select * into v_msg from public.driver_channel_messages
   where id = p_message_id and dsp_id = v_drv.dsp_id;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;

  if not exists (
    select 1 from public.driver_channel_members
     where channel_id = v_msg.channel_id and driver_id = v_drv.id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  if coalesce(p_on, true) then
    insert into public.driver_channel_message_reactions
      (message_id, channel_id, dsp_id, reactor_kind, reactor_driver_id, emoji)
    values (p_message_id, v_msg.channel_id, v_drv.dsp_id, 'driver', v_drv.id, p_emoji)
    on conflict do nothing;
  else
    delete from public.driver_channel_message_reactions
     where message_id = p_message_id and reactor_kind = 'driver'
       and reactor_driver_id = v_drv.id and emoji = p_emoji;
  end if;

  return public.driver_channel_reactions(p_token, v_msg.channel_id);
end;
$$;
grant execute on function public.driver_channel_message_react(text, uuid, text, boolean) to anon, authenticated;

-- 6b. Reaction aggregates for a channel, from the driver's perspective.
create or replace function public.driver_channel_reactions(
  p_token      text,
  p_channel_id uuid
)
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
  if not exists (
    select 1 from public.driver_channel_members
     where channel_id = p_channel_id and driver_id = v_drv.id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'message_id', t.message_id,
    'emoji',      t.emoji,
    'count',      t.n,
    'mine',       t.mine
  )), '[]'::jsonb) into v_rows
  from (
    select r.message_id, r.emoji,
           count(*)::int as n,
           bool_or(r.reactor_kind = 'driver' and r.reactor_driver_id = v_drv.id) as mine
      from public.driver_channel_message_reactions r
     where r.channel_id = p_channel_id
     group by r.message_id, r.emoji
  ) t;
  return jsonb_build_object('reactions', v_rows);
end;
$$;
grant execute on function public.driver_channel_reactions(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
