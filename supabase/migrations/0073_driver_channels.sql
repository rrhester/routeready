-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0073 · Driver group channels
--
-- Drivers (and dispatchers) post into shared rooms scoped to a DSP.
-- Channels can optionally be tied to a station_id; drivers at that
-- station auto-join, and joining/leaving a station auto-syncs membership.
-- Dispatchers can read every channel in their DSP for moderation; no
-- private back-channels.
--
-- Schema
--   driver_channels          one row per channel
--   driver_channel_members   composite (channel_id, driver_id) + last_read_at + muted
--   driver_channel_messages  one row per post (driver or dispatcher sender)
--
-- Backend surface
--   Driver-side  (token-scoped, anon-callable):
--     driver_channels_list(token)
--     driver_channel_messages(token, channel_id, limit)
--     driver_channel_post(token, channel_id, body, attachment_*)
--     driver_channel_mark_read(token, channel_id)
--     driver_channel_mute(token, channel_id, muted)
--   Dispatcher-side (auth.uid() scoped):
--     dispatch_channels_list()
--     dispatch_channel_create(name, description, station_id)
--     dispatch_channel_archive(channel_id, archived)
--     dispatch_channel_members(channel_id)
--     dispatch_channel_add_member(channel_id, driver_id)
--     dispatch_channel_remove_member(channel_id, driver_id)
--     dispatch_channel_messages(channel_id, limit)
--     dispatch_channel_post(channel_id, body, attachment_*)
--     dispatch_channel_mark_read(channel_id)
--
-- Attachments reuse the existing driver-chat-attachments bucket; storage
-- policies from 0072 are unchanged. RPCs validate path prefixes.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Tables ──
create table if not exists public.driver_channels (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  name            text not null check (length(trim(name)) between 1 and 80),
  description     text check (description is null or length(description) <= 280),
  station_id      uuid references public.stations(id) on delete set null,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  archived_at     timestamptz,
  last_message_at timestamptz,
  unique (dsp_id, name)
);
create index if not exists driver_channels_dsp_idx
  on public.driver_channels (dsp_id, archived_at, last_message_at desc);

create table if not exists public.driver_channel_members (
  channel_id    uuid not null references public.driver_channels(id) on delete cascade,
  driver_id     uuid not null references public.drivers(id) on delete cascade,
  added_by      uuid references auth.users(id),
  added_at      timestamptz not null default now(),
  last_read_at  timestamptz,
  muted         boolean not null default false,
  primary key (channel_id, driver_id)
);
create index if not exists driver_channel_members_drv_idx
  on public.driver_channel_members (driver_id);

create table if not exists public.driver_channel_messages (
  id                     uuid primary key default gen_random_uuid(),
  channel_id             uuid not null references public.driver_channels(id) on delete cascade,
  dsp_id                 uuid not null references public.dsps(id) on delete cascade,
  sender_kind            text not null check (sender_kind in ('driver','dispatch')),
  sender_driver_id       uuid references public.drivers(id) on delete set null,
  sender_user_id         uuid references auth.users(id),
  body                   text,
  attachment_path        text,
  attachment_mime        text,
  attachment_name        text,
  attachment_size_bytes  int,
  created_at             timestamptz not null default now(),
  check (
    (sender_kind = 'driver'   and sender_driver_id is not null)
    or
    (sender_kind = 'dispatch' and sender_user_id is not null)
  ),
  check (
    (body is not null and length(trim(body)) > 0 and length(body) <= 2000)
    or attachment_path is not null
  )
);
create index if not exists driver_channel_messages_chan_idx
  on public.driver_channel_messages (channel_id, created_at desc);
create index if not exists driver_channel_messages_dsp_idx
  on public.driver_channel_messages (dsp_id, created_at desc);


-- ── 2. RLS ──
-- Direct-table access is dispatch-only.  Drivers go through RPCs.
alter table public.driver_channels         enable row level security;
alter table public.driver_channel_members  enable row level security;
alter table public.driver_channel_messages enable row level security;

drop policy if exists "driver_channels_tenant_r" on public.driver_channels;
create policy "driver_channels_tenant_r"
  on public.driver_channels for select
  using (dsp_id = private.current_dsp_id());

