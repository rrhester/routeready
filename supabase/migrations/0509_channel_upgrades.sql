-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0509 · Messages 100-list Batch 4 (rooms & broadcasts)
--
--   #36 announcement-only rooms   → driver_channels.announcement_only +
--                                   driver_channel_post gate + update RPC
--   #43 room threads              → reply_to_message_id on channel messages
--   #37/#38 ack board + nudge     → requires_ack on channel messages +
--                                   driver_channel_message_acks + RPCs
--   #41 polls                     → channel_polls / channel_poll_votes + RPCs
--   #39 recurring broadcasts      → scheduled_messages repeat_every/until +
--                                   flush reschedules the next occurrence
--
-- Signature changes drop the old function first so PostgREST never sees
-- ambiguous overloads. Idempotent throughout.
--
-- ⚠️ Section 0 re-asserts migration 0484's scheduled_messages table and its
-- list/cancel/flush RPCs verbatim: at least one live DB skipped 0484 (same
-- failure mode as 0432/0496), and this migration's `alter table` + recurrence
-- flush assume it exists. `dispatch_schedule_message` and
-- `private.flush_scheduled_messages` are NOT re-asserted here — section 8
-- recreates both with recurrence support. All idempotent; a DB that already
-- ran 0484 is untouched by section 0.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 0. Re-assert 0484 · scheduled_messages (skipped on some live DBs) ──

create table if not exists public.scheduled_messages (
  id                     uuid primary key default gen_random_uuid(),
  dsp_id                 uuid not null references public.dsps(id) on delete cascade,
  created_by             uuid not null references auth.users(id) on delete cascade,
  target_kind            text not null check (target_kind in ('driver','channel')),
  driver_id              uuid references public.drivers(id) on delete cascade,
  channel_id             uuid references public.driver_channels(id) on delete cascade,
  body                   text,
  attachment_path        text,
  attachment_mime        text,
  attachment_name        text,
  attachment_size_bytes  int,
  priority               text not null default 'normal',
  requires_ack           boolean not null default false,
  mention_driver_ids     uuid[],
  send_at                timestamptz not null,
  status                 text not null default 'pending' check (status in ('pending','sent','canceled','failed')),
  sent_message_id        uuid,
  error                  text,
  created_at             timestamptz not null default now(),
  sent_at                timestamptz,
  check (
    (target_kind = 'driver'  and driver_id  is not null and channel_id is null) or
    (target_kind = 'channel' and channel_id is not null and driver_id  is null)
  ),
  check (
    (body is not null and length(trim(body)) > 0) or attachment_path is not null
  )
);
create index if not exists scheduled_messages_due_idx
  on public.scheduled_messages (send_at) where status = 'pending';
create index if not exists scheduled_messages_dsp_idx
  on public.scheduled_messages (dsp_id, status, send_at desc);

alter table public.scheduled_messages enable row level security;
drop policy if exists "scheduled_messages_tenant_r" on public.scheduled_messages;
create policy "scheduled_messages_tenant_r"
  on public.scheduled_messages for select
  using (dsp_id = private.current_dsp_id());
grant select on public.scheduled_messages to authenticated;

-- 0b. Pending + recently-resolved scheduled messages for the DSP (0484 §3b).
create or replace function public.dispatch_scheduled_list()
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

  select coalesce(jsonb_agg(row_to_json(t) order by t.send_at), '[]'::jsonb) into v_rows
  from (
    select s.id, s.target_kind, s.driver_id, s.channel_id, s.body,
           s.attachment_name, s.priority, s.requires_ack, s.send_at, s.status,
           s.created_at, s.sent_at,
           case when s.target_kind = 'driver'  then dn.full_name end as driver_name,
           case when s.target_kind = 'channel' then c.name end       as channel_name
      from public.scheduled_messages s
      left join public.drivers dn         on dn.id = s.driver_id
      left join public.driver_channels c  on c.id  = s.channel_id
     where s.dsp_id = v_dsp
       and (s.status = 'pending' or s.sent_at > now() - interval '2 days')
  ) t;

  return jsonb_build_object('scheduled', v_rows);
end;
$$;
grant execute on function public.dispatch_scheduled_list() to authenticated;

