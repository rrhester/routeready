-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0257 · Separate "resend activation" template from "you're hired"
--
-- Until now, every send of an activation link reused the
-- applicant.outcome_hired template — warm "Welcome to the team" copy
-- with iOS/Android install hints.  That's perfect for the first send
-- (the driver was just hired), but tone-deaf on re-sends to an
-- already-activated driver who's installing on a second device or
-- recovering after a sign-out.  They get "Welcome to the team" again,
-- as if they're being hired twice.
--
-- This migration:
--
--   1. Seeds a new template key  driver.resend_activation  in both
--      SMS + email flavors, with returning-driver copy: "Here's a
--      fresh sign-in link for your driver app …".
--
--   2. Updates public.send_onboarding_invite + public.driver_request_activation
--      to pick the template based on driver.pin_hash:
--        ◦ pin_hash is null  → applicant.outcome_hired   (first time)
--        ◦ pin_hash is set   → driver.resend_activation  (returning)
--
-- Operators can still override either template per-DSP via the
-- standard message_templates surface; both rows are seeded under the
-- platform default DSP (00..0d000) and copied to tenants by the
-- existing template-bootstrap path.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Seed the new templates ────────────────────────────────────────

insert into public.message_templates (dsp_id, channel, key, name, subject, body) values
  ('00000000-0000-0000-0000-00000000d000', 'sms', 'driver.resend_activation',
   'Resend activation link (SMS)',
   null,
   E'Hi {{first_name}}, here''s a fresh sign-in link for your {{dsp_name}} driver app: {{app_login_url}}\n\nTap to sign in — no PIN re-entry needed. Code: {{invite_code}}.')
on conflict (dsp_id, channel, key) do update
  set body = excluded.body, updated_at = now();

insert into public.message_templates (dsp_id, channel, key, name, subject, body) values
  ('00000000-0000-0000-0000-00000000d000', 'email', 'driver.resend_activation',
   'Resend activation link (email)',
   'Your {{dsp_name}} driver app sign-in link',
   E'Hi {{first_name}},\n\nHere''s a fresh sign-in link for your {{dsp_name}} driver app:\n\n   {{app_login_url}}\n\nTap the link and you''ll be signed in — no PIN re-entry needed.  Your activation code is {{invite_code}} (it''s pre-filled if you tap the link).\n\nThe link is good for 14 days, and tapping it on a new device just adds that device to your account — your other devices stay signed in.\n\n— The {{dsp_name}} team')
on conflict (dsp_id, channel, key) do update
  set subject = excluded.subject, body = excluded.body, updated_at = now();


-- Also seed the row for every existing DSP so render_template (which
-- looks up by dsp_id + channel + key) finds something.  This mirrors
-- how applicant.outcome_hired ships per-DSP at provision time.
insert into public.message_templates (dsp_id, channel, key, name, subject, body)
select d.id, 'sms', 'driver.resend_activation',
       'Resend activation link (SMS)', null,
       E'Hi {{first_name}}, here''s a fresh sign-in link for your {{dsp_name}} driver app: {{app_login_url}}\n\nTap to sign in — no PIN re-entry needed. Code: {{invite_code}}.'
from public.dsps d
on conflict (dsp_id, channel, key) do nothing;

insert into public.message_templates (dsp_id, channel, key, name, subject, body)
select d.id, 'email', 'driver.resend_activation',
       'Resend activation link (email)',
       'Your {{dsp_name}} driver app sign-in link',
       E'Hi {{first_name}},\n\nHere''s a fresh sign-in link for your {{dsp_name}} driver app:\n\n   {{app_login_url}}\n\nTap the link and you''ll be signed in — no PIN re-entry needed.  Your activation code is {{invite_code}} (it''s pre-filled if you tap the link).\n\nThe link is good for 14 days, and tapping it on a new device just adds that device to your account — your other devices stay signed in.\n\n— The {{dsp_name}} team'
from public.dsps d
on conflict (dsp_id, channel, key) do nothing;


