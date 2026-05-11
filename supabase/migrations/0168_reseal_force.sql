-- Migration 0168 · documents_envelope_reseal — use the worker's force
-- flag instead of nulling the artifact paths.
--
-- 0167's reseal nulled signed_pdf_path / certificate_pdf_path /
-- seal_path before re-firing the worker so the worker wouldn't
-- short-circuit on "already_sealed". Downside: if the worker then
-- failed/timed out, the envelope was left worse off (no artifacts at
-- all). The worker now honors a `force: true` in the request body, so
-- the RPC just re-fires it with force=true and leaves the existing
-- seal alone; the new artifacts overwrite the old ones on success.

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

  select value into v_url    from private.app_settings where key = 'sealing_service_url';
  select value into v_secret from private.app_settings where key = 'sealing_service_secret';
  if v_url is null or v_url = '' or v_secret is null or v_secret = '' then
    raise exception 'sealing_service_not_configured' using errcode = 'P0001';
  end if;

  begin
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || v_secret
                 ),
      body    := jsonb_build_object('envelope_id', p_envelope_id, 'force', true)
    );
  exception when others then
    raise notice 'documents_envelope_reseal: worker invocation failed (%): %', p_envelope_id, sqlerrm;
  end;

  return v_env;
end;
$$;
grant execute on function public.documents_envelope_reseal(uuid) to authenticated;

notify pgrst, 'reload schema';
