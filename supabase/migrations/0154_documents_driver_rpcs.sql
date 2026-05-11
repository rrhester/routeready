-- Migration 0154 · Documents · driver-side RPCs (slice 3)
--
-- The driver-facing entry points used by the PWA signing flow. The
-- corresponding edge function (driver-document-fetch) mints the signed
-- storage URL after auth + ownership checks; these RPCs handle the
-- listing, declining, and signing operations.
--
-- Auth: every driver-side function validates the per-session token via
-- private.driver_validate_token (sets last_seen_at, raises on invalid
-- or revoked tokens).

-- ── driver_envelopes_list ──────────────────────────────────────────────
-- Returns { pending, completed } for the calling driver. The signing
-- token is exposed so the PWA can deep-link into the sign view; nothing
-- else about the document is revealed here.

create or replace function public.driver_envelopes_list(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_pending jsonb;
  v_completed jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',             e.id,
    'signing_token',  e.signing_token,
    'template_title', t.title,
    'status',         e.status,
    'sent_at',        e.sent_at,
    'expires_at',     e.expires_at
  ) order by e.sent_at desc), '[]'::jsonb)
  into v_pending
  from public.document_envelopes e
  join public.document_templates t on t.id = e.template_id
  where e.recipient_driver_id = v_drv.id
    and e.status in ('sent', 'viewed');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',             e.id,
    'signing_token',  e.signing_token,
    'template_title', t.title,
    'status',         e.status,
    'sent_at',        e.sent_at,
    'signed_at',      e.signed_at,
    'declined_at',    e.declined_at,
    'voided_at',      e.voided_at
  ) order by coalesce(e.signed_at, e.declined_at, e.voided_at, e.sent_at) desc), '[]'::jsonb)
  into v_completed
  from public.document_envelopes e
  join public.document_templates t on t.id = e.template_id
  where e.recipient_driver_id = v_drv.id
    and e.status in ('signed', 'declined', 'voided', 'expired')
  limit 100;

  return jsonb_build_object('pending', v_pending, 'completed', v_completed);
end;
$$;
grant execute on function public.driver_envelopes_list(text) to anon, authenticated;


-- ── driver_envelope_view ───────────────────────────────────────────────
-- Called by the driver-document-fetch edge function on first open.
-- Validates ownership; if status is 'sent', flips to 'viewed' and logs
-- the event. Returns envelope + template metadata (so the function can
-- mint a signed URL for the source PDF). The IP and user-agent are
-- captured by the edge function and passed in for the audit trail.

