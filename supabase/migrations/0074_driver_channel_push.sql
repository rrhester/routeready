-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0074 · Web Push fan-out for driver channel messages
--
-- AFTER INSERT trigger on driver_channel_messages calls send-driver-push
-- with { channel_id, message_id }.  The edge function (updated in this
-- same release) looks up channel members, drops the sender + anyone
-- muted, and pushes to each remaining member's subscriptions.
--
-- Same env-driven http_post pattern as migration 0056 / 0057.  Requires
-- app.functions_base_url and app.service_role_key to be set on the DB
-- (already done for the existing dispatch→driver push).
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.fire_channel_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base text;
  v_key  text;
begin
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
      'channel_id', new.channel_id,
      'message_id', new.id
    )
  );

  return new;
end;
$$;

drop trigger if exists trg_channel_messages_fire_push on public.driver_channel_messages;
create trigger trg_channel_messages_fire_push
  after insert on public.driver_channel_messages
  for each row execute function private.fire_channel_push();
