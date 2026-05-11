-- Migration 0158 · Documents · send the driver an email when an envelope is created
--
-- Slice 2 set up the envelope row + audit chain, but didn't actually
-- notify the driver — they had to discover pending envelopes on their
-- own by opening the PWA. For real-world use, an email at send time is
-- essential. This migration:
--
--   • Seeds an `documents.envelope_sent` email template on every DSP
--     that doesn't already have it (so existing tenants aren't left out
--     and new DSPs inherit it via admin_create_dsp's copy step).
--   • Re-creates documents_envelope_create so it queues the
--     notification email in a best-effort sub-block — a missing
--     template or render error logs a notice but doesn't roll back the
--     envelope creation (same lesson as queue_outcome_message in 0146).

-- ── Template seed (idempotent) ──────────────────────────────────────────
insert into public.message_templates (dsp_id, channel, key, name, subject, body, active)
select d.id,
       'email'::public.message_channel,
       'documents.envelope_sent',
       'Document · signature requested (email)',
       'Signature requested: {{document_title}}',
       E'Hi {{first_name}},\n\n{{dsp_name}} has sent you a document to review and sign:\n\n    {{document_title}}\n\nOpen the RouteReady driver app to sign it:\n\n    {{app_url}}\n\nOnce signed, the document is recorded with a tamper-evident audit trail — you can come back to it any time from the Tasks tab in the app.\n\n— The {{dsp_name}} team',
       true
from public.dsps d
where not exists (
  select 1 from public.message_templates t
   where t.dsp_id = d.id and t.channel = 'email' and t.key = 'documents.envelope_sent'
);


-- ── documents_envelope_create · queue the email after the envelope row ──
create or replace function public.documents_envelope_create(
  p_template_id        uuid,
  p_recipient_driver_id uuid,
  p_expires_at         timestamptz default null
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
  v_env public.document_envelopes;
  v_msg record;
  v_app_url text;
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
     doc_hash_at_send, fields_snapshot, expires_at, status)
  values
    (v_dsp, v_tpl.id, v_uid,
     v_drv.id, v_email, v_name,
     v_tpl.source_hash, v_tpl.fields, p_expires_at, 'sent')
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
      'expires_at',          p_expires_at
    )
  );
  perform private.append_document_event(
    v_env.id, 'sent', 'system',
    null, null, null, null, null, null,
    jsonb_build_object('signing_token_issued', true)
  );

  -- Best-effort notification email. A missing template or render error
  -- shouldn't roll back the envelope creation — the driver still sees
  -- the envelope in their PWA Tasks hub regardless.
  begin
    select * into v_dsp_row from public.dsps where id = v_dsp;
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

  return v_env;
end;
$$;
grant execute on function public.documents_envelope_create(uuid, uuid, timestamptz) to authenticated;


notify pgrst, 'reload schema';
