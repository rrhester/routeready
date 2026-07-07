-- 0436_receipt_ledger_sync.sql
--
-- Receipt Intake — the Receipt Ledger projection.
--
-- Each receipt_uploads row (0435) is the source of truth; this migration
-- keeps a matching row in a per-DSP "Receipt Ledger" workbook sheet in sync,
-- both directions, entirely server-side (security definer) so it works whether
-- the write came from an anon driver token or an authenticated dispatcher:
--
--   • private.ensure_receipt_ledger(dsp)   — find/create the workbook + sheet,
--                                            header row, and Status dropdown.
--   • private.sync_receipt_to_ledger(rec)  — project one receipt into its row.
--   • trg forward  (receipt_uploads BEFORE) — receipt change → ledger cells.
--   • trg reverse  (workbook_cells AFTER)   — Status/Notes cell edit → receipt.
--
-- Loop guard: the forward path sets a transaction-local GUC rr.ledger_sync='1'
-- around its cell writes; the reverse trigger skips while it is set, so a
-- receipt→cell→receipt ping-pong can't happen.
--
-- Ledger column order (0-based) — must match the phone/dashboard + 0437:
--   0 Date  1 Uploaded By  2 Driver  3 Van  4 Category  5 Vendor
--   6 Amount  7 Tax  8 Payment Type  9 Route Date  10 Status  11 Receipt  12 Notes
--
-- Idempotent throughout.

-- One Receipt Ledger workbook per DSP (the singleton the projection targets).
create unique index if not exists uq_workbooks_receipt_ledger
  on public.workbooks (dsp_id)
  where template_key = 'receipt-ledger' and archived_at is null;

-- ─── ensure_receipt_ledger ──────────────────────────────────────────────────
-- Returns (workbook_id, sheet_id) for the DSP's Receipt Ledger, creating the
-- workbook → sheet block → "Receipt Ledger" sheet (frozen header + Status
-- dropdown) on first use. Serialized per-DSP by an xact advisory lock so two
-- concurrent first receipts can't create two ledgers.
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
  v_meta jsonb := jsonb_build_object(
    'validation', jsonb_build_array(jsonb_build_object(
      'type',  'list',
      'style', 'chip',
      'mode',  'warn',
      'r0', 1, 'c0', 10, 'r1', 9999, 'c1', 10,
      'list',   jsonb_build_array('Unreconciled','Matched','Needs Review',
                                  'Duplicate Possible','Rejected','Reimbursable'),
      'colors', jsonb_build_array('#E5E7EB','#DCFCE7','#FEF3C7','#FFEDD5',
                                  '#FEE2E2','#DBEAFE')
    ))
  );
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
    values (p_dsp_id, v_wb, v_block, 'Receipt Ledger', 0, 500, 13, 1, v_meta)
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

  workbook_id := v_wb;
  sheet_id    := v_sheet;
  return next;
end;
$$;

