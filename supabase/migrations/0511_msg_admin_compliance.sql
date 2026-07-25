-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0511 · Messages 100-list Batch 10 (admin, compliance,
-- integrations)
--
--   #93 retention + legal hold  → dsp_msg_settings.retention_days,
--        driver_conversations.legal_hold_at, purge worker + cron
--   #94 audit log               → dispatch_msg_audit RPC (edits / deletes /
--        urgent sends, last 30 days)
--   #97 inbound SMS bridge      → trigger matches inbound sms_messages to a
--        driver by phone and lands them in the chat thread
--   #98 email transcript        → dispatch_email_transcript queues an
--        email_messages row with the thread transcript
--   #99 outbound webhooks       → dsp_msg_webhooks + AFTER-INSERT pg_net
--        POST on driver_messages
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Retention + legal hold (#93) ──
alter table public.dsp_msg_settings
  add column if not exists retention_days int
    check (retention_days is null or retention_days between 30 and 3650);
alter table public.driver_conversations
  add column if not exists legal_hold_at timestamptz;

-- Extend the settings RPC (drop the 0510 signature to avoid overloads).
drop function if exists public.dispatch_msg_settings_set(boolean, text);
create or replace function public.dispatch_msg_settings_set(
  p_autoreply_enabled boolean default null,
  p_autoreply_text    text    default null,
  p_retention_days    int     default null,
  p_clear_retention   boolean default false
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
  if p_retention_days is not null and (p_retention_days < 30 or p_retention_days > 3650) then
    raise exception 'bad_retention' using errcode = '22023';
  end if;
  insert into public.dsp_msg_settings (dsp_id) values (v_dsp)
  on conflict (dsp_id) do nothing;
  update public.dsp_msg_settings
     set autoreply_enabled = coalesce(p_autoreply_enabled, autoreply_enabled),
         autoreply_text = case when p_autoreply_text is null then autoreply_text else nullif(trim(p_autoreply_text), '') end,
         retention_days = case when coalesce(p_clear_retention, false) then null else coalesce(p_retention_days, retention_days) end,
         updated_at = now()
   where dsp_id = v_dsp;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.dispatch_msg_settings_set(boolean, text, int, boolean) to authenticated;

create or replace function public.dispatch_thread_legal_hold(p_driver_id uuid, p_on boolean)
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
  update public.driver_conversations
     set legal_hold_at = case when coalesce(p_on, false) then now() else null end
   where driver_id = p_driver_id and dsp_id = v_dsp;
  if not found then raise exception 'conversation_not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object('driver_id', p_driver_id, 'legal_hold', coalesce(p_on, false));
end;
$$;
grant execute on function public.dispatch_thread_legal_hold(uuid, boolean) to authenticated;

-- Purge worker: per-DSP retention window; legal-hold conversations and
-- pinned messages are exempt. Attachment blobs are NOT deleted here
-- (storage cleanup stays a manual owner action — losing bytes early is
-- worse than keeping them late).
create or replace function private.run_message_retention()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total int := 0;
  v_batch int;
  r record;
begin
  for r in select dsp_id, retention_days from public.dsp_msg_settings where retention_days is not null loop
    delete from public.driver_messages m
     where m.dsp_id = r.dsp_id
       and m.created_at < now() - make_interval(days => r.retention_days)
       and not exists (select 1 from public.driver_conversations c
                        where c.driver_id = m.driver_id and c.legal_hold_at is not null)
       and not exists (select 1 from public.driver_message_pins p where p.message_id = m.id);
    get diagnostics v_batch = row_count;
    v_total := v_total + coalesce(v_batch, 0);
  end loop;
  return v_total;
end;
$$;

create or replace function public.dispatch_run_retention()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_n int;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  v_n := private.run_message_retention();
  return jsonb_build_object('purged', v_n);
end;
$$;
grant execute on function public.dispatch_run_retention() to authenticated;

-- Nightly cron (03:17) when pg_cron is available; harmless no-op if not.
do $$
begin
  perform cron.schedule('rr-msg-retention', '17 3 * * *', 'select private.run_message_retention()');
exception when others then null;
end $$;

-- ── 2. Audit log RPC (#94) ──
create or replace function public.dispatch_msg_audit(p_limit int default 100)
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
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(row_to_json(t) order by t.at desc), '[]'::jsonb)
    into v_out
    from (
      (select 'edit'::text as kind, e.edited_at as at, m.driver_id,
              (select coalesce(full_name, email) from public.app_users where id = m.sender_user_id) as actor,
              left(coalesce(e.old_body, ''), 120) as detail
         from public.driver_message_edits e
         join public.driver_messages m on m.id = e.message_id
        where e.dsp_id = v_dsp and e.edited_at > now() - interval '30 days')
      union all
      (select 'delete', m.deleted_at, m.driver_id,
              (select coalesce(full_name, email) from public.app_users where id = m.sender_user_id),
              null
         from public.driver_messages m
        where m.dsp_id = v_dsp and m.deleted_at is not null and m.deleted_at > now() - interval '30 days')
      union all
      (select 'urgent', m.created_at, m.driver_id,
              (select coalesce(full_name, email) from public.app_users where id = m.sender_user_id),
              left(coalesce(m.body, ''), 120)
         from public.driver_messages m
        where m.dsp_id = v_dsp and m.priority = 'urgent' and m.created_at > now() - interval '30 days')
      order by at desc
      limit greatest(1, least(coalesce(p_limit, 100), 300))
    ) t;
  return jsonb_build_object('events', v_out);
end;
$$;
grant execute on function public.dispatch_msg_audit(int) to authenticated;

-- ── 3. Inbound SMS → chat bridge (#97) ──
-- When a driver texts the DSP's Twilio number, land it in their chat
-- thread (matched by the last 10 digits of the phone). Exception-safe so
-- the SMS webhook can never fail on this.
create or replace function private.trg_sms_bridge_to_chat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_digits text;
begin
  if new.direction is distinct from 'inbound' then return new; end if;
  begin
    v_digits := right(regexp_replace(coalesce(new.from_phone, ''), '\D', '', 'g'), 10);
    if length(v_digits) < 10 or nullif(trim(coalesce(new.body, '')), '') is null then return new; end if;
    select * into v_drv from public.drivers
     where dsp_id = new.dsp_id
       and right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = v_digits
     limit 1;
    if v_drv.id is null then return new; end if;
    insert into public.driver_messages (driver_id, dsp_id, sender_kind, body)
    values (v_drv.id, new.dsp_id, 'driver', left('📱 (SMS) ' || trim(new.body), 2000));
    insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
    values (v_drv.id, new.dsp_id, now())
    on conflict (driver_id) do update set last_message_at = excluded.last_message_at;
  exception when others then
    null; -- never block the webhook insert
  end;
  return new;
end;
$$;
drop trigger if exists sms_bridge_to_chat on public.sms_messages;
create trigger sms_bridge_to_chat
  after insert on public.sms_messages
  for each row execute function private.trg_sms_bridge_to_chat();

-- ── 4. Email transcript (#98) ──
create or replace function public.dispatch_email_transcript(p_driver_id uuid, p_to_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers;
  v_to text := lower(trim(coalesce(p_to_email, '')));
  v_body text := '';
  r record;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_to !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email' using errcode = '22023'; end if;
  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then raise exception 'driver_not_found' using errcode = 'P0002'; end if;

  for r in
    select * from (
      select sender_kind, body, attachment_name, created_at, deleted_at
        from public.driver_messages
       where driver_id = p_driver_id and dsp_id = v_dsp
       order by created_at desc
       limit 500
    ) x order by created_at
  loop
    v_body := v_body || to_char(r.created_at, 'YYYY-MM-DD HH24:MI') || '  '
      || case when r.sender_kind = 'dispatch' then 'Dispatch' else coalesce(v_drv.full_name, 'Driver') end || ': '
      || case when r.deleted_at is not null then '[message deleted]'
              else coalesce(r.body, '') || case when r.attachment_name is not null then ' [attachment: ' || r.attachment_name || ']' else '' end
         end || E'\n';
  end loop;
  if v_body = '' then raise exception 'empty_thread' using errcode = 'P0001'; end if;

  insert into public.email_messages (dsp_id, direction, status, to_email, subject, body_text)
  values (v_dsp, 'outbound', 'queued', v_to,
          'Message transcript — ' || coalesce(v_drv.full_name, 'driver') || ' (' || to_char(now(), 'YYYY-MM-DD') || ')',
          v_body);
  return jsonb_build_object('ok', true, 'to', v_to);
end;
$$;
grant execute on function public.dispatch_email_transcript(uuid, text) to authenticated;

-- ── 5. Outbound webhooks (#99) ──
create table if not exists public.dsp_msg_webhooks (
  dsp_id     uuid primary key references public.dsps(id) on delete cascade,
  url        text not null check (url like 'https://%' and length(url) <= 500),
  secret     text check (secret is null or length(secret) <= 128),
  active     boolean not null default true,
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
alter table public.dsp_msg_webhooks enable row level security;
drop policy if exists "dsp_msg_webhooks_tenant_r" on public.dsp_msg_webhooks;
create policy "dsp_msg_webhooks_tenant_r"
  on public.dsp_msg_webhooks for select
  using (dsp_id = private.current_dsp_id());
grant select on public.dsp_msg_webhooks to authenticated;

create or replace function public.dispatch_msg_webhook_set(
  p_url    text default null,
  p_secret text default null,
  p_active boolean default null,
  p_delete boolean default false
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
  if coalesce(p_delete, false) then
    delete from public.dsp_msg_webhooks where dsp_id = v_dsp;
    return jsonb_build_object('ok', true, 'deleted', true);
  end if;
  if p_url is null or p_url not like 'https://%' then
    raise exception 'bad_url' using errcode = '22023';
  end if;
  insert into public.dsp_msg_webhooks (dsp_id, url, secret, active, created_by)
  values (v_dsp, p_url, nullif(p_secret, ''), coalesce(p_active, true), auth.uid())
  on conflict (dsp_id) do update
    set url = excluded.url,
        secret = coalesce(excluded.secret, public.dsp_msg_webhooks.secret),
        active = excluded.active,
        updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.dispatch_msg_webhook_set(text, text, boolean, boolean) to authenticated;

-- Fire-and-forget POST on every new chat message. Body carries ids + a
-- short preview only (keep payloads lean; the consumer can call back in
-- through their own service role if they need more).
create or replace function private.trg_driver_messages_webhook()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hook public.dsp_msg_webhooks;
begin
  select * into v_hook from public.dsp_msg_webhooks
   where dsp_id = new.dsp_id and active;
  if v_hook.dsp_id is null then return new; end if;
  begin
    perform net.http_post(
      url     := v_hook.url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-RouteReady-Event', 'message.created',
        'X-RouteReady-Secret', coalesce(v_hook.secret, '')
      ),
      body    := jsonb_build_object(
        'event',       'message.created',
        'dsp_id',      new.dsp_id,
        'driver_id',   new.driver_id,
        'message_id',  new.id,
        'sender_kind', new.sender_kind,
        'priority',    new.priority,
        'preview',     left(coalesce(new.body, ''), 140),
        'has_attachment', new.attachment_path is not null,
        'created_at',  new.created_at
      )
    );
  exception when others then
    null; -- webhook problems never block a message
  end;
  return new;
end;
$$;
drop trigger if exists driver_messages_webhook on public.driver_messages;
create trigger driver_messages_webhook
  after insert on public.driver_messages
  for each row execute function private.trg_driver_messages_webhook();

notify pgrst, 'reload schema';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0511_msg_admin_compliance.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
