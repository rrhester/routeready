-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0260 · Hired outcome message · interpolate activation context
--
-- When an applicant is marked "Hired" via record_outcome, the outbound
-- message (SMS + email) was rendered against `applicant.outcome_hired`,
-- which references {{first_name}}, {{dsp_name}}, {{invite_code}}, and
-- {{app_login_url}} (see 0253_driver_activation_unified.sql:716-731).
-- queue_outcome_message was only passing {first_name}, so the other
-- three placeholders survived render_template untouched and the driver
-- received an email/SMS with raw "{{invite_code}}" / "{{app_login_url}}"
-- text where the login info should have been.
--
-- Fix: when the outcome is 'hired' and the driver row already exists
-- (record_outcome creates/binds it before this runs), mint a fresh
-- driver_invite_codes row, build the activation URL, and pass them into
-- the template render context alongside dsp_name. Mirrors the alphabet,
-- collision loop, and `{base}/app/?code=<code>` URL shape used by
-- public.send_onboarding_invite (0257:118-144) so a later dispatcher
-- resend stays consistent with what the hire email handed out.
--
-- Non-hired outcomes (no_hire, no_show) keep the lighter render context
-- (their templates only reference {{first_name}}); dsp_name is added to
-- the dict unconditionally so future template tweaks have it available.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.queue_outcome_message(p_applicant_id uuid, p_outcome text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app        public.applicants;
  v_dsp        public.dsps;
  v_drv        public.drivers;
  v_key        text;
  v_msg        record;
  v_tpl        public.message_templates;
  v_code       text;
  v_alphabet   text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_collision  boolean;
  v_attempts   int := 0;
  v_base_url   text;
  v_app_url    text;
  v_app_login_url text;
  v_first_name text;
  v_dsp_name   text;
  v_vars       jsonb;
begin
  select * into v_app from public.applicants where id = p_applicant_id;
  if v_app.id is null then return; end if;

  select * into v_dsp from public.dsps where id = v_app.dsp_id;

  if p_outcome = 'no_show'
     and not coalesce((v_dsp.metadata->'outcomes'->>'send_no_show')::boolean, false) then
    return;
  end if;

  v_key := 'applicant.outcome_' || p_outcome;

  v_first_name := coalesce(v_app.first_name, v_app.full_name);
  v_dsp_name   := coalesce(v_dsp.name, '');
  v_vars := jsonb_build_object(
    'first_name', v_first_name,
    'dsp_name',   v_dsp_name
  );

  -- For 'hired', mint a fresh driver_invite_codes row and add the
  -- activation context to the placeholder dict so the hired template's
  -- {{invite_code}} / {{app_login_url}} interpolate. record_outcome
  -- creates or rebinds the driver row before invoking this function, so
  -- v_drv should generally be found; if it isn't (e.g. driver creation
  -- failed in a prior step), fall through with bare {first_name, dsp_name}
  -- — better to send an imperfect message than nothing at all.
  if p_outcome = 'hired' then
    select * into v_drv from public.drivers
     where applicant_id = p_applicant_id and dsp_id = v_app.dsp_id
     limit 1;

    if v_drv.id is not null and v_drv.status <> 'terminated' then
      loop
        v_code := '';
        for i in 1..8 loop
          v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
        end loop;
        select exists(select 1 from public.driver_invite_codes where code = v_code) into v_collision;
        v_attempts := v_attempts + 1;
        exit when not v_collision or v_attempts > 8;
      end loop;

      if not v_collision then
        -- Invalidate any prior open codes for this driver so the link in
        -- the hire email is the only live one. Mirrors send_onboarding_invite.
        update public.driver_invite_codes
           set expires_at = now()
         where driver_id = v_drv.id
           and consumed_at is null
           and expires_at > now();

        insert into public.driver_invite_codes
          (code, dsp_id, driver_id, created_by, expires_at)
        values
          (v_code, v_app.dsp_id, v_drv.id, auth.uid(), now() + interval '14 days');

        v_base_url      := coalesce(v_dsp.metadata->>'public_base_url', 'https://gorouteready.com');
        v_app_url       := v_base_url || '/app/';
        v_app_login_url := v_app_url || '?code=' || v_code;

        v_vars := v_vars
          || jsonb_build_object(
               'invite_code',   v_code,
               'app_login_url', v_app_login_url,
               'app_url',       v_app_url
             );
      end if;
    end if;
  end if;

  if v_app.phone is not null then
    select * into v_tpl from public.message_templates
      where dsp_id = v_app.dsp_id and channel = 'sms' and key = v_key and active = true;
    select * into v_msg from private.render_template(v_app.dsp_id, 'sms', v_key, v_vars);
    insert into public.sms_messages
      (dsp_id, applicant_id, template_id, direction, status, to_phone, body, attachments)
    values
      (v_app.dsp_id, v_app.id, v_tpl.id, 'outbound', 'queued', v_app.phone, v_msg.body, coalesce(v_tpl.attachments, '[]'::jsonb));
  end if;

  if v_app.email is not null then
    select * into v_tpl from public.message_templates
      where dsp_id = v_app.dsp_id and channel = 'email' and key = v_key and active = true;
    select * into v_msg from private.render_template(v_app.dsp_id, 'email', v_key, v_vars);
    insert into public.email_messages
      (dsp_id, applicant_id, template_id, direction, status, to_email, subject, body_text, attachments)
    values
      (v_app.dsp_id, v_app.id, v_tpl.id, 'outbound', 'queued', v_app.email, v_msg.subject, v_msg.body, coalesce(v_tpl.attachments, '[]'::jsonb));
  end if;
end;
$$;
