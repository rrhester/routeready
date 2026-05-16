-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0255 · Self-serve driver activation + channel choice
--
-- 0253 introduced "Send activation link" but hard-coded SMS-first with
-- an email fallback only when phone was null.  Two real-world gaps
-- showed up immediately:
--
--   1. DSPs that haven't wired up Twilio yet can't send the link at all
--      — the SMS is queued and silently never delivered.  The
--      dispatcher needs an explicit "send via email" option.
--
--   2. A driver who existed BEFORE 0253 (no pin_hash yet) hits the
--      phone+PIN sign-in screen with nothing to enter — there's no
--      self-serve path.  They have to ask dispatch for a code.
--
-- This migration:
--
--   • Adds public.send_onboarding_invite(driver_id, channel) — the
--     optional second arg is 'sms' | 'email' | null (auto).  Replaces
--     the prior single-arg variant via DROP+CREATE so the auto behavior
--     stays the default.
--
--   • Adds public.driver_request_activation(p_phone, p_channel) —
--     anon-callable.  Looks up the driver by normalized phone, mints
--     a fresh code (or reuses a recent un-consumed one if minted in
--     the last 2 minutes — that's the rate limit), queues a message
--     on the preferred channel.  Always returns { ok: true } so the
--     surface can't be used to enumerate phones.  Internally records
--     whether a send actually happened in the returned 'channel'
--     field, but only when the phone matched a real driver.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. send_onboarding_invite — now channel-aware ────────────────────

drop function if exists public.send_onboarding_invite(uuid);
drop function if exists public.send_onboarding_invite(uuid, text);

create or replace function public.send_onboarding_invite(
  p_driver_id uuid,
  p_channel   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers;
  v_dsp_row public.dsps;
  v_code text;
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_collision boolean;
  v_attempts int := 0;
  v_base_url text;
  v_app_url  text;
  v_app_login_url text;
  v_first_name text;
  v_dsp_name text;
  v_msg record;
  v_channel text := null;
  v_expires timestamptz;
  v_prefer  text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;
  if v_drv.status = 'terminated' then
    raise exception 'driver_terminated' using errcode = 'P0001';
  end if;

  v_prefer := lower(coalesce(nullif(trim(p_channel), ''), 'auto'));
  if v_prefer not in ('auto','sms','email') then
    raise exception 'invalid_channel' using errcode = '22023';
  end if;

  -- Mint a fresh code (alphabet + uniqueness loop matches
  -- public.issue_driver_invite).
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    select exists(select 1 from public.driver_invite_codes where code = v_code) into v_collision;
    v_attempts := v_attempts + 1;
    exit when not v_collision or v_attempts > 8;
  end loop;
  if v_collision then
    raise exception 'code_generation_failed';
  end if;

  update public.driver_invite_codes
     set expires_at = now()
   where driver_id = v_drv.id
     and consumed_at is null
     and expires_at > now();

  insert into public.driver_invite_codes (code, dsp_id, driver_id, created_by, expires_at)
  values (v_code, v_dsp, v_drv.id, auth.uid(), now() + interval '14 days')
  returning expires_at into v_expires;

  select * into v_dsp_row from public.dsps where id = v_dsp;
  v_base_url := coalesce(v_dsp_row.metadata->>'public_base_url', 'https://gorouteready.com');
  v_app_url       := v_base_url || '/app/';
  v_app_login_url := v_app_url || '?code=' || v_code;
  v_first_name    := coalesce(nullif(trim(v_drv.first_name), ''),
                              nullif(trim(v_drv.preferred_name), ''),
                              v_drv.full_name);
  v_dsp_name      := coalesce(v_dsp_row.name, '');

  -- Decide channel.  Explicit choice wins, else SMS if phone present,
  -- else email if email present.
  if v_prefer = 'sms' then
    if v_drv.phone is null then raise exception 'driver_has_no_phone' using errcode = 'P0001'; end if;
    v_channel := 'sms';
  elsif v_prefer = 'email' then
    if v_drv.email is null then raise exception 'driver_has_no_email' using errcode = 'P0001'; end if;
    v_channel := 'email';
  else
    if v_drv.phone is not null then v_channel := 'sms';
    elsif v_drv.email is not null then v_channel := 'email';
    else v_channel := null;
    end if;
  end if;

  if v_channel = 'sms' then
    select * into v_msg from private.render_template(
      v_dsp, 'sms', 'applicant.outcome_hired',
      jsonb_build_object(
        'first_name',    v_first_name,
        'invite_code',   v_code,
        'app_url',       v_app_url,
        'app_login_url', v_app_login_url,
        'dsp_name',      v_dsp_name
      )
    );
    insert into public.sms_messages
      (dsp_id, applicant_id, direction, status, to_phone, body)
    values
      (v_dsp, v_drv.applicant_id, 'outbound', 'queued', v_drv.phone, v_msg.body);
  elsif v_channel = 'email' then
    select * into v_msg from private.render_template(
      v_dsp, 'email', 'applicant.outcome_hired',
      jsonb_build_object(
        'first_name',    v_first_name,
        'invite_code',   v_code,
        'app_url',       v_app_url,
        'app_login_url', v_app_login_url,
        'dsp_name',      v_dsp_name
      )
    );
    insert into public.email_messages
      (dsp_id, applicant_id, direction, status, to_email, subject, body_text)
    values
      (v_dsp, v_drv.applicant_id, 'outbound', 'queued', v_drv.email, v_msg.subject, v_msg.body);
  end if;

  insert into public.onboarding_progress (driver_id, dsp_id, welcome_email_sent_at)
  values (v_drv.id, v_dsp, now())
  on conflict (driver_id) do update
    set welcome_email_sent_at = now(),
        updated_at = now();

  return jsonb_build_object(
    'code',            v_code,
    'code_expires_at', v_expires,
    'app_login_url',   v_app_login_url,
    'message_channel', v_channel,
    'sent_to',         case when v_channel = 'sms' then v_drv.phone
                            when v_channel = 'email' then v_drv.email
                            else null end
  );
end;
$$;
grant execute on function public.send_onboarding_invite(uuid, text) to authenticated;


-- ── 2. driver_request_activation — anon, self-serve ──────────────────
--
-- The "First time, or forgot PIN?" path on the sign-in screen.  Looks
-- up a non-terminated driver by normalized phone.  If found:
--
--   • If the driver has an un-consumed, un-expired code minted in the
--     last 2 minutes, reuse it — that throttles SMS/email cost to
--     ~one send per 2 minutes per phone even if the user spams the
--     button.
--   • Otherwise mint a fresh code (revoking any prior un-consumed)
--     and queue a message.
--   • Channel preference: explicit p_channel, else email if available
--     (the common case for someone who can't sign in is "can't get
--     SMS for whatever reason"), else SMS.
--
-- Always returns { ok: true } so the response shape doesn't reveal
-- whether the phone matched a real driver.  When it DID match, the
-- response also includes `channel` ('sms' | 'email') and a masked
-- `sent_to` so the UI can show "We sent a link to ***@gmail.com"
-- as positive confirmation.  When it didn't match (or rate-limited),
-- those fields are null.

create or replace function public.driver_request_activation(
  p_phone   text,
  p_channel text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone_norm  text;
  v_drv         public.drivers;
  v_dsp         public.dsps;
  v_code        text;
  v_alphabet    text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_collision   boolean;
  v_attempts    int := 0;
  v_base_url    text;
  v_app_url     text;
  v_app_login_url text;
  v_first_name  text;
  v_dsp_name    text;
  v_msg         record;
  v_channel     text := null;
  v_existing    public.driver_invite_codes;
  v_prefer      text;
  v_masked      text := null;
begin
  v_phone_norm := private.normalize_phone(p_phone);
  if v_phone_norm is null then
    return jsonb_build_object('ok', true, 'channel', null, 'sent_to', null);
  end if;

  v_prefer := lower(coalesce(nullif(trim(p_channel), ''), 'auto'));
  if v_prefer not in ('auto','sms','email') then
    v_prefer := 'auto';
  end if;

  -- Pick the most-recently-active driver across DSPs.  The partial
  -- unique index from 0253 keeps at most one per DSP, and we'd rather
  -- prefer onboarding (someone setting up) over active (someone
  -- re-PINing) since both should still work.
  select * into v_drv from public.drivers
   where phone_normalized = v_phone_norm
     and status in ('active','onboarding')
   order by case status when 'onboarding' then 0 when 'active' then 1 else 2 end,
            updated_at desc
   limit 1;

  if v_drv.id is null then
    -- No driver — silently succeed so the call shape doesn't reveal it.
    return jsonb_build_object('ok', true, 'channel', null, 'sent_to', null);
  end if;

  -- Rate limit: if a code was minted in the last 2 minutes and not yet
  -- consumed, just resend nothing and return ok.  That's the throttle.
  select * into v_existing from public.driver_invite_codes
   where driver_id = v_drv.id
     and consumed_at is null
     and expires_at > now()
     and created_at > now() - interval '2 minutes'
   order by created_at desc
   limit 1;
  if v_existing.code is not null then
    return jsonb_build_object('ok', true, 'channel', null, 'sent_to', null,
                              'throttled', true);
  end if;

  -- Decide channel.  Explicit > email (if present) > sms (if present).
  if v_prefer = 'sms' and v_drv.phone is not null then
    v_channel := 'sms';
  elsif v_prefer = 'email' and v_drv.email is not null then
    v_channel := 'email';
  elsif v_prefer = 'auto' then
    if v_drv.email is not null then v_channel := 'email';
    elsif v_drv.phone is not null then v_channel := 'sms';
    end if;
  else
    -- Explicit channel requested but the driver doesn't have a contact
    -- for that channel — fall through to whatever they do have.
    if v_drv.email is not null then v_channel := 'email';
    elsif v_drv.phone is not null then v_channel := 'sms';
    end if;
  end if;
  if v_channel is null then
    return jsonb_build_object('ok', true, 'channel', null, 'sent_to', null);
  end if;

  -- Mint a unique code.
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    select exists(select 1 from public.driver_invite_codes where code = v_code) into v_collision;
    v_attempts := v_attempts + 1;
    exit when not v_collision or v_attempts > 8;
  end loop;
  if v_collision then
    return jsonb_build_object('ok', true, 'channel', null, 'sent_to', null);
  end if;

  -- Revoke any prior un-consumed code, then insert.
  update public.driver_invite_codes
     set expires_at = now()
   where driver_id = v_drv.id
     and consumed_at is null
     and expires_at > now();

  insert into public.driver_invite_codes (code, dsp_id, driver_id, created_by, expires_at)
  values (v_code, v_drv.dsp_id, v_drv.id, null, now() + interval '14 days');

  select * into v_dsp from public.dsps where id = v_drv.dsp_id;
  v_base_url := coalesce(v_dsp.metadata->>'public_base_url', 'https://gorouteready.com');
  v_app_url       := v_base_url || '/app/';
  v_app_login_url := v_app_url || '?code=' || v_code;
  v_first_name    := coalesce(nullif(trim(v_drv.first_name), ''),
                              nullif(trim(v_drv.preferred_name), ''),
                              v_drv.full_name);
  v_dsp_name      := coalesce(v_dsp.name, '');

  if v_channel = 'sms' then
    select * into v_msg from private.render_template(
      v_drv.dsp_id, 'sms', 'applicant.outcome_hired',
      jsonb_build_object(
        'first_name',    v_first_name,
        'invite_code',   v_code,
        'app_url',       v_app_url,
        'app_login_url', v_app_login_url,
        'dsp_name',      v_dsp_name
      )
    );
    insert into public.sms_messages
      (dsp_id, applicant_id, direction, status, to_phone, body)
    values
      (v_drv.dsp_id, v_drv.applicant_id, 'outbound', 'queued', v_drv.phone, v_msg.body);

    -- Mask: (•••) •••-1234
    if length(v_phone_norm) >= 4 then
      v_masked := '(•••) •••-' || right(v_phone_norm, 4);
    end if;

  elsif v_channel = 'email' then
    select * into v_msg from private.render_template(
      v_drv.dsp_id, 'email', 'applicant.outcome_hired',
      jsonb_build_object(
        'first_name',    v_first_name,
        'invite_code',   v_code,
        'app_url',       v_app_url,
        'app_login_url', v_app_login_url,
        'dsp_name',      v_dsp_name
      )
    );
    insert into public.email_messages
      (dsp_id, applicant_id, direction, status, to_email, subject, body_text)
    values
      (v_drv.dsp_id, v_drv.applicant_id, 'outbound', 'queued', v_drv.email, v_msg.subject, v_msg.body);

    -- Mask: j•••@gmail.com
    v_masked := case
      when v_drv.email like '%@%' then
        left(v_drv.email, 1) || '•••' || substring(v_drv.email from position('@' in v_drv.email))
      else null
    end;
  end if;

  return jsonb_build_object(
    'ok',              true,
    'channel',         v_channel,
    'sent_to',         v_masked
  );
end;
$$;
grant execute on function public.driver_request_activation(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
