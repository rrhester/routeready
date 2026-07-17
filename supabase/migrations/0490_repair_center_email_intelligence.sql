-- Migration 0490 · Repair Center — Phase 7: email & document intelligence.
--
-- Three capabilities, all riding existing rails:
--
--   1. INBOUND SHOP MAIL → CASE TIMELINE. webhook-email-inbound already
--      stores every inbound email (email_messages) and its attachments
--      (document_intake + the document-intake bucket). This migration
--      adds the matcher: sender ↔ vendor, case-number token ('RC-YYYY-
--      NNNN' in subject/body) or single-open-case fallback → a
--      'shop_email' timeline event + the attachments filed onto the
--      case (document_intake's Phase-3 filing columns finally get
--      used). Ambiguity NEVER guesses — unmatched mail stays in the
--      Fleet Bridge inbox untouched.
--
--   2. ESTIMATE EXTRACTION → DRAFT QUOTES. The repair-quote-extract
--      edge function (document-classify's sibling) transcribes an
--      attached estimate into a DRAFT repair_quotes row + line items.
--      Money integrity: the model only TRANSCRIBES amounts printed on
--      the document (integer cents); totals are recomputed by the
--      existing private.repair_quote_recompute and disagreements are
--      FLAGGED (totals_mismatch), never corrected. Extraction only
--      ever creates/replaces UNREVIEWED drafts — once a human has
--      accepted (reviewed_at set, status submitted), re-extraction
--      records data but never touches the quote. Every extraction is
--      journaled in repair_document_extractions (raw payload, model,
--      confidence) per the Phase 7 design.
--
--   3. DELIVERABILITY. The webhook-email-events edge function feeds
--      Resend's delivered/bounced/complained events into
--      email_messages (delivered_at / error_code — schema-ready since
--      0002, unwritten until now). A bounced quote-request email flips
--      its repair_quote_requests row to 'failed' — the one request
--      state the UI paints red, because silent non-delivery is the
--      most expensive failure in the whole loop.
--
-- New table:  repair_document_extractions
-- New RPCs:   service_role — repair_inbound_email_match,
--                            repair_email_event_apply,
--                            repair_quote_extract_save
--             staff        — repair_quote_review (accept / discard)
-- Replaced:   repair_case_quotes (extracted drafts now included)
--
-- Idempotent: safe to re-run in the SQL Editor.

-- ═══════════════════════════ 0. document_intake — adopted-migration
-- guard. 0330 predates the 0373 ledger baseline (same class of gap as
-- the 0313 vendor columns found in 0487): re-create defensively so
-- this migration and the inbound matcher can't land on a missing
-- table. Identical shapes to 0330 — a no-op where 0330 really ran.

insert into storage.buckets (id, name, public, file_size_limit)
values ('document-intake', 'document-intake', false, 104857600)
on conflict (id) do nothing;

create table if not exists public.document_intake (
  id               uuid primary key default gen_random_uuid(),
  dsp_id           uuid not null references public.dsps(id) on delete cascade,
  source           text not null default 'email',
  email_message_id uuid references public.email_messages(id) on delete set null,
  sender_email     text,
  sender_name      text,
  storage_path     text not null,
  file_name        text not null,
  file_size_bytes  bigint,
  mime_type        text,
  status           text not null default 'pending',
  classified_type  text,
  classified_type_label text,
  classification_score numeric(4,3),
  classification_summary text,
  classification_model text,
  classification_prompt_version int,
  classification_error text,
  classified_at    timestamptz,
  extracted_data   jsonb,
  filed_to_table   text,
  filed_to_id      uuid,
  filed_at         timestamptz,
  filed_by         uuid references auth.users(id) on delete set null,
  dismissed_at     timestamptz,
  dismissed_reason text,
  retention_until  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists document_intake_dsp_idx
  on public.document_intake (dsp_id, created_at desc);
create index if not exists document_intake_email_idx
  on public.document_intake (email_message_id)
  where email_message_id is not null;
alter table public.document_intake enable row level security;
drop policy if exists "document_intake_tenant_select" on public.document_intake;
create policy "document_intake_tenant_select"
  on public.document_intake for select to authenticated
  using (dsp_id = private.current_dsp_id());
grant select on public.document_intake to authenticated;


-- ═══════════════════════════ 1. repair_document_extractions ═════════
-- One row per extraction run: the raw model payload, confidence, and a
-- pointer to the draft quote it produced (if any). The journal is what
-- makes "re-extract" auditable and "never overwrite reviewed data"
-- checkable.

create table if not exists public.repair_document_extractions (
  id               uuid primary key default gen_random_uuid(),
  dsp_id           uuid not null references public.dsps(id) on delete cascade,
  repair_case_id   uuid not null references public.repair_cases(id) on delete cascade,
  attachment_id    uuid references public.repair_case_attachments(id) on delete set null,
  email_message_id uuid references public.email_messages(id) on delete set null,
  kind             text not null default 'other',
  status           text not null default 'completed',
  model            text,
  prompt_version   int,
  confidence       numeric(4,3),
  raw              jsonb not null default '{}'::jsonb,
  summary          text,
  error            text,
  quote_id         uuid references public.repair_quotes(id) on delete set null,
  created_at       timestamptz not null default now()
);

do $$ begin
  alter table public.repair_document_extractions
    add constraint repair_document_extractions_kind_chk
    check (kind in ('estimate','invoice','other'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.repair_document_extractions
    add constraint repair_document_extractions_status_chk
    check (status in ('completed','error'));
exception when duplicate_object then null; end $$;

create index if not exists repair_document_extractions_case_idx
  on public.repair_document_extractions (repair_case_id, created_at desc);

alter table public.repair_document_extractions enable row level security;
drop policy if exists "repair_document_extractions_tenant_select" on public.repair_document_extractions;
create policy "repair_document_extractions_tenant_select"
  on public.repair_document_extractions for select to authenticated
  using (dsp_id = private.current_dsp_id());
grant select on public.repair_document_extractions to authenticated;


-- ═══════════════════════════ 2. repair_quotes review columns ════════
-- The DVIC pattern: machine columns and reviewer columns are separate,
-- so "extracted" can never masquerade as "reviewed".

alter table public.repair_quotes
  add column if not exists extracted_from_attachment_id uuid
    references public.repair_case_attachments(id) on delete set null,
  add column if not exists extracted_at          timestamptz,
  add column if not exists extraction_confidence numeric(4,3),
  add column if not exists extraction_model      text,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz;


-- ═══════════════════════════ 3. Coercion helpers ════════════════════
-- The extraction payload is model output — treat every field as
-- untrusted. Money accepts INTEGER CENTS only (0..$1M), timestamps and
-- numerics fail closed to null.

create or replace function private._rc_cents(p jsonb)
returns int
language plpgsql
immutable
as $$
declare
  v numeric;
begin
  if p is null or jsonb_typeof(p) not in ('number','string') then
    return null;
  end if;
  begin
    v := (p #>> '{}')::numeric;
  exception when others then
    return null;
  end;
  if v is null or v < 0 or v > 100000000 or v <> round(v) then
    return null;
  end if;
  return v::int;
end;
$$;

create or replace function private._rc_num(p jsonb, p_max numeric default 100000)
returns numeric
language plpgsql
immutable
as $$
declare
  v numeric;
begin
  if p is null or jsonb_typeof(p) not in ('number','string') then
    return null;
  end if;
  begin
    v := (p #>> '{}')::numeric;
  exception when others then
    return null;
  end;
  if v is null or v < 0 or v > p_max then return null; end if;
  return v;
end;
$$;

create or replace function private._rc_safe_ts(p text)
returns timestamptz
language plpgsql
stable
as $$
begin
  return nullif(btrim(coalesce(p, '')), '')::timestamptz;
exception when others then
  return null;
end;
$$;


-- ═══════════════════════════ 4. repair_inbound_email_match ══════════
-- Called by webhook-email-inbound after it stores an inbound email.
-- Matching is deliberately conservative:
--   ① a case-number token (RC-YYYY-NNNN) in subject/body always wins
--   ② else sender ↔ vendor email, and ONLY when that vendor has
--     exactly one open case — ambiguity never guesses
-- On match: one 'shop_email' timeline event (idempotent across webhook
-- redeliveries) + the email's document_intake attachments filed onto
-- the case as repair_case_attachments.

create or replace function public.repair_inbound_email_match(p_email_id uuid)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_email public.email_messages;
  v_vendor public.vendors;
  v_case public.repair_cases;
  v_token text;
  v_open int;
  v_att record;
  v_new_id uuid;
  v_atts jsonb := '[]'::jsonb;
begin
  select * into v_email from public.email_messages
   where id = p_email_id and direction = 'inbound';
  if not found then
    return jsonb_build_object('matched', false, 'reason', 'email_not_found');
  end if;

  select * into v_vendor from public.vendors vn
   where vn.dsp_id = v_email.dsp_id
     and coalesce(v_email.from_email, '') <> ''
     and (lower(coalesce(vn.contact_email, '')) = lower(v_email.from_email)
          or exists (
            select 1 from jsonb_array_elements(coalesce(vn.contacts, '[]'::jsonb)) e
            where lower(coalesce(e->>'email', '')) = lower(v_email.from_email)))
   order by vn.name
   limit 1;

  -- ① explicit case-number token
  v_token := substring(coalesce(v_email.subject, '') || ' ' || coalesce(v_email.body_text, '')
                       from 'RC-\d{4}-\d{4}');
  if v_token is not null then
    select * into v_case from public.repair_cases
     where dsp_id = v_email.dsp_id and case_number = v_token
     order by (stage not in ('closed','cancelled')) desc, created_at desc
     limit 1;
  end if;

  -- ② known vendor with exactly one open case
  if v_case.id is null and v_vendor.id is not null then
    select count(*)::int into v_open from public.repair_cases
     where dsp_id = v_email.dsp_id and vendor_id = v_vendor.id
       and stage not in ('closed','cancelled') and archived_at is null;
    if v_open = 1 then
      select * into v_case from public.repair_cases
       where dsp_id = v_email.dsp_id and vendor_id = v_vendor.id
         and stage not in ('closed','cancelled') and archived_at is null;
    end if;
  end if;

  if v_case.id is null then
    return jsonb_build_object(
      'matched', false, 'vendor_id', v_vendor.id,
      'reason', case when v_vendor.id is null then 'no_vendor_match'
                     else 'no_single_open_case' end);
  end if;

  -- one timeline event per email, ever (webhook redeliveries no-op)
  if not exists (
    select 1 from public.repair_case_events
    where repair_case_id = v_case.id and kind = 'shop_email'
      and payload->>'email_message_id' = p_email_id::text) then
    perform private.repair_case_event(
      v_email.dsp_id, v_case.id, 'shop_email',
      coalesce(nullif(btrim(coalesce(v_email.subject, '')), ''), '(no subject)')
        || case when coalesce(btrim(v_email.body_text), '') = '' then ''
                else ' — ' || left(regexp_replace(btrim(v_email.body_text), '\s+', ' ', 'g'), 220) end,
      null, null, 'email', false, false,
      jsonb_build_object('email_message_id', p_email_id, 'vendor_id', v_vendor.id));
  end if;

  -- file the email's attachments onto the case (idempotent by path)
  for v_att in
    select * from public.document_intake
    where email_message_id = p_email_id and dsp_id = v_email.dsp_id
      and status <> 'dismissed'
  loop
    select id into v_new_id from public.repair_case_attachments
     where repair_case_id = v_case.id and storage_path = v_att.storage_path;
    if v_new_id is null then
      insert into public.repair_case_attachments
        (dsp_id, repair_case_id, storage_bucket, storage_path, file_name,
         mime_type, byte_size, attachment_type, source, shop_visible)
      values
        (v_email.dsp_id, v_case.id, 'document-intake', v_att.storage_path,
         v_att.file_name, v_att.mime_type, v_att.file_size_bytes,
         'other', 'email', false)
      returning id into v_new_id;
      update public.document_intake
         set status = 'filed',
             filed_to_table = 'repair_case_attachments',
             filed_to_id = v_new_id,
             filed_at = now(),
             updated_at = now()
       where id = v_att.id;
    end if;
    v_atts := v_atts || jsonb_build_object('id', v_new_id, 'mime_type', v_att.mime_type);
  end loop;

  return jsonb_build_object(
    'matched', true,
    'case_id', v_case.id,
    'case_number', v_case.case_number,
    'vendor_id', v_vendor.id,
    'attachments', v_atts);
end;
$$;


-- ═══════════════════════════ 5. repair_email_event_apply ════════════
-- Called by webhook-email-events for Resend deliverability events.
-- Writes the 0002-era delivered_at / error columns and flips bounced
-- quote-request emails to 'failed' — the red state the queue shows.

create or replace function public.repair_email_event_apply(
  p_provider_message_id text,
  p_event  text,
  p_detail text default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_email public.email_messages;
  v_event text := lower(regexp_replace(coalesce(p_event, ''), '^email\.', ''));
  v_req record;
  v_auth record;
  v_vendor_name text;
  v_flipped int := 0;
begin
  if coalesce(btrim(p_provider_message_id), '') = '' then
    return jsonb_build_object('matched', false, 'reason', 'no_message_id');
  end if;
  select * into v_email from public.email_messages
   where provider = 'resend' and provider_message_id = btrim(p_provider_message_id)
   limit 1;
  if not found then
    return jsonb_build_object('matched', false, 'reason', 'email_not_found');
  end if;

  if v_event = 'delivered' then
    update public.email_messages
       set status = 'delivered', delivered_at = coalesce(delivered_at, now()),
           updated_at = now()
     where id = v_email.id and status in ('sent','delivered');
    return jsonb_build_object('matched', true, 'event', v_event);
  end if;

  if v_event in ('bounced','complained','failed') then
    update public.email_messages
       set status = 'failed',
           error_code = left(v_event, 60),
           error_message = left(coalesce(nullif(btrim(coalesce(p_detail,'')),''), v_event), 500),
           updated_at = now()
     where id = v_email.id;

    -- A bounced quote request is a failed shop communication.
    for v_req in
      select r.*, vn.name as vendor_name
      from public.repair_quote_requests r
      left join public.vendors vn on vn.id = r.vendor_id
      where r.email_message_id = v_email.id
        and r.request_status in ('queued','sent','opened')
    loop
      update public.repair_quote_requests
         set request_status = 'failed', updated_at = now()
       where id = v_req.id;
      perform private.repair_case_event(
        v_req.dsp_id, v_req.repair_case_id, 'email_bounced',
        'Quote request email to ' || coalesce(v_req.vendor_name, 'shop')
          || ' bounced — check the shop''s email address',
        null, null, 'system', false, true,
        jsonb_build_object('request_id', v_req.id, 'email_message_id', v_email.id));
      v_flipped := v_flipped + 1;
    end loop;

    -- A bounced authorization email is called out on the timeline too.
    for v_auth in
      select a.* from public.repair_authorizations a
      where a.email_message_id = v_email.id
        and a.status in ('issued','acknowledged')
    loop
      select name into v_vendor_name from public.vendors where id = v_auth.vendor_id;
      perform private.repair_case_event(
        v_auth.dsp_id, v_auth.repair_case_id, 'email_bounced',
        'Authorization email to ' || coalesce(v_vendor_name, 'shop')
          || ' bounced — confirm the shop received the scope',
        null, null, 'system', false, true,
        jsonb_build_object('authorization_id', v_auth.id, 'email_message_id', v_email.id));
    end loop;

    return jsonb_build_object('matched', true, 'event', v_event, 'requests_failed', v_flipped);
  end if;

  -- delivery_delayed / opened / clicked …: acknowledged, not acted on.
  return jsonb_build_object('matched', true, 'event', v_event, 'noted', true);
end;
$$;


-- ═══════════════════════════ 6. repair_quote_extract_save ═══════════
-- Write-back for the repair-quote-extract edge function. The payload
-- is MODEL OUTPUT: every field is coerced fail-closed, money accepts
-- integer cents only, and totals are recomputed by
-- private.repair_quote_recompute — a transcription that doesn't add up
-- surfaces as totals_mismatch, exactly like a shop-typed quote.
--
-- Reviewed data is never overwritten: extraction only creates a draft,
-- replaces ITS OWN previous unreviewed draft on re-extract, and backs
-- off entirely once a human has reviewed the quote.

create or replace function public.repair_quote_extract_save(
  p_attachment_id  uuid,
  p_payload        jsonb default null,
  p_model          text default null,
  p_prompt_version int default 1,
  p_error          text default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_att public.repair_case_attachments;
  v_case public.repair_cases;
  v_kind text;
  v_conf numeric;
  v_ext_id uuid;
  v_quote public.repair_quotes;
  v_reviewed uuid;
  v_item jsonb;
  v_n int := 0;
begin
  select * into v_att from public.repair_case_attachments where id = p_attachment_id;
  if not found then
    raise exception 'attachment_not_found' using errcode = 'P0002';
  end if;
  select * into v_case from public.repair_cases where id = v_att.repair_case_id;

  if p_error is not null then
    insert into public.repair_document_extractions
      (dsp_id, repair_case_id, attachment_id, kind, status, model,
       prompt_version, error)
    values
      (v_att.dsp_id, v_att.repair_case_id, v_att.id, 'other', 'error',
       p_model, p_prompt_version, left(p_error, 500))
    returning id into v_ext_id;
    return jsonb_build_object('ok', false, 'extraction_id', v_ext_id);
  end if;

  v_kind := case when p_payload->>'document_kind' in ('estimate','invoice')
                 then p_payload->>'document_kind' else 'other' end;
  v_conf := least(greatest(coalesce(private._rc_num(p_payload->'confidence', 1), 0), 0), 1);

  -- classify the attachment itself (estimate/invoice) for the drawer
  update public.repair_case_attachments
     set attachment_type = case v_kind when 'estimate' then 'estimate'
                                       when 'invoice'  then 'invoice'
                                       else attachment_type end
   where id = v_att.id;

  insert into public.repair_document_extractions
    (dsp_id, repair_case_id, attachment_id, email_message_id, kind, status,
     model, prompt_version, confidence, raw, summary)
  values
    (v_att.dsp_id, v_att.repair_case_id, v_att.id, null, v_kind, 'completed',
     p_model, p_prompt_version, v_conf, coalesce(p_payload, '{}'::jsonb),
     left(nullif(btrim(coalesce(p_payload->>'summary','')),''), 500))
  returning id into v_ext_id;

  if v_kind <> 'estimate' then
    -- invoices are Phase 8's reconciliation input; journal only.
    return jsonb_build_object('ok', true, 'extraction_id', v_ext_id,
                              'kind', v_kind, 'quote_id', null);
  end if;

  -- never touch a reviewed quote
  select id into v_reviewed from public.repair_quotes
   where extracted_from_attachment_id = v_att.id and status <> 'draft'
   limit 1;
  if v_reviewed is not null then
    return jsonb_build_object('ok', true, 'extraction_id', v_ext_id,
                              'kind', v_kind, 'quote_id', null,
                              'reason', 'already_reviewed');
  end if;

  -- replace THIS attachment's previous unreviewed draft (re-extract)
  delete from public.repair_quotes
   where extracted_from_attachment_id = v_att.id and status = 'draft';

  insert into public.repair_quotes
    (dsp_id, repair_case_id, vendor_id, source, status,
     quote_number, shop_work_order_number,
     shop_reported_total_cents,
     earliest_appointment_at, estimated_completion_at, expires_at,
     warranty_summary, parts_availability, notes,
     contact_name, contact_phone, service_advisor,
     extracted_from_attachment_id, extracted_at,
     extraction_confidence, extraction_model)
  values
    (v_att.dsp_id, v_att.repair_case_id, v_case.vendor_id,
     case when v_att.source = 'email' then 'email_attachment'
          when coalesce(v_att.mime_type,'') like 'image/%' then 'image_upload'
          else 'pdf_upload' end,
     'draft',
     left(nullif(btrim(coalesce(p_payload->>'quote_number','')),''), 60),
     left(nullif(btrim(coalesce(p_payload->>'shop_work_order_number','')),''), 80),
     private._rc_cents(p_payload->'shop_reported_total_cents'),
     private._rc_safe_ts(p_payload->>'earliest_appointment_at'),
     private._rc_safe_ts(p_payload->>'estimated_completion_at'),
     private._rc_safe_ts(p_payload->>'expires_at'),
     left(nullif(btrim(coalesce(p_payload->>'warranty_summary','')),''), 200),
     left(nullif(btrim(coalesce(p_payload->>'parts_availability','')),''), 200),
     left(nullif(btrim(coalesce(p_payload->>'notes','')),''), 1000),
     left(nullif(btrim(coalesce(p_payload->>'contact_name','')),''), 80),
     left(nullif(btrim(coalesce(p_payload->>'contact_phone','')),''), 30),
     left(nullif(btrim(coalesce(p_payload->>'service_advisor','')),''), 80),
     v_att.id, now(), v_conf, p_model)
  returning * into v_quote;

  for v_item in
    select * from jsonb_array_elements(coalesce(p_payload->'line_items', '[]'::jsonb))
  loop
    v_n := v_n + 1;
    exit when v_n > 60;                       -- sanity ceiling
    insert into public.repair_quote_line_items
      (dsp_id, quote_id, line_number, category, description,
       part_number, quantity, unit_price_cents, parts_total_cents,
       labor_hours, labor_rate_cents, labor_total_cents,
       fees_cents, tax_cents, line_total_cents)
    values
      (v_att.dsp_id, v_quote.id, v_n,
       case when v_item->>'category' in
              ('diagnostic','labor','part_oem','part_aftermarket','part_used',
               'part_reman','sublet','towing','supplies','environmental',
               'tax','discount','misc')
            then v_item->>'category' else 'misc' end,
       left(coalesce(nullif(btrim(coalesce(v_item->>'description','')),''), 'Line ' || v_n), 500),
       left(nullif(btrim(coalesce(v_item->>'part_number','')),''), 80),
       private._rc_num(v_item->'quantity', 10000),
       private._rc_cents(v_item->'unit_price_cents'),
       private._rc_cents(v_item->'parts_total_cents'),
       private._rc_num(v_item->'labor_hours', 1000),
       private._rc_cents(v_item->'labor_rate_cents'),
       private._rc_cents(v_item->'labor_total_cents'),
       private._rc_cents(v_item->'fees_cents'),
       private._rc_cents(v_item->'tax_cents'),
       private._rc_cents(v_item->'line_total_cents'));
  end loop;

  perform private.repair_quote_recompute(v_quote.id);

  update public.repair_document_extractions
     set quote_id = v_quote.id where id = v_ext_id;

  perform private.repair_case_event(
    v_att.dsp_id, v_att.repair_case_id, 'quote_extracted',
    'Estimate extracted from ' || left(v_att.file_name, 120) || ' — review before use',
    null, null, 'system', false, true,
    jsonb_build_object('quote_id', v_quote.id, 'attachment_id', v_att.id,
                       'extraction_id', v_ext_id, 'confidence', v_conf));

  return jsonb_build_object('ok', true, 'extraction_id', v_ext_id,
                            'kind', v_kind, 'quote_id', v_quote.id,
                            'confidence', v_conf);
end;
$$;

-- Service-role only: these three are edge-function write paths.
revoke execute on function public.repair_inbound_email_match(uuid) from public, anon, authenticated;
revoke execute on function public.repair_email_event_apply(text, text, text) from public, anon, authenticated;
revoke execute on function public.repair_quote_extract_save(uuid, jsonb, text, int, text) from public, anon, authenticated;
grant execute on function public.repair_inbound_email_match(uuid) to service_role;
grant execute on function public.repair_email_event_apply(text, text, text) to service_role;
grant execute on function public.repair_quote_extract_save(uuid, jsonb, text, int, text) to service_role;


-- ═══════════════════════════ 7. repair_quote_review ═════════════════
-- The human decision on an extracted draft: accept (becomes a normal
-- submitted quote, reviewer stamped) or discard (draft deleted; the
-- extraction journal row is kept for audit).

create or replace function public.repair_quote_review(
  p_quote_id  uuid,
  p_action    text,
  p_vendor_id uuid default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_quote public.repair_quotes;
  v_case public.repair_cases;
  v_vendor uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_quote from public.repair_quotes
   where id = p_quote_id and dsp_id = v_dsp;
  if not found then
    raise exception 'quote_not_found' using errcode = 'P0002';
  end if;
  if v_quote.status <> 'draft' or v_quote.extracted_at is null then
    raise exception 'not_reviewable' using errcode = '22023';
  end if;
  select * into v_case from public.repair_cases where id = v_quote.repair_case_id;

  if p_action = 'accept' then
    v_vendor := coalesce(p_vendor_id, v_quote.vendor_id);
    if v_vendor is null then
      raise exception 'vendor_required' using errcode = '22023';
    end if;
    if not exists (select 1 from public.vendors where id = v_vendor and dsp_id = v_dsp) then
      raise exception 'vendor_not_found' using errcode = 'P0002';
    end if;
    update public.repair_quotes
       set vendor_id = v_vendor, status = 'submitted', submitted_at = now(),
           reviewed_by = auth.uid(), reviewed_at = now()
     where id = v_quote.id;
    perform private.repair_case_event(
      v_dsp, v_case.id, 'quote_received',
      'Extracted quote accepted after review',
      null, null, 'dsp', false, false,
      jsonb_build_object('quote_id', v_quote.id, 'vendor_id', v_vendor));
    perform private._repair_stage_apply(
      v_dsp, v_case.id, v_case.stage,
      case when v_case.stage = 'quoting' then 'quotes_in' else v_case.stage end,
      'Quotes received');

  elsif p_action = 'discard' then
    delete from public.repair_quotes where id = v_quote.id;  -- lines cascade
    perform private.repair_case_event(
      v_dsp, v_case.id, 'quote_discarded',
      'Extracted quote discarded after review',
      null, null, 'dsp', false, false,
      jsonb_build_object('attachment_id', v_quote.extracted_from_attachment_id));

  else
    raise exception 'bad_action' using errcode = '22023';
  end if;

  return public.repair_case_quotes(v_case.id);
end;
$$;
grant execute on function public.repair_quote_review(uuid, text, uuid) to authenticated;


-- ═══════════════════════════ 8. repair_case_quotes (replaced) ═══════
-- Extracted drafts (extracted_at set) now ride along so the drawer can
-- show the needs-review cards; ordinary shop drafts stay hidden.
create or replace function public.repair_case_quotes(p_case_id uuid)
returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  select jsonb_build_object(
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'vendor_id', r.vendor_id, 'vendor_name', vn.name,
        'request_status', r.request_status, 'respond_by', r.respond_by,
        'sent_at', r.sent_at, 'opened_at', r.opened_at,
        'submitted_at', r.submitted_at, 'declined_at', r.declined_at,
        'decline_reason', r.decline_reason,
        'reminder_count', r.reminder_count,
        'link_expires_at', l.expires_at, 'link_revoked', l.revoked_at is not null)
        order by r.created_at desc)
      from public.repair_quote_requests r
      left join public.vendors vn on vn.id = r.vendor_id
      left join public.secure_external_links l on l.id = r.secure_link_id
      where r.repair_case_id = p_case_id), '[]'::jsonb),
    'quotes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id, 'vendor_id', q.vendor_id, 'vendor_name', vn.name,
        'quote_request_id', q.quote_request_id,
        'source', q.source, 'status', q.status, 'version', q.version,
        'quote_number', q.quote_number,
        'shop_work_order_number', q.shop_work_order_number,
        'grand_total_cents', q.grand_total_cents,
        'shop_reported_total_cents', q.shop_reported_total_cents,
        'totals_mismatch', q.totals_mismatch,
        'labor_total_cents', q.labor_total_cents,
        'parts_total_cents', q.parts_total_cents,
        'tax_total_cents', q.tax_total_cents,
        'earliest_appointment_at', q.earliest_appointment_at,
        'estimated_completion_at', q.estimated_completion_at,
        'expires_at', q.expires_at,
        'warranty_summary', q.warranty_summary,
        'parts_availability', q.parts_availability,
        'notes', q.notes,
        'contact_name', q.contact_name, 'contact_phone', q.contact_phone,
        'submitted_at', q.submitted_at, 'created_at', q.created_at)
      || jsonb_build_object(
        'extracted_at', q.extracted_at,
        'extraction_confidence', q.extraction_confidence,
        'extraction_model', q.extraction_model,
        'extracted_from_attachment_id', q.extracted_from_attachment_id,
        'reviewed_at', q.reviewed_at,
        'line_items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', li.id, 'line_number', li.line_number,
            'category', li.category, 'description', li.description,
            'part_number', li.part_number, 'part_brand', li.part_brand,
            'part_condition', li.part_condition,
            'quantity', li.quantity, 'unit_price_cents', li.unit_price_cents,
            'parts_total_cents', li.parts_total_cents,
            'labor_hours', li.labor_hours, 'labor_rate_cents', li.labor_rate_cents,
            'labor_total_cents', li.labor_total_cents,
            'fees_cents', li.fees_cents, 'tax_cents', li.tax_cents,
            'line_total_cents', li.line_total_cents,
            'required', li.required, 'recommended', li.recommended,
            'approval_status', li.approval_status, 'notes', li.notes)
            order by li.line_number)
          from public.repair_quote_line_items li
          where li.quote_id = q.id), '[]'::jsonb))
        order by q.created_at desc)
      from public.repair_quotes q
      left join public.vendors vn on vn.id = q.vendor_id
      where q.repair_case_id = p_case_id
        and (q.status <> 'draft' or q.extracted_at is not null)), '[]'::jsonb),
    'authorizations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'authorization_type', a.authorization_type,
        'status', a.status, 'version', a.version,
        'quote_id', a.quote_id, 'vendor_id', a.vendor_id,
        'vendor_name', vn.name,
        'authorized_total_cents', a.authorized_total_cents,
        'nte_cap_cents', a.nte_cap_cents,
        'po_number', a.po_number, 'notes', a.notes,
        'authorized_at', a.authorized_at,
        'acknowledged_at', a.acknowledged_at,
        'acknowledged_by', a.acknowledged_by,
        'superseded_at', a.superseded_at,
        'revoked_at', a.revoked_at, 'revoke_reason', a.revoke_reason,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'line_number', al.line_number, 'category', al.category,
            'description', al.description,
            'line_total_cents', al.line_total_cents,
            'decision', al.decision)
            order by al.line_number)
          from public.repair_authorization_lines al
          where al.authorization_id = a.id), '[]'::jsonb))
        order by a.version desc)
      from public.repair_authorizations a
      left join public.vendors vn on vn.id = a.vendor_id
      where a.repair_case_id = p_case_id), '[]'::jsonb)
  )
  from public.repair_cases rc
  where rc.id = p_case_id
    and rc.dsp_id = private.current_dsp_id()
    and private.is_staff(rc.dsp_id, 'dispatcher');
$$;
grant execute on function public.repair_case_quotes(uuid) to authenticated;


notify pgrst, 'reload schema';