-- ── 2. send_onboarding_invite — pick template by activation state ────

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
  v_template_key text;
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

  -- Returning driver gets the resend template; first-timer gets the
  -- warm "welcome to the team" hired copy.
  v_template_key := case when v_drv.pin_hash is not null
                         then 'driver.resend_activation'
                         else 'applicant.outcome_hired'
                    end;

  if v_channel = 'sms' then
    select * into v_msg from private.render_template(
      v_dsp, 'sms', v_template_key,
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
      v_dsp, 'email', v_template_key,
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

  -- Only the FIRST send is a "welcome" event for the funnel.  Subsequent
  -- re-sends shouldn't reset welcome_email_sent_at — that would make
  -- the onboarding funnel falsely re-start.
  if v_drv.pin_hash is null then
    insert into public.onboarding_progress (driver_id, dsp_id, welcome_email_sent_at)
    values (v_drv.id, v_dsp, now())
    on conflict (driver_id) do update
      set welcome_email_sent_at = coalesce(public.onboarding_progress.welcome_email_sent_at, excluded.welcome_email_sent_at),
          updated_at = now();
  end if;

  return jsonb_build_object(
    'code',            v_code,
    'code_expires_at', v_expires,
    'app_login_url',   v_app_login_url,
    'message_channel', v_channel,
    'sent_to',         case when v_channel = 'sms' then v_drv.phone
                            when v_channel = 'email' then v_drv.email
                            else null end,
    'template_key',    v_template_key
  );
end;
$$;
grant execute on function public.send_onboarding_invite(uuid, text) to authenticated;


-- ── 3. driver_request_activation — pick template by activation state ─

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
  v_template_key text;
begin
  v_phone_norm := private.normalize_phone(p_phone);
  if v_phone_norm is null then
    return jsonb_build_object('ok', true, 'channel', null, 'sent_to', null);
  end if;

  v_prefer := lower(coalesce(nullif(trim(p_channel), ''), 'auto'));
  if v_prefer not in ('auto','sms','email') then
    v_prefer := 'auto';
  end if;

  select * into v_drv from public.drivers
   where phone_normalized = v_phone_norm
     and status in ('active','onboarding')
   order by case status when 'onboarding' then 0 when 'active' then 1 else 2 end,
            updated_at desc
   limit 1;

  if v_drv.id is null then
    return jsonb_build_object('ok', true, 'channel', null, 'sent_to', null);
  end if;

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

  if v_prefer = 'sms' and v_drv.phone is not null then
    v_channel := 'sms';
  elsif v_prefer = 'email' and v_drv.email is not null then
    v_channel := 'email';
  elsif v_prefer = 'auto' then
    if v_drv.email is not null then v_channel := 'email';
    elsif v_drv.phone is not null then v_channel := 'sms';
    end if;
  else
    if v_drv.email is not null then v_channel := 'email';
    elsif v_drv.phone is not null then v_channel := 'sms';
    end if;
  end if;
  if v_channel is null then
    return jsonb_build_object('ok', true, 'channel', null, 'sent_to', null);
  end if;

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

  v_template_key := case when v_drv.pin_hash is not null
                         then 'driver.resend_activation'
                         else 'applicant.outcome_hired'
                    end;

  if v_channel = 'sms' then
    select * into v_msg from private.render_template(
      v_drv.dsp_id, 'sms', v_template_key,
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

    if length(v_phone_norm) >= 4 then
      v_masked := '(•••) •••-' || right(v_phone_norm, 4);
    end if;

  elsif v_channel = 'email' then
    select * into v_msg from private.render_template(
      v_drv.dsp_id, 'email', v_template_key,
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

    v_masked := case
      when v_drv.email like '%@%' then
        left(v_drv.email, 1) || '•••' || substring(v_drv.email from position('@' in v_drv.email))
      else null
    end;
  end if;

  return jsonb_build_object(
    'ok',           true,
    'channel',      v_channel,
    'sent_to',      v_masked,
    'template_key', v_template_key
  );
end;
$$;
grant execute on function public.driver_request_activation(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
