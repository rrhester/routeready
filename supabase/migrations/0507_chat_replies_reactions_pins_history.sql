-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0507 · Messages 100-list Batch 2 (#13 replies, #15 emoji
-- reactions, #18 pins, #20 edit history) for the driver ↔ dispatch 1:1 chat.
--
-- 1. reply_to_message_id on driver_messages + dispatch_chat_send accepts
--    p_reply_to + dispatch_chat_thread returns reply_to. (Additive; the
--    driver app ignores the new column until it adopts it.)
-- 2. Multi-emoji reactions: per-emoji uniqueness on the existing
--    driver_message_reactions table (0389 already has an emoji column),
--    a whitelist, react RPCs + _v2 read RPCs grouped by emoji. The 0389
--    single-👍 RPCs stay for older driver-app builds.
-- 3. Pinned messages: driver_message_pins + pin/unpin/list RPCs.
-- 4. Edit history: driver_message_edits + capture trigger + read RPC.
--
-- Idempotent throughout.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1a. Reply column ──
alter table public.driver_messages
  add column if not exists reply_to_message_id uuid references public.driver_messages(id) on delete set null;

-- ── 1b. dispatch_chat_send · accept p_reply_to ──
-- Drop the 0151 signature first so PostgREST doesn't see two ambiguous
-- overloads for the same named-argument call.
drop function if exists public.dispatch_chat_send(uuid, text, text, text, text, int, text, boolean);

create or replace function public.dispatch_chat_send(
  p_driver_id             uuid,
  p_body                  text,
  p_attachment_path       text    default null,
  p_attachment_mime       text    default null,
  p_attachment_name       text    default null,
  p_attachment_size_bytes int     default null,
  p_priority              text    default 'normal',
  p_requires_ack          boolean default false,
  p_reply_to              uuid    default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers;
  v_body text := nullif(trim(coalesce(p_body, '')), '');
  v_msg public.driver_messages;
  v_pri public.message_priority := case lower(coalesce(p_priority, 'normal'))
    when 'urgent' then 'urgent'::public.message_priority
    when 'high'   then 'high'::public.message_priority
    else 'normal'::public.message_priority
  end;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_body is null and p_attachment_path is null then
    raise exception 'empty_message' using errcode = 'P0001';
  end if;
  if v_body is not null and length(v_body) > 2000 then
    raise exception 'too_long' using errcode = 'P0001';
  end if;

  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then raise exception 'driver_not_found' using errcode = 'P0002'; end if;

  -- A reply must point at a message in the SAME conversation.
  if p_reply_to is not null and not exists (
    select 1 from public.driver_messages
     where id = p_reply_to and driver_id = p_driver_id and dsp_id = v_dsp
  ) then
    raise exception 'reply_target_not_found' using errcode = 'P0002';
  end if;

  insert into public.driver_messages
    (driver_id, dsp_id, sender_kind, sender_user_id, body,
     attachment_path, attachment_mime, attachment_name, attachment_size_bytes,
     priority, requires_ack, reply_to_message_id)
  values
    (p_driver_id, v_dsp, 'dispatch', auth.uid(), v_body,
     nullif(p_attachment_path, ''), nullif(p_attachment_mime, ''),
     nullif(p_attachment_name, ''), p_attachment_size_bytes,
     v_pri, coalesce(p_requires_ack, false), p_reply_to)
  returning * into v_msg;

  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (p_driver_id, v_dsp, v_msg.created_at)
  on conflict (driver_id) do update set last_message_at = excluded.last_message_at;

  return jsonb_build_object(
    'id',                    v_msg.id,
    'sender_kind',           v_msg.sender_kind,
    'body',                  v_msg.body,
    'attachment_path',       v_msg.attachment_path,
    'attachment_mime',       v_msg.attachment_mime,
    'attachment_name',       v_msg.attachment_name,
    'attachment_size_bytes', v_msg.attachment_size_bytes,
    'priority',              v_msg.priority,
    'requires_ack',          v_msg.requires_ack,
    'acked_at',              v_msg.acked_at,
    'reply_to',              v_msg.reply_to_message_id,
    'created_at',            v_msg.created_at
  );
end;
$$;
grant execute on function public.dispatch_chat_send(uuid, text, text, text, text, int, text, boolean, uuid) to authenticated;

-- ── 1c. dispatch_chat_thread · expose reply_to ──
create or replace function public.dispatch_chat_thread(p_driver_id uuid, p_limit int default 200)
returns jsonb
language plpgsql
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
    'id',                    m.id,
    'sender_kind',           m.sender_kind,
    'is_auto',               (m.sender_kind = 'dispatch' and m.sender_user_id is null),
    'body',                  case when m.deleted_at is null then m.body else null end,
    'edited_at',             m.edited_at,
    'deleted_at',            m.deleted_at,
    'attachment_path',       case when m.deleted_at is null then m.attachment_path else null end,
    'attachment_mime',       case when m.deleted_at is null then m.attachment_mime else null end,
    'attachment_name',       case when m.deleted_at is null then m.attachment_name else null end,
    'attachment_size_bytes', case when m.deleted_at is null then m.attachment_size_bytes else null end,
    'priority',              m.priority,
    'requires_ack',          m.requires_ack,
    'acked_at',              m.acked_at,
    'reply_to',              m.reply_to_message_id,
    'created_at',            m.created_at,
    'is_unread',             m.sender_kind = 'driver'
                             and m.deleted_at is null
                             and (v_conv.dispatch_last_read_at is null
                                  or m.created_at > v_conv.dispatch_last_read_at)
  ) order by m.created_at), '[]'::jsonb)
  into v_messages
  from (
    select id, sender_kind, sender_user_id, body, edited_at, deleted_at,
           attachment_path, attachment_mime, attachment_name, attachment_size_bytes,
           priority, requires_ack, acked_at, reply_to_message_id, created_at
      from public.driver_messages
     where driver_id = p_driver_id and dsp_id = v_dsp
     order by created_at desc
     limit greatest(1, least(1000, coalesce(p_limit, 200)))
  ) m;

  return jsonb_build_object(
    'driver', jsonb_build_object(
      'id',        v_drv.id,
      'name',      coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
      'full_name', v_drv.full_name
    ),
    'messages',          v_messages,
    'last_read_at',      v_conv.dispatch_last_read_at,
    'peer_last_read_at', v_conv.driver_last_read_at
  );
