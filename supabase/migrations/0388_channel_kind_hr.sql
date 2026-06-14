-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0388 · HR group channels (kind discriminator)
--
-- HR groups are a true membership space — drivers are explicitly added /
-- removed, dispatch posts and moderates — exactly like the broadcast
-- channels from migration 0073.  Rather than fork a parallel system, we add
-- a `kind` column to driver_channels ('broadcast' | 'hr') and let the
-- Messages page show each kind on its own tab.  Every existing channel is a
-- 'broadcast' (the column default), so nothing moves.
--
-- All membership, threading, posting, archiving, station-auto-join, RLS, and
-- driver-side RPCs from 0073 are reused unchanged.  Only three functions
-- change: the two list RPCs (surface `kind`) and create (accept `p_kind`).
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Column ──
alter table public.driver_channels
  add column if not exists kind text not null default 'broadcast';

alter table public.driver_channels
  drop constraint if exists driver_channels_kind_chk;
alter table public.driver_channels
  add constraint driver_channels_kind_chk check (kind in ('broadcast','hr'));

create index if not exists driver_channels_kind_idx
  on public.driver_channels (dsp_id, kind, archived_at, last_message_at desc);


-- ── 2. dispatch_channels_list · surface kind ──
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
    'kind',            c.kind,
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


-- ── 3. dispatch_channel_create · accept kind ──
-- Signature changes (extra p_kind arg) so drop the 0073 three-arg version
-- first.  The new four-arg version is backward compatible: a 3-named-arg
-- call still resolves here because p_kind defaults to 'broadcast'.
drop function if exists public.dispatch_channel_create(text, text, uuid);
create or replace function public.dispatch_channel_create(
  p_name        text,
  p_description text default null,
  p_station_id  uuid default null,
  p_kind        text default 'broadcast'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_uid  uuid := auth.uid();
  v_id   uuid;
  v_kind text := case when p_kind = 'hr' then 'hr' else 'broadcast' end;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'name_required' using errcode = '22023';
  end if;

  insert into public.driver_channels (dsp_id, name, description, station_id, created_by, kind)
  values (v_dsp, trim(p_name), nullif(trim(p_description), ''), p_station_id, v_uid, v_kind)
  returning id into v_id;

  -- If station-scoped, populate membership immediately.
  if p_station_id is not null then
    perform private.sync_channel_station_members(v_id);
  end if;

  return jsonb_build_object('id', v_id);
end;
$$;

grant execute on function public.dispatch_channel_create(text, text, uuid, text) to authenticated;


-- ── 4. driver_channels_list · surface kind (additive; driver app ignores it) ──
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
    'kind',            c.kind,
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