drop policy if exists "driver_channel_members_tenant_r" on public.driver_channel_members;
create policy "driver_channel_members_tenant_r"
  on public.driver_channel_members for select
  using (
    exists (
      select 1 from public.driver_channels c
      where c.id = driver_channel_members.channel_id
        and c.dsp_id = private.current_dsp_id()
    )
  );

drop policy if exists "driver_channel_messages_tenant_r" on public.driver_channel_messages;
create policy "driver_channel_messages_tenant_r"
  on public.driver_channel_messages for select
  using (dsp_id = private.current_dsp_id());

grant select on public.driver_channels         to authenticated;
grant select on public.driver_channel_members  to authenticated;
grant select on public.driver_channel_messages to authenticated;


-- ── 3. Station-auto-membership ──
-- When a channel is tied to a station, every active/onboarding driver at
-- that station is a member.  When a driver's station changes, station-
-- scoped memberships sync.  When the channel station changes, members
-- are recomputed.
create or replace function private.sync_channel_station_members(p_channel_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chan public.driver_channels;
begin
  select * into v_chan from public.driver_channels where id = p_channel_id;
  if v_chan.station_id is null then return; end if;

  -- Add every active driver at that station.
  insert into public.driver_channel_members (channel_id, driver_id)
  select v_chan.id, d.id
    from public.drivers d
   where d.dsp_id = v_chan.dsp_id
     and d.station_id = v_chan.station_id
     and d.status in ('active','onboarding')
  on conflict do nothing;

  -- Remove anyone no longer matching the station scope (left or terminated).
  delete from public.driver_channel_members m
   where m.channel_id = v_chan.id
     and not exists (
       select 1 from public.drivers d
        where d.id = m.driver_id
          and d.dsp_id = v_chan.dsp_id
          and d.station_id = v_chan.station_id
          and d.status in ('active','onboarding')
     );
end;
$$;

create or replace function private.sync_driver_channels(p_driver_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  select * into v_drv from public.drivers where id = p_driver_id;
  if v_drv is null then return; end if;

  -- Remove driver from station-scoped channels they no longer match.
  delete from public.driver_channel_members m
   using public.driver_channels c
   where m.channel_id = c.id
     and m.driver_id = p_driver_id
     and c.station_id is not null
     and c.dsp_id = v_drv.dsp_id
     and (
       v_drv.station_id is null
       or v_drv.station_id <> c.station_id
       or v_drv.status not in ('active','onboarding')
     );

  -- Add driver to station-scoped channels they now match.
  if v_drv.station_id is not null and v_drv.status in ('active','onboarding') then
    insert into public.driver_channel_members (channel_id, driver_id)
    select c.id, p_driver_id
      from public.driver_channels c
     where c.dsp_id = v_drv.dsp_id
       and c.station_id = v_drv.station_id
       and c.archived_at is null
    on conflict do nothing;
  end if;
end;
$$;

-- Trigger on drivers: any station_id / status change reshuffles
-- station-scoped channel memberships for that driver.
create or replace function private.trg_drivers_sync_channels()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    perform private.sync_driver_channels(NEW.id);
  elsif TG_OP = 'UPDATE' and (
        coalesce(NEW.station_id::text,'') is distinct from coalesce(OLD.station_id::text,'')
     or NEW.status is distinct from OLD.status
  ) then
    perform private.sync_driver_channels(NEW.id);
  end if;
  return NEW;
end;
$$;

drop trigger if exists drivers_sync_channels on public.drivers;
create trigger drivers_sync_channels
  after insert or update on public.drivers
  for each row execute function private.trg_drivers_sync_channels();


-- ── 4. Dispatcher RPCs ──

-- 4a. List channels in DSP with member count, last message preview, my-unread.
create or replace function public.dispatch_channels_list()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_rows jsonb;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',              c.id,
    'name',            c.name,
    'description',     c.description,
    'station_id',      c.station_id,
    'station_code',    s.code,
    'archived_at',     c.archived_at,
    'last_message_at', c.last_message_at,
    'last_message',    last_msg.preview,
    'last_sender',     last_msg.sender,
    'member_count',    coalesce(mc.n, 0)
  ) order by (c.archived_at is null) desc, coalesce(c.last_message_at, c.created_at) desc), '[]'::jsonb)
    into v_rows
    from public.driver_channels c
    left join public.stations s on s.id = c.station_id
    left join lateral (
      select count(*) as n
        from public.driver_channel_members m
       where m.channel_id = c.id
    ) mc on true
    left join lateral (
      select left(coalesce(m.body, m.attachment_name, ''), 80) as preview,
             case when m.sender_kind = 'driver'
                  then (select full_name from public.drivers where id = m.sender_driver_id)
                  else (select coalesce(full_name, email) from public.app_users where id = m.sender_user_id)
             end as sender
        from public.driver_channel_messages m
       where m.channel_id = c.id
       order by m.created_at desc
       limit 1
    ) last_msg on true
   where c.dsp_id = v_dsp;

  return jsonb_build_object('channels', v_rows);
