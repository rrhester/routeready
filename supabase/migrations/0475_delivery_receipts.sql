-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0475 · Delivery receipts (dispatch → driver)
--
-- Adds the middle state between "Sent" and "Read": "Delivered" — set the
-- moment the driver's device actually receives a dispatch message, even if
-- the app is closed. The driver PWA's service worker already fires on every
-- Web Push; it now also stamps driver_conversations.driver_delivered_at, so
-- the dispatcher's thread can show Sent ✓ → Delivered ✓✓ → Read ✓✓ (blue),
-- WhatsApp-style.
--
-- Surface:
--   driver_chat_mark_delivered(p_token)      → driver/SW marks "received up to now"
--                                              (advance-only; anon-callable via token)
--   dispatch_chat_delivered(p_driver_id)     → dispatcher reads the driver's
--                                              delivered marker (staff-gated)
--
-- Purely additive; existing read-receipt fields (driver_last_read_at) are
-- untouched. The big thread RPCs are NOT modified — the dashboard reads the
-- delivered marker via the small dispatch_chat_delivered RPC alongside the
-- thread poll, so there's no risk to dispatch_chat_thread.
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.driver_conversations
  add column if not exists driver_delivered_at timestamptz;

-- Driver (or the driver's service worker on a push) confirms receipt up to
-- now. Advance-only so an out-of-order call can't move the marker backwards.
create or replace function public.driver_chat_mark_delivered(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);   -- raises if invalid/revoked
  insert into public.driver_conversations (driver_id, dsp_id, driver_delivered_at)
  values (v_drv.id, v_drv.dsp_id, now())
  on conflict (driver_id) do update
    set driver_delivered_at = greatest(
      coalesce(public.driver_conversations.driver_delivered_at, 'epoch'::timestamptz),
      now());
end;
$$;

grant execute on function public.driver_chat_mark_delivered(text) to anon, authenticated;

-- Dispatcher reads the driver's delivered marker (staff-gated, own DSP only).
create or replace function public.dispatch_chat_delivered(p_driver_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_ts  timestamptz;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select c.driver_delivered_at into v_ts
    from public.driver_conversations c
   where c.driver_id = p_driver_id and c.dsp_id = v_dsp;
  return v_ts;
end;
$$;

grant execute on function public.dispatch_chat_delivered(uuid) to authenticated;

notify pgrst, 'reload schema';
