-- ─────────────────────────────────────────────────────────────────────────
-- 0496 · Outlook push, Google overlay selection, sync health, webhooks
--        (calendar 100-list #63, #65, #66, #68, #70)
--
--  • ms_calendar_accounts + fire_mscal_sync trigger + ms_* columns on
--    cal_events: one-way push of interviews/orientations/events into the
--    DSP's Outlook calendar via the microsoft-calendar-sync edge function
--    (config-gated on MS_CLIENT_ID/MS_CLIENT_SECRET/MS_OAUTH_REDIRECT_URI).
--  • google_calendar_accounts.overlay_calendar_ids + set-RPC: overlay any of
--    the connected account's calendars, not just primary.
--  • google_calendar_status now reports last_pulled_at (sync health).
--  • dsp_webhooks + trigger: outbound webhooks (Zapier-style) on
--    booking_created / rescheduled / cancelled / no_show, posted via pg_net
--    with the row's shared secret in x-rr-webhook-secret.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1 · Outlook account store (mirrors google_calendar_accounts) ────────

create table if not exists public.ms_calendar_accounts (
  dsp_id                   uuid primary key references public.dsps(id) on delete cascade,
  ms_email                 text,
  refresh_token_enc        text not null,
  refresh_token_iv         text not null,
  access_token_enc         text,
  access_token_iv          text,
  access_token_expires_at  timestamptz,
  scope                    text,
  connected_by             uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
alter table public.ms_calendar_accounts enable row level security;
-- No policies: service-role only (same posture as google_calendar_accounts).

alter table public.cal_events add column if not exists ms_event_id    text;
alter table public.cal_events add column if not exists ms_sync_status text;
alter table public.cal_events add column if not exists ms_sync_error  text;
alter table public.cal_events add column if not exists ms_synced_at   timestamptz;

create or replace function public.ms_calendar_status()
returns table (connected boolean, email text, connected_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select true, a.ms_email, a.created_at
  from public.ms_calendar_accounts a
  where a.dsp_id = private.current_dsp_id()
  union all
  select false, null, null
  where not exists (
    select 1 from public.ms_calendar_accounts a
    where a.dsp_id = private.current_dsp_id()
  )
  limit 1;
$$;
grant execute on function public.ms_calendar_status() to authenticated;

insert into private.integration_settings (key, value) values
  ('mscal_sync_url', 'https://doiwrhkirgblcvuskhno.supabase.co/functions/v1/microsoft-calendar-sync')
on conflict (key) do nothing;

create or replace function private.fire_mscal_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_url   text;
  v_token text;
  v_id    uuid := coalesce(new.id, old.id);
  v_op    text := lower(tg_op);
begin
  -- Only when this DSP actually connected Outlook — a no-op for everyone else.
  if not exists (select 1 from public.ms_calendar_accounts a
                  where a.dsp_id = coalesce(new.dsp_id, old.dsp_id)) then
    return coalesce(new, old);
  end if;

  select value into v_url   from private.integration_settings where key = 'mscal_sync_url';
  select value into v_token from private.integration_settings where key = 'gcal_sync_token';
  if v_url is null or v_token is null then return coalesce(new, old); end if;

  if v_op = 'delete' then
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object('content-type','application/json','x-rr-sync-token', v_token),
      body    := jsonb_build_object('cal_event_id', v_id, 'op', v_op,
                                    'dsp_id', old.dsp_id, 'ms_event_id', old.ms_event_id)
    );
  else
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object('content-type','application/json','x-rr-sync-token', v_token),
      body    := jsonb_build_object('cal_event_id', v_id, 'op', v_op)
    );
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_cal_events_mscal_sync on public.cal_events;
create trigger trg_cal_events_mscal_sync
  after insert or update or delete on public.cal_events
  for each row execute function private.fire_mscal_sync();

-- ── 2 · Google overlay-calendar selection + sync health ─────────────────

alter table public.google_calendar_accounts
  add column if not exists overlay_calendar_ids jsonb;
-- Re-assert last_pulled_at (0432) so this migration stands alone on a
-- database that never applied the two-way-sync migration — same defensive
-- pattern as 0409. The column stays null until 0432's pull cron runs.
alter table public.google_calendar_accounts
  add column if not exists last_pulled_at timestamptz;

create or replace function public.google_calendar_set_overlays(p_ids jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_ids is not null and (jsonb_typeof(p_ids) <> 'array' or jsonb_array_length(p_ids) > 8) then
    raise exception 'invalid_calendar_list';
  end if;
  update public.google_calendar_accounts
     set overlay_calendar_ids = case when p_ids is null or jsonb_array_length(p_ids) = 0 then null else p_ids end,
         updated_at = now()
   where dsp_id = v_dsp;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_connected');
  end if;
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.google_calendar_set_overlays(jsonb) to authenticated;

drop function if exists public.google_calendar_status();
create or replace function public.google_calendar_status()
returns table (connected boolean, email text, calendar_id text, connected_at timestamptz,
               last_pulled_at timestamptz, overlay_calendar_ids jsonb)
language sql stable security definer set search_path = '' as $$
  select true, a.google_email, a.calendar_id, a.created_at, a.last_pulled_at, a.overlay_calendar_ids
  from public.google_calendar_accounts a
  where a.dsp_id = private.current_dsp_id()
  union all
  select false, null, null, null, null, null
  where not exists (
    select 1 from public.google_calendar_accounts a
    where a.dsp_id = private.current_dsp_id()
  )
  limit 1;
$$;
grant execute on function public.google_calendar_status() to authenticated;

-- ── 3 · Outbound webhooks (#70) ──────────────────────────────────────────

create table if not exists public.dsp_webhooks (
  id         uuid        primary key default gen_random_uuid(),
  dsp_id     uuid        not null references public.dsps(id) on delete cascade,
  url        text        not null,
  secret     text        not null,
  events     text[]      not null default '{booking_created,booking_cancelled,booking_rescheduled,booking_no_show}',
  active     boolean     not null default true,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists dsp_webhooks_dsp_idx on public.dsp_webhooks (dsp_id) where active;
alter table public.dsp_webhooks enable row level security;
-- Definer RPCs only (the secret must never be readable via generic selects).

create or replace function public.webhook_list()
returns table (id uuid, url text, events text[], active boolean, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select w.id, w.url, w.events, w.active, w.created_at
  from public.dsp_webhooks w
  where w.dsp_id = private.current_dsp_id()
    and private.is_staff(private.current_dsp_id(), 'dispatcher')
  order by w.created_at;
$$;
grant execute on function public.webhook_list() to authenticated;

create or replace function public.webhook_add(p_url text, p_events text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  -- Two v4 UUIDs = 61 hex chars of CSPRNG randomness, no extension deps.
  v_secret text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_id uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_url is null or p_url !~* '^https://' then
    raise exception 'https_url_required';
  end if;
  if (select count(*) from public.dsp_webhooks where dsp_id = v_dsp and active) >= 5 then
    raise exception 'webhook_limit';
  end if;
  insert into public.dsp_webhooks (dsp_id, url, secret, events, created_by)
  values (v_dsp, btrim(p_url),
          v_secret,
          coalesce(p_events, '{booking_created,booking_cancelled,booking_rescheduled,booking_no_show}'),
          auth.uid())
  returning id into v_id;
  -- The secret is shown exactly once, at creation.
  return jsonb_build_object('ok', true, 'id', v_id, 'secret', v_secret);
end; $$;
grant execute on function public.webhook_add(text, text[]) to authenticated;

create or replace function public.webhook_remove(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  delete from public.dsp_webhooks
  where id = p_id and dsp_id = private.current_dsp_id()
    and private.is_staff(private.current_dsp_id(), 'dispatcher');
$$;
grant execute on function public.webhook_remove(uuid) to authenticated;

-- Fire on interview lifecycle transitions. Deliveries are fire-and-forget
-- pg_net posts; the shared secret rides x-rr-webhook-secret.
create or replace function private.fire_cal_webhooks()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_event text := null;
  w record;
  v_body jsonb;
begin
  if new.kind not in ('interview', 'orientation') then return new; end if;
  if tg_op = 'INSERT' and new.status in ('scheduled') and new.applicant_id is not null then
    v_event := 'booking_created';
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status then
    v_event := case new.status
      when 'cancelled' then 'booking_cancelled'
      when 'rescheduled' then 'booking_rescheduled'
      when 'no_show' then 'booking_no_show'
      else null end;
  elsif tg_op = 'UPDATE' and old.starts_at is distinct from new.starts_at
        and new.status in ('scheduled', 'rescheduled') then
    v_event := 'booking_rescheduled';
  end if;
  if v_event is null then return new; end if;

  v_body := jsonb_build_object(
    'event', v_event,
    'at', now(),
    'cal_event', jsonb_build_object(
      'id', new.id, 'kind', new.kind, 'status', new.status,
      'starts_at', new.starts_at, 'ends_at', new.ends_at,
      'timezone', new.timezone, 'location', new.location,
      'applicant_id', new.applicant_id));

  for w in select * from public.dsp_webhooks
            where dsp_id = new.dsp_id and active and v_event = any(events)
  loop
    begin
      perform net.http_post(
        url     := w.url,
        headers := jsonb_build_object('content-type', 'application/json',
                                      'x-rr-webhook-secret', w.secret,
                                      'x-rr-event', v_event),
        body    := v_body
      );
    exception when others then null;   -- a broken hook must never block a booking
    end;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_cal_events_webhooks on public.cal_events;
create trigger trg_cal_events_webhooks
  after insert or update on public.cal_events
  for each row execute function private.fire_cal_webhooks();

notify pgrst, 'reload schema';
