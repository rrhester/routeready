-- Migration 0155 · Documents · sealing trigger + sealed-event helper
--
-- When a document_envelope transitions to 'signed' (and isn't already
-- sealed), fire an HTTP POST to the rr-document-sealing Cloudflare
-- Worker. The Worker stamps the signature onto the PDF, generates a
-- Certificate of Completion, uploads both, and logs a `pdf_sealed`
-- event back via document_log_sealed.
--
-- Same model as the SMS/email immediate-send triggers (migration 0007).
-- Endpoint URL and shared secret are read from Postgres-level settings
-- so the migration doesn't bake environment data in:
--   alter database postgres set "app.sealing_service_url"   to '…';
--   alter database postgres set "app.sealing_service_secret" to '…';
-- Set them once per environment (see services/document-sealing/README.md).

-- pg_net is required by the http_post call below. Already enabled on
-- the project via the cron drainer setup, but make the dependency
-- explicit so a fresh project surfaces a sensible error.
create extension if not exists pg_net;


-- ── document_log_sealed · public wrapper for the worker to call ────────
-- The worker is service-role and bypasses RLS; this is the only entry
-- point that lets it append a pdf_sealed event without exposing the
-- generic private.append_document_event to the world.

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

  -- Idempotency: don't double-append pdf_sealed if it's already on the chain.
  if exists (
    select 1 from public.document_events
     where envelope_id = p_envelope_id and kind = 'pdf_sealed'
  ) then
    select * into v_row from public.document_events
     where envelope_id = p_envelope_id and kind = 'pdf_sealed'
     order by id desc limit 1;
    return v_row;
  end if;

  v_row := private.append_document_event(
    p_envelope_id, 'pdf_sealed', 'system',
    null, null, null, null, null, 'rr-document-sealing/0.1',
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


-- ── Trigger function · POST to the sealing worker ──────────────────────

create or replace function private.document_envelopes_seal_on_signed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text := current_setting('app.sealing_service_url',    true);
  v_secret text := current_setting('app.sealing_service_secret', true);
begin
  -- Only act when an envelope transitions INTO 'signed' and isn't
  -- already sealed. The worker is idempotent, but firing on every
  -- subsequent UPDATE would be wasteful.
  if new.status is distinct from 'signed' then return new; end if;
  if old.status = 'signed' then return new; end if;
  if new.signed_pdf_path is not null then return new; end if;

  -- Settings missing → no-op (don't block the signing flow). The
  -- worker will pick it up on a later manual nudge or a re-set.
  if v_url is null or v_url = '' or v_secret is null or v_secret = '' then
    raise notice 'document sealing settings missing — skipping trigger for envelope %', new.id;
    return new;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_secret
               ),
    body    := jsonb_build_object('envelope_id', new.id)
  );

  return new;
end;
$$;

drop trigger if exists document_envelopes_seal_on_signed on public.document_envelopes;
create trigger document_envelopes_seal_on_signed
  after update of status on public.document_envelopes
  for each row
  execute function private.document_envelopes_seal_on_signed();


notify pgrst, 'reload schema';
