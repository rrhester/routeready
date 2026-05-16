-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0256 · Activation codes reusable for multi-device sign-in
--
-- Real-world bug: a driver activates by tapping the welcome email link
-- in Safari, then installs the home-screen PWA.  On iOS the PWA has
-- its own localStorage sandbox, so the activated session in Safari
-- isn't visible from the PWA — the PWA launches signed out.  Tapping
-- the email link again opens it in Safari (iOS doesn't route external
-- links into installed PWAs), Safari re-activates (or errors because
-- the code is "consumed"), and the PWA stays empty.  Loop.
--
-- This migration makes the same activation code a one-tap sign-in for
-- the entire 14-day window.  Concretely:
--
--   • driver_activation_lookup no longer hides "consumed" codes —
--     only expired ones.  The response keeps reporting
--     already_activated so the client can render the right screen.
--
--   • driver_activate now branches on driver.pin_hash:
--       ◦ pin_hash is null  → first-time activation.  PIN required,
--                              must be 4–6 digits, stored as bcrypt.
--                              Marks consumed_at on the code (the
--                              record that this driver has set up).
--       ◦ pin_hash is set   → returning sign-in via the same code.
--                              PIN parameter is ignored; the code
--                              itself is the credential, just like
--                              any magic-link system.  consumed_at
--                              stays on the original first-activation
--                              timestamp.  Phone changes are also
--                              ignored on subsequent uses — the
--                              driver's phone of record can only
--                              change during the initial activation
--                              (or via the dashboard).
--
--   • Prior driver_sessions are NO LONGER auto-revoked on every
--     re-activation — drivers stay signed in on every device they've
--     activated to.  We do still revoke on a brand-new first-time
--     activation (the protection a fresh PIN signal carries).
-- ─────────────────────────────────────────────────────────────────────────


create or replace function public.driver_activation_lookup(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_invite public.driver_invite_codes;
  v_drv    public.drivers;
  v_dsp    public.dsps;
  v_phone  text;
  v_hint   text;
begin
  -- Match by code + not expired.  Consumed codes are still valid as
  -- one-tap sign-in for the rest of the 14-day window.
  select * into v_invite
    from public.driver_invite_codes
   where code = upper(trim(coalesce(p_code, '')))
     and expires_at > now();
  if v_invite.code is null then
    raise exception 'invalid_or_expired_code' using errcode = 'P0001';
  end if;

  select * into v_drv from public.drivers where id = v_invite.driver_id;
  if v_drv.id is null or v_drv.status not in ('active','onboarding') then
    raise exception 'invalid_or_expired_code' using errcode = 'P0001';
  end if;

  select * into v_dsp from public.dsps where id = v_drv.dsp_id;

  v_phone := v_drv.phone_normalized;
  if v_phone is not null and length(v_phone) >= 4 then
    v_hint := '(•••) •••-' || right(v_phone, 4);
  else
    v_hint := null;
  end if;

  return jsonb_build_object(
    'code',          v_invite.code,
    'driver_id',     v_drv.id,
    'name',          coalesce(nullif(trim(v_drv.preferred_name), ''),
                              nullif(trim(v_drv.first_name), ''),
                              v_drv.full_name),
    'full_name',     v_drv.full_name,
    'phone_hint',    v_hint,
    'has_phone',     v_phone is not null,
    'dsp_name',      coalesce(v_dsp.name, ''),
    'already_activated', v_drv.pin_hash is not null,
    'status',        v_drv.status
  );
end;
$$;
grant execute on function public.driver_activation_lookup(text) to anon, authenticated;


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

  v_first_time := v_drv.pin_hash is null;

  if v_first_time then
    -- First-time activation: PIN required and stored.  Phone may also
    -- be edited from the prefilled value.
    v_pin_clean := regexp_replace(coalesce(p_pin, ''), '[^0-9]', '', 'g');
    if length(v_pin_clean) < 4 or length(v_pin_clean) > 6 then
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

    update public.drivers
       set phone        = case when v_phone_norm <> coalesce(phone_normalized, '') then p_phone else phone end,
           pin_hash     = extensions.crypt(v_pin_clean, extensions.gen_salt('bf', 10)),
           pin_set_at   = now(),
           activated_at = coalesce(activated_at, now()),
           updated_at   = now()
     where id = v_drv.id
     returning * into v_drv;

    -- Mark the code as consumed (first-activation timestamp) and
    -- revoke any prior sessions — a fresh PIN means a fresh slate.
    update public.driver_invite_codes
       set consumed_at = now()
     where code = v_invite.code
       and consumed_at is null;

    update public.driver_sessions
       set revoked_at = now()
     where driver_id = v_drv.id
       and revoked_at is null;

  else
    -- Returning sign-in via the same code (e.g., the home-screen PWA
    -- after the driver activated in Safari).  PIN argument is
    -- ignored; the code itself is the credential.  We do NOT revoke
    -- existing sessions — drivers stay signed in on every device.
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