create or replace function public.driver_envelope_view(
  p_token         text,
  p_signing_token text,
  p_ip            inet default null,
  p_user_agent    text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_env public.document_envelopes;
  v_tpl public.document_templates;
begin
  v_drv := private.driver_validate_token(p_token);

  select * into v_env from public.document_envelopes
   where signing_token = p_signing_token
     and recipient_driver_id = v_drv.id;
  if v_env.id is null then raise exception 'envelope_not_found' using errcode = 'P0002'; end if;

  if v_env.status = 'sent' then
    update public.document_envelopes
       set status = 'viewed', viewed_at = now()
     where id = v_env.id
     returning * into v_env;

    perform private.append_document_event(
      v_env.id, 'viewed', 'driver',
      null, v_drv.id, v_drv.email,
      coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
      p_ip, p_user_agent, '{}'::jsonb
    );
  end if;

  select * into v_tpl from public.document_templates where id = v_env.template_id;

  return jsonb_build_object(
    'envelope', jsonb_build_object(
      'id',              v_env.id,
      'signing_token',   v_env.signing_token,
      'status',          v_env.status,
      'recipient_name',  v_env.recipient_name,
      'recipient_email', v_env.recipient_email,
      'doc_hash_at_send', v_env.doc_hash_at_send,
      'sent_at',         v_env.sent_at,
      'viewed_at',       v_env.viewed_at,
      'expires_at',      v_env.expires_at,
      'fields_snapshot', v_env.fields_snapshot
    ),
    'template', jsonb_build_object(
      'id',          v_tpl.id,
      'title',       v_tpl.title,
      'description', v_tpl.description,
      'source_path', v_tpl.source_path,
      'source_hash', v_tpl.source_hash
    )
  );
end;
$$;
grant execute on function public.driver_envelope_view(text, text, inet, text) to anon, authenticated;


-- ── driver_envelope_decline ────────────────────────────────────────────
-- Driver declines to sign. Only valid while the envelope is open
-- (sent or viewed). Logs the decline + reason to the audit chain.

create or replace function public.driver_envelope_decline(
  p_token         text,
  p_signing_token text,
  p_reason        text default null
) returns public.document_envelopes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_env public.document_envelopes;
begin
  v_drv := private.driver_validate_token(p_token);

  select * into v_env from public.document_envelopes
   where signing_token = p_signing_token
     and recipient_driver_id = v_drv.id;
  if v_env.id is null then raise exception 'envelope_not_found' using errcode = 'P0002'; end if;
  if v_env.status not in ('sent','viewed') then
    raise exception 'envelope_terminal' using errcode = 'P0001';
  end if;

  update public.document_envelopes
     set status = 'declined',
         declined_at = now(),
         decline_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = v_env.id
   returning * into v_env;

  perform private.append_document_event(
    v_env.id, 'declined', 'driver',
    null, v_drv.id, v_drv.email,
    coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
    null, null,
    jsonb_build_object('reason', nullif(trim(coalesce(p_reason, '')), ''))
  );

  return v_env;
end;
$$;
grant execute on function public.driver_envelope_decline(text, text, text) to anon, authenticated;


-- ── driver_envelope_sign ───────────────────────────────────────────────
-- Driver finalizes the signature. The PWA passes the consent text the
-- driver agreed to (so the audit row records exactly what they saw),
-- the signature method ('drawn' | 'typed'), and the signature payload
-- (data URL of the drawn canvas, or the typed name string). The sealed
-- PDF (PKCS#7 + RFC 3161) is produced by the signing service in a
-- later slice; here we capture the signing intent on the audit chain
-- and flip the envelope to 'signed' so the service can pick it up.

create or replace function public.driver_envelope_sign(
  p_token            text,
  p_signing_token    text,
  p_signature_method text,     -- 'drawn' | 'typed'
  p_signature_data   text,     -- data URL (drawn) or typed name string
  p_consent_version  text,     -- e.g. 'esign-v1-2026-05'
  p_consent_text     text,     -- exact text the driver agreed to
  p_typed_name       text default null,
  p_ip               inet default null,
  p_user_agent       text default null
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

  v_signer_name := coalesce(
    nullif(trim(coalesce(p_typed_name, '')), ''),
    nullif(trim(v_drv.preferred_name), ''),
    v_drv.full_name
  );

  select * into v_tpl from public.document_templates where id = v_env.template_id;

  -- Audit: consent first (so the chain shows agreement *before* signing).
  perform private.append_document_event(
    v_env.id, 'consent_accepted', 'driver',
    null, v_drv.id, v_drv.email, v_signer_name,
    p_ip, p_user_agent,
    jsonb_build_object(
      'consent_version', p_consent_version,
      'consent_text',    p_consent_text
    )
  );

  -- Flip the envelope. We re-snapshot the template's source_hash as
  -- doc_hash_at_sign: if the operator somehow swapped the template's
  -- source between send and sign (RLS doesn't actually permit this for
  -- past envelopes since we snapshotted into doc_hash_at_send already,
  -- but capturing it again gives the chain two independent witnesses).
  update public.document_envelopes
     set status = 'signed',
         signed_at = now(),
         doc_hash_at_sign = v_tpl.source_hash
   where id = v_env.id
   returning * into v_env;

  -- Audit: the signing event itself. Signature payload lives in
  -- event_data so the slice-4 sealing service can fetch + stamp it
  -- into the PDF, then append a Certificate of Completion.
  perform private.append_document_event(
    v_env.id, 'signed', 'driver',
    null, v_drv.id, v_drv.email, v_signer_name,
    p_ip, p_user_agent,
    jsonb_build_object(
      'signature_method',   p_signature_method,
      'signature_data',     p_signature_data,
      'typed_name',         p_typed_name,
      'doc_hash_at_sign',   v_tpl.source_hash,
      'doc_hash_at_send',   v_env.doc_hash_at_send,
      'hash_witness_match', v_tpl.source_hash = v_env.doc_hash_at_send
    )
  );

  return v_env;
end;
$$;
grant execute on function public.driver_envelope_sign(text, text, text, text, text, text, text, inet, text) to anon, authenticated;


notify pgrst, 'reload schema';
