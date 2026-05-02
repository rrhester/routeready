-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510260000 · Phase 7 RPCs + audit
-- import_invoice, file_dispute, resolve_dispute, mark_invoice_reviewed.
-- Trigger that rolls dispute amounts up to invoices.amount_disputed/
-- recovered.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── import_invoice + line items in one call ──────────────────────────

create or replace function public.import_invoice(
  p_source            text,
  p_period_start      date,
  p_period_end        date,
  p_invoice_number    text,
  p_amount_billed     int,
  p_attached_file     text   default null,
  p_raw_data          jsonb  default null,
  p_line_items        jsonb  default '[]'::jsonb,
  p_vendor_name       text   default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_caller  uuid := auth.uid();
  v_id      uuid;
  rec       jsonb;
  i         int := 0;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'import_invoice: ops only';
  end if;

  insert into public.invoices
    (dsp_id, source, vendor_name, period_start, period_end, invoice_number,
     amount_billed_cents, attached_file, raw_data, imported_by)
  values
    (v_dsp, p_source::public.invoice_source, p_vendor_name,
     p_period_start, p_period_end, p_invoice_number,
     p_amount_billed, p_attached_file, p_raw_data, v_caller)
  returning id into v_id;

  -- Insert line items if provided
  if jsonb_typeof(p_line_items) = 'array' then
    for rec in select * from jsonb_array_elements(p_line_items)
    loop
      i := i + 1;
      insert into public.invoice_line_items
        (dsp_id, invoice_id, line_number, description, category,
         amount_cents, quantity, rule_check, flagged)
      values
        (v_dsp, v_id, coalesce((rec->>'line_number')::int, i),
         coalesce(rec->>'description', '(no description)'),
         nullif(rec->>'category', ''),
         coalesce((rec->>'amount_cents')::int, 0),
         nullif(rec->>'quantity', '')::numeric,
         rec - 'line_number' - 'description' - 'category' - 'amount_cents' - 'quantity',
         coalesce((rec->>'flagged')::boolean, false));
    end loop;
  end if;

  return v_id;
end $$;

revoke execute on function public.import_invoice(text, date, date, text, int, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.import_invoice(text, date, date, text, int, text, jsonb, jsonb, text) to authenticated;

-- ─── flag_invoice_line: mark a line worth disputing ────────────────────

create or replace function public.flag_invoice_line(
  p_line_id   uuid,
  p_flagged   boolean default true,
  p_rule_check jsonb  default null
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'flag_invoice_line: ops only';
  end if;

  update public.invoice_line_items
     set flagged    = p_flagged,
         rule_check = coalesce(p_rule_check, rule_check)
   where id = p_line_id and dsp_id = v_dsp;

  if not found then
    raise exception 'flag_invoice_line: line % not in DSP %', p_line_id, v_dsp;
  end if;
end $$;

revoke execute on function public.flag_invoice_line(uuid, boolean, jsonb) from public, anon;
grant execute on function public.flag_invoice_line(uuid, boolean, jsonb) to authenticated;

-- ─── file_dispute: create dispute row ─────────────────────────────────

create or replace function public.file_dispute(
  p_invoice_id     uuid,
  p_line_item_id   uuid,
  p_amount_cents   int,
  p_drafted_letter text   default null,
  p_evidence_refs  jsonb  default null,
  p_attached_files text[] default null,
  p_submission_method text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_caller  uuid := auth.uid();
  v_id      uuid;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'file_dispute: ops only';
  end if;
  if p_amount_cents <= 0 then
    raise exception 'file_dispute: amount must be positive';
  end if;

  if p_invoice_id is not null then
    perform 1 from public.invoices where id = p_invoice_id and dsp_id = v_dsp;
    if not found then
      raise exception 'file_dispute: invoice % not in DSP %', p_invoice_id, v_dsp;
    end if;
  end if;

  insert into public.disputes
    (dsp_id, invoice_id, line_item_id, amount_cents,
     drafted_letter, evidence_refs, attached_files, submission_method, created_by)
  values
    (v_dsp, p_invoice_id, p_line_item_id, p_amount_cents,
     p_drafted_letter, p_evidence_refs, p_attached_files,
     coalesce(p_submission_method, 'amazon_portal'), v_caller)
  returning id into v_id;

  -- Mark line item as disputed
  if p_line_item_id is not null then
    update public.invoice_line_items
       set disputed = true
     where id = p_line_item_id and dsp_id = v_dsp;
  end if;

  return v_id;
end $$;

revoke execute on function public.file_dispute(uuid, uuid, int, text, jsonb, text[], text) from public, anon;
grant execute on function public.file_dispute(uuid, uuid, int, text, jsonb, text[], text) to authenticated;

-- ─── resolve_dispute ──────────────────────────────────────────────────

create or replace function public.resolve_dispute(
  p_dispute_id      uuid,
  p_resolution      text,
  p_recovered_cents int    default 0,
  p_notes           text   default null
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'resolve_dispute: ops only';
  end if;

  update public.disputes
     set resolution      = p_resolution::public.dispute_resolution,
         recovered_cents = p_recovered_cents,
         resolved_at     = now(),
         notes           = coalesce(p_notes, notes)
   where id = p_dispute_id and dsp_id = v_dsp;

  if not found then
    raise exception 'resolve_dispute: dispute % not in DSP %', p_dispute_id, v_dsp;
  end if;
end $$;

revoke execute on function public.resolve_dispute(uuid, text, int, text) from public, anon;
grant execute on function public.resolve_dispute(uuid, text, int, text) to authenticated;

-- ─── submit_dispute (mark submitted_at) ───────────────────────────────

create or replace function public.submit_dispute(
  p_dispute_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'submit_dispute: ops only';
  end if;

  update public.disputes
     set submitted_at = coalesce(submitted_at, now())
   where id = p_dispute_id and dsp_id = v_dsp;

  if not found then
    raise exception 'submit_dispute: dispute % not in DSP %', p_dispute_id, v_dsp;
  end if;
end $$;

revoke execute on function public.submit_dispute(uuid) from public, anon;
grant execute on function public.submit_dispute(uuid) to authenticated;

-- ─── Roll-up trigger: dispute amounts → invoice ───────────────────────

create or replace function private.fn_rollup_invoice_disputes()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_invoice_id uuid;
  v_disputed   int;
  v_recovered  int;
begin
  v_invoice_id := coalesce(new.invoice_id, old.invoice_id);
  if v_invoice_id is null then
    return coalesce(new, old);
  end if;

  select coalesce(sum(amount_cents), 0),
         coalesce(sum(case when resolution in ('won','partial') then recovered_cents else 0 end), 0)
    into v_disputed, v_recovered
    from public.disputes
   where invoice_id = v_invoice_id;

  update public.invoices
     set amount_disputed_cents  = v_disputed,
         amount_recovered_cents = v_recovered,
         status = case
           when v_recovered > 0 and not exists (
             select 1 from public.disputes
              where invoice_id = v_invoice_id and resolution = 'pending'
           ) then 'closed'::public.invoice_status
           when v_disputed > 0 then 'disputed'::public.invoice_status
           else status
         end
   where id = v_invoice_id;

  return coalesce(new, old);
end $$;

create trigger trg_disputes_rollup
  after insert or update or delete on public.disputes
  for each row execute function private.fn_rollup_invoice_disputes();

-- ─── Audit triggers ───────────────────────────────────────────────────

create trigger trg_audit_invoices
  after insert or update or delete on public.invoices
  for each row execute function private.fn_audit_log();

create trigger trg_audit_invoice_line_items
  after insert or update or delete on public.invoice_line_items
  for each row execute function private.fn_audit_log();

create trigger trg_audit_disputes
  after insert or update or delete on public.disputes
  for each row execute function private.fn_audit_log();

create trigger trg_audit_reconciliation_rules
  after insert or update or delete on public.reconciliation_rules
  for each row execute function private.fn_audit_log();