-- 0c. Cancel a still-pending scheduled message (0484 §3c).
create or replace function public.dispatch_scheduled_cancel(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_n   int;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  update public.scheduled_messages
     set status = 'canceled', sent_at = now()
   where id = p_id and dsp_id = v_dsp and status = 'pending';
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'not_cancelable' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', p_id, 'status', 'canceled');
end;
$$;
grant execute on function public.dispatch_scheduled_cancel(uuid) to authenticated;

-- 0d. Staff-callable flush fallback (0484 §4b). The flush worker itself
-- (private.flush_scheduled_messages) is created in section 8 below.
create or replace function public.dispatch_flush_scheduled()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_n   int;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;
  v_n := private.flush_scheduled_messages();
  return jsonb_build_object('sent', v_n);
end;
$$;
grant execute on function public.dispatch_flush_scheduled() to authenticated;

-- 0e. pg_cron minute job (0484 §5; best-effort, no-op if pg_cron is absent).
do $$ begin
  perform cron.unschedule('flush-scheduled-messages');
exception when others then null; end $$;
do $$ begin
  perform cron.schedule('flush-scheduled-messages', '* * * * *', 'select private.flush_scheduled_messages();');
exception when others then null; end $$;

-- 0f. Re-assert 0481's mentions table too — the flush worker inserts into it
-- for channel sends, and a DB that skipped 0484 may have skipped 0481 as
-- well. Table/RLS/realtime only; 0481's mention RPCs aren't needed by 0509.
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
alter table public.driver_channel_message_mentions enable row level security;
drop policy if exists "driver_channel_msg_mention_tenant_r" on public.driver_channel_message_mentions;
create policy "driver_channel_msg_mention_tenant_r"
  on public.driver_channel_message_mentions for select
  using (dsp_id = private.current_dsp_id());
grant select on public.driver_channel_message_mentions to authenticated;
do $$ begin
  alter publication supabase_realtime add table public.driver_channel_message_mentions;
exception when duplicate_object then null; end $$;

-- ── 1. Columns ──
alter table public.driver_channels
  add column if not exists announcement_only boolean not null default false;
alter table public.driver_channel_messages
  add column if not exists reply_to_message_id uuid references public.driver_channel_messages(id) on delete set null,
  add column if not exists requires_ack boolean not null default false;
alter table public.scheduled_messages
  add column if not exists repeat_every text not null default 'none'
    check (repeat_every in ('none','daily','weekdays','weekly')),
  add column if not exists repeat_until timestamptz;

-- ── 2. Channel settings update (#36 + #44) ──
create or replace function public.dispatch_channel_update(
  p_channel_id        uuid,
  p_name              text default null,
  p_description       text default null,
  p_announcement_only boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_chan public.driver_channels;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_chan from public.driver_channels where id = p_channel_id and dsp_id = v_dsp;
  if v_chan.id is null then raise exception 'channel_not_found' using errcode = 'P0002'; end if;
  update public.driver_channels
     set name = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
         description = case when p_description is null then description else nullif(trim(p_description), '') end,
         announcement_only = coalesce(p_announcement_only, announcement_only)
   where id = p_channel_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.dispatch_channel_update(uuid, text, text, boolean) to authenticated;

-- ── 3. dispatch_channel_messages · expose reply_to / requires_ack /
--       announcement flag (additive) ──
create or replace function public.dispatch_channel_messages(
  p_channel_id uuid,
  p_limit      int default 200
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_msgs jsonb;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;

  if not exists (select 1 from public.driver_channels where id = p_channel_id and dsp_id = v_dsp) then
    raise exception 'not_found' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_to_json(t) order by t.created_at), '[]'::jsonb) into v_msgs
    from (
      select m.id, m.sender_kind, m.body,
             m.attachment_path, m.attachment_mime, m.attachment_name, m.attachment_size_bytes,
             m.created_at,
             m.reply_to_message_id as reply_to,
             m.requires_ack,
             case when m.sender_kind = 'driver'
                  then (select full_name from public.drivers where id = m.sender_driver_id)
                  else (select coalesce(full_name, email) from public.app_users where id = m.sender_user_id)
             end as sender_name,
             m.sender_driver_id,
             m.sender_user_id
        from public.driver_channel_messages m
       where m.channel_id = p_channel_id
       order by m.created_at desc
       limit greatest(1, least(p_limit, 500))
    ) t;

  return jsonb_build_object('messages', v_msgs);
end;
$$;
grant execute on function public.dispatch_channel_messages(uuid, int) to authenticated;

-- ── 4. dispatch_channel_post · + p_reply_to / p_requires_ack ──
drop function if exists public.dispatch_channel_post(uuid, text, text, text, text, int);

create or replace function public.dispatch_channel_post(
  p_channel_id            uuid,
  p_body                  text default null,
  p_attachment_path       text default null,
  p_attachment_mime       text default null,
  p_attachment_name       text default null,
  p_attachment_size_bytes int  default null,
  p_reply_to              uuid default null,
  p_requires_ack          boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_uid  uuid := auth.uid();
  v_chan public.driver_channels;
  v_body text := nullif(trim(coalesce(p_body, '')), '');
  v_msg  public.driver_channel_messages;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;

  select * into v_chan from public.driver_channels
   where id = p_channel_id and dsp_id = v_dsp;
  if v_chan.id is null then raise exception 'channel_not_found' using errcode = '42501'; end if;
  if v_chan.archived_at is not null then raise exception 'channel_archived' using errcode = '42501'; end if;

  if v_body is null and p_attachment_path is null then
    raise exception 'empty_message' using errcode = '22023';
  end if;

  if p_attachment_path is not null and p_attachment_path <> '' then
    if not (p_attachment_path like (v_dsp::text || '/%')) then
      raise exception 'invalid_attachment_path' using errcode = '42501';
    end if;
  end if;

  if p_reply_to is not null and not exists (
    select 1 from public.driver_channel_messages
     where id = p_reply_to and channel_id = p_channel_id
  ) then
    raise exception 'reply_target_not_found' using errcode = 'P0002';
  end if;

  insert into public.driver_channel_messages
    (channel_id, dsp_id, sender_kind, sender_user_id, body,
     attachment_path, attachment_mime, attachment_name, attachment_size_bytes,
     reply_to_message_id, requires_ack)
  values
    (v_chan.id, v_dsp, 'dispatch', v_uid, v_body,
     nullif(p_attachment_path, ''), nullif(p_attachment_mime, ''),
     nullif(p_attachment_name, ''), p_attachment_size_bytes,
     p_reply_to, coalesce(p_requires_ack, false))
  returning * into v_msg;

  update public.driver_channels
     set last_message_at = v_msg.created_at
   where id = v_chan.id;

  return jsonb_build_object(
    'id',          v_msg.id,
    'sender_kind', v_msg.sender_kind,
    'body',        v_msg.body,
    'created_at',  v_msg.created_at,
    'reply_to',    v_msg.reply_to_message_id,
    'requires_ack', v_msg.requires_ack,
    'attachment_path',       v_msg.attachment_path,
    'attachment_mime',       v_msg.attachment_mime,
    'attachment_name',       v_msg.attachment_name,
    'attachment_size_bytes', v_msg.attachment_size_bytes
  );
end;
$$;
grant execute on function public.dispatch_channel_post(uuid, text, text, text, text, int, uuid, boolean) to authenticated;

-- ── 5. driver_channel_post · announcement-only gate + reply support ──
drop function if exists public.driver_channel_post(text, uuid, text, text, text, text, int);

create or replace function public.driver_channel_post(
  p_token                 text,
  p_channel_id            uuid,
  p_body                  text default null,
  p_attachment_path       text default null,
  p_attachment_mime       text default null,
  p_attachment_name       text default null,
  p_attachment_size_bytes int  default null,
  p_reply_to              uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv  public.drivers;
  v_chan public.driver_channels;
  v_body text := nullif(trim(coalesce(p_body, '')), '');
  v_msg  public.driver_channel_messages;
begin
  v_drv := private.driver_validate_token(p_token);

  select * into v_chan from public.driver_channels where id = p_channel_id;
  if v_chan.id is null or v_chan.dsp_id <> v_drv.dsp_id then
    raise exception 'channel_not_found' using errcode = '42501';
  end if;
  if v_chan.archived_at is not null then
    raise exception 'channel_archived' using errcode = '42501';
  end if;
  -- Announcement-only rooms (#36): drivers read, react and acknowledge —
  -- they don't post.
  if v_chan.announcement_only then
    raise exception 'announcement_only' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.driver_channel_members
     where channel_id = p_channel_id and driver_id = v_drv.id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  if v_body is null and p_attachment_path is null then
    raise exception 'empty_message' using errcode = '22023';
  end if;

  if p_attachment_path is not null and p_attachment_path <> '' then
    if not (
      p_attachment_path like (v_drv.dsp_id::text || '/' || v_drv.id::text || '/%')
    ) then
      raise exception 'invalid_attachment_path' using errcode = '42501';
    end if;
  end if;

  if p_reply_to is not null and not exists (
    select 1 from public.driver_channel_messages
     where id = p_reply_to and channel_id = p_channel_id
  ) then
    raise exception 'reply_target_not_found' using errcode = 'P0002';
  end if;

  insert into public.driver_channel_messages
    (channel_id, dsp_id, sender_kind, sender_driver_id, body,
     attachment_path, attachment_mime, attachment_name, attachment_size_bytes,
     reply_to_message_id)
  values
    (v_chan.id, v_drv.dsp_id, 'driver', v_drv.id, v_body,
     nullif(p_attachment_path, ''), nullif(p_attachment_mime, ''),
     nullif(p_attachment_name, ''), p_attachment_size_bytes,
     p_reply_to)
  returning * into v_msg;

  update public.driver_channels
     set last_message_at = v_msg.created_at
   where id = v_chan.id;

  return jsonb_build_object(
    'id',          v_msg.id,
    'sender_kind', v_msg.sender_kind,
    'body',        v_msg.body,
    'created_at',  v_msg.created_at,
    'reply_to',    v_msg.reply_to_message_id,
    'attachment_path',       v_msg.attachment_path,
    'attachment_mime',       v_msg.attachment_mime,
    'attachment_name',       v_msg.attachment_name,
    'attachment_size_bytes', v_msg.attachment_size_bytes
  );
end;
$$;
grant execute on function public.driver_channel_post(text, uuid, text, text, text, text, int, uuid) to anon, authenticated;

-- ── 6. Channel message acknowledgements (#37/#38) ──
create table if not exists public.driver_channel_message_acks (
  message_id uuid not null references public.driver_channel_messages(id) on delete cascade,
  channel_id uuid not null references public.driver_channels(id) on delete cascade,
  dsp_id     uuid not null references public.dsps(id) on delete cascade,
  driver_id  uuid not null references public.drivers(id) on delete cascade,
  acked_at   timestamptz not null default now(),
  primary key (message_id, driver_id)
);
create index if not exists driver_channel_message_acks_ch_idx
  on public.driver_channel_message_acks (channel_id, acked_at desc);

alter table public.driver_channel_message_acks enable row level security;
drop policy if exists "driver_channel_message_acks_tenant_r" on public.driver_channel_message_acks;
create policy "driver_channel_message_acks_tenant_r"
  on public.driver_channel_message_acks for select
  using (dsp_id = private.current_dsp_id());
grant select on public.driver_channel_message_acks to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.driver_channel_message_acks;
exception when duplicate_object then null; end $$;

create or replace function public.driver_channel_ack(p_token text, p_message_id uuid)
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
  select * into v_msg from public.driver_channel_messages where id = p_message_id;
  if v_msg.id is null or v_msg.dsp_id <> v_drv.dsp_id then
    raise exception 'message_not_found' using errcode = 'P0002';
  end if;
  if not v_msg.requires_ack then raise exception 'ack_not_required' using errcode = 'P0001'; end if;
  if not exists (
    select 1 from public.driver_channel_members
     where channel_id = v_msg.channel_id and driver_id = v_drv.id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  insert into public.driver_channel_message_acks (message_id, channel_id, dsp_id, driver_id)
  values (p_message_id, v_msg.channel_id, v_msg.dsp_id, v_drv.id)
  on conflict do nothing;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.driver_channel_ack(text, uuid) to anon, authenticated;

create or replace function public.dispatch_channel_acks(p_channel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_out jsonb;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.driver_channels where id = p_channel_id and dsp_id = v_dsp) then
    raise exception 'not_found' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'message_id', a.message_id, 'driver_id', a.driver_id, 'acked_at', a.acked_at)), '[]'::jsonb)
    into v_out
    from public.driver_channel_message_acks a
   where a.channel_id = p_channel_id;
  return jsonb_build_object('acks', v_out);
end;
$$;
grant execute on function public.dispatch_channel_acks(uuid) to authenticated;

-- ── 7. Polls (#41) ──
create table if not exists public.channel_polls (
  id         uuid primary key default gen_random_uuid(),
  dsp_id     uuid not null references public.dsps(id) on delete cascade,
  channel_id uuid not null references public.driver_channels(id) on delete cascade,
  message_id uuid unique references public.driver_channel_messages(id) on delete cascade,
  question   text not null check (length(trim(question)) between 1 and 300),
  options    jsonb not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  closes_at  timestamptz
);
create index if not exists channel_polls_ch_idx on public.channel_polls (channel_id, created_at desc);

create table if not exists public.channel_poll_votes (
  poll_id    uuid not null references public.channel_polls(id) on delete cascade,
  dsp_id     uuid not null references public.dsps(id) on delete cascade,
  voter_kind text not null check (voter_kind in ('driver','dispatch')),
  driver_id  uuid references public.drivers(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete cascade,
  option_idx int  not null check (option_idx >= 0 and option_idx < 10),
  created_at timestamptz not null default now(),
  check (
    (voter_kind = 'driver' and driver_id is not null and user_id is null)
    or (voter_kind = 'dispatch' and user_id is not null and driver_id is null)
  )
);
create unique index if not exists channel_poll_votes_driver_uq
  on public.channel_poll_votes (poll_id, driver_id) where voter_kind = 'driver';
create unique index if not exists channel_poll_votes_dispatch_uq
  on public.channel_poll_votes (poll_id, user_id) where voter_kind = 'dispatch';

alter table public.channel_polls enable row level security;
alter table public.channel_poll_votes enable row level security;
drop policy if exists "channel_polls_tenant_r" on public.channel_polls;
create policy "channel_polls_tenant_r" on public.channel_polls for select
  using (dsp_id = private.current_dsp_id());
drop policy if exists "channel_poll_votes_tenant_r" on public.channel_poll_votes;
create policy "channel_poll_votes_tenant_r" on public.channel_poll_votes for select
  using (dsp_id = private.current_dsp_id());
grant select on public.channel_polls, public.channel_poll_votes to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.channel_poll_votes;
exception when duplicate_object then null; end $$;

create or replace function public.dispatch_poll_create(
  p_channel_id uuid,
  p_question   text,
  p_options    jsonb,
  p_closes_at  timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_chan public.driver_channels;
  v_q text := trim(coalesce(p_question, ''));
  v_opts jsonb;
  v_msg_id uuid;
  v_poll_id uuid;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_chan from public.driver_channels where id = p_channel_id and dsp_id = v_dsp;
  if v_chan.id is null then raise exception 'channel_not_found' using errcode = 'P0002'; end if;
  if v_chan.archived_at is not null then raise exception 'channel_archived' using errcode = '42501'; end if;
  if length(v_q) < 1 or length(v_q) > 300 then raise exception 'bad_question' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    into v_opts
    from (
      select left(trim(value::text, '"'), 80) as x
        from jsonb_array_elements(coalesce(p_options, '[]'::jsonb))
       where length(trim(value::text, '"')) between 1 and 80
       limit 10
    ) t;
  if jsonb_array_length(v_opts) < 2 then raise exception 'need_two_options' using errcode = '22023'; end if;

  insert into public.driver_channel_messages (channel_id, dsp_id, sender_kind, sender_user_id, body)
  values (p_channel_id, v_dsp, 'dispatch', v_uid, '📊 ' || v_q)
  returning id into v_msg_id;
  update public.driver_channels set last_message_at = now() where id = p_channel_id;

  insert into public.channel_polls (dsp_id, channel_id, message_id, question, options, created_by, closes_at)
  values (v_dsp, p_channel_id, v_msg_id, v_q, v_opts, v_uid, p_closes_at)
  returning id into v_poll_id;

  return jsonb_build_object('poll_id', v_poll_id, 'message_id', v_msg_id);
end;
$$;
grant execute on function public.dispatch_poll_create(uuid, text, jsonb, timestamptz) to authenticated;

create or replace function public.dispatch_channel_polls(p_channel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.driver_channels where id = p_channel_id and dsp_id = v_dsp) then
    raise exception 'not_found' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'poll_id', p.id, 'message_id', p.message_id, 'question', p.question,
           'options', p.options, 'closes_at', p.closes_at,
           'counts', (
             select coalesce(jsonb_agg(cnt order by idx), '[]'::jsonb)
               from (
                 select gs.idx, count(v.poll_id)::int as cnt
                   from generate_series(0, jsonb_array_length(p.options) - 1) as gs(idx)
                   left join public.channel_poll_votes v
                     on v.poll_id = p.id and v.option_idx = gs.idx
                  group by gs.idx
               ) c
           ),
           'my_vote', (
             select v.option_idx from public.channel_poll_votes v
              where v.poll_id = p.id and v.voter_kind = 'dispatch' and v.user_id = v_uid
              limit 1
           ),
           'voters', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'kind', v.voter_kind, 'driver_id', v.driver_id, 'option_idx', v.option_idx)), '[]'::jsonb)
               from public.channel_poll_votes v where v.poll_id = p.id
           )
         ) order by p.created_at desc), '[]'::jsonb)
    into v_out
    from public.channel_polls p
   where p.channel_id = p_channel_id;
  return jsonb_build_object('polls', v_out);
