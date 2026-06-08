-- ───────────────────────────────────────────────────────────────────────
-- 0367 · Google Calendar integration
--   private.google_calendar_accounts  · one per DSP, tokens encrypted
--   public.google_calendar_status()   · safe {connected,email} for clients
--   cal_events.google_*               · event-id mapping + sync state
--   trigger → google-calendar-sync     · fire on interview event changes
-- Requires pg_net (already used by the message-send trigger). Idempotent.
-- ───────────────────────────────────────────────────────────────────────

create schema if not exists private;
create extension if not exists pg_net;

-- ── Token store ──
-- Lives in `public` so edge functions can reach it through PostgREST with the
-- service-role key (PostgREST only serves the public schema). It is locked to
-- service-role only: RLS is ON with NO policies and all grants are revoked
-- from anon/authenticated, so the browser can never read a token. The service
-- role bypasses RLS. Clients only ever see status via google_calendar_status().
create table if not exists public.google_calendar_accounts (
  dsp_id                  uuid primary key references public.dsps(id) on delete cascade,
  google_email            text not null,
  calendar_id             text not null default 'primary',
  -- AES-GCM ciphertext (base64) + iv (base64); plaintext never stored.
  refresh_token_enc       text not null,
  refresh_token_iv        text not null,
  access_token_enc        text,
  access_token_iv         text,
  access_token_expires_at timestamptz,
  scope                   text,
  connected_by            uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
alter table public.google_calendar_accounts enable row level security;
-- No policies + no grants → unreachable by anon/authenticated; service role bypasses.
revoke all on public.google_calendar_accounts from anon, authenticated;

-- ── Client-facing status (security definer; returns only safe fields) ──
create or replace function public.google_calendar_status()
returns table (connected boolean, email text, calendar_id text, connected_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select true, a.google_email, a.calendar_id, a.created_at
  from public.google_calendar_accounts a
  where a.dsp_id = private.current_dsp_id()
  union all
  select false, null, null, null
  where not exists (
    select 1 from public.google_calendar_accounts a
    where a.dsp_id = private.current_dsp_id()
  )
  limit 1;
$$;
grant execute on function public.google_calendar_status() to authenticated;

-- ── Event-id mapping on the existing interview/orientation events ──
alter table public.cal_events add column if not exists google_event_id    text;
alter table public.cal_events add column if not exists google_calendar_id  text;
alter table public.cal_events add column if not exists google_sync_status  text;   -- 'synced' | 'error' | null
alter table public.cal_events add column if not exists google_sync_error   text;
alter table public.cal_events add column if not exists google_synced_at    timestamptz;

-- ── Trigger config (URL is public; the token is a shared secret) ──
create table if not exists private.integration_settings (key text primary key, value text not null);
insert into private.integration_settings (key, value) values
  ('gcal_sync_url', 'https://doiwrhkirgblcvuskhno.supabase.co/functions/v1/google-calendar-sync')
on conflict (key) do nothing;
-- IMPORTANT: set this to the same value as the GOOGLE_SYNC_TRIGGER_TOKEN secret:
--   insert into private.integration_settings(key,value)
--   values ('gcal_sync_token','<hex>') on conflict (key) do update set value = excluded.value;

-- ── Fire the sync function on interview/orientation event changes ──
create or replace function private.fire_gcal_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_url   text;
  v_token text;
  v_id    uuid := coalesce(new.id, old.id);
  v_op    text := lower(tg_op);
begin
  if v_op <> 'delete' and new.kind not in ('interview','orientation') then return new; end if;
  if v_op =  'delete' and old.kind not in ('interview','orientation') then return old; end if;

  select value into v_url   from private.integration_settings where key = 'gcal_sync_url';
  select value into v_token from private.integration_settings where key = 'gcal_sync_token';
  if v_url is null or v_token is null then return coalesce(new, old); end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('content-type','application/json','x-rr-sync-token', v_token),
    body    := jsonb_build_object('cal_event_id', v_id, 'op', v_op)
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_cal_events_gcal_sync on public.cal_events;
create trigger trg_cal_events_gcal_sync
  after insert or update or delete on public.cal_events
  for each row execute function private.fire_gcal_sync();
