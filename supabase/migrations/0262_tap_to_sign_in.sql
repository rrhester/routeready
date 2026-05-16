-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0262 · Tap-to-sign-in · PIN optional on activation
--
-- Operator feedback after going through the driver app onboarding:
--   "I had to log in/out so many times and use codes and the 4-digit
--    code didn't work — it was just a hot mess."
--
-- The current first-time activation requires a phone + a 4-to-6-digit
-- PIN before the driver is signed in. That's three text fields on a
-- screen they hit straight off an SMS link. The PIN exists for fast
-- multi-device sign-in, but the activation code is already reusable
-- for 14 days (0256_activation_code_reusable.sql), so a driver who
-- skips the PIN can just tap a fresh link from dispatch on any new
-- device — same one-tap UX.
--
-- This migration makes p_pin optional on driver_activate:
--   • p_pin null / empty / whitespace → skip PIN validation, leave
--     pin_hash null, do NOT revoke prior driver_sessions (the
--     PIN-revocation signal only applies when a PIN is being set).
--     Still mark activated_at, consume the code, issue a session token.
--   • p_pin provided → existing behavior. Length check, bcrypt hash,
--     revoke prior sessions. A driver can opt in to a PIN at first
--     activation if they want faster phone+PIN sign-in later.
--
-- p_phone was already optional in the first-time path (empty kept what
-- was on file). This migration also accepts empty p_phone in the
-- subsequent-activation path so the driver app can call the function
-- with just the code for both first-time and returning drivers.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.driver_activate(
  p_code   text,
  p_phone  text,
  p_pin    text,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite        public.driver_invite_codes;
  v_drv           public.drivers;
  v_dsp           public.dsps;
  v_phone_norm    text;
  v_phone_clash   uuid;
  v_token         text;
  v_pin_clean     text;
  v_first_time    boolean;
  v_setting_pin   boolean;
begin
  select * into v_invite
    from public.driver_invite_codes
   where code = upper(trim(coalesce(p_code, '')))
     and expires_at > now();
  if v_invite.code is null then
    raise exception 'invalid_or_expired_code' using errcode = 'P0001';
  end if;

  select * into v_drv from public.drivers where id = v_invite.driver_id;
  if v_drv.id is null or v_drv.status not in ('active','onboarding') then
    raise exception 'driver_inactive' using errcode = 'P0001';
  end if;

  v_first_time  := v_drv.pin_hash is null;
  v_pin_clean   := regexp_replace(coalesce(p_pin, ''), '[^0-9]', '', 'g');
  v_setting_pin := v_first_time and length(v_pin_clean) >= 4;

  if v_first_time then
    -- PIN is optional now. If the driver supplied one, validate and
    -- store it; otherwise leave pin_hash null. The activation code
    -- remains the credential they re-use to sign in on new devices.
    if length(v_pin_clean) > 0 and (length(v_pin_clean) < 4 or length(v_pin_clean) > 6) then
      raise exception 'pin_must_be_4_to_6_digits' using errcode = '22023';
    end if;

    v_phone_norm := private.normalize_phone(p_phone);
    if v_phone_norm is null then
      if v_drv.phone_normalized is null then
        raise exception 'phone_required' using errcode = '22023';
      end if;
      v_phone_norm := v_drv.phone_normalized;
    end if;

    if v_phone_norm <> coalesce(v_drv.phone_normalized, '') then
      select id into v_phone_clash from public.drivers
       where dsp_id = v_drv.dsp_id
         and status <> 'terminated'
         and phone_normalized = v_phone_norm
         and id <> v_drv.id
       limit 1;
      if v_phone_clash is not null then
        raise exception 'phone_already_in_use' using errcode = '23505';
      end if;
    end if;

    if v_setting_pin then
      update public.drivers
         set phone        = case when v_phone_norm <> coalesce(phone_normalized, '') then p_phone else phone end,
             pin_hash     = extensions.crypt(v_pin_clean, extensions.gen_salt('bf', 10)),
             pin_set_at   = now(),
             activated_at = coalesce(activated_at, now()),
             updated_at   = now()
       where id = v_drv.id
       returning * into v_drv;
    else
      update public.drivers
         set phone        = case when v_phone_norm <> coalesce(phone_normalized, '') then p_phone else phone end,
             activated_at = coalesce(activated_at, now()),
             updated_at   = now()
       where id = v_drv.id
       returning * into v_drv;
    end if;

    update public.driver_invite_codes
       set consumed_at = now()
     where code = v_invite.code
       and consumed_at is null;

    -- Fresh PIN = fresh slate: revoke any prior sessions. No PIN means
    -- we treat this like any other returning sign-in (other devices
    -- keep their sessions).
    if v_setting_pin then
      update public.driver_sessions
         set revoked_at = now()
       where driver_id = v_drv.id
         and revoked_at is null;
    end if;

  else
    -- Returning sign-in via the same code (e.g., the home-screen PWA
    -- after the driver activated in Safari). PIN argument is ignored;
    -- the code itself is the credential. We do NOT revoke existing
    -- sessions — drivers stay signed in on every device.
    null;
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '');

  insert into public.driver_sessions (token, dsp_id, driver_id, user_agent)
  values (v_token, v_drv.dsp_id, v_drv.id, p_user_agent);

  select * into v_dsp from public.dsps where id = v_drv.dsp_id;

  return jsonb_build_object(
    'token', v_token,
    'first_time', v_first_time,
    'pin_set',    v_drv.pin_hash is not null,
    'driver', jsonb_build_object(
      'id',         v_drv.id,
      'dsp_id',     v_drv.dsp_id,
      'full_name',  v_drv.full_name,
      'name',       coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
      'station_id', v_drv.station_id,
      'tier',       v_drv.tier,
      'status',     v_drv.status,
      'dsp_name',   coalesce(v_dsp.name, ''),
      'phone_normalized', v_drv.phone_normalized
    )
  );
end;
$$;
grant execute on function public.driver_activate(text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
