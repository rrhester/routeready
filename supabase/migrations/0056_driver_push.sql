-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0056 · Driver push notifications (Web Push + iOS PWA badge)
--
-- Wire up Web Push so dispatch→driver chat messages produce a notification
-- on the driver's home screen, including an unread-count badge on the app
-- icon. Works on iOS 16.4+ PWAs and Chrome/Android.
--
-- Surface:
--   driver_push_vapid_key()                                  → public key for SW subscribe()
--   driver_push_register(token, endpoint, p256dh, auth, ua)  → upsert subscription
--   driver_push_unregister(token, endpoint)                  → delete on signout
--   trigger on driver_messages (dispatch sender)             → fires send-driver-push edge fn
--
-- Required runtime config (set once, see SECRETS.md):
--   Database settings:
--     app.functions_base_url     (already set for SMS/email triggers)
--     app.service_role_key       (already set for SMS/email triggers)
--     app.vapid_public_key       NEW — base64url, 65-byte uncompressed P-256 point
--   Edge-function secrets (Supabase secrets set):
--     VAPID_PUBLIC_KEY           same value as above
--     VAPID_PRIVATE_KEY          base64url, 32 raw bytes
--     VAPID_SUBJECT              e.g. mailto:support@gorouteready.com
--
-- If any of these are missing the trigger silently no-ops and the driver
-- app simply doesn't receive pushes — chat polling still works.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Table ──
create table if not exists public.driver_push_subscriptions (
  endpoint        text primary key,
  driver_id       uuid not null references public.drivers(id) on delete cascade,
  dsp_id          uuid not null references public.dsps(id)    on delete cascade,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz not null default now(),
  last_failed_at  timestamptz,
  failure_count   int not null default 0
);
create index if not exists driver_push_subs_driver_idx
  on public.driver_push_subscriptions(driver_id);

alter table public.driver_push_subscriptions enable row level security;

drop policy if exists "driver_push_subs_tenant_r" on public.driver_push_subscriptions;
create policy "driver_push_subs_tenant_r"
  on public.driver_push_subscriptions for select
  using (dsp_id = private.current_dsp_id());

grant select on public.driver_push_subscriptions to authenticated;


-- ── 2. driver_push_vapid_key ──
-- Returns the VAPID public key from a database setting so the driver app
-- can subscribe without a hard-coded constant. Returns null if the
-- setting is missing — in that case the app skips subscription.
create or replace function public.driver_push_vapid_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(current_setting('app.vapid_public_key', true), '');
$$;
grant execute on function public.driver_push_vapid_key() to anon, authenticated;


-- ── 3. driver_push_register ──
create or replace function public.driver_push_register(
  p_token      text,
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text
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

  if p_endpoint is null or p_endpoint = ''
     or p_p256dh is null or p_p256dh = ''
     or p_auth is null or p_auth = '' then
    raise exception 'invalid_subscription' using errcode = 'P0001';
  end if;

  insert into public.driver_push_subscriptions
    (endpoint, driver_id, dsp_id, p256dh, auth, user_agent)
  values
    (p_endpoint, v_drv.id, v_drv.dsp_id, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update set
    driver_id      = excluded.driver_id,
    dsp_id         = excluded.dsp_id,
    p256dh         = excluded.p256dh,
    auth           = excluded.auth,
    user_agent     = coalesce(excluded.user_agent, public.driver_push_subscriptions.user_agent),
    last_used_at   = now(),
    last_failed_at = null,
    failure_count  = 0;
end;
$$;
grant execute on function public.driver_push_register(text, text, text, text, text) to anon, authenticated;


-- ── 4. driver_push_unregister ──
create or replace function public.driver_push_unregister(
  p_token    text,
  p_endpoint text
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
  delete from public.driver_push_subscriptions
   where endpoint  = p_endpoint
     and driver_id = v_drv.id;
end;
$$;
grant execute on function public.driver_push_unregister(text, text) to anon, authenticated;


-- ── 5. Trigger: fire send-driver-push on dispatch→driver message ──
create or replace function private.fire_driver_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base text;
  v_key  text;
begin
  if new.sender_kind <> 'dispatch' then
    return new;
  end if;

  v_base := current_setting('app.functions_base_url', true);
  v_key  := current_setting('app.service_role_key',   true);
  if v_base is null or v_base = '' or v_key is null or v_key = '' then
    return new;
  end if;

  perform net.http_post(
    url     := v_base || '/send-driver-push',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body    := jsonb_build_object(
      'driver_id',  new.driver_id,
      'message_id', new.id
    )
  );

  return new;
end;
$$;

drop trigger if exists trg_driver_messages_fire_push on public.driver_messages;
create trigger trg_driver_messages_fire_push
  after insert on public.driver_messages
  for each row execute function private.fire_driver_push();


notify pgrst, 'reload schema';
