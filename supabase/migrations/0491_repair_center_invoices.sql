-- Migration 0491 · Repair Center — Phase 8: invoice reconciliation.
--
-- The final money step: the shop's invoice, diffed against what was
-- actually AUTHORIZED, with variance surfaced — never absorbed.
--
--   · repair_invoices + repair_invoice_line_items mirror the quote
--     tables (integer cents, server-recomputed totals, totals_mismatch
--     flagged never corrected). Lifecycle: draft (extracted,
--     unreviewed) → recorded (a human confirmed the numbers) →
--     settled (variance reviewed & accepted; the case rollup updates)
--     or disputed (sent back to the shop). A corrected invoice
--     supersedes the previous one — history is never rewritten.
--   · VARIANCE IS NEVER AUTO-APPROVED: settling an invoice that
--     exceeds the authorized amount (or has lines outside the
--     authorized scope) requires an explicit reason note, which lands
--     on the timeline and in the compliance audit log. The tolerance
--     is ZERO by design — policy looseness belongs to the human, not
--     the system.
--   · Extraction rides the existing Phase-7 pipeline: the
--     repair-quote-extract edge function already classifies invoices;
--     repair_quote_extract_save (replaced here) now materializes them
--     as DRAFT invoices under the same reviewed-never-overwritten
--     rules as estimates.
--   · The line-by-line diff against the authorization snapshot is
--     display math in repair-engine.js (buildReconciliation), reading
--     server-stored cents — the same division of labor as quote
--     comparison.
--
-- New tables: repair_invoices, repair_invoice_line_items
-- New RPCs:   staff — repair_invoice_review (record / discard),
--                     repair_invoice_settle (accept / dispute),
--                     repair_invoice_manual_add, repair_case_invoices
-- Replaced:   repair_quote_extract_save (invoice kind → draft invoice)
--
-- Idempotent: safe to re-run in the SQL Editor.

-- ═══════════════════════════ 1. repair_invoices ═════════════════════