end;
$$;

-- 4b. Create channel.
create or replace function public.dispatch_channel_create(
  p_name        text,
  p_description text default null,
  p_station_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'name_required' using errcode = '22023';
  end if;

  insert into public.driver_channels (dsp_id, name, description, station_id, created_by)
  values (v_dsp, trim(p_name), nullif(trim(p_description), ''), p_station_id, v_uid)
  returning id into v_id;

  -- If station-scoped, populate membership immediately.
  if p_station_id is not null then
    perform private.sync_channel_station_members(v_id);
  end if;

  return jsonb_build_object('id', v_id);
end;
$$;

-- 4c. Archive / unarchive.
create or replace function public.dispatch_channel_archive(
  p_channel_id uuid,
  p_archived   boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;

  update public.driver_channels
     set archived_at = case when p_archived then now() else null end
   where id = p_channel_id and dsp_id = v_dsp;
end;
$$;

-- 4d. List members of a channel.
create or replace function public.dispatch_channel_members(p_channel_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_rows jsonb;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;

  if not exists (select 1 from public.driver_channels where id = p_channel_id and dsp_id = v_dsp) then
    raise exception 'not_found' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'driver_id',     d.id,
    'full_name',     d.full_name,
    'station_code',  s.code,
    'status',        d.status,
    'added_at',      m.added_at,
    'last_read_at',  m.last_read_at
  ) order by d.full_name), '[]'::jsonb)
    into v_rows
    from public.driver_channel_members m
    join public.drivers d on d.id = m.driver_id
    left join public.stations s on s.id = d.station_id
   where m.channel_id = p_channel_id;

  return jsonb_build_object('members', v_rows);
end;
$$;

