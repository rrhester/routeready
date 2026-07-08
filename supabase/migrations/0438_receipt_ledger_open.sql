-- 0438_receipt_ledger_open.sql
--
-- Lets a dispatcher open the Receipt Ledger from the workbook template library
-- without waiting for the first receipt. Wraps the same private provisioning
-- function receipts use (0436), so the template button and the receipt-driven
-- path converge on ONE durable ledger per DSP (enforced by the partial unique
-- index uq_workbooks_receipt_ledger). Idempotent: returns the existing ledger
-- if it already exists.

create or replace function public.receipt_ledger_ensure()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_wb    uuid;
  v_sheet uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select workbook_id, sheet_id into v_wb, v_sheet
    from private.ensure_receipt_ledger(v_dsp);
  return jsonb_build_object('workbook_id', v_wb, 'sheet_id', v_sheet);
end;
$$;
grant execute on function public.receipt_ledger_ensure() to authenticated;

notify pgrst, 'reload schema';