end;
$$;
grant execute on function public.dispatch_chat_thread(uuid, int) to authenticated;

-- ── 2. Multi-emoji reactions ──
create or replace function private.dm_reaction_allowed(p_emoji text)
returns boolean
language sql
immutable
as $$
  select p_emoji in ('👍','👎','❤️','😂','😮','😢','✅','❌','🔥','🎉','🙏');
$$;

-- Per-emoji uniqueness (the 0389 indexes allowed one reaction TOTAL per
-- actor per message; multi-emoji needs one PER EMOJI per actor).
drop index if exists public.driver_message_reactions_dispatch_uq;
drop index if exists public.driver_message_reactions_driver_uq;
create unique index if not exists driver_message_reactions_dispatch_em_uq
  on public.driver_message_reactions (message_id, reactor_user_id, emoji) where reactor_kind = 'dispatch';
create unique index if not exists driver_message_reactions_driver_em_uq
  on public.driver_message_reactions (message_id, reactor_driver_id, emoji) where reactor_kind = 'driver';

create or replace function public.dispatch_message_react_emoji(
  p_message_id uuid,
  p_emoji      text,
  p_on         boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_msg public.driver_messages;
  v_count int;
  v_mine boolean;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not private.dm_reaction_allowed(p_emoji) then
    raise exception 'emoji_not_allowed' using errcode = '22023';
  end if;
  select * into v_msg from public.driver_messages where id = p_message_id and dsp_id = v_dsp;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;

  if coalesce(p_on, true) then
    insert into public.driver_message_reactions (message_id, dsp_id, reactor_kind, reactor_user_id, emoji)
    values (p_message_id, v_dsp, 'dispatch', v_uid, p_emoji)
    on conflict do nothing;
  else
    delete from public.driver_message_reactions
     where message_id = p_message_id and reactor_kind = 'dispatch'
       and reactor_user_id = v_uid and emoji = p_emoji;
  end if;

  select count(*)::int,
         bool_or(reactor_kind = 'dispatch' and reactor_user_id = v_uid)
    into v_count, v_mine
    from public.driver_message_reactions
   where message_id = p_message_id and emoji = p_emoji;
  return jsonb_build_object('message_id', p_message_id, 'emoji', p_emoji,
                            'count', coalesce(v_count, 0), 'mine', coalesce(v_mine, false));
end;
$$;
grant execute on function public.dispatch_message_react_emoji(uuid, text, boolean) to authenticated;

create or replace function public.dispatch_chat_reactions_v2(p_driver_id uuid)
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
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'message_id', r.message_id, 'emoji', r.emoji,
           'count', r.cnt, 'mine', r.mine)), '[]'::jsonb)
    into v_out
    from (
      select x.message_id, x.emoji, count(*)::int as cnt,
             bool_or(x.reactor_kind = 'dispatch' and x.reactor_user_id = v_uid) as mine
        from public.driver_message_reactions x
        join public.driver_messages m on m.id = x.message_id
       where m.driver_id = p_driver_id and m.dsp_id = v_dsp
       group by x.message_id, x.emoji
    ) r;
  return jsonb_build_object('reactions', v_out);
