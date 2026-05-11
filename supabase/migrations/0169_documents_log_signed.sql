-- Migration 0169 · Documents · append the pdf_signed event reliably +
-- let re-seals re-log pdf_sealed.
--
-- Two audit-trail gaps the sealing worker hit:
--   1. It records the cryptographic seal by calling rpc/append_document_event,
--      but only private.append_document_event exists — PostgREST resolves
--      against the public schema, so the call 404s and the pdf_signed event
--      is never written. Add a public.document_log_signed wrapper (granted
--      to service_role only, like document_log_sealed) for it to call.
--   2. document_log_sealed had an "if a pdf_sealed event already exists,
--      don't add another" guard, so a *re-seal* never logged a fresh
--      pdf_sealed. Drop that guard — the timeline should record re-seals.
--
-- (pdf_signed was added to the document_event_kind enum back in 0160;
-- the IF NOT EXISTS below is just belt-and-suspenders.)

alter type public.document_event_kind add value if not exists 'pdf_signed';


create or replace function public.document_log_sealed(
  p_envelope_id        uuid,
  p_signed_pdf_path    text,
  p_certificate_path   text,
  p_sealed_byte_count  int,
  p_cert_byte_count    int default null,
  p_algorithm          text default 'stamp+certificate-v1'
) returns public.document_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_env public.document_envelopes;
  v_row public.document_events;
begin
  select * into v_env from public.document_envelopes where id = p_envelope_id;
  if v_env.id is null then raise exception 'envelope_not_found' using errcode = 'P0002'; end if;
  v_row := private.append_document_event(
    p_envelope_id, 'pdf_sealed', 'system',
    null, null, null, null, null, 'rr-document-sealing',
    jsonb_build_object(
      'signed_pdf_path',      p_signed_pdf_path,
      'certificate_pdf_path', p_certificate_path,
      'sealed_byte_count',    p_sealed_byte_count,
      'cert_byte_count',      p_cert_byte_count,
      'sealing_algorithm',    p_algorithm
    )
  );
  return v_row;
end;
$$;
grant execute on function public.document_log_sealed(uuid, text, text, int, int, text) to service_role;


create or replace function public.document_log_signed(
  p_envelope_id uuid,
  p_event_data  jsonb
) returns public.document_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_env public.document_envelopes;
  v_row public.document_events;
begin
  select * into v_env from public.document_envelopes where id = p_envelope_id;
  if v_env.id is null then raise exception 'envelope_not_found' using errcode = 'P0002'; end if;
  v_row := private.append_document_event(
    p_envelope_id, 'pdf_signed', 'system',
    null, null, null, null, null, 'rr-document-sealing',
    coalesce(p_event_data, '{}'::jsonb)
  );
  return v_row;
end;
$$;
grant execute on function public.document_log_signed(uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
