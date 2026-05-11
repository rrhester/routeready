-- Migration 0165 · Documents · recipient-fill fields (Text / Checkbox)
--
-- Slice extends e-signature fields beyond signature + auto-fill kinds
-- (initials / name / date) to recipient-completed kinds: `text` and
-- `checkbox`. The driver fills these in the PWA during signing; the
-- values land on the envelope (field_values jsonb, keyed by field id)
-- and the sealing worker stamps them at the field positions.
--
--   • document_envelopes gets a field_values jsonb column.
--   • driver_envelope_sign gains p_field_values (defaults to {}); the
--     values are written onto the envelope and recorded in the signed
--     audit event (so the chain witnesses exactly what was entered).
--
-- Backwards compatible: the new parameter has a default, existing
-- callers are unaffected, and templates with no text/checkbox fields
-- behave exactly as before.

alter table public.document_envelopes
  add column if not exists field_values jsonb not null default '{}'::jsonb;

-- Adding a parameter changes the signature, so drop the old 9-arg
-- version before recreating (leaving both would make PostgREST's
-- overload resolution ambiguous for calls that omit p_field_values).
drop function if exists public.driver_envelope_sign(text, text, text, text, text, text, text, inet, text);

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

  update public.document_envelopes
     set status = 'signed',
         signed_at = now(),
         doc_hash_at_sign = v_tpl.source_hash,
         field_values = v_field_values
   where id = v_env.id
   returning * into v_env;

  perform private.append_document_event(
    v_env.id, 'signed', 'driver',
    null, v_drv.id, v_drv.email, v_signer_name,
    p_ip, p_user_agent,
    jsonb_build_object(
      'signature_method',   p_signature_method,
      'signature_data',     p_signature_data,
      'typed_name',         p_typed_name,
      'field_values',       v_field_values,
      'doc_hash_at_sign',   v_tpl.source_hash,
      'doc_hash_at_send',   v_env.doc_hash_at_send,
      'hash_witness_match', v_tpl.source_hash = v_env.doc_hash_at_send
    )
  );

  return v_env;
end;
$$;
grant execute on function public.driver_envelope_sign(text, text, text, text, text, text, text, inet, text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