-- ─── sync_receipt_to_ledger ─────────────────────────────────────────────────
-- Writes (upserts) the 13 ledger cells for one receipt. Assigns the row index
-- on first projection. Wrapped so any failure records ledger_sync_error on the
-- receipt (for a retry) rather than aborting — the receipt must never be lost.
create or replace function private.sync_receipt_to_ledger(p_receipt_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r        public.receipt_uploads;
  v_wb     uuid;
  v_sheet  uuid;
  v_row    integer;
  v_cells  jsonb;
  el       jsonb;
begin
  select * into r from public.receipt_uploads where id = p_receipt_id;
  if not found then return; end if;

  select workbook_id, sheet_id into v_wb, v_sheet
    from private.ensure_receipt_ledger(r.dsp_id);
  if v_sheet is null then return; end if;

  v_row := r.ledger_row_index;
  if v_row is null or r.ledger_sheet_id is distinct from v_sheet then
    select coalesce(max(ledger_row_index), 0) + 1 into v_row
      from public.receipt_uploads
     where ledger_sheet_id = v_sheet;
    if v_row is null then v_row := 1; end if;
  end if;

  v_cells := jsonb_build_array(
    jsonb_build_object('c', 0,  'v', coalesce(to_char(r.receipt_date, 'YYYY-MM-DD'), ''), 't', 'date'),
    jsonb_build_object('c', 1,  'v', coalesce(r.uploaded_by_name, ''),                    't', 'text'),
    jsonb_build_object('c', 2,  'v', coalesce(r.driver_name, ''),                         't', 'text'),
    jsonb_build_object('c', 3,  'v', coalesce(r.van_number, ''),                          't', 'text'),
    jsonb_build_object('c', 4,  'v', coalesce(r.category, ''),                            't', 'text'),
    jsonb_build_object('c', 5,  'v', coalesce(r.vendor_name, ''),                         't', 'text'),
    jsonb_build_object('c', 6,  'v', coalesce(to_char(r.total_amount, 'FM999999990.00'), ''), 't', 'currency'),
    jsonb_build_object('c', 7,  'v', coalesce(to_char(r.tax_amount,   'FM999999990.00'), ''), 't', 'currency'),
    jsonb_build_object('c', 8,  'v', coalesce(r.payment_type, ''),                        't', 'text'),
    jsonb_build_object('c', 9,  'v', coalesce(to_char(r.route_date, 'YYYY-MM-DD'), ''),   't', 'date'),
    jsonb_build_object('c', 10, 'v', r.reconciliation_status,                             't', 'text'),
    jsonb_build_object('c', 11, 'v', case when r.file_storage_key is not null then 'View Receipt' else '' end, 't', 'text',
                       'f', case when r.file_storage_key is not null
                                 then jsonb_build_object('receipt',
                                        jsonb_build_object('path', r.file_storage_key, 'name', coalesce(r.file_name, 'receipt')))
                                 else '{}'::jsonb end),
    jsonb_build_object('c', 12, 'v', coalesce(r.notes, ''),                               't', 'text')
  );

  -- Guard the reverse trigger against our own writes.
  perform set_config('rr.ledger_sync', '1', true);

  for el in select * from jsonb_array_elements(v_cells) loop
    insert into public.workbook_cells
      (dsp_id, workbook_id, sheet_id, row_index, col_index, value, value_type, format)
    values (
      r.dsp_id, v_wb, v_sheet, v_row, (el->>'c')::int,
      el->>'v', el->>'t',
      coalesce(el->'f', '{}'::jsonb))
    on conflict (sheet_id, row_index, col_index) do update
      set value      = excluded.value,
          value_type = excluded.value_type,
          format     = case when (el->'f') is not null then excluded.format
                            else public.workbook_cells.format end,
          formula    = null,
          computed   = null,
          updated_at = now();
  end loop;

  perform set_config('rr.ledger_sync', '0', true);

  -- Keep row_count ahead of the highest used row so the grid shows it.
  update public.workbook_sheets
     set row_count = greatest(row_count, v_row + 1), updated_at = now()
   where id = v_sheet;

  -- Record the linkage (without re-firing the forward trigger: caller is the
  -- BEFORE trigger writing NEW.* directly, or an explicit retry path).
  update public.receipt_uploads
     set ledger_workbook_id = v_wb,
         ledger_sheet_id    = v_sheet,
         ledger_row_index   = v_row,
         ledger_synced_at   = now(),
         ledger_sync_error  = null
   where id = p_receipt_id
     and (ledger_row_index is distinct from v_row
          or ledger_sheet_id is distinct from v_sheet
          or ledger_synced_at is null
          or ledger_sync_error is not null);
exception when others then
  perform set_config('rr.ledger_sync', '0', true);
  update public.receipt_uploads
     set ledger_sync_error = left(coalesce(sqlerrm, 'ledger sync failed'), 500),
         ledger_synced_at   = null
   where id = p_receipt_id;
end;
$$;

-- ─── Forward trigger: receipt change → ledger cells ─────────────────────────
-- BEFORE INSERT/UPDATE so we can stamp NEW.ledger_* on the same row without a
-- self-referential UPDATE. Only re-projects when a projected field changed
-- (or the last projection failed), so ordinary metadata churn is cheap.
create or replace function private.tg_receipt_sync_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wb    uuid;
  v_sheet uuid;
  v_row   integer;
  v_cells jsonb;
  el      jsonb;
  v_changed boolean;
begin
  if tg_op = 'UPDATE' then
    v_changed :=
         new.receipt_date          is distinct from old.receipt_date
      or new.uploaded_by_name       is distinct from old.uploaded_by_name
      or new.driver_name            is distinct from old.driver_name
      or new.van_number             is distinct from old.van_number
      or new.category               is distinct from old.category
      or new.vendor_name            is distinct from old.vendor_name
      or new.total_amount           is distinct from old.total_amount
      or new.tax_amount             is distinct from old.tax_amount
      or new.payment_type           is distinct from old.payment_type
      or new.route_date             is distinct from old.route_date
      or new.reconciliation_status  is distinct from old.reconciliation_status
      or new.notes                  is distinct from old.notes
      or new.file_storage_key       is distinct from old.file_storage_key
      or new.ledger_synced_at is null;
    if not v_changed then
      return new;
    end if;
    v_row   := new.ledger_row_index;
    v_sheet := new.ledger_sheet_id;
  end if;

  begin
    select workbook_id, sheet_id into v_wb, v_sheet
      from private.ensure_receipt_ledger(new.dsp_id);
    if v_sheet is null then
      new.ledger_sync_error := 'no ledger sheet';
      return new;
    end if;

    if v_row is null or new.ledger_sheet_id is distinct from v_sheet then
      select coalesce(max(ledger_row_index), 0) + 1 into v_row
        from public.receipt_uploads where ledger_sheet_id = v_sheet;
      if v_row is null then v_row := 1; end if;
    end if;

    v_cells := jsonb_build_array(
      jsonb_build_object('c', 0,  'v', coalesce(to_char(new.receipt_date, 'YYYY-MM-DD'), ''), 't', 'date'),
      jsonb_build_object('c', 1,  'v', coalesce(new.uploaded_by_name, ''), 't', 'text'),
      jsonb_build_object('c', 2,  'v', coalesce(new.driver_name, ''),      't', 'text'),
      jsonb_build_object('c', 3,  'v', coalesce(new.van_number, ''),       't', 'text'),
      jsonb_build_object('c', 4,  'v', coalesce(new.category, ''),         't', 'text'),
      jsonb_build_object('c', 5,  'v', coalesce(new.vendor_name, ''),      't', 'text'),
      jsonb_build_object('c', 6,  'v', coalesce(to_char(new.total_amount, 'FM999999990.00'), ''), 't', 'currency'),
      jsonb_build_object('c', 7,  'v', coalesce(to_char(new.tax_amount,   'FM999999990.00'), ''), 't', 'currency'),
      jsonb_build_object('c', 8,  'v', coalesce(new.payment_type, ''),     't', 'text'),
      jsonb_build_object('c', 9,  'v', coalesce(to_char(new.route_date, 'YYYY-MM-DD'), ''), 't', 'date'),
      jsonb_build_object('c', 10, 'v', new.reconciliation_status,          't', 'text'),
      jsonb_build_object('c', 11, 'v', case when new.file_storage_key is not null then 'View Receipt' else '' end, 't', 'text',
                         'f', case when new.file_storage_key is not null
                                   then jsonb_build_object('receipt',
                                          jsonb_build_object('path', new.file_storage_key, 'name', coalesce(new.file_name, 'receipt')))
                                   else '{}'::jsonb end),
      jsonb_build_object('c', 12, 'v', coalesce(new.notes, ''),            't', 'text')
    );

    perform set_config('rr.ledger_sync', '1', true);
    for el in select * from jsonb_array_elements(v_cells) loop
      insert into public.workbook_cells
        (dsp_id, workbook_id, sheet_id, row_index, col_index, value, value_type, format)
      values (new.dsp_id, v_wb, v_sheet, v_row, (el->>'c')::int, el->>'v', el->>'t',
              coalesce(el->'f', '{}'::jsonb))
      on conflict (sheet_id, row_index, col_index) do update
        set value      = excluded.value,
            value_type = excluded.value_type,
            format     = case when (el->'f') is not null then excluded.format
                              else public.workbook_cells.format end,
            formula    = null,
            computed   = null,
            updated_at = now();
    end loop;
    perform set_config('rr.ledger_sync', '0', true);

    update public.workbook_sheets
       set row_count = greatest(row_count, v_row + 1), updated_at = now()
     where id = v_sheet;

    new.ledger_workbook_id := v_wb;
    new.ledger_sheet_id    := v_sheet;
    new.ledger_row_index   := v_row;
    new.ledger_synced_at   := now();
    new.ledger_sync_error  := null;
  exception when others then
    perform set_config('rr.ledger_sync', '0', true);
    new.ledger_sync_error := left(coalesce(sqlerrm, 'ledger sync failed'), 500);
    new.ledger_synced_at  := null;
  end;

  return new;
end;
$$;

drop trigger if exists trg_receipt_sync_ledger on public.receipt_uploads;
create trigger trg_receipt_sync_ledger
  before insert or update on public.receipt_uploads
  for each row execute function private.tg_receipt_sync_ledger();

-- ─── Reverse trigger: Status / Notes cell edit → receipt ────────────────────
-- When a dispatcher edits the Status (col 10) or Notes (col 12) cell of a
-- receipt-ledger row, push it back onto the receipt record so the source of
-- truth stays authoritative. Skips its own upstream writes via rr.ledger_sync.
create or replace function private.tg_ledger_cell_to_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.receipt_uploads;
  v_status text;
begin
  if coalesce(current_setting('rr.ledger_sync', true), '0') = '1' then
    return new;
  end if;
  if new.col_index not in (10, 12) then
    return new;
  end if;

  select * into r from public.receipt_uploads
   where ledger_sheet_id = new.sheet_id and ledger_row_index = new.row_index;
  if not found then return new; end if;

  if new.col_index = 10 then
    v_status := btrim(coalesce(new.value, ''));
    if v_status in ('Unreconciled','Matched','Needs Review','Duplicate Possible','Rejected','Reimbursable')
       and v_status is distinct from r.reconciliation_status then
      update public.receipt_uploads
         set reconciliation_status = v_status,
             reviewed_by = auth.uid(),
             reviewed_at = now()
       where id = r.id;
    end if;
  elsif new.col_index = 12 then
    if nullif(btrim(coalesce(new.value, '')), '') is distinct from r.notes then
      update public.receipt_uploads
         set notes = nullif(btrim(coalesce(new.value, '')), '')
       where id = r.id;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_ledger_cell_to_receipt on public.workbook_cells;
create trigger trg_ledger_cell_to_receipt
  after update on public.workbook_cells
  for each row execute function private.tg_ledger_cell_to_receipt();

notify pgrst, 'reload schema';
