-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0480 · @mentions in group / HR / broadcast channels
--
-- Lets a poster tag specific channel members ("@Marcus — this one's yours")
-- so the mention is highlighted for that person in-app.  Mentions are
-- recorded in their own table and set via a dedicated RPC called right
-- after the message is posted — the auth-critical channel send/fetch RPCs
-- (0073) are left completely untouched, same separation-of-concerns
-- pattern used for reactions (0389 / 0479).
--
-- Notification: channel messages already fan out Web + native push to every
-- member (migration 0074), so a mentioned driver is already notified.  This
-- migration adds the in-app highlight + a durable mention trail (which a
-- future "Mentions" filter can read).  A mention-specific push is a
-- follow-up and intentionally NOT wired here to keep the change additive.
--
-- Mentions target drivers (channel members).  Mentioning dispatch/operators
-- is a follow-up.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Table ──
create table if not exists public.driver_channel_message_mentions (
  id                  uuid primary key default gen_random_uuid(),
  message_id          uuid not null references public.driver_channel_messages(id) on delete cascade,
  channel_id          uuid not null references public.driver_channels(id) on delete cascade,
  dsp_id              uuid not null references public.dsps(id) on delete cascade,
  mentioned_driver_id uuid not null references public.drivers(id) on delete cascade,
  created_at          timestamptz not null default now(),
  unique (message_id, mentioned_driver_id)
);
create index if not exists driver_channel_msg_mention_msg_idx
  on public.driver_channel_message_mentions (message_id);
create index if not exists driver_channel_msg_mention_chan_idx
  on public.driver_channel_message_mentions (channel_id);
create index if not exists driver_channel_msg_mention_drv_idx
  on public.driver_channel_message_mentions (mentioned_driver_id, created_at desc);


-- ── 2. RLS ──  Direct reads dispatch-only; drivers go through RPCs.
alter table public.driver_channel_message_mentions enable row level security;
drop policy if exists "driver_channel_msg_mention_tenant_r" on public.driver_channel_message_mentions;
create policy "driver_channel_msg_mention_tenant_r"
  on public.driver_channel_message_mentions for select
  using (dsp_id = private.current_dsp_id());
grant select on public.driver_channel_message_mentions to authenticated;


-- ── 3. Realtime ──  Highlight appears live on both ends.
do $$ begin
  alter publication supabase_realtime add table public.driver_channel_message_mentions;
exception when duplicate_object then null; end $$;


-- ── 4. Dispatcher RPCs ──

-- 4a. Replace the mention set for a message the dispatcher just posted.
--     Only members of the message's channel can be mentioned; unknown /
--     non-member ids are silently dropped so a stale client can't error.
create or replace function public.dispatch_channel_set_mentions(
  p_message_id uuid,
  p_driver_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_msg public.driver_channel_messages;
  v_n   int;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;

  select * into v_msg from public.driver_channel_messages
   where id = p_message_id and dsp_id = v_dsp;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;

  delete from public.driver_channel_message_mentions where message_id = p_message_id;

  insert into public.driver_channel_message_mentions
    (message_id, channel_id, dsp_id, mentioned_driver_id)
  select p_message_id, v_msg.channel_id, v_dsp, m.driver_id
    from public.driver_channel_members m
   where m.channel_id = v_msg.channel_id
     and m.driver_id = any(coalesce(p_driver_ids, '{}'::uuid[]))
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return jsonb_build_object('message_id', p_message_id, 'mention_count', v_n);
end;
$$;
grant execute on function public.dispatch_channel_set_mentions(uuid, uuid[]) to authenticated;

-- 4b. Mentions for a whole channel — one row per message with the mentioned
--     members' ids + names, for rendering highlights.
create or replace function public.dispatch_channel_mentions(p_channel_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_rows jsonb;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.driver_channels where id = p_channel_id and dsp_id = v_dsp) then
    raise exception 'not_found' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'message_id', t.message_id,
    'mentioned',  t.mentioned
  )), '[]'::jsonb) into v_rows
  from (
    select mn.message_id,
           jsonb_agg(jsonb_build_object('driver_id', d.id, 'full_name', d.full_name) order by d.full_name) as mentioned
      from public.driver_channel_message_mentions mn
      join public.drivers d on d.id = mn.mentioned_driver_id
     where mn.channel_id = p_channel_id
     group by mn.message_id
  ) t;
  return jsonb_build_object('mentions', v_rows);
end;
$$;
grant execute on function public.dispatch_channel_mentions(uuid) to authenticated;


-- ── 5. Driver RPCs (token-scoped) ──

-- 5a. A driver posting in a channel can mention fellow members.
create or replace function public.driver_channel_set_mentions(
  p_token      text,
  p_message_id uuid,
  p_driver_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_msg public.driver_channel_messages;
  v_n   int;
begin
  v_drv := private.driver_validate_token(p_token);

  select * into v_msg from public.driver_channel_messages
   where id = p_message_id and dsp_id = v_drv.dsp_id
     and sender_kind = 'driver' and sender_driver_id = v_drv.id;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;

  delete from public.driver_channel_message_mentions where message_id = p_message_id;

  insert into public.driver_channel_message_mentions
    (message_id, channel_id, dsp_id, mentioned_driver_id)
  select p_message_id, v_msg.channel_id, v_drv.dsp_id, m.driver_id
    from public.driver_channel_members m
   where m.channel_id = v_msg.channel_id
     and m.driver_id = any(coalesce(p_driver_ids, '{}'::uuid[]))
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return jsonb_build_object('message_id', p_message_id, 'mention_count', v_n);
end;
$$;
grant execute on function public.driver_channel_set_mentions(text, uuid, uuid[]) to anon, authenticated;

-- 5b. Mentions for a channel, from the driver's perspective.
create or replace function public.driver_channel_mentions(
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
    'mentioned',  t.mentioned
  )), '[]'::jsonb) into v_rows
  from (
    select mn.message_id,
           jsonb_agg(jsonb_build_object('driver_id', d.id, 'full_name', d.full_name) order by d.full_name) as mentioned
      from public.driver_channel_message_mentions mn
      join public.drivers d on d.id = mn.mentioned_driver_id
     where mn.channel_id = p_channel_id
     group by mn.message_id
  ) t;
  return jsonb_build_object('mentions', v_rows, 'me', v_drv.id);
end;
$$;
grant execute on function public.driver_channel_mentions(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
