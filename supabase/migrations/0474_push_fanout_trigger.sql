-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0474 · Fire push-fanout alongside send-driver-push
--
-- The driver_messages dispatch→driver trigger (private.fire_driver_push,
-- migration 0056) already POSTs to the send-driver-push edge function for
-- Web Push. This extends it to ALSO POST to push-fanout, which delivers the
-- same notification to the driver's NATIVE devices (APNs / FCM tokens in
-- device_push_tokens, migration 0473). Web Push and native push then fire
-- together on every dispatch message — a browser/PWA gets Web Push, a
-- Capacitor app gets APNs/FCM.
--
-- Purely additive: push-fanout is a graceful no-op when the driver has no
-- native tokens or the APNs/FCM secrets aren't configured, so this is safe to
-- apply before the native apps or secrets exist.
--
-- Idempotent — safe to re-run (create-or-replace + drop/recreate trigger).
-- ─────────────────────────────────────────────────────────────────────────

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

  -- Web Push (browsers + installed PWAs) — unchanged from 0056.
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

  -- Native push (Capacitor apps: APNs / FCM). No-op when the driver has no
  -- native tokens or the secrets aren't set — never blocks the Web Push path.
  perform net.http_post(
    url     := v_base || '/push-fanout',
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
