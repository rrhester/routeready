-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0286 · Documents · employer_envelope_sign
--
-- Step 4 of the multi-signer build. RPC the operator-side modal calls
-- to complete the second leg of a two-signer envelope:
--
--   · Verifies the caller is a dispatcher on the envelope's DSP.
--   · Verifies the envelope is in 'awaiting_employer' (i.e. the
--     driver already signed their leg via driver_envelope_sign).
--   · Verifies the signature method + data + consent.
--   · Stores employer signature, employer field_values, signer
--     identity / title / consent snapshot, completion timestamp.
--   · Flips status to 'signed', records signed_at + doc_hash_at_sign
--     so the sealing worker fires off the now-final envelope.
--   · Appends an envelope-level document_event for the audit chain.
--
-- The signing token isn't required at this point — the operator is
-- already authenticated via Supabase, and the dispatcher role check
-- gates access. The token still exists on the envelope so a future
-- email-link path can use it.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.employer_envelope_sign(
  p_envelope_id      uuid,
  p_signature_method text,
  p_signature_data   text,
  p_consent_version  text,
  p_consent_text     text,
  p_signer_title     text default null,
  p_field_values     jsonb default '{}'::jsonb,
  p_typed_name       text default null,
  p_ip               inet default null,
  p_user_agent       text default null
) returns public.document_envelopes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_uid        uuid := auth.uid();
  v_env        public.document_envelopes;
  v_tpl        public.document_templates;
  v_signer_name text;
  v_field_values jsonb := coalesce(p_field_values, '{}'::jsonb);
begin
  if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_envelope_id is null then raise exception 'envelope_id_required' using errcode = '22023'; end if;
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

  select * into v_env from public.document_envelopes
   where id = p_envelope_id and dsp_id = v_dsp;
  if v_env.id is null then raise exception 'envelope_not_found' using errcode = 'P0002'; end if;
  if v_env.status <> 'awaiting_employer' then
    raise exception 'envelope_not_awaiting_employer' using errcode = 'P0001';
  end if;

  select * into v_tpl from public.document_templates where id = v_env.template_id;

  -- Resolve a display name for the audit row. Prefer the typed signature
  -- when the operator chose typed, otherwise the app_user name on file.
  begin
    select coalesce(nullif(trim(coalesce(p_typed_name, '')), ''),
                    nullif(trim(full_name), ''),
                    email)
      into v_signer_name
      from public.app_users where id = v_uid;
  exception when others then v_signer_name := null;
  end;

  perform private.append_document_event(
    v_env.id, 'consent_accepted', 'dispatcher',
    v_uid, null, null, v_signer_name,
    p_ip, p_user_agent,
    jsonb_build_object(
      'consent_version', p_consent_version,
      'consent_text',    p_consent_text,
      'role',            'employer'
    )
  );

  update public.document_envelopes
     set status                       = 'signed',
         signed_at                    = now(),
         doc_hash_at_sign             = v_tpl.source_hash,
         employer_field_values        = v_field_values,
         employer_signature           = jsonb_build_object('method', p_signature_method, 'data', p_signature_data),
         employer_completed_at        = now(),
         employer_completed_by        = v_uid,
         employer_completed_by_name   = v_signer_name,
         employer_completed_by_title  = p_signer_title,
         employer_consent_version     = p_consent_version,
         employer_consent_text        = p_consent_text
   where id = v_env.id
   returning * into v_env;

  perform private.append_document_event(
    v_env.id, 'signed', 'dispatcher',
    v_uid, null, null, v_signer_name,
    p_ip, p_user_agent,
    jsonb_build_object(
      'signature_method',     p_signature_method,
      'signature_data',       p_signature_data,
      'typed_name',           p_typed_name,
      'field_values',         v_field_values,
      'role',                 'employer',
      'doc_hash_at_send',     v_env.doc_hash_at_send,
      'doc_hash_at_sign',     v_tpl.source_hash,
      'hash_witness_match',   v_tpl.source_hash = v_env.doc_hash_at_send,
      'signer_title',         p_signer_title
    )
  );

  return v_env;
end;
$$;

grant execute on function public.employer_envelope_sign(uuid, text, text, text, text, text, jsonb, text, inet, text) to authenticated;

notify pgrst, 'reload schema';
