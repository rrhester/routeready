-- Migration 0166 · Documents · re-seal an already-signed envelope
--
-- The sealing worker short-circuits if signed_pdf_path is already set
-- ("already_sealed"), so a document sealed while the RFC 3161 TSA was
-- unreachable keeps its timestamp-less seal forever. This RPC lets a
-- dispatcher re-run the seal on a signed envelope: it clears the
-- artifact paths and re-fires net.http_post to the worker (same call
-- the on-signed trigger makes), which then re-stamps the PDF, rebuilds
-- the Certificate of Completion, re-signs the ECDSA seal, and retries
-- the timestamp. The new pdf_sealed / pdf_signed events append to the
-- audit chain — re-sealing is itself a recorded event.

create or replace function public.documents_envelope_reseal(p_envelope_id uuid)
returns public.document_envelopes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_env public.document_envelopes;
  v_url    text;
  v_secret text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_env from public.document_envelopes
   where id = p_envelope_id and dsp_id = v_dsp;
  if v_env.id is null then raise exception 'envelope_not_found' using errcode = 'P0002'; end if;
  if v_env.status <> 'signed' then
    raise exception 'envelope_not_signed' using errcode = 'P0001';
  end if;

  -- Clear the artifact paths so the worker doesn't short-circuit; the
  -- storage objects get overwritten (worker uploads with x-upsert).
  update public.document_envelopes
     set signed_pdf_path = null, certificate_pdf_path = null, seal_path = null, updated_at = now()
   where id = p_envelope_id
   returning * into v_env;

  -- Re-fire the worker (best-effort — same as the on-signed trigger).
  begin
    select value into v_url    from private.app_settings where key = 'sealing_service_url';
    select value into v_secret from private.app_settings where key = 'sealing_service_secret';
    if v_url is not null and v_url <> '' and v_secret is not null and v_secret <> '' then
      perform net.http_post(
        url     := v_url,
        headers := jsonb_build_object(
                     'Content-Type',  'application/json',
                     'Authorization', 'Bearer ' || v_secret
                   ),
        body    := jsonb_build_object('envelope_id', p_envelope_id)
      );
    else
      raise notice 'documents_envelope_reseal: sealing settings missing — paths cleared but worker not invoked (%)', p_envelope_id;
    end if;
  exception when others then
    raise notice 'documents_envelope_reseal: worker invocation failed (%): %', p_envelope_id, sqlerrm;
  end;

  return v_env;
end;
$$;
grant execute on function public.documents_envelope_reseal(uuid) to authenticated;

notify pgrst, 'reload schema';
