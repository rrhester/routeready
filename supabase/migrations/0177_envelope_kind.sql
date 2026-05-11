-- Migration 0177 · Expose document_templates.kind to the driver-side
-- envelope RPCs, so the driver app can show a lighter "review &
-- acknowledge" flow for informational documents (no signature pad, no
-- e-sign consent) vs the full signing flow for secure documents.
-- Pure additive change to two read RPCs — same signatures, one extra
-- field in the returned JSON.

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
    'kind',           t.kind,
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
    'kind',           t.kind,
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
      'kind',        v_tpl.kind,
      'source_path', v_tpl.source_path,
      'source_hash', v_tpl.source_hash
    )
  );
end;
$$;
grant execute on function public.driver_envelope_view(text, text, inet, text) to anon, authenticated;

notify pgrst, 'reload schema';