end;
$$;
grant execute on function public.dispatch_chat_reactions_v2(uuid) to authenticated;

-- Driver-side (token-scoped) equivalents so the app can adopt multi-emoji.
create or replace function public.driver_message_react_emoji(
  p_token      text,
  p_message_id uuid,
  p_emoji      text,
  p_on         boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_msg public.driver_messages;
  v_count int;
  v_mine boolean;
begin
  v_drv := private.driver_validate_token(p_token);
  if not private.dm_reaction_allowed(p_emoji) then
    raise exception 'emoji_not_allowed' using errcode = '22023';
  end if;
  select * into v_msg from public.driver_messages
   where id = p_message_id and driver_id = v_drv.id;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;

  if coalesce(p_on, true) then
    insert into public.driver_message_reactions (message_id, dsp_id, reactor_kind, reactor_driver_id, emoji)
    values (p_message_id, v_drv.dsp_id, 'driver', v_drv.id, p_emoji)
    on conflict do nothing;
  else
    delete from public.driver_message_reactions
     where message_id = p_message_id and reactor_kind = 'driver'
       and reactor_driver_id = v_drv.id and emoji = p_emoji;
  end if;

  select count(*)::int,
         bool_or(reactor_kind = 'driver' and reactor_driver_id = v_drv.id)
    into v_count, v_mine
    from public.driver_message_reactions
   where message_id = p_message_id and emoji = p_emoji;
  return jsonb_build_object('message_id', p_message_id, 'emoji', p_emoji,
                            'count', coalesce(v_count, 0), 'mine', coalesce(v_mine, false));
end;
$$;
grant execute on function public.driver_message_react_emoji(text, uuid, text, boolean) to anon, authenticated;

create or replace function public.driver_chat_reactions_v2(p_token text)
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
  select coalesce(jsonb_agg(jsonb_build_object(
           'message_id', r.message_id, 'emoji', r.emoji,
           'count', r.cnt, 'mine', r.mine)), '[]'::jsonb)
    into v_out
    from (
      select x.message_id, x.emoji, count(*)::int as cnt,
             bool_or(x.reactor_kind = 'driver' and x.reactor_driver_id = v_drv.id) as mine
        from public.driver_message_reactions x
        join public.driver_messages m on m.id = x.message_id
       where m.driver_id = v_drv.id
       group by x.message_id, x.emoji
    ) r;
  return jsonb_build_object('reactions', v_out);
end;
$$;
grant execute on function public.driver_chat_reactions_v2(text) to anon, authenticated;

-- ── 3. Pinned messages ──
create table if not exists public.driver_message_pins (
  message_id uuid primary key references public.driver_messages(id) on delete cascade,
  driver_id  uuid not null references public.drivers(id) on delete cascade,
  dsp_id     uuid not null references public.dsps(id) on delete cascade,
  pinned_by  uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists driver_message_pins_drv_idx
  on public.driver_message_pins (driver_id, created_at desc);

alter table public.driver_message_pins enable row level security;
drop policy if exists "driver_message_pins_tenant_r" on public.driver_message_pins;
create policy "driver_message_pins_tenant_r"
  on public.driver_message_pins for select
  using (dsp_id = private.current_dsp_id());
grant select on public.driver_message_pins to authenticated;

create or replace function public.dispatch_pin_message(p_message_id uuid, p_on boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_msg public.driver_messages;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_msg from public.driver_messages where id = p_message_id and dsp_id = v_dsp;
  if v_msg.id is null then raise exception 'message_not_found' using errcode = 'P0002'; end if;
  if coalesce(p_on, true) then
    if (select count(*) from public.driver_message_pins where driver_id = v_msg.driver_id) >= 20 then
      raise exception 'pin_limit' using errcode = 'P0001';
    end if;
    insert into public.driver_message_pins (message_id, driver_id, dsp_id, pinned_by)
    values (p_message_id, v_msg.driver_id, v_dsp, auth.uid())
    on conflict (message_id) do nothing;
  else
    delete from public.driver_message_pins where message_id = p_message_id;
  end if;
  return jsonb_build_object('message_id', p_message_id, 'pinned', coalesce(p_on, true));
end;
$$;
grant execute on function public.dispatch_pin_message(uuid, boolean) to authenticated;

create or replace function public.dispatch_chat_pins(p_driver_id uuid)
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
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'message_id', p.message_id,
           'pinned_at',  p.created_at,
           'sender_kind', m.sender_kind,
           'body',        case when m.deleted_at is null then m.body else null end,
           'attachment_name', m.attachment_name,
           'created_at',  m.created_at
         ) order by p.created_at desc), '[]'::jsonb)
    into v_out
    from public.driver_message_pins p
    join public.driver_messages m on m.id = p.message_id
   where p.driver_id = p_driver_id and p.dsp_id = v_dsp;
  return jsonb_build_object('pins', v_out);
