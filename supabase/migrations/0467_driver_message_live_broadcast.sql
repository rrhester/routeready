-- 0467_driver_message_live_broadcast.sql
-- Instant (realtime) in-app delivery of dispatch chat + channel messages
-- to the driver app, closing the last gap in driver-directed realtime.
--
-- Why this is needed
-- ──────────────────
-- Drivers auth by opaque token and have no auth.uid, so RLS-filtered
-- postgres_changes can't reach them (see 0426). The driver app *does*
-- subscribe to postgres_changes on driver_messages / driver_channel_
-- messages, but Realtime evaluates those as the anon role — the RLS
-- policies gate SELECT to dispatchers (dsp_id = current_dsp_id()), so the
-- row events are never delivered to the driver. New messages therefore
-- only surfaced via the app's 10–30s safety-net poll, on focus, or Web
-- Push — never truly "instant" in-app.
--
-- Migration 0426 fixed exactly this class of problem for cover offers,
-- swaps, and 5th-day confirmations using Realtime *Broadcast* (channel-
-- based, NOT RLS-filtered) to the public topic rr-driver-live-<driver_id>.
-- This migration extends that same pattern to the two highest-volume
-- driver-directed streams:
--
--   1. driver_messages          (dispatch ↔ driver chat)
--   2. driver_channel_messages  (group channels)
--
-- On each relevant write we broadcast a content-free { kind } ping to the
-- affected driver's rr-driver-live topic. The app (subscribed once, app-
-- wide) re-fetches through the existing token-gated RPCs the instant a
-- ping arrives — so the message and the unread badge update immediately.
-- The ping carries NO message content (only a kind hint + channel_id), so
-- a leaked topic name reveals nothing sensitive.
--
-- Web Push is untouched: the 0056 (driver_messages) and 0074 (channel)
-- triggers still fire send-driver-push, so the driver is *notified* even
-- with the app closed. Together: every message → notification + instant
-- in-app delivery.
--
-- Fully self-contained and idempotent (create-or-replace + drop-if-exists).
-- Every broadcast is wrapped so a Realtime failure is a silent no-op that
-- never rolls back the caller's insert (push + polling still cover it).

-- ── 1. Dispatch chat → live ping to the driver ────────────────────────
-- Fires on INSERT (a new dispatch message) and on UPDATE (edits, deletes,
-- acknowledgements) so the driver's open thread re-renders at once. A
-- driver's own outbound message is skipped on INSERT — the app already
-- painted it optimistically — but UPDATEs always ping so a dispatch edit
-- or delete reflects immediately.
create or replace function private.fire_driver_message_live()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' and NEW.sender_kind <> 'dispatch' then
    return NEW;
  end if;

  perform private.driver_live_ping(NEW.driver_id, 'chat');
  return NEW;
exception when others then
  return NEW;  -- Realtime unavailable → silent no-op; push + polling cover it
end;
$$;

drop trigger if exists trg_driver_messages_fire_live on public.driver_messages;
create trigger trg_driver_messages_fire_live
  after insert or update on public.driver_messages
  for each row execute function private.fire_driver_message_live();


-- ── 2. Channel message → live ping fanned out to each member ──────────
-- Mirrors the Web Push fan-out (0074): every member of the channel except
-- the sender, skipping muted members, gets a ping on their own
-- rr-driver-live topic. The payload includes channel_id so the app can
-- refresh the open thread precisely and re-count the channels list.
create or replace function private.fire_channel_message_live()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_driver_id uuid;
begin
  for v_driver_id in
    select m.driver_id
      from public.driver_channel_members m
     where m.channel_id = NEW.channel_id
       and m.muted is not true
       and (NEW.sender_driver_id is null or m.driver_id <> NEW.sender_driver_id)
  loop
    perform realtime.send(
      jsonb_build_object('kind', 'channel', 'channel_id', NEW.channel_id::text),
      'refresh',
      'rr-driver-live-' || v_driver_id::text,
      false
    );
  end loop;
  return NEW;
exception when others then
  return NEW;  -- Realtime unavailable → silent no-op; push + polling cover it
end;
$$;

drop trigger if exists trg_channel_messages_fire_live on public.driver_channel_messages;
create trigger trg_channel_messages_fire_live
  after insert on public.driver_channel_messages
  for each row execute function private.fire_channel_message_live();


notify pgrst, 'reload schema';
