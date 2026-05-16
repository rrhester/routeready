-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0264 · Onboarding friction round 2
--
-- Two server-side fixes the driver-app PR (sibling commit) needs:
--
-- 1. documents_envelope_create auto-fires an "envelope_sent" email when
--    a dispatcher creates an envelope. Operator: "I am getting auto
--    emails for documents to sign. Those don't need to go out
--    automatically. Needed documents are loaded in the onboarding
--    screen." The driver app's Tasks hub already surfaces pending
--    envelopes; the email duplicates that and clutters inboxes during
--    onboarding. Gate the auto-email behind a DSP metadata flag that
--    defaults to off so envelope creation goes quiet by default. The
--    document_envelopes row + audit event still get created the same
--    way — only the email queue is suppressed.
--
-- 2. tap-to-sign-in (0262) skipped the PIN step, so drivers who go
--    through the new activation flow never have a PIN saved and can
--    never sign in via phone+PIN afterward ("there is never a moment
--    when the pin is saved so it never works"). Add a driver_set_pin
--    RPC the driver app can call from Settings → Set PIN. Validates
--    the same 4–6 digit rule as activation, bcrypts with the same
--    work factor, and revokes all OTHER sessions for that driver so
--    a fresh PIN means a fresh trust boundary.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. documents_envelope_create · auto-email opt-in ─────────────────

create or replace function public.documents_envelope_create(
  p_template_id         uuid,
  p_recipient_driver_id uuid,
  p_expires_at          timestamptz default null,
  p_onboarding_step_key text default null
) returns public.document_envelopes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_tpl public.document_templates;
  v_drv public.drivers;
  v_dsp_row public.dsps;
  v_email text;
  v_name text;
  v_step text := nullif(trim(coalesce(p_onboarding_step_key, '')), '');
  v_env public.document_envelopes;
  v_msg record;
  v_app_url text;
  v_auto_email boolean;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_tpl from public.document_templates
    where id = p_template_id and dsp_id = v_dsp;
  if v_tpl.id is null then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  if v_tpl.archived_at is not null then raise exception 'template_archived' using errcode = 'P0001'; end if;

  select * into v_drv from public.drivers where id = p_recipient_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then raise exception 'driver_not_found' using errcode = 'P0002'; end if;

  v_email := nullif(trim(coalesce(v_drv.email, '')), '');
  v_name  := coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name);
  if v_email is null then raise exception 'driver_has_no_email' using errcode = 'P0001'; end if;

  insert into public.document_envelopes
    (dsp_id, template_id, sender_user_id,
     recipient_driver_id, recipient_email, recipient_name,
     doc_hash_at_send, fields_snapshot, expires_at, status, onboarding_step_key)
  values
    (v_dsp, v_tpl.id, v_uid,
     v_drv.id, v_email, v_name,
     v_tpl.source_hash, v_tpl.fields, p_expires_at, 'sent', v_step)
  returning * into v_env;

  perform private.append_document_event(
    v_env.id, 'envelope_created', 'dispatcher',
    v_uid, null, null, null, null, null,
    jsonb_build_object(
      'template_id',         v_tpl.id,
      'template_title',      v_tpl.title,
      'source_hash',         v_tpl.source_hash,
      'recipient_driver_id', v_drv.id,
      'recipient_email',     v_email,
      'recipient_name',      v_name,
      'expires_at',          p_expires_at,
      'onboarding_step_key', v_step
    )
  );
  perform private.append_document_event(
    v_env.id, 'sent', 'system',
    null, null, null, null, null, null,
    jsonb_build_object('signing_token_issued', true)
  );

  -- Auto-email is off by default now. The driver sees the envelope in
  -- their app's Tasks hub, so the email was just noise. A DSP can flip
  -- it back on by setting dsps.metadata.documents.auto_email_on_create
  -- to true if they want the legacy behavior.
  select * into v_dsp_row from public.dsps where id = v_dsp;
  v_auto_email := coalesce(
    (v_dsp_row.metadata->'documents'->>'auto_email_on_create')::boolean,
    false
  );

  if v_auto_email then
    begin
      v_app_url := coalesce(v_dsp_row.metadata->>'public_base_url', 'https://gorouteready.com') || '/app/';

      select * into v_msg from private.render_template(
        v_dsp,
        'email'::public.message_channel,
        'documents.envelope_sent',
        jsonb_build_object(
          'first_name',     coalesce(nullif(trim(v_drv.first_name), ''), v_drv.full_name, v_name),
          'dsp_name',       coalesce(v_dsp_row.name, 'Dispatch'),
          'document_title', v_tpl.title,
          'app_url',        v_app_url
        )
      );

      insert into public.email_messages
        (dsp_id, direction, status, to_email, subject, body_text)
      values
        (v_dsp, 'outbound', 'queued', v_email, v_msg.subject, v_msg.body);

      perform private.append_document_event(
        v_env.id, 'reminder_sent', 'system',
        null, null, null, null, null, null,
        jsonb_build_object('channel', 'email', 'kind', 'envelope_sent_notification')
      );
    exception when others then
      raise notice 'documents_envelope_create: notification email skipped (%): %', v_env.id, sqlerrm;
    end;
  end if;

  return v_env;
end;
$$;
grant execute on function public.documents_envelope_create(uuid, uuid, timestamptz, text) to authenticated;


-- ── 2. driver_set_pin · token-auth, driver self-serve ─────────────────

create or replace function public.driver_set_pin(p_token text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv       public.drivers;
  v_pin_clean text;
begin
  v_drv := private.driver_validate_token(p_token);

  v_pin_clean := regexp_replace(coalesce(p_pin, ''), '[^0-9]', '', 'g');
  if length(v_pin_clean) < 4 or length(v_pin_clean) > 6 then
    raise exception 'pin_must_be_4_to_6_digits' using errcode = '22023';
  end if;

  update public.drivers
     set pin_hash   = extensions.crypt(v_pin_clean, extensions.gen_salt('bf', 10)),
         pin_set_at = now(),
         updated_at = now()
   where id = v_drv.id;

  -- Fresh PIN = fresh trust boundary on every OTHER device. We deliberately
  -- spare the current session (matched by the token the caller used)
  -- so the driver doesn't get bounced out of the page they just set
  -- the PIN on.
  update public.driver_sessions
     set revoked_at = now()
   where driver_id = v_drv.id
     and revoked_at is null
     and token <> p_token;

  -- Clear any rate-limit lockout on the driver's phone, since the
  -- "PIN exists but I can't remember it" loop is what landed us here.
  -- Guarded because driver_pin_attempts isn't on every deployment yet.
  if v_drv.phone_normalized is not null
     and to_regclass('public.driver_pin_attempts') is not null then
    execute 'delete from public.driver_pin_attempts where phone_normalized = $1'
      using v_drv.phone_normalized;
  end if;

  return jsonb_build_object('ok', true, 'pin_set_at', now());
end;
$$;
grant execute on function public.driver_set_pin(text, text) to anon, authenticated;


notify pgrst, 'reload schema';
