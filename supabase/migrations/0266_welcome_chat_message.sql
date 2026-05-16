-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0266 · Welcome chat message on activation
--
-- Operator: "It would be great if when the driver got access to the
-- app, that a welcome message was on the message for him, and there
-- was a notification like a small red 1 on the message icon to alert
-- them of a message. I believe this would create more awareness that
-- the message app was there to support the onboarding experience."
--
-- This migration handles the server side: when a driver's activated_at
-- flips from NULL to a real timestamp (which is exactly the "tap the
-- welcome link → activate" moment from driver_activate), insert a
-- friendly from-dispatch message into their driver↔dispatcher chat
-- thread and bump the conversation's last_message_at so the chat
-- thread sorts to the top of any future inbox view. The unread badge
-- on the Chat tab is wired up app-side (sibling commit) — driver_chat_list
-- already exposes `is_unread` per message, so the badge just counts
-- those.
--
-- Implementation notes:
--   • sender_kind = 'dispatch', sender_user_id = NULL. The driver app
--     renders all dispatch messages identically (right-aligned, no
--     authored-by line), so the NULL author is fine — the message
--     reads as if it's from the DSP.
--   • The body uses the DSP name and the driver's preferred-or-first
--     name. Avoids any per-DSP templating burden — operators can edit
--     it later via a templates UI if/when we add one.
--   • Trigger is AFTER UPDATE OF activated_at + WHEN clause that
--     specifically catches the NULL → non-NULL transition. A driver
--     who gets "re-activated" (consumed_at refresh from 0256) doesn't
--     fire this — activated_at is set once via coalesce(activated_at, now()).
--   • Wrap in private. namespace + security definer; the trigger runs
--     under the driver_activate RPC's elevated context so the chat
--     insert clears RLS.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.post_driver_welcome_message(p_driver_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv   public.drivers;
  v_dsp   public.dsps;
  v_first text;
  v_dspn  text;
  v_body  text;
begin
  select * into v_drv from public.drivers where id = p_driver_id;
  if v_drv.id is null then return; end if;

  -- Idempotent guard: don't post twice if for some reason this fires
  -- more than once for the same driver.
  if exists (
    select 1 from public.driver_messages
     where driver_id = v_drv.id
       and sender_kind = 'dispatch'
       and sender_user_id is null
  ) then
    return;
  end if;

  select * into v_dsp from public.dsps where id = v_drv.dsp_id;

  v_first := coalesce(nullif(trim(v_drv.preferred_name), ''),
                      nullif(trim(v_drv.first_name), ''),
                      'there');
  v_dspn  := coalesce(nullif(trim(v_dsp.name), ''), 'your team');

  v_body :=
    'Hi ' || v_first || ' — welcome to ' || v_dspn || '!' || chr(10) || chr(10)
    || 'This is your direct line to dispatch. Use it any time during onboarding '
    || 'if you have questions about a step, your schedule, or anything else. '
    || 'A real person on our team will see what you send.' || chr(10) || chr(10)
    || 'Glad to have you on board.';

  -- Make sure the conversation row exists; bump last_message_at so
  -- future inbox sorts surface this thread.
  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (v_drv.id, v_drv.dsp_id, now())
  on conflict (driver_id) do update
    set last_message_at = excluded.last_message_at,
        dsp_id          = excluded.dsp_id;

  insert into public.driver_messages
    (driver_id, dsp_id, sender_kind, sender_user_id, body)
  values
    (v_drv.id, v_drv.dsp_id, 'dispatch', null, v_body);
end;
$$;


create or replace function private.driver_activation_welcome_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.activated_at is null and new.activated_at is not null then
    perform private.post_driver_welcome_message(new.id);
  end if;
  return new;
end;
$$;


drop trigger if exists trg_drivers_activation_welcome on public.drivers;
create trigger trg_drivers_activation_welcome
  after update of activated_at on public.drivers
  for each row execute function private.driver_activation_welcome_trigger();


notify pgrst, 'reload schema';
