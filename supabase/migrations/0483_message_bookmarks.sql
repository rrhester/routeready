-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0483 · Saved / flagged messages (operator bookmarks)
--
-- A dispatcher can flag any message — a 1:1 driver message (driver_messages)
-- or a channel post (driver_channel_messages) — to a personal "Saved" list
-- for follow-up, the Slack "Save for later" affordance.  Per-operator and
-- private: a bookmark is visible only to the operator who made it.
--
-- Because a bookmark can point at either message table, message_id is a bare
-- uuid discriminated by message_kind (no cross-table FK); the row is cleaned
-- up lazily (a bookmark whose message was deleted simply resolves to null in
-- the list RPC and is skipped).  Dashboard-only feature — drivers have no
-- bookmarks.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Table ──
create table if not exists public.message_bookmarks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  message_kind text not null check (message_kind in ('driver','channel')),
  message_id   uuid not null,
  note         text check (note is null or length(note) <= 500),
  created_at   timestamptz not null default now(),
  unique (user_id, message_kind, message_id)
);
create index if not exists message_bookmarks_user_idx
  on public.message_bookmarks (user_id, dsp_id, created_at desc);


-- ── 2. RLS ──  An operator sees only their own bookmarks.
alter table public.message_bookmarks enable row level security;
drop policy if exists "message_bookmarks_own_r" on public.message_bookmarks;
create policy "message_bookmarks_own_r"
  on public.message_bookmarks for select
  using (user_id = auth.uid() and dsp_id = private.current_dsp_id());
grant select on public.message_bookmarks to authenticated;


-- ── 3. RPCs ──

-- 3a. Toggle a bookmark on a message (with an optional note).
create or replace function public.dispatch_bookmark_toggle(
  p_message_kind text,
  p_message_id   uuid,
  p_on           boolean default true,
  p_note         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_uid   uuid := auth.uid();
  v_ok    boolean;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_message_kind not in ('driver','channel') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;

  -- Confirm the target message exists in this DSP before saving it.
  if p_message_kind = 'driver' then
    select exists (select 1 from public.driver_messages where id = p_message_id and dsp_id = v_dsp) into v_ok;
  else
    select exists (select 1 from public.driver_channel_messages where id = p_message_id and dsp_id = v_dsp) into v_ok;
  end if;
  if not v_ok then raise exception 'message_not_found' using errcode = 'P0002'; end if;

  if coalesce(p_on, true) then
    insert into public.message_bookmarks (user_id, dsp_id, message_kind, message_id, note)
    values (v_uid, v_dsp, p_message_kind, p_message_id, nullif(trim(coalesce(p_note, '')), ''))
    on conflict (user_id, message_kind, message_id)
    do update set note = excluded.note;
    return jsonb_build_object('message_id', p_message_id, 'saved', true);
  else
    delete from public.message_bookmarks
     where user_id = v_uid and message_kind = p_message_kind and message_id = p_message_id;
    return jsonb_build_object('message_id', p_message_id, 'saved', false);
  end if;
end;
$$;
grant execute on function public.dispatch_bookmark_toggle(text, uuid, boolean, text) to authenticated;

-- 3b. The calling operator's saved messages, newest first, with the context
--     needed to render + jump (driver name / channel name, snippet, target id).
--     Bookmarks whose message was since deleted resolve to null and are dropped.
create or replace function public.dispatch_bookmarks_list()
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

  select coalesce(jsonb_agg(row_to_json(t) order by t.created_at desc), '[]'::jsonb) into v_rows
  from (
    select b.id            as bookmark_id,
           b.message_kind,
           b.message_id,
           b.note,
           b.created_at,
           case when b.message_kind = 'driver' then dm.driver_id else null end            as driver_id,
           case when b.message_kind = 'driver' then dn.full_name else null end            as driver_name,
           case when b.message_kind = 'channel' then cm.channel_id else null end          as channel_id,
           case when b.message_kind = 'channel' then c.name else null end                 as channel_name,
           coalesce(
             case when b.message_kind = 'driver'  then left(coalesce(dm.body, dm.attachment_name, ''), 140)
                  when b.message_kind = 'channel' then left(coalesce(cm.body, cm.attachment_name, ''), 140)
             end, '') as snippet,
           case when b.message_kind = 'driver'  then dm.sender_kind
                when b.message_kind = 'channel' then cm.sender_kind end                    as sender_kind,
           case when b.message_kind = 'driver'  then dm.created_at
                when b.message_kind = 'channel' then cm.created_at end                     as message_at
      from public.message_bookmarks b
      left join public.driver_messages dm
             on b.message_kind = 'driver' and dm.id = b.message_id
      left join public.drivers dn
             on dn.id = dm.driver_id
      left join public.driver_channel_messages cm
             on b.message_kind = 'channel' and cm.id = b.message_id
      left join public.driver_channels c
             on c.id = cm.channel_id
     where b.user_id = v_uid and b.dsp_id = v_dsp
       and (
         (b.message_kind = 'driver'  and dm.id is not null) or
         (b.message_kind = 'channel' and cm.id is not null)
       )
  ) t;

  return jsonb_build_object('bookmarks', v_rows);
end;
$$;
grant execute on function public.dispatch_bookmarks_list() to authenticated;

notify pgrst, 'reload schema';
