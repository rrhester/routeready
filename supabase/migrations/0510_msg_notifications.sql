-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0510 · Messages 100-list Batch 5 (notifications & escalation)
--
--   #45 per-thread notification level → dispatch_thread_prefs.notify_level
--   #46/#48/#51/#53 operator prefs    → dispatch_operator_msg_prefs
--        (quiet hours, keyword alerts, tones, manual presence status)
--   #49 SMS fallback                  → dispatch_send_sms_fallback RPC
--        (queues an sms_messages row for a driver, drained by send-sms)
--   #50 dispatch auto-reply           → dsp_msg_settings + AFTER-INSERT
--        trigger on driver_messages (max one auto-reply per conversation
--        per 4 hours, marked is_auto via NULL sender_user_id)
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Per-thread notification level (#45) ──
alter table public.dispatch_thread_prefs
  add column if not exists notify_level text not null default 'all'
    check (notify_level in ('all','urgent','off'));

-- Patch support in dispatch_thread_pref_set + expose in the list RPC.
create or replace function public.dispatch_thread_prefs()
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
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'driver_id', p.driver_id,
           'archived',  p.archived_at is not null,
           'muted',     p.muted,
           'snooze_until', p.snooze_until,
           'mark_unread', p.mark_unread_at is not null,
           'labels',    to_jsonb(p.labels),
           'notify_level', p.notify_level,
           'updated_at', p.updated_at
         )), '[]'::jsonb)
    into v_out
    from public.dispatch_thread_prefs p
   where p.user_id = v_uid and p.dsp_id = v_dsp;
  return jsonb_build_object('prefs', v_out);
end;
$$;
grant execute on function public.dispatch_thread_prefs() to authenticated;

create or replace function public.dispatch_thread_pref_set(p_driver_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_row public.dispatch_thread_prefs;
  v_labels text[];
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.drivers where id = p_driver_id and dsp_id = v_dsp) then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;

  insert into public.dispatch_thread_prefs (user_id, driver_id, dsp_id)
  values (v_uid, p_driver_id, v_dsp)
  on conflict (user_id, driver_id) do nothing;

  select * into v_row from public.dispatch_thread_prefs
   where user_id = v_uid and driver_id = p_driver_id;

  if p_patch ? 'archived' then
    v_row.archived_at := case when (p_patch->>'archived')::boolean then now() else null end;
  end if;
  if p_patch ? 'muted' then
    v_row.muted := coalesce((p_patch->>'muted')::boolean, false);
  end if;
  if p_patch ? 'snooze_until' then
    v_row.snooze_until := nullif(p_patch->>'snooze_until', '')::timestamptz;
  end if;
  if p_patch ? 'mark_unread' then
    v_row.mark_unread_at := case when (p_patch->>'mark_unread')::boolean then now() else null end;
  end if;
  if p_patch ? 'notify_level' then
    if p_patch->>'notify_level' not in ('all','urgent','off') then
      raise exception 'bad_notify_level' using errcode = '22023';
    end if;
    v_row.notify_level := p_patch->>'notify_level';
  end if;
  if p_patch ? 'labels' then
    select coalesce(array_agg(x), '{}'::text[])
      into v_labels
      from (
        select distinct trim(value::text, '"') as x
          from jsonb_array_elements(coalesce(p_patch->'labels', '[]'::jsonb))
         where length(trim(value::text, '"')) between 1 and 32
         limit 12
      ) t;
    v_row.labels := v_labels;
  end if;

  update public.dispatch_thread_prefs
     set archived_at = v_row.archived_at,
         muted = v_row.muted,
         snooze_until = v_row.snooze_until,
         mark_unread_at = v_row.mark_unread_at,
         labels = v_row.labels,
         notify_level = v_row.notify_level,
         updated_at = now()
   where user_id = v_uid and driver_id = p_driver_id;

  return jsonb_build_object('pref', jsonb_build_object(
    'driver_id', p_driver_id,
    'archived', v_row.archived_at is not null,
    'muted', v_row.muted,
    'snooze_until', v_row.snooze_until,
    'mark_unread', v_row.mark_unread_at is not null,
    'labels', to_jsonb(v_row.labels),
    'notify_level', v_row.notify_level
  ));
