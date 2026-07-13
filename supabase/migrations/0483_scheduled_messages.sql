-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0483 · Scheduled send (dispatch → driver DM or channel)
--
-- Lets a dispatcher compose a message now and have it delivered at a future
-- time — e.g. pre-staging tomorrow's route/dock assignments.  A scheduled
-- message sits in scheduled_messages until due, then a worker inserts it into
-- the real message table (driver_messages or driver_channel_messages), which
-- fires the existing push + realtime pipeline exactly as a live send would.
--
-- ⚠️ HIGH BLAST RADIUS — this writes into the auth-critical driver-message
-- tables from a background worker (no auth.uid() in cron context, so the row
-- is stamped sender_user_id = the scheduling operator).  Delivery has two
-- independent drivers, either of which is sufficient:
--   1. pg_cron job 'flush-scheduled-messages' (every minute) — primary.
--   2. dispatch_flush_scheduled() — a staff-callable fallback the dashboard
--      pings on load, so due messages still go out if pg_cron is disabled.
-- Both call the same idempotent, row-locked flush (FOR UPDATE SKIP LOCKED),
-- so concurrent runs never double-send.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Table ──
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


-- ── 2. RLS ──  Operators read scheduled messages in their DSP.
alter table public.scheduled_messages enable row level security;
drop policy if exists "scheduled_messages_tenant_r" on public.scheduled_messages;
create policy "scheduled_messages_tenant_r"
  on public.scheduled_messages for select
  using (dsp_id = private.current_dsp_id());
grant select on public.scheduled_messages to authenticated;


-- ── 3. Schedule / list / cancel RPCs ──

-- 3a. Schedule a message.  send_at must be in the future.
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
  p_mention_driver_ids    uuid[]  default null
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
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_target_kind not in ('driver','channel') then raise exception 'invalid_kind' using errcode = '22023'; end if;
  if p_send_at is null or p_send_at <= now() then raise exception 'send_at_must_be_future' using errcode = '22023'; end if;
  if v_body is null and p_attachment_path is null then raise exception 'empty_message' using errcode = '22023'; end if;
  if v_body is not null and length(v_body) > 2000 then raise exception 'too_long' using errcode = '22023'; end if;

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
     priority, requires_ack, mention_driver_ids, send_at)
  values
    (v_dsp, v_uid, p_target_kind,
     case when p_target_kind = 'driver'  then p_driver_id  end,
     case when p_target_kind = 'channel' then p_channel_id end,
     v_body,
     nullif(p_attachment_path, ''), nullif(p_attachment_mime, ''),
     nullif(p_attachment_name, ''), p_attachment_size_bytes,
     lower(coalesce(p_priority, 'normal')), coalesce(p_requires_ack, false),
     case when p_target_kind = 'channel' then p_mention_driver_ids end,
     p_send_at)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'send_at', p_send_at);
end;
$$;
grant execute on function public.dispatch_schedule_message(text, timestamptz, uuid, uuid, text, text, text, text, int, text, boolean, uuid[]) to authenticated;

-- 3b. Pending + recently-resolved scheduled messages for the DSP.
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

-- 3c. Cancel a still-pending scheduled message.
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


-- ── 4. Worker ──
-- Sends every due pending row.  Row-locked with SKIP LOCKED so the cron job
-- and a dashboard-triggered fallback can never double-send the same row.
-- Each row is sent in its own sub-block: one bad row is marked 'failed' and
-- never blocks the rest.
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
           attachment_path, attachment_mime, attachment_name, attachment_size_bytes)
        values
          (r.channel_id, r.dsp_id, 'dispatch', r.created_by, nullif(trim(coalesce(r.body, '')), ''),
           r.attachment_path, r.attachment_mime, r.attachment_name, r.attachment_size_bytes)
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
    exception when others then
      update public.scheduled_messages
         set status = 'failed', error = left(SQLERRM, 500), sent_at = now()
       where id = r.id;
    end;
  end loop;
  return v_sent;
end;
$fn$;

-- 4b. Staff-callable fallback so due messages still send when pg_cron is off.
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


-- ── 5. pg_cron minute job (best-effort; no-op if pg_cron is absent) ──
do $$ begin
  perform cron.unschedule('flush-scheduled-messages');
exception when others then null; end $$;
do $$ begin
  perform cron.schedule('flush-scheduled-messages', '* * * * *', 'select private.flush_scheduled_messages();');
exception when others then null; end $$;

notify pgrst, 'reload schema';