end;
$$;
grant execute on function public.dispatch_chat_pins(uuid) to authenticated;

-- ── 4. Edit history ──
create table if not exists public.driver_message_edits (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.driver_messages(id) on delete cascade,
  dsp_id     uuid not null references public.dsps(id) on delete cascade,
  old_body   text,
  edited_at  timestamptz not null default now()
);
create index if not exists driver_message_edits_msg_idx
  on public.driver_message_edits (message_id, edited_at);

alter table public.driver_message_edits enable row level security;
drop policy if exists "driver_message_edits_tenant_r" on public.driver_message_edits;
create policy "driver_message_edits_tenant_r"
  on public.driver_message_edits for select
  using (dsp_id = private.current_dsp_id());
grant select on public.driver_message_edits to authenticated;

create or replace function private.trg_driver_messages_capture_edit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.body is distinct from new.body and old.deleted_at is null and new.deleted_at is null then
    insert into public.driver_message_edits (message_id, dsp_id, old_body)
    values (old.id, old.dsp_id, old.body);
  end if;
  return new;
end;
$$;
drop trigger if exists driver_messages_capture_edit on public.driver_messages;
create trigger driver_messages_capture_edit
  before update on public.driver_messages
  for each row execute function private.trg_driver_messages_capture_edit();

create or replace function public.dispatch_message_edit_history(p_message_id uuid)
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
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'old_body', e.old_body, 'edited_at', e.edited_at
         ) order by e.edited_at), '[]'::jsonb)
    into v_out
    from public.driver_message_edits e
   where e.message_id = p_message_id and e.dsp_id = v_dsp;
  return jsonb_build_object('history', v_out);
end;
$$;
grant execute on function public.dispatch_message_edit_history(uuid) to authenticated;

notify pgrst, 'reload schema';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0507_chat_replies_reactions_pins_history.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
