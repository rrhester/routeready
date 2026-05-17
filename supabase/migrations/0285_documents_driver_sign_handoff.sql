-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0285 · Documents · driver-sign hands off to employer when
-- the template carries any signer_role: 'employer' fields
--
-- Step 3 of the multi-signer build. Extends driver_envelope_sign so a
-- two-signer template stops at `awaiting_employer` after the driver
-- completes their fields, instead of going straight to `signed`.
-- Generates an employer_signing_token at that moment so the
-- operator-side UI (PR 4) can key off it.
--
-- Single-signer templates (no employer-tagged fields, every legacy
-- template) keep the existing single-shot behavior: status = 'signed'
-- right away.
--
-- The check looks at the envelope's fields_snapshot — the per-envelope
-- copy of the template's field layout taken at send time — so editing
-- a template after sending can't change which leg an in-flight
-- envelope expects.
-- ─────────────────────────────────────────────────────────────────────────

drop function if exists public.driver_envelope_sign(text, text, text, text, text, text, text, inet, text);
drop function if exists public.driver_envelope_sign(text, text, text, text, text, text, text, inet, text, jsonb);

create or replace function public.driver_envelope_sign(
  p_token            text,
  p_signing_token    text,
  p_signature_method text,
  p_signature_data   text,
  p_consent_version  text,
  p_consent_text     text,
  p_typed_name       text default null,
  p_ip               inet default null,
  p_user_agent       text default null,
  p_field_values     jsonb default '{}'::jsonb
) returns public.document_envelopes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_env public.document_envelopes;
  v_tpl public.document_templates;
  v_signer_name text;
  v_field_values jsonb := coalesce(p_field_values, '{}'::jsonb);
  v_has_employer boolean;
  v_next_status public.document_envelope_status;
  v_employer_token text;
begin
  v_drv := private.driver_validate_token(p_token);

  select * into v_env from public.document_envelopes
   where signing_token = p_signing_token
     and recipient_driver_id = v_drv.id;
  if v_env.id is null then raise exception 'envelope_not_found' using errcode = 'P0002'; end if;
  if v_env.status not in ('sent','viewed') then
    raise exception 'envelope_terminal' using errcode = 'P0001';
  end if;
  if v_env.expires_at is not null and v_env.expires_at < now() then
    raise exception 'envelope_expired' using errcode = 'P0001';
  end if;
  if p_signature_method not in ('drawn','typed') then
    raise exception 'invalid_signature_method' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_signature_data), '') = '' then
    raise exception 'signature_required' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_consent_version), '') = '' or coalesce(trim(p_consent_text), '') = '' then
    raise exception 'consent_required' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_field_values) <> 'object' then
    raise exception 'field_values_must_be_object' using errcode = '22023';
  end if;

  v_signer_name := coalesce(
    nullif(trim(coalesce(p_typed_name, '')), ''),
    nullif(trim(v_drv.preferred_name), ''),
    v_drv.full_name
  );

  select * into v_tpl from public.document_templates where id = v_env.template_id;

  perform private.append_document_event(
    v_env.id, 'consent_accepted', 'driver',
    null, v_drv.id, v_drv.email, v_signer_name,
    p_ip, p_user_agent,
    jsonb_build_object(
      'consent_version', p_consent_version,
      'consent_text',    p_consent_text
    )
  );

  -- Does the envelope have any employer-completed fields? Decided off
  -- the per-envelope fields_snapshot, not the (mutable) template, so a
  -- template edit after sending can't change the flow midstream.
  select exists (
    select 1 from jsonb_array_elements(v_env.fields_snapshot) f
     where f->>'signer_role' = 'employer'
  ) into v_has_employer;

  if v_has_employer then
    v_next_status := 'awaiting_employer';
    v_employer_token := encode(gen_random_bytes(32), 'hex');
  else
    v_next_status := 'signed';
    v_employer_token := null;
  end if;

  update public.document_envelopes
     set status                 = v_next_status,
         signed_at              = case when v_next_status = 'signed' then now() else null end,
         doc_hash_at_sign       = case when v_next_status = 'signed' then v_tpl.source_hash else null end,
         field_values           = v_field_values,
         employer_signing_token = coalesce(employer_signing_token, v_employer_token)
   where id = v_env.id
   returning * into v_env;

  perform private.append_document_event(
    v_env.id,
    case when v_next_status = 'signed' then 'signed' else 'signed' end,
    'driver',
    null, v_drv.id, v_drv.email, v_signer_name,
    p_ip, p_user_agent,
    jsonb_build_object(
      'signature_method',   p_signature_method,
      'signature_data',     p_signature_data,
      'typed_name',         p_typed_name,
      'field_values',       v_field_values,
      'doc_hash_at_send',   v_env.doc_hash_at_send,
      'awaiting_employer',  v_next_status = 'awaiting_employer'
    )
  );

  return v_env;
end;
$$;

grant execute on function public.driver_envelope_sign(text, text, text, text, text, text, text, inet, text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
