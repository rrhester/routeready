-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0267 · Welcome chat message · split + install instructions
--
-- Operator: "In the welcome message, there isn't any need to explain
-- how to save the app to the phone. I would rather have those
-- instructions in the message app when they open it. Please also
-- include pictures on how to do it."
--
-- The single welcome message added in 0266 already kept itself
-- separate from any email about install steps. This migration:
--
--   1. Trims the welcome text to its core "this is your line to
--      dispatch" framing — no install talk, no "we're glad to have
--      you" filler that buries the actionable bit.
--   2. Posts a SECOND from-dispatch message immediately after, with
--      step-by-step "save the app to your home screen" instructions
--      for both iPhone (Safari → Share → Add to Home Screen) and
--      Android (Chrome → menu → Install app), AND attaches a
--      schematic illustration showing the share button / 3-dot menu /
--      install menu items highlighted. The attachment_path points at
--      /app/icons/install-instructions.svg — the sibling app commit
--      teaches the chat attachment resolver to use such absolute
--      paths directly (no Supabase storage round-trip), so this
--      works without uploading anything to a bucket.
--
-- Idempotency: the install-instructions message is keyed on its
-- attachment_path so re-running the trigger won't post duplicates.
-- The welcome-text message uses the existing (sender_user_id IS NULL
-- + body LIKE 'Hi % — welcome to %') heuristic from 0266 so existing
-- onboarded drivers won't get a re-post either.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.post_driver_welcome_message(p_driver_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv          public.drivers;
  v_dsp          public.dsps;
  v_first        text;
  v_dspn         text;
  v_welcome_body text;
  v_install_body text;
  v_install_path constant text := '/app/icons/install-instructions.svg';
begin
  select * into v_drv from public.drivers where id = p_driver_id;
  if v_drv.id is null then return; end if;

  select * into v_dsp from public.dsps where id = v_drv.dsp_id;

  v_first := coalesce(nullif(trim(v_drv.preferred_name), ''),
                      nullif(trim(v_drv.first_name), ''),
                      'there');
  v_dspn  := coalesce(nullif(trim(v_dsp.name), ''), 'your team');

  v_welcome_body :=
    'Hi ' || v_first || ' — welcome to ' || v_dspn || '!' || chr(10) || chr(10)
    || 'This is your direct line to dispatch. Use it any time during onboarding '
    || 'if you have questions about a step, your schedule, or anything else. '
    || 'A real person on our team will see what you send.';

  v_install_body :=
    'One quick setup tip — save RouteReady to your phone''s home screen so it''s one tap to open from here on out.'
    || chr(10) || chr(10)
    || 'iPhone (Safari):' || chr(10)
    || '  1. Tap the Share button at the bottom.' || chr(10)
    || '  2. Scroll down and tap "Add to Home Screen".' || chr(10)
    || '  3. Tap "Add".' || chr(10)
    || chr(10)
    || 'Android (Chrome):' || chr(10)
    || '  1. Tap the three-dot menu at the top right.' || chr(10)
    || '  2. Tap "Install app" (or "Add to Home screen").' || chr(10)
    || chr(10)
    || 'See the picture below for the exact buttons.';

  -- Conversation row + last_message_at so the thread sorts to the top.
  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (v_drv.id, v_drv.dsp_id, now())
  on conflict (driver_id) do update
    set last_message_at = excluded.last_message_at,
        dsp_id          = excluded.dsp_id;

  -- 1. Welcome message — skip if any system welcome from dispatch is
  -- already on file for this driver (covers both this migration's
  -- format and 0266's slightly longer one).
  if not exists (
    select 1 from public.driver_messages
     where driver_id = v_drv.id
       and sender_kind = 'dispatch'
       and sender_user_id is null
       and attachment_path is null
  ) then
    insert into public.driver_messages
      (driver_id, dsp_id, sender_kind, sender_user_id, body)
    values
      (v_drv.id, v_drv.dsp_id, 'dispatch', null, v_welcome_body);
  end if;

  -- 2. Install instructions + image. Keyed on attachment_path so we
  -- never post twice even if the trigger fires more than once.
  if not exists (
    select 1 from public.driver_messages
     where driver_id = v_drv.id
       and sender_kind = 'dispatch'
       and sender_user_id is null
       and attachment_path = v_install_path
  ) then
    insert into public.driver_messages
      (driver_id, dsp_id, sender_kind, sender_user_id,
       body, attachment_path, attachment_mime, attachment_name)
    values
      (v_drv.id, v_drv.dsp_id, 'dispatch', null,
       v_install_body, v_install_path, 'image/svg+xml', 'How to save the app');
  end if;
end;
$$;


notify pgrst, 'reload schema';