create table if not exists public.repair_invoices (
  id               uuid primary key default gen_random_uuid(),
  dsp_id           uuid not null references public.dsps(id) on delete cascade,
  repair_case_id   uuid not null references public.repair_cases(id) on delete cascade,
  vendor_id        uuid references public.vendors(id) on delete set null,
  authorization_id uuid references public.repair_authorizations(id) on delete set null,
  quote_id         uuid references public.repair_quotes(id) on delete set null,

  source           text not null default 'manual',
  status           text not null default 'draft',
  supersedes_id    uuid references public.repair_invoices(id) on delete set null,

  invoice_number   text,
  shop_work_order_number text,

  -- Integer cents; grand total recomputed from lines server-side.
  shop_reported_total_cents int,
  grand_total_cents int,
  tax_total_cents   int,
  totals_mismatch   boolean not null default false,

  invoice_date     timestamptz,
  due_at           timestamptz,
  notes            text,

  -- Machine vs reviewer columns stay separate (the DVIC pattern).
  extracted_from_attachment_id uuid references public.repair_case_attachments(id) on delete set null,
  extracted_at          timestamptz,
  extraction_confidence numeric(4,3),
  extraction_model      text,
  reviewed_by  uuid references auth.users(id) on delete set null,
  reviewed_at  timestamptz,

  -- Settlement / dispute trail
  settled_by   uuid references auth.users(id) on delete set null,
  settled_at   timestamptz,
  variance_note text,
  disputed_at  timestamptz,
  dispute_note text,
  superseded_at timestamptz,

  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

do $$ begin
  alter table public.repair_invoices
    add constraint repair_invoices_source_chk check (source in
      ('pdf_upload','image_upload','email_attachment','manual','phone'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.repair_invoices
    add constraint repair_invoices_status_chk check (status in
      ('draft','recorded','disputed','settled','superseded'));
exception when duplicate_object then null; end $$;

create index if not exists repair_invoices_case_idx
  on public.repair_invoices (repair_case_id, created_at desc);
create index if not exists repair_invoices_dsp_open_idx
  on public.repair_invoices (dsp_id)
  where status in ('draft','recorded','disputed');

alter table public.repair_invoices enable row level security;
drop policy if exists "repair_invoices_tenant_select" on public.repair_invoices;
create policy "repair_invoices_tenant_select"
  on public.repair_invoices for select to authenticated
  using (dsp_id = private.current_dsp_id());
-- Writes only through the SECURITY DEFINER RPCs below.
grant select on public.repair_invoices to authenticated;


-- ═══════════════════════════ 2. repair_invoice_line_items ═══════════

create table if not exists public.repair_invoice_line_items (
  id               uuid primary key default gen_random_uuid(),
  dsp_id           uuid not null references public.dsps(id) on delete cascade,
  invoice_id       uuid not null references public.repair_invoices(id) on delete cascade,
  line_number      int not null default 1,
  category         text not null default 'labor',
  description      text not null,
  part_number      text,
  quantity         numeric(10,2),
  unit_price_cents int,
  parts_total_cents int,
  labor_hours      numeric(6,2),
  labor_rate_cents int,
  labor_total_cents int,
  fees_cents       int,
  tax_cents        int,
  line_total_cents int,
  created_at       timestamptz not null default now()
);

do $$ begin
  alter table public.repair_invoice_line_items
    add constraint repair_invoice_line_items_category_chk check (category in
      ('diagnostic','labor','part_oem','part_aftermarket','part_used',
       'part_reman','sublet','towing','supplies','environmental',
       'tax','discount','misc'));
exception when duplicate_object then null; end $$;

create index if not exists repair_invoice_line_items_invoice_idx
  on public.repair_invoice_line_items (invoice_id, line_number);

alter table public.repair_invoice_line_items enable row level security;
drop policy if exists "repair_invoice_line_items_tenant_select" on public.repair_invoice_line_items;
create policy "repair_invoice_line_items_tenant_select"
  on public.repair_invoice_line_items for select to authenticated
  using (dsp_id = private.current_dsp_id());
grant select on public.repair_invoice_line_items to authenticated;


-- ═══════════════════════════ 3. Helpers ═════════════════════════════

-- Deterministic totals from lines (single money path; twin of
-- private.repair_quote_recompute).
create or replace function private.repair_invoice_recompute(p_invoice_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  update public.repair_invoices i set
    tax_total_cents   = t.tax,
    grand_total_cents = t.grand,
    totals_mismatch = (i.shop_reported_total_cents is not null
                       and abs(i.shop_reported_total_cents - t.grand) > 100),
    updated_at = now()
  from (
    select
      coalesce(sum(tax_cents), 0)::int
        + coalesce(sum(line_total_cents) filter (where category = 'tax'), 0)::int as tax,
      coalesce(sum(line_total_cents), 0)::int as grand
    from public.repair_invoice_line_items
    where invoice_id = p_invoice_id
  ) t
  where i.id = p_invoice_id;
end;
$$;

-- The case's current authorization (issued/acknowledged), if any.
create or replace function private._repair_current_authorization(p_case_id uuid)
returns public.repair_authorizations
language sql
stable
as $$
  select * from public.repair_authorizations
  where repair_case_id = p_case_id and status in ('issued','acknowledged')
  order by version desc limit 1;
$$;

-- Internal: create a DRAFT invoice from extraction payload (called by
-- repair_quote_extract_save below). Same fail-closed coercion and
-- reviewed-never-overwritten rules as estimates.
create or replace function private.repair_invoice_from_extraction(
  p_att public.repair_case_attachments,
  p_payload jsonb,
  p_model text,
  p_conf numeric
) returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_case public.repair_cases;
  v_auth public.repair_authorizations;
  v_inv public.repair_invoices;
  v_reviewed uuid;
  v_item jsonb;
  v_n int := 0;
begin
  select * into v_case from public.repair_cases where id = p_att.repair_case_id;

  -- never touch a reviewed invoice
  select id into v_reviewed from public.repair_invoices
   where extracted_from_attachment_id = p_att.id and status <> 'draft'
   limit 1;
  if v_reviewed is not null then
    return null;
  end if;

  delete from public.repair_invoices
   where extracted_from_attachment_id = p_att.id and status = 'draft';

  v_auth := private._repair_current_authorization(p_att.repair_case_id);

  insert into public.repair_invoices
    (dsp_id, repair_case_id, vendor_id, authorization_id, quote_id, source, status,
     invoice_number, shop_work_order_number,
     shop_reported_total_cents, invoice_date, due_at, notes,
     extracted_from_attachment_id, extracted_at, extraction_confidence, extraction_model)
  values
    (p_att.dsp_id, p_att.repair_case_id, v_case.vendor_id, v_auth.id, v_auth.quote_id,
     case when p_att.source = 'email' then 'email_attachment'
          when coalesce(p_att.mime_type,'') like 'image/%' then 'image_upload'
          else 'pdf_upload' end,
     'draft',
     left(nullif(btrim(coalesce(p_payload->>'quote_number','')),''), 60),
     left(nullif(btrim(coalesce(p_payload->>'shop_work_order_number','')),''), 80),
     private._rc_cents(p_payload->'shop_reported_total_cents'),
     private._rc_safe_ts(p_payload->>'estimated_completion_at'),
     private._rc_safe_ts(p_payload->>'expires_at'),
     left(nullif(btrim(coalesce(p_payload->>'notes','')),''), 1000),
     p_att.id, now(), p_conf, p_model)
  returning * into v_inv;

  for v_item in
    select * from jsonb_array_elements(coalesce(p_payload->'line_items', '[]'::jsonb))
  loop
    v_n := v_n + 1;
    exit when v_n > 60;
    insert into public.repair_invoice_line_items
      (dsp_id, invoice_id, line_number, category, description,
       part_number, quantity, unit_price_cents, parts_total_cents,
       labor_hours, labor_rate_cents, labor_total_cents,
       fees_cents, tax_cents, line_total_cents)
    values
      (p_att.dsp_id, v_inv.id, v_n,
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

  perform private.repair_invoice_recompute(v_inv.id);

  perform private.repair_case_event(
    p_att.dsp_id, p_att.repair_case_id, 'invoice_extracted',
    'Invoice extracted from ' || left(p_att.file_name, 120) || ' — review before reconciling',
    null, null, 'system', false, true,
    jsonb_build_object('invoice_id', v_inv.id, 'attachment_id', p_att.id,
                       'confidence', p_conf));
  return v_inv.id;
end;
$$;


-- ═══════════════════════════ 4. repair_quote_extract_save (replaced) ═
-- Identical to 0490's version except the invoice branch: instead of
-- journal-only, it now materializes a DRAFT invoice via
-- private.repair_invoice_from_extraction.
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
  v_invoice_id uuid;
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

  if v_kind = 'invoice' then
    v_invoice_id := private.repair_invoice_from_extraction(v_att, p_payload, p_model, v_conf);
    return jsonb_build_object('ok', true, 'extraction_id', v_ext_id,
                              'kind', v_kind, 'quote_id', null,
                              'invoice_id', v_invoice_id,
                              'reason', case when v_invoice_id is null
                                             then 'already_reviewed' end);
  end if;

  if v_kind <> 'estimate' then
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
    exit when v_n > 60;
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
-- (service-role-only grants from 0490 persist across create-or-replace)


-- ═══════════════════════════ 5. repair_invoice_review ═══════════════
-- Human decision on an extracted draft invoice: record (the numbers
-- are real) or discard. Recording supersedes any previously recorded/
-- disputed invoice on the case — a corrected invoice replaces its
-- predecessor without rewriting history. Settled invoices are final.
create or replace function public.repair_invoice_review(
  p_invoice_id uuid,
  p_action     text,
  p_vendor_id  uuid default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_inv public.repair_invoices;
  v_vendor uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_inv from public.repair_invoices
   where id = p_invoice_id and dsp_id = v_dsp;
  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  if v_inv.status <> 'draft' then
    raise exception 'not_reviewable' using errcode = '22023';
  end if;

  if p_action = 'record' then
    v_vendor := coalesce(p_vendor_id, v_inv.vendor_id);
    if v_vendor is null then
      raise exception 'vendor_required' using errcode = '22023';
    end if;
    if not exists (select 1 from public.vendors where id = v_vendor and dsp_id = v_dsp) then
      raise exception 'vendor_not_found' using errcode = 'P0002';
    end if;
    -- a newer invoice supersedes the previous unsettled one
    update public.repair_invoices
       set status = 'superseded', superseded_at = now(), updated_at = now()
     where repair_case_id = v_inv.repair_case_id
       and status in ('recorded','disputed') and id <> v_inv.id;
    update public.repair_invoices
       set vendor_id = v_vendor, status = 'recorded',
           supersedes_id = coalesce(supersedes_id, (
             select id from public.repair_invoices
              where repair_case_id = v_inv.repair_case_id
                and status = 'superseded' and id <> v_inv.id
              order by superseded_at desc limit 1)),
           reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
     where id = v_inv.id;
    perform private.repair_case_event(
      v_dsp, v_inv.repair_case_id, 'invoice_recorded',
      'Invoice recorded after review'
        || case when v_inv.grand_total_cents is null then ''
           else ' · $' || to_char(v_inv.grand_total_cents::numeric / 100, 'FM999,999,990.00') end,
      null, null, 'dsp', false, false,
      jsonb_build_object('invoice_id', v_inv.id));

  elsif p_action = 'discard' then
    delete from public.repair_invoices where id = v_inv.id;  -- lines cascade
    perform private.repair_case_event(
      v_dsp, v_inv.repair_case_id, 'invoice_discarded',
      'Extracted invoice discarded after review',
      null, null, 'dsp', false, false,
      jsonb_build_object('attachment_id', v_inv.extracted_from_attachment_id));

  else
    raise exception 'bad_action' using errcode = '22023';
  end if;

  return public.repair_case_invoices(v_inv.repair_case_id);
end;
$$;


-- ═══════════════════════════ 6. repair_invoice_settle ═══════════════
-- The reconciliation decision. Variance is computed HERE from stored
-- cents (invoice grand vs the linked authorization's total/cap) and is
-- NEVER auto-approved: any positive variance requires an explicit
-- reason note that lands on the timeline + the audit log.
create or replace function public.repair_invoice_settle(
  p_invoice_id uuid,
  p_action     text,
  p_note       text default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_inv public.repair_invoices;
  v_auth public.repair_authorizations;
  v_authorized int;
  v_variance int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_inv from public.repair_invoices
   where id = p_invoice_id and dsp_id = v_dsp;
  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  if v_inv.status not in ('recorded','disputed') then
    raise exception 'not_settleable' using errcode = '22023';
  end if;

  -- Reconcile against the invoice's pinned authorization, falling back
  -- to the case's current one.
  if v_inv.authorization_id is not null then
    select * into v_auth from public.repair_authorizations where id = v_inv.authorization_id;
  end if;
  if v_auth.id is null then
    v_auth := private._repair_current_authorization(v_inv.repair_case_id);
  end if;
  v_authorized := coalesce(v_auth.nte_cap_cents, v_auth.authorized_total_cents);
  v_variance := case when v_authorized is null or v_inv.grand_total_cents is null then null
                     else v_inv.grand_total_cents - v_authorized end;

  if p_action = 'accept' then
    if v_variance is not null and v_variance > 0
       and coalesce(btrim(p_note), '') = '' then
      raise exception 'variance_note_required' using errcode = '22023';
    end if;
    update public.repair_invoices
       set status = 'settled', settled_by = auth.uid(), settled_at = now(),
           authorization_id = coalesce(authorization_id, v_auth.id),
           variance_note = left(nullif(btrim(coalesce(p_note,'')),''), 500),
           updated_at = now()
     where id = v_inv.id;
    -- the case rollup mirrors the SETTLED invoice
    update public.repair_cases
       set invoice_total_cents = v_inv.grand_total_cents, updated_at = now()
     where id = v_inv.repair_case_id;
    perform private.repair_case_event(
      v_dsp, v_inv.repair_case_id, 'invoice_settled',
      'Invoice settled'
        || case when v_inv.grand_total_cents is null then ''
           else ' · $' || to_char(v_inv.grand_total_cents::numeric / 100, 'FM999,999,990.00') end
        || case when v_variance is null or v_variance <= 0 then ''
           else ' — $' || to_char(v_variance::numeric / 100, 'FM999,999,990.00')
             || ' over authorization: ' || left(btrim(p_note), 200) end,
      null, null, 'dsp', false, false,
      jsonb_build_object('invoice_id', v_inv.id,
                         'authorization_id', v_auth.id,
                         'variance_cents', v_variance));
    if v_variance is not null and v_variance > 0 then
      insert into public.compliance_audit_events
        (dsp_id, actor_type, actor_id, kind, summary, object_type, object_id)
      values
        (v_dsp, 'user', auth.uid(), 'repair_invoice_variance_accepted',
         'Invoice over authorization by $'
           || to_char(v_variance::numeric / 100, 'FM999,999,990.00')
           || ' — ' || left(btrim(p_note), 200),
         'repair_case', v_inv.repair_case_id);
    end if;

  elsif p_action = 'dispute' then
    if coalesce(btrim(p_note), '') = '' then
      raise exception 'note_required' using errcode = '22023';
    end if;
    update public.repair_invoices
       set status = 'disputed', disputed_at = now(),
           dispute_note = left(btrim(p_note), 500), updated_at = now()
     where id = v_inv.id;
    perform private.repair_case_event(
      v_dsp, v_inv.repair_case_id, 'invoice_disputed',
      'Invoice disputed — ' || left(btrim(p_note), 200),
      null, null, 'dsp', false, false,
      jsonb_build_object('invoice_id', v_inv.id, 'variance_cents', v_variance));

  else
    raise exception 'bad_action' using errcode = '22023';
  end if;

  return public.repair_case_invoices(v_inv.repair_case_id);
end;
$$;


-- ═══════════════════════════ 7. repair_invoice_manual_add ═══════════
-- Paper/phone invoices typed in by staff (twin of
-- repair_quote_manual_add). Enters directly as 'recorded' — a human IS
-- the source; settlement still runs the variance gate.
create or replace function public.repair_invoice_manual_add(
  p_case_id   uuid,
  p_vendor_id uuid,
  p_grand_total_cents int default null,
  p_line_items jsonb default '[]'::jsonb,
  p_details   jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_case public.repair_cases;
  v_auth public.repair_authorizations;
  v_inv public.repair_invoices;
  v_item jsonb;
  v_n int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_case from public.repair_cases
   where id = p_case_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.vendors where id = p_vendor_id and dsp_id = v_dsp) then
    raise exception 'vendor_not_found' using errcode = 'P0002';
  end if;
  if p_grand_total_cents is not null
     and (p_grand_total_cents < 0 or p_grand_total_cents > 100000000) then
    raise exception 'bad_amount' using errcode = '22023';
  end if;

  v_auth := private._repair_current_authorization(p_case_id);

  -- a newer invoice supersedes the previous unsettled one
  update public.repair_invoices
     set status = 'superseded', superseded_at = now(), updated_at = now()
   where repair_case_id = p_case_id and status in ('recorded','disputed');

  insert into public.repair_invoices
    (dsp_id, repair_case_id, vendor_id, authorization_id, quote_id,
     source, status, invoice_number, shop_work_order_number,
     shop_reported_total_cents, grand_total_cents,
     invoice_date, notes, reviewed_by, reviewed_at, created_by)
  values
    (v_dsp, p_case_id, p_vendor_id, v_auth.id, v_auth.quote_id,
     'manual', 'recorded',
     left(nullif(btrim(coalesce(p_details->>'invoice_number','')),''), 60),
     left(nullif(btrim(coalesce(p_details->>'shop_work_order_number','')),''), 80),
     p_grand_total_cents, p_grand_total_cents,
     private._rc_safe_ts(p_details->>'invoice_date'),
     left(nullif(btrim(coalesce(p_details->>'notes','')),''), 1000),
     auth.uid(), now(), auth.uid())
  returning * into v_inv;

  for v_item in select * from jsonb_array_elements(coalesce(p_line_items, '[]'::jsonb)) loop
    v_n := v_n + 1;
    exit when v_n > 60;
    insert into public.repair_invoice_line_items
      (dsp_id, invoice_id, line_number, category, description,
       part_number, quantity, unit_price_cents, parts_total_cents,
       labor_hours, labor_rate_cents, labor_total_cents,
       fees_cents, tax_cents, line_total_cents)
    values
      (v_dsp, v_inv.id, v_n,
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

  if v_n > 0 then
    perform private.repair_invoice_recompute(v_inv.id);
  end if;

  perform private.repair_case_event(
    v_dsp, p_case_id, 'invoice_recorded',
    'Invoice recorded (manual entry)'
      || case when coalesce((select grand_total_cents from public.repair_invoices where id = v_inv.id),
                            p_grand_total_cents) is null then ''
         else ' · $' || to_char(coalesce((select grand_total_cents from public.repair_invoices where id = v_inv.id),
                                          p_grand_total_cents)::numeric / 100, 'FM999,999,990.00') end,
    null, null, 'dsp', false, false,
    jsonb_build_object('invoice_id', v_inv.id, 'vendor_id', p_vendor_id));

  return public.repair_case_invoices(p_case_id);
end;
$$;


-- ═══════════════════════════ 8. repair_case_invoices ════════════════
-- Invoices + lines + the reconciliation context (the authorization
-- snapshot each invoice reconciles against) in one call. The
-- line-by-line diff itself is display math in repair-engine.js.
create or replace function public.repair_case_invoices(p_case_id uuid)
returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  select jsonb_build_object(
    'invoices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'vendor_id', i.vendor_id, 'vendor_name', vn.name,
        'authorization_id', i.authorization_id,
        'source', i.source, 'status', i.status,
        'invoice_number', i.invoice_number,
        'shop_work_order_number', i.shop_work_order_number,
        'grand_total_cents', i.grand_total_cents,
        'shop_reported_total_cents', i.shop_reported_total_cents,
        'tax_total_cents', i.tax_total_cents,
        'totals_mismatch', i.totals_mismatch,
        'invoice_date', i.invoice_date, 'due_at', i.due_at,
        'notes', i.notes,
        'extracted_at', i.extracted_at,
        'extraction_confidence', i.extraction_confidence,
        'extracted_from_attachment_id', i.extracted_from_attachment_id,
        'reviewed_at', i.reviewed_at,
        'settled_at', i.settled_at, 'variance_note', i.variance_note,
        'disputed_at', i.disputed_at, 'dispute_note', i.dispute_note,
        'created_at', i.created_at)
      || jsonb_build_object(
        'line_items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', li.id, 'line_number', li.line_number,
            'category', li.category, 'description', li.description,
            'part_number', li.part_number, 'quantity', li.quantity,
            'unit_price_cents', li.unit_price_cents,
            'parts_total_cents', li.parts_total_cents,
            'labor_hours', li.labor_hours, 'labor_rate_cents', li.labor_rate_cents,
            'labor_total_cents', li.labor_total_cents,
            'fees_cents', li.fees_cents, 'tax_cents', li.tax_cents,
            'line_total_cents', li.line_total_cents)
            order by li.line_number)
          from public.repair_invoice_line_items li
          where li.invoice_id = i.id), '[]'::jsonb))
        order by i.created_at desc)
      from public.repair_invoices i
      left join public.vendors vn on vn.id = i.vendor_id
      where i.repair_case_id = p_case_id), '[]'::jsonb),
    'authorization', (
      select case when a.id is null then null else jsonb_build_object(
        'id', a.id, 'authorization_type', a.authorization_type,
        'status', a.status, 'version', a.version,
        'authorized_total_cents', a.authorized_total_cents,
        'nte_cap_cents', a.nte_cap_cents, 'po_number', a.po_number,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'line_number', al.line_number, 'category', al.category,
            'description', al.description,
            'line_total_cents', al.line_total_cents,
            'decision', al.decision)
            order by al.line_number)
          from public.repair_authorization_lines al
          where al.authorization_id = a.id), '[]'::jsonb)) end
      from (select (private._repair_current_authorization(p_case_id)).*) a)
  )
  from public.repair_cases rc
  where rc.id = p_case_id
    and rc.dsp_id = private.current_dsp_id()
    and private.is_staff(rc.dsp_id, 'dispatcher');
$$;

grant execute on function public.repair_invoice_review(uuid, text, uuid) to authenticated;
grant execute on function public.repair_invoice_settle(uuid, text, text) to authenticated;
grant execute on function public.repair_invoice_manual_add(uuid, uuid, int, jsonb, jsonb) to authenticated;
grant execute on function public.repair_case_invoices(uuid) to authenticated;


notify pgrst, 'reload schema';