end;
$$;
grant execute on function public.dispatch_channel_polls(uuid) to authenticated;

create or replace function public.dispatch_poll_vote(p_poll_id uuid, p_option int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_poll public.channel_polls;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  select * into v_poll from public.channel_polls where id = p_poll_id and dsp_id = v_dsp;
  if v_poll.id is null then raise exception 'poll_not_found' using errcode = 'P0002'; end if;
  if v_poll.closes_at is not null and v_poll.closes_at < now() then
    raise exception 'poll_closed' using errcode = 'P0001';
  end if;
  if p_option is null or p_option < 0 or p_option >= jsonb_array_length(v_poll.options) then
    raise exception 'bad_option' using errcode = '22023';
  end if;
  insert into public.channel_poll_votes (poll_id, dsp_id, voter_kind, user_id, option_idx)
  values (p_poll_id, v_dsp, 'dispatch', v_uid, p_option)
  on conflict (poll_id, user_id) where voter_kind = 'dispatch'
  do update set option_idx = excluded.option_idx, created_at = now();
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.dispatch_poll_vote(uuid, int) to authenticated;

create or replace function public.driver_channel_polls(p_token text, p_channel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_out jsonb;
begin
  v_drv := private.driver_validate_token(p_token);
  if not exists (
    select 1 from public.driver_channel_members
     where channel_id = p_channel_id and driver_id = v_drv.id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'poll_id', p.id, 'message_id', p.message_id, 'question', p.question,
           'options', p.options, 'closes_at', p.closes_at,
           'counts', (
             select coalesce(jsonb_agg(cnt order by idx), '[]'::jsonb)
               from (
                 select gs.idx, count(v.poll_id)::int as cnt
                   from generate_series(0, jsonb_array_length(p.options) - 1) as gs(idx)
                   left join public.channel_poll_votes v
                     on v.poll_id = p.id and v.option_idx = gs.idx
                  group by gs.idx
               ) c
           ),
           'my_vote', (
             select v.option_idx from public.channel_poll_votes v
              where v.poll_id = p.id and v.voter_kind = 'driver' and v.driver_id = v_drv.id
              limit 1
           )
         ) order by p.created_at desc), '[]'::jsonb)
    into v_out
    from public.channel_polls p
   where p.channel_id = p_channel_id;
  return jsonb_build_object('polls', v_out);