end;
$$;
grant execute on function public.dispatch_thread_pref_set(uuid, jsonb) to authenticated;

-- ── 2. Operator message prefs (#46 quiet hours, #48 keywords, #51 status,
--       #53 tones) ──
create table if not exists public.dispatch_operator_msg_prefs (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  dsp_id           uuid not null references public.dsps(id) on delete cascade,
  quiet_start_min  smallint check (quiet_start_min between 0 and 1439),
  quiet_end_min    smallint check (quiet_end_min between 0 and 1439),
  quiet_urgent_only boolean not null default true,
  keywords         text[] not null default '{}',
  tones_enabled    boolean not null default true,
  presence_status  text check (presence_status in ('available','busy','on_road') or presence_status is null),
  presence_until   timestamptz,
  updated_at       timestamptz not null default now()
);
alter table public.dispatch_operator_msg_prefs enable row level security;
drop policy if exists "dispatch_operator_msg_prefs_own_r" on public.dispatch_operator_msg_prefs;
create policy "dispatch_operator_msg_prefs_own_r"
  on public.dispatch_operator_msg_prefs for select
  using (user_id = auth.uid());
grant select on public.dispatch_operator_msg_prefs to authenticated;

create or replace function public.dispatch_operator_msg_prefs_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_row public.dispatch_operator_msg_prefs;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  select * into v_row from public.dispatch_operator_msg_prefs where user_id = v_uid;
  if v_row.user_id is null then return jsonb_build_object('prefs', null); end if;
  return jsonb_build_object('prefs', jsonb_build_object(
    'quiet_start_min', v_row.quiet_start_min,
    'quiet_end_min', v_row.quiet_end_min,
    'quiet_urgent_only', v_row.quiet_urgent_only,
    'keywords', to_jsonb(v_row.keywords),
    'tones_enabled', v_row.tones_enabled,
    'presence_status', v_row.presence_status,
    'presence_until', v_row.presence_until
  ));
end;
$$;
grant execute on function public.dispatch_operator_msg_prefs_get() to authenticated;

create or replace function public.dispatch_operator_msg_prefs_set(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_row public.dispatch_operator_msg_prefs;
  v_kw text[];
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  insert into public.dispatch_operator_msg_prefs (user_id, dsp_id)
  values (v_uid, v_dsp)
  on conflict (user_id) do nothing;
  select * into v_row from public.dispatch_operator_msg_prefs where user_id = v_uid;

  if p_patch ? 'quiet_start_min' then v_row.quiet_start_min := nullif(p_patch->>'quiet_start_min', '')::smallint; end if;
  if p_patch ? 'quiet_end_min' then v_row.quiet_end_min := nullif(p_patch->>'quiet_end_min', '')::smallint; end if;
  if p_patch ? 'quiet_urgent_only' then v_row.quiet_urgent_only := coalesce((p_patch->>'quiet_urgent_only')::boolean, true); end if;
  if p_patch ? 'tones_enabled' then v_row.tones_enabled := coalesce((p_patch->>'tones_enabled')::boolean, true); end if;
  if p_patch ? 'presence_status' then v_row.presence_status := nullif(p_patch->>'presence_status', ''); end if;
  if p_patch ? 'presence_until' then v_row.presence_until := nullif(p_patch->>'presence_until', '')::timestamptz; end if;
  if p_patch ? 'keywords' then
    select coalesce(array_agg(x), '{}'::text[])
      into v_kw
      from (
        select distinct lower(trim(value::text, '"')) as x
          from jsonb_array_elements(coalesce(p_patch->'keywords', '[]'::jsonb))
         where length(trim(value::text, '"')) between 2 and 40
         limit 20
      ) t;
    v_row.keywords := v_kw;
  end if;

  update public.dispatch_operator_msg_prefs
     set quiet_start_min = v_row.quiet_start_min,
         quiet_end_min = v_row.quiet_end_min,
         quiet_urgent_only = v_row.quiet_urgent_only,
         keywords = v_row.keywords,
         tones_enabled = v_row.tones_enabled,
         presence_status = v_row.presence_status,
         presence_until = v_row.presence_until,
         updated_at = now()
   where user_id = v_uid;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.dispatch_operator_msg_prefs_set(jsonb) to authenticated;

-- ── 3. SMS fallback for unseen urgent messages (#49) ──
-- Queues a plain SMS to the driver's phone through the existing
-- sms_messages pipeline (0007 trigger → send-sms edge function, TCPA
-- opt-out respected there).
create or replace function public.dispatch_send_sms_fallback(p_driver_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers;
  v_body text := trim(coalesce(p_body, ''));
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(v_body) < 1 or length(v_body) > 640 then raise exception 'bad_body' using errcode = '22023'; end if;
  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then raise exception 'driver_not_found' using errcode = 'P0002'; end if;
  if nullif(trim(coalesce(v_drv.phone, '')), '') is null then
    raise exception 'driver_has_no_phone' using errcode = 'P0001';
  end if;
  insert into public.sms_messages (dsp_id, direction, status, to_phone, body)
  values (v_dsp, 'outbound', 'queued', v_drv.phone, v_body);
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.dispatch_send_sms_fallback(uuid, text) to authenticated;

-- ── 4. Dispatch auto-reply (#50) ──
create table if not exists public.dsp_msg_settings (
  dsp_id            uuid primary key references public.dsps(id) on delete cascade,
  autoreply_enabled boolean not null default false,
  autoreply_text    text check (autoreply_text is null or length(autoreply_text) <= 500),
  updated_at        timestamptz not null default now()
);
alter table public.dsp_msg_settings enable row level security;
drop policy if exists "dsp_msg_settings_tenant_r" on public.dsp_msg_settings;
create policy "dsp_msg_settings_tenant_r"
  on public.dsp_msg_settings for select
  using (dsp_id = private.current_dsp_id());
grant select on public.dsp_msg_settings to authenticated;

alter table public.driver_conversations
  add column if not exists last_autoreply_at timestamptz;

create or replace function public.dispatch_msg_settings_set(
  p_autoreply_enabled boolean default null,
  p_autoreply_text    text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.dsp_msg_settings (dsp_id)
  values (v_dsp)
  on conflict (dsp_id) do nothing;
  update public.dsp_msg_settings
     set autoreply_enabled = coalesce(p_autoreply_enabled, autoreply_enabled),
         autoreply_text = case when p_autoreply_text is null then autoreply_text else nullif(trim(p_autoreply_text), '') end,
         updated_at = now()
   where dsp_id = v_dsp;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.dispatch_msg_settings_set(boolean, text) to authenticated;

-- Auto-reply trigger: when a driver messages in and auto-reply is on,
-- answer once per conversation per 4 hours with an automated dispatch
-- message (NULL sender_user_id → renders with the "Auto" pill).
create or replace function private.trg_driver_messages_autoreply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set public.dsp_msg_settings;
  v_conv public.driver_conversations;
begin
  if new.sender_kind <> 'driver' then return new; end if;
  select * into v_set from public.dsp_msg_settings where dsp_id = new.dsp_id;
  if v_set.dsp_id is null or not v_set.autoreply_enabled
     or nullif(trim(coalesce(v_set.autoreply_text, '')), '') is null then
    return new;
  end if;
  select * into v_conv from public.driver_conversations where driver_id = new.driver_id;
  if v_conv.driver_id is not null and v_conv.last_autoreply_at is not null
     and v_conv.last_autoreply_at > now() - interval '4 hours' then
    return new;
  end if;
  insert into public.driver_messages (driver_id, dsp_id, sender_kind, sender_user_id, body)
  values (new.driver_id, new.dsp_id, 'dispatch', null, v_set.autoreply_text);
  update public.driver_conversations
     set last_autoreply_at = now(), last_message_at = now()
   where driver_id = new.driver_id;
  return new;
end;
$$;
drop trigger if exists driver_messages_autoreply on public.driver_messages;
create trigger driver_messages_autoreply
  after insert on public.driver_messages
  for each row execute function private.trg_driver_messages_autoreply();

notify pgrst, 'reload schema';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0510_msg_notifications.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