-- 4e. Add a member.
create or replace function public.dispatch_channel_add_member(
  p_channel_id uuid,
  p_driver_id  uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;

  if not exists (select 1 from public.driver_channels where id = p_channel_id and dsp_id = v_dsp) then
    raise exception 'channel_not_found' using errcode = '42501';
  end if;
  if not exists (select 1 from public.drivers where id = p_driver_id and dsp_id = v_dsp) then
    raise exception 'driver_not_found' using errcode = '42501';
  end if;

  insert into public.driver_channel_members (channel_id, driver_id, added_by)
  values (p_channel_id, p_driver_id, v_uid)
  on conflict do nothing;
end;
$$;

-- 4f. Remove a member.
create or replace function public.dispatch_channel_remove_member(
  p_channel_id uuid,
  p_driver_id  uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;

  delete from public.driver_channel_members
   where channel_id = p_channel_id
     and driver_id  = p_driver_id
     and exists (
       select 1 from public.driver_channels c
        where c.id = p_channel_id and c.dsp_id = v_dsp
     );
end;
$$;

-- 4g. Read messages for one channel.
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

-- 4h. Post as dispatcher.
create or replace function public.dispatch_channel_post(
  p_channel_id            uuid,
  p_body                  text default null,
  p_attachment_path       text default null,
  p_attachment_mime       text default null,
  p_attachment_name       text default null,
  p_attachment_size_bytes int  default null
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

  insert into public.driver_channel_messages
    (channel_id, dsp_id, sender_kind, sender_user_id, body,
     attachment_path, attachment_mime, attachment_name, attachment_size_bytes)
  values
    (v_chan.id, v_dsp, 'dispatch', v_uid, v_body,
     nullif(p_attachment_path, ''), nullif(p_attachment_mime, ''),
     nullif(p_attachment_name, ''), p_attachment_size_bytes)
  returning * into v_msg;

  update public.driver_channels
     set last_message_at = v_msg.created_at
   where id = v_chan.id;

  return jsonb_build_object(
    'id',          v_msg.id,
    'sender_kind', v_msg.sender_kind,
    'body',        v_msg.body,
    'created_at',  v_msg.created_at,
    'attachment_path',       v_msg.attachment_path,
    'attachment_mime',       v_msg.attachment_mime,
    'attachment_name',       v_msg.attachment_name,
    'attachment_size_bytes', v_msg.attachment_size_bytes
  );
end;
$$;

-- 4i. Mark all read for the calling dispatcher.  Currently dispatcher
-- read state is global per-channel (no per-dispatcher unread); we just
-- expose this so the UI doesn't need to track anything.
create or replace function public.dispatch_channel_mark_read(p_channel_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Placeholder so the dashboard can call this; if we add per-operator
  -- read state later this becomes the write point.
  perform 1;
end;
$$;


-- ── 5. Driver-side RPCs (token-scoped, anon-callable) ──

-- 5a. List channels the driver is in, with unread counts and last message.
create or replace function public.driver_channels_list(p_token text)
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
    'id',              c.id,
    'name',            c.name,
    'description',     c.description,
    'station_code',    s.code,
    'last_message_at', c.last_message_at,
    'last_message',    last_msg.preview,
    'last_sender',     last_msg.sender,
    'unread',          coalesce(uc.n, 0),
    'muted',           m.muted,
    'member_count',    coalesce(mc.n, 0)
  ) order by coalesce(c.last_message_at, c.created_at) desc), '[]'::jsonb)
    into v_rows
    from public.driver_channel_members m
    join public.driver_channels c on c.id = m.channel_id
    left join public.stations s on s.id = c.station_id
    left join lateral (
      select count(*) as n
        from public.driver_channel_messages msg
       where msg.channel_id = c.id
         and (m.last_read_at is null or msg.created_at > m.last_read_at)
         and not (msg.sender_kind = 'driver' and msg.sender_driver_id = v_drv.id)
    ) uc on true
    left join lateral (
      select count(*) as n
        from public.driver_channel_members mm
       where mm.channel_id = c.id
    ) mc on true
    left join lateral (
      select left(coalesce(msg.body, msg.attachment_name, ''), 80) as preview,
             case when msg.sender_kind = 'driver'
                  then (select full_name from public.drivers where id = msg.sender_driver_id)
                  else 'Dispatch'
             end as sender
        from public.driver_channel_messages msg
       where msg.channel_id = c.id
       order by msg.created_at desc
       limit 1
    ) last_msg on true
   where m.driver_id = v_drv.id
     and c.archived_at is null;

  return jsonb_build_object('channels', v_rows);
end;
$$;

-- 5b. Read one channel's messages.  Bumps last_read_at.
create or replace function public.driver_channel_messages(
  p_token      text,
  p_channel_id uuid,
  p_limit      int default 200
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv  public.drivers;
  v_msgs jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  if not exists (
    select 1 from public.driver_channel_members
     where channel_id = p_channel_id and driver_id = v_drv.id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_to_json(t) order by t.created_at), '[]'::jsonb) into v_msgs
    from (
      select msg.id, msg.sender_kind, msg.body,
             msg.attachment_path, msg.attachment_mime, msg.attachment_name, msg.attachment_size_bytes,
             msg.created_at,
             case when msg.sender_kind = 'driver'
                  then (select full_name from public.drivers where id = msg.sender_driver_id)
                  else 'Dispatch'
             end as sender_name,
             (msg.sender_kind = 'driver' and msg.sender_driver_id = v_drv.id) as is_self
        from public.driver_channel_messages msg
       where msg.channel_id = p_channel_id
       order by msg.created_at desc
       limit greatest(1, least(p_limit, 500))
    ) t;

  update public.driver_channel_members
     set last_read_at = now()
   where channel_id = p_channel_id and driver_id = v_drv.id;

  return jsonb_build_object('messages', v_msgs);
end;
$$;

-- 5c. Post a message.
create or replace function public.driver_channel_post(
  p_token                 text,
  p_channel_id            uuid,
  p_body                  text default null,
  p_attachment_path       text default null,
  p_attachment_mime       text default null,
  p_attachment_name       text default null,
  p_attachment_size_bytes int  default null
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

  if not exists (
    select 1 from public.driver_channel_members
     where channel_id = p_channel_id and driver_id = v_drv.id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  if v_body is null and p_attachment_path is null then
    raise exception 'empty_message' using errcode = '22023';
  end if;

  -- Driver-uploaded attachments must live under the driver's own dir to
  -- match the existing storage RLS pattern from migration 0072.
  if p_attachment_path is not null and p_attachment_path <> '' then
    if not (
      p_attachment_path like (v_drv.dsp_id::text || '/' || v_drv.id::text || '/%')
    ) then
      raise exception 'invalid_attachment_path' using errcode = '42501';
    end if;
  end if;

  insert into public.driver_channel_messages
    (channel_id, dsp_id, sender_kind, sender_driver_id, body,
     attachment_path, attachment_mime, attachment_name, attachment_size_bytes)
  values
    (v_chan.id, v_drv.dsp_id, 'driver', v_drv.id, v_body,
     nullif(p_attachment_path, ''), nullif(p_attachment_mime, ''),
     nullif(p_attachment_name, ''), p_attachment_size_bytes)
  returning * into v_msg;

  update public.driver_channels
     set last_message_at = v_msg.created_at
   where id = v_chan.id;

  return jsonb_build_object(
    'id',          v_msg.id,
    'sender_kind', v_msg.sender_kind,
    'body',        v_msg.body,
    'created_at',  v_msg.created_at,
    'attachment_path',       v_msg.attachment_path,
    'attachment_mime',       v_msg.attachment_mime,
    'attachment_name',       v_msg.attachment_name,
    'attachment_size_bytes', v_msg.attachment_size_bytes
  );
end;
$$;

-- 5d. Mark a channel read.
create or replace function public.driver_channel_mark_read(
  p_token      text,
  p_channel_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
  update public.driver_channel_members
     set last_read_at = now()
   where channel_id = p_channel_id and driver_id = v_drv.id;
end;
$$;

-- 5e. Mute / unmute push for a channel.
create or replace function public.driver_channel_mute(
  p_token      text,
  p_channel_id uuid,
  p_muted      boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
  update public.driver_channel_members
     set muted = coalesce(p_muted, false)
   where channel_id = p_channel_id and driver_id = v_drv.id;
end;
$$;


-- ── 6. Grants ──
grant execute on function public.dispatch_channels_list()                        to authenticated;
grant execute on function public.dispatch_channel_create(text, text, uuid)       to authenticated;
grant execute on function public.dispatch_channel_archive(uuid, boolean)         to authenticated;
grant execute on function public.dispatch_channel_members(uuid)                  to authenticated;
grant execute on function public.dispatch_channel_add_member(uuid, uuid)         to authenticated;
grant execute on function public.dispatch_channel_remove_member(uuid, uuid)      to authenticated;
grant execute on function public.dispatch_channel_messages(uuid, int)            to authenticated;
grant execute on function public.dispatch_channel_post(uuid, text, text, text, text, int) to authenticated;
grant execute on function public.dispatch_channel_mark_read(uuid)                to authenticated;

grant execute on function public.driver_channels_list(text)                                              to anon, authenticated;
grant execute on function public.driver_channel_messages(text, uuid, int)                                to anon, authenticated;
grant execute on function public.driver_channel_post(text, uuid, text, text, text, text, int)            to anon, authenticated;
grant execute on function public.driver_channel_mark_read(text, uuid)                                    to anon, authenticated;
grant execute on function public.driver_channel_mute(text, uuid, boolean)                                to anon, authenticated;