end;
$$;
grant execute on function public.driver_channel_polls(text, uuid) to anon, authenticated;

create or replace function public.driver_poll_vote(p_token text, p_poll_id uuid, p_option int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_poll public.channel_polls;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_poll from public.channel_polls where id = p_poll_id and dsp_id = v_drv.dsp_id;
  if v_poll.id is null then raise exception 'poll_not_found' using errcode = 'P0002'; end if;
  if v_poll.closes_at is not null and v_poll.closes_at < now() then
    raise exception 'poll_closed' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.driver_channel_members
     where channel_id = v_poll.channel_id and driver_id = v_drv.id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  if p_option is null or p_option < 0 or p_option >= jsonb_array_length(v_poll.options) then
    raise exception 'bad_option' using errcode = '22023';
  end if;
  insert into public.channel_poll_votes (poll_id, dsp_id, voter_kind, driver_id, option_idx)
  values (p_poll_id, v_drv.dsp_id, 'driver', v_drv.id, p_option)
  on conflict (poll_id, driver_id) where voter_kind = 'driver'
  do update set option_idx = excluded.option_idx, created_at = now();
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.driver_poll_vote(text, uuid, int) to anon, authenticated;

-- ── 8. Recurring broadcasts (#39) ──
-- dispatch_schedule_message gains repeat params (drop the 0484 signature
-- to avoid overload ambiguity).
drop function if exists public.dispatch_schedule_message(text, timestamptz, uuid, uuid, text, text, text, text, int, text, boolean, uuid[]);

create or replace function public.dispatch_schedule_message(
  p_target_kind           text,
  p_send_at               timestamptz,
  p_driver_id             uuid    default null,
  p_channel_id            uuid    default null,
  p_body                  text    default null,
  p_attachment_path       text    default null,
  p_attachment_mime       text    default null,
  p_attachment_name       text    default null,
  p_attachment_size_bytes int     default null,
  p_priority              text    default 'normal',
  p_requires_ack          boolean default false,
  p_mention_driver_ids    uuid[]  default null,
  p_repeat_every          text    default 'none',
  p_repeat_until          timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_uid  uuid := auth.uid();
  v_body text := nullif(trim(coalesce(p_body, '')), '');
  v_id   uuid;
  v_rep  text := lower(coalesce(p_repeat_every, 'none'));
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_target_kind not in ('driver','channel') then raise exception 'invalid_kind' using errcode = '22023'; end if;
  if p_send_at is null or p_send_at <= now() then raise exception 'send_at_must_be_future' using errcode = '22023'; end if;
  if v_body is null and p_attachment_path is null then raise exception 'empty_message' using errcode = '22023'; end if;
  if v_body is not null and length(v_body) > 2000 then raise exception 'too_long' using errcode = '22023'; end if;
  if v_rep not in ('none','daily','weekdays','weekly') then raise exception 'bad_repeat' using errcode = '22023'; end if;

  if p_target_kind = 'driver' then
    if p_driver_id is null then raise exception 'driver_required' using errcode = '22023'; end if;
    if not exists (select 1 from public.drivers where id = p_driver_id and dsp_id = v_dsp) then
      raise exception 'driver_not_found' using errcode = 'P0002';
    end if;
  else
    if p_channel_id is null then raise exception 'channel_required' using errcode = '22023'; end if;
    if not exists (select 1 from public.driver_channels where id = p_channel_id and dsp_id = v_dsp and archived_at is null) then
      raise exception 'channel_not_found' using errcode = 'P0002';
    end if;
  end if;

  insert into public.scheduled_messages
    (dsp_id, created_by, target_kind, driver_id, channel_id, body,
     attachment_path, attachment_mime, attachment_name, attachment_size_bytes,
     priority, requires_ack, mention_driver_ids, send_at, repeat_every, repeat_until)
  values
    (v_dsp, v_uid, p_target_kind,
     case when p_target_kind = 'driver'  then p_driver_id  end,
     case when p_target_kind = 'channel' then p_channel_id end,
     v_body,
     nullif(p_attachment_path, ''), nullif(p_attachment_mime, ''),
     nullif(p_attachment_name, ''), p_attachment_size_bytes,
     lower(coalesce(p_priority, 'normal')), coalesce(p_requires_ack, false),
     case when p_target_kind = 'channel' then p_mention_driver_ids end,
     p_send_at, v_rep, p_repeat_until)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'send_at', p_send_at, 'repeat_every', v_rep);
end;
$$;
grant execute on function public.dispatch_schedule_message(text, timestamptz, uuid, uuid, text, text, text, text, int, text, boolean, uuid[], text, timestamptz) to authenticated;

-- Next occurrence after a fired repeat: daily +1d, weekly +7d, weekdays →
-- next Mon–Fri, preserving the time of day.
create or replace function private.next_scheduled_occurrence(p_at timestamptz, p_repeat text)
returns timestamptz
language plpgsql
immutable
as $$
declare
  v_next timestamptz := p_at;
begin
  if p_repeat = 'daily' then
    v_next := p_at + interval '1 day';
  elsif p_repeat = 'weekly' then
    v_next := p_at + interval '7 days';
  elsif p_repeat = 'weekdays' then
    v_next := p_at + interval '1 day';
    while extract(isodow from v_next) > 5 loop
      v_next := v_next + interval '1 day';
    end loop;
  else
    return null;
  end if;
  return v_next;
end;
$$;

-- Flush worker: on sending a repeating row, queue the next occurrence as a
-- fresh pending row (the fired row keeps its sent audit trail).
create or replace function private.flush_scheduled_messages()
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r        public.scheduled_messages;
  v_msg_id uuid;
  v_pri    public.message_priority;
  v_sent   int := 0;
  v_next   timestamptz;
begin
  for r in
    select * from public.scheduled_messages
     where status = 'pending' and send_at <= now()
     order by send_at
     for update skip locked
     limit 500
  loop
    begin
      if r.target_kind = 'driver' then
        v_pri := case lower(coalesce(r.priority, 'normal'))
          when 'urgent' then 'urgent'::public.message_priority
          when 'high'   then 'high'::public.message_priority
          else 'normal'::public.message_priority
        end;
        insert into public.driver_messages
          (driver_id, dsp_id, sender_kind, sender_user_id, body,
           attachment_path, attachment_mime, attachment_name, attachment_size_bytes,
           priority, requires_ack)
        values
          (r.driver_id, r.dsp_id, 'dispatch', r.created_by, nullif(trim(coalesce(r.body, '')), ''),
           r.attachment_path, r.attachment_mime, r.attachment_name, r.attachment_size_bytes,
           v_pri, coalesce(r.requires_ack, false))
        returning id into v_msg_id;

        insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
        values (r.driver_id, r.dsp_id, now())
        on conflict (driver_id) do update set last_message_at = excluded.last_message_at;

      else
        insert into public.driver_channel_messages
          (channel_id, dsp_id, sender_kind, sender_user_id, body,
           attachment_path, attachment_mime, attachment_name, attachment_size_bytes,
           requires_ack)
        values
          (r.channel_id, r.dsp_id, 'dispatch', r.created_by, nullif(trim(coalesce(r.body, '')), ''),
           r.attachment_path, r.attachment_mime, r.attachment_name, r.attachment_size_bytes,
           coalesce(r.requires_ack, false))
        returning id into v_msg_id;

        update public.driver_channels set last_message_at = now() where id = r.channel_id;

        if r.mention_driver_ids is not null and array_length(r.mention_driver_ids, 1) > 0 then
          insert into public.driver_channel_message_mentions
            (message_id, channel_id, dsp_id, mentioned_driver_id)
          select v_msg_id, r.channel_id, r.dsp_id, m.driver_id
            from public.driver_channel_members m
           where m.channel_id = r.channel_id and m.driver_id = any(r.mention_driver_ids)
          on conflict do nothing;
        end if;
      end if;

      update public.scheduled_messages
         set status = 'sent', sent_message_id = v_msg_id, sent_at = now()
       where id = r.id;
      v_sent := v_sent + 1;

      -- Recurrence (#39): queue the next occurrence.
      if coalesce(r.repeat_every, 'none') <> 'none' then
        v_next := private.next_scheduled_occurrence(r.send_at, r.repeat_every);
        -- Catch up past-due occurrences (e.g. cron was down) without
        -- firing a burst — skip straight to the next future slot.
        while v_next is not null and v_next <= now() loop
          v_next := private.next_scheduled_occurrence(v_next, r.repeat_every);
        end loop;
        if v_next is not null and (r.repeat_until is null or v_next <= r.repeat_until) then
          insert into public.scheduled_messages
            (dsp_id, created_by, target_kind, driver_id, channel_id, body,
             attachment_path, attachment_mime, attachment_name, attachment_size_bytes,
             priority, requires_ack, mention_driver_ids, send_at, repeat_every, repeat_until)
          values
            (r.dsp_id, r.created_by, r.target_kind, r.driver_id, r.channel_id, r.body,
             r.attachment_path, r.attachment_mime, r.attachment_name, r.attachment_size_bytes,
             r.priority, r.requires_ack, r.mention_driver_ids, v_next, r.repeat_every, r.repeat_until);
        end if;
      end if;
    exception when others then
      update public.scheduled_messages
         set status = 'failed', error = left(SQLERRM, 500), sent_at = now()
       where id = r.id;
    end;
  end loop;
  return v_sent;
end;
$fn$;

notify pgrst, 'reload schema';
