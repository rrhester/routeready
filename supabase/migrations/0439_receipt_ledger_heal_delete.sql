-- 0439_receipt_ledger_heal_delete.sql
--
-- Two fixes for the Receipt Ledger:
--
--  1. Status dropdown self-heal. ensure_receipt_ledger() now (re)applies the
--     Status data-validation rule to the sheet every time it runs — not just
--     at creation — so a ledger that was created before the meta existed (or
--     via the client fallback build) gets its dropdown the next time it's
--     opened from the template card. Also stamps the rule with an id to match
--     the shape the workbook UI writes.
--
--  2. Delete an entry. receipt_delete_at(sheet, row) removes the receipt the
--     given ledger row maps to; a BEFORE DELETE trigger clears that row's
--     cells in place (no row shifting, so other rows' mappings stay valid).
--     The caller deletes the storage object with the returned key.

-- ─── 1. ensure_receipt_ledger — now self-heals the Status dropdown ───────────
create or replace function private.ensure_receipt_ledger(p_dsp_id uuid)
returns table(workbook_id uuid, sheet_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wb    uuid;
  v_block uuid;
  v_sheet uuid;
  v_headers text[] := array[
    'Date','Uploaded By','Driver','Van','Category','Vendor','Amount','Tax',
    'Payment Type','Route Date','Status','Receipt','Notes'];
  v_validation jsonb := jsonb_build_array(jsonb_build_object(
    'id',    'dv-status',
    'type',  'list',
    'style', 'chip',
    'mode',  'warn',
    'r0', 1, 'c0', 10, 'r1', 9999, 'c1', 10,
    'list',   jsonb_build_array('Unreconciled','Matched','Needs Review',
                                'Duplicate Possible','Rejected','Reimbursable'),
    'colors', jsonb_build_array('#E8EAED','#D9EAD3','#FFF2CC','#FCE5CD',
                                '#F4CCCC','#C9DAF8')
  ));
  i int;
begin
  perform pg_advisory_xact_lock(hashtext('rr_receipt_ledger:' || p_dsp_id::text));

  select w.id into v_wb
    from public.workbooks w
   where w.dsp_id = p_dsp_id
     and w.template_key = 'receipt-ledger'
     and w.archived_at is null
   limit 1;

  if v_wb is null then
    insert into public.workbooks (dsp_id, title, description, visibility, template_key)
    values (p_dsp_id, 'Receipt Ledger',
            'Receipts submitted from the RouteReady app — reconcile against your card / fuel statements.',
            'org', 'receipt-ledger')
    returning id into v_wb;

    insert into public.workbook_blocks (dsp_id, workbook_id, type, title, position)
    values (p_dsp_id, v_wb, 'sheet', '', 0)
    returning id into v_block;

    insert into public.workbook_sheets
      (dsp_id, workbook_id, block_id, name, position, row_count, col_count, frozen_rows, meta)
    values (p_dsp_id, v_wb, v_block, 'Receipt Ledger', 0, 500, 13, 1,
            jsonb_build_object('validation', v_validation))
    returning id into v_sheet;

    for i in 1 .. array_length(v_headers, 1) loop
      insert into public.workbook_cells
        (dsp_id, workbook_id, sheet_id, row_index, col_index, value, value_type, format)
      values (p_dsp_id, v_wb, v_sheet, 0, i - 1, v_headers[i], 'text',
              jsonb_build_object('bold', true, 'bg', 'header'))
      on conflict (sheet_id, row_index, col_index) do nothing;
    end loop;
  else
    select s.id into v_sheet
      from public.workbook_sheets s
     where s.workbook_id = v_wb and s.name = 'Receipt Ledger'
     order by s.position
     limit 1;
  end if;

  -- Self-heal: make sure the Status dropdown is present + the header row is
  -- frozen, whatever state the sheet was in. Preserves any other meta keys.
  if v_sheet is not null then
    update public.workbook_sheets
       set meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{validation}', v_validation, true),
           frozen_rows = 1,
           updated_at = now()
     where id = v_sheet
       and coalesce(meta, '{}'::jsonb) -> 'validation' is distinct from v_validation;
  end if;

  workbook_id := v_wb;
  sheet_id    := v_sheet;
  return next;
end;
$$;

-- ─── 2. Delete an entry ─────────────────────────────────────────────────────
-- BEFORE DELETE: clear the mapped ledger row's cells in place. Deleting cells
-- fires no reverse sync (that trigger is AFTER UPDATE only), and we don't shift
-- row indices, so every other receipt's ledger_row_index stays correct.
create or replace function private.tg_receipt_delete_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.ledger_sheet_id is not null and old.ledger_row_index is not null then
    delete from public.workbook_cells
     where sheet_id = old.ledger_sheet_id
       and row_index = old.ledger_row_index;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_receipt_delete_ledger on public.receipt_uploads;
create trigger trg_receipt_delete_ledger
  before delete on public.receipt_uploads
  for each row execute function private.tg_receipt_delete_ledger();

-- Delete the receipt a ledger cell maps to. Returns the storage key so the
-- caller can remove the image object. Dispatcher+.
create or replace function public.receipt_delete_at(
  p_sheet_id  uuid,
  p_row_index int
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  r public.receipt_uploads;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into r from public.receipt_uploads
   where dsp_id = v_dsp
     and ledger_sheet_id = p_sheet_id
     and ledger_row_index = p_row_index;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  delete from public.receipt_uploads where id = r.id;

  return jsonb_build_object('id', r.id, 'file_storage_key', r.file_storage_key);
end;
$$;
grant execute on function public.receipt_delete_at(uuid, int) to authenticated;

-- Also allow deleting straight by receipt id (for a future admin panel).
create or replace function public.receipt_delete(p_receipt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  r public.receipt_uploads;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into r from public.receipt_uploads where id = p_receipt_id and dsp_id = v_dsp;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;

  delete from public.receipt_uploads where id = r.id;
  return jsonb_build_object('id', r.id, 'file_storage_key', r.file_storage_key);
end;
$$;
grant execute on function public.receipt_delete(uuid) to authenticated;

notify pgrst, 'reload schema';
