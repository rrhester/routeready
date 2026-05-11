-- Migration 0153 · Documents · template + envelope RPCs (slice 2)
--
-- Operator-facing entry points for the e-signature flow:
--   • documents_template_create — record an uploaded PDF as a reusable
--     template (storage path + SHA-256 already computed client-side).
--   • documents_envelope_create — create one envelope for one recipient
--     (caller fans out for bulk). Snapshots the template's hash and
--     field layout onto the envelope so a later template edit can't
--     retroactively change what the signer saw, and writes the
--     envelope_created + sent audit events through the hash-chained
--     append_document_event path.
-- All read paths (list, get, events) use direct SELECTs via RLS — no
-- RPCs needed.

-- ── documents_template_create ────────────────────────────────────────────
-- The frontend has already uploaded the PDF to the 'documents' bucket
-- under <dsp_id>/templates/<random>.pdf and computed its SHA-256.

create or replace function public.documents_template_create(
  p_title       text,
  p_source_path text,
  p_source_hash text,
  p_description text  default null,
  p_source_size int   default null,
  p_fields      jsonb default '[]'::jsonb
) returns public.document_templates
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.document_templates;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(trim(p_title), '') = '' then
    raise exception 'title_required' using errcode = 'P0001';
  end if;
  if p_source_path is null or p_source_path = '' then
    raise exception 'source_path_required' using errcode = 'P0001';
  end if;
  if p_source_hash is null or length(p_source_hash) <> 64 then
    raise exception 'source_hash_required' using errcode = 'P0001';
  end if;
  -- The source must live under <dsp>/templates/... so a misconfigured
  -- upload can't claim a different tenant's file.
  if p_source_path not like (v_dsp::text || '/templates/%') then
    raise exception 'invalid_source_path' using errcode = '42501';
  end if;

  insert into public.document_templates
    (dsp_id, title, description, source_path, source_hash, source_size, fields, created_by)
  values
    (v_dsp, trim(p_title),
     nullif(trim(coalesce(p_description, '')), ''),
     p_source_path, p_source_hash, p_source_size,
     coalesce(p_fields, '[]'::jsonb), auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.documents_template_create(text, text, text, text, int, jsonb) to authenticated;


-- ── documents_envelope_create ────────────────────────────────────────────
-- One envelope per (template, recipient_driver). The frontend bulk-sends
-- by calling this N times. We snapshot the template's hash and fields
-- onto the envelope so this signer's record is independent of later
-- template edits.

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
  v_email text;
  v_name text;
  v_env public.document_envelopes;
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

  -- Genesis + sent events on the audit chain.
  perform private.append_document_event(
    v_env.id, 'envelope_created', 'dispatcher',
    v_uid, null, null, null, null, null,
    jsonb_build_object(
      'template_id',   v_tpl.id,
      'template_title', v_tpl.title,
      'source_hash',   v_tpl.source_hash,
      'recipient_driver_id', v_drv.id,
      'recipient_email', v_email,
      'recipient_name',  v_name,
      'expires_at',    p_expires_at
    )
  );
  perform private.append_document_event(
    v_env.id, 'sent', 'system',
    null, null, null, null, null, null,
    jsonb_build_object('signing_token_issued', true)
  );

  return v_env;
end;
$$;
grant execute on function public.documents_envelope_create(uuid, uuid, timestamptz) to authenticated;


-- ── documents_envelope_void ──────────────────────────────────────────────
-- Cancel an envelope that hasn't completed. Logs the void to the audit
-- chain with the sender's reason.

create or replace function public.documents_envelope_void(
  p_envelope_id uuid,
  p_reason      text default null
) returns public.document_envelopes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_env public.document_envelopes;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_env from public.document_envelopes
    where id = p_envelope_id and dsp_id = v_dsp;
  if v_env.id is null then raise exception 'envelope_not_found' using errcode = 'P0002'; end if;
  if v_env.status in ('signed','declined','voided','expired') then
    raise exception 'envelope_terminal' using errcode = 'P0001';
  end if;

  update public.document_envelopes
     set status = 'voided', voided_at = now(),
         void_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_envelope_id
   returning * into v_env;

  perform private.append_document_event(
    v_env.id, 'voided', 'dispatcher',
    v_uid, null, null, null, null, null,
    jsonb_build_object('reason', nullif(trim(coalesce(p_reason, '')), ''))
  );
  return v_env;
end;
$$;
grant execute on function public.documents_envelope_void(uuid, text) to authenticated;


-- ── Storage policies for the 'documents' bucket ─────────────────────────
-- Staff (dispatcher+) read/write their own DSP's prefix. Driver/external
-- access goes through signed URLs (which bypass these policies), not
-- direct SELECTs, so no separate driver-side policy is needed here.

create policy "documents_staff_read" on storage.objects for select
  using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = private.current_dsp_id()::text
  );

create policy "documents_staff_write" on storage.objects for insert
  with check (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = private.current_dsp_id()::text
    and private.is_staff(private.current_dsp_id(), 'dispatcher')
  );

create policy "documents_staff_update" on storage.objects for update
  using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = private.current_dsp_id()::text
    and private.is_staff(private.current_dsp_id(), 'dispatcher')
  );

create policy "documents_staff_delete" on storage.objects for delete
  using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = private.current_dsp_id()::text
    and private.is_staff(private.current_dsp_id(), 'dispatcher')
  );


notify pgrst, 'reload schema';
