-- 0437_receipt_rpcs.sql
--
-- Receipt Intake — the API surface.
--
--   Phone app (anon + driver session token, security definer):
--     • driver_receipt_submit(...)  — record a scanned receipt + dedup flag.
--
--   Dashboard (authenticated dispatcher+, security definer, DSP-scoped):
--     • receipts_list(...)          — filtered admin list.
--     • receipts_summary(...)       — totals by category and by month.
--     • receipt_set_status(...)     — update status / notes (syncs the ledger).
--     • receipt_resync(id)          — retry a failed ledger projection.
--
-- The ledger row is maintained by the triggers in 0436; these RPCs only ever
-- touch receipt_uploads and let the projection follow.

-- ─── driver_receipt_submit ──────────────────────────────────────────────────
-- The image is uploaded by the client to  <dsp_id>/<driver_id>/...  in the
-- private 'receipts' bucket first (anon storage insert); this records the row.
-- Amount + category are the only fields the UI requires, but we defend here
-- too. Everything else is best-effort (manual entry or on-device OCR).
create or replace function public.driver_receipt_submit(
  p_token           text,
  p_storage_key     text,
  p_category        text,
  p_total_amount    numeric      default null,
  p_vendor_name     text         default null,
  p_receipt_date    date         default null,
  p_tax_amount      numeric      default null,
  p_payment_type    text         default null,
  p_van_id          uuid         default null,
  p_van_number      text         default null,
  p_route_date      date         default null,
  p_shift_id        uuid         default null,
  p_notes           text         default null,
  p_file_name       text         default null,
  p_file_size_bytes bigint       default null,
  p_mime_type       text         default null,
  p_ocr_raw_text    text         default null,
  p_ocr_confidence  numeric      default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv   public.drivers;
  v_name  text;
  v_van   uuid := p_van_id;
  v_vannum text := p_van_number;
  v_dup   boolean := false;
  v_id    uuid;
begin
  v_drv := private.driver_validate_token(p_token);
  v_name := coalesce(nullif(btrim(v_drv.preferred_name), ''), v_drv.full_name);

  if p_category is null or p_category not in (
       'Fuel','Maintenance','Tires','Tolls / Parking','Supplies',
       'Uniforms / Equipment','Reimbursement','Cleaning','Other') then
    raise exception 'invalid_category' using errcode = 'P0001';
  end if;

  -- The object must live under this driver's own folder (RLS can't see the
  -- token, so we verify the prefix before trusting the key). Mirrors
  -- driver_chat_send's attachment-path check.
  if p_storage_key is null
     or p_storage_key not like (v_drv.dsp_id::text || '/' || v_drv.id::text || '/%') then
    raise exception 'invalid_storage_key' using errcode = '42501';
  end if;

  -- Resolve the van: an explicit id (verified to the DSP) wins; otherwise try
  -- to match a vehicle by its label/number so the ledger shows a clean value.
  if v_van is not null then
    if not exists (select 1 from public.vehicles where id = v_van and dsp_id = v_drv.dsp_id) then
      v_van := null;
    else
      select name into v_vannum from public.vehicles where id = v_van;
    end if;
  elsif nullif(btrim(coalesce(p_van_number, '')), '') is not null then
    select id into v_van from public.vehicles
      where dsp_id = v_drv.dsp_id and lower(btrim(name)) = lower(btrim(p_van_number))
      limit 1;
  end if;

  -- Lightweight duplicate detection — same vendor + amount + date in this DSP.
  -- Never blocks the upload; just flags it for review.
  if p_total_amount is not null then
    select exists (
      select 1 from public.receipt_uploads
       where dsp_id = v_drv.dsp_id
         and total_amount = p_total_amount
         and (p_receipt_date is null or receipt_date = p_receipt_date)
         and lower(btrim(coalesce(vendor_name, ''))) = lower(btrim(coalesce(p_vendor_name, '')))
    ) into v_dup;
  end if;

  insert into public.receipt_uploads (
    dsp_id, uploaded_by_employee_id, uploaded_by_name, driver_id, driver_name,
    receipt_date, vendor_name, total_amount, tax_amount, payment_type, category,
    van_id, van_number, route_date, shift_id, notes,
    file_storage_key, file_name, file_size_bytes, mime_type,
    ocr_raw_text, ocr_confidence, duplicate_flag
  ) values (
    v_drv.dsp_id, v_drv.id, v_name, v_drv.id, v_name,
    p_receipt_date, nullif(btrim(coalesce(p_vendor_name,'')),''), p_total_amount, p_tax_amount,
    nullif(btrim(coalesce(p_payment_type,'')),''), p_category,
    v_van, nullif(btrim(coalesce(v_vannum,'')),''), p_route_date, p_shift_id,
    nullif(btrim(coalesce(p_notes,'')),''),
    p_storage_key, p_file_name, p_file_size_bytes, p_mime_type,
    p_ocr_raw_text, p_ocr_confidence, v_dup
  ) returning id into v_id;

  return jsonb_build_object(
    'id',             v_id,
    'duplicate_flag', v_dup,
    'status',         'Unreconciled');
end;
$$;
grant execute on function public.driver_receipt_submit(
  text, text, text, numeric, text, date, numeric, text, uuid, text, date, uuid,
  text, text, bigint, text, text, numeric) to anon, authenticated;

-- ─── receipts_list ──────────────────────────────────────────────────────────
-- Powers the DSP admin views: unreconciled, needs review, duplicates, by
-- driver / van / category / date range. All filters optional. Dispatcher+.
create or replace function public.receipts_list(
  p_status     text default null,
  p_driver_id  uuid default null,
  p_van_id     uuid default null,
  p_category   text default null,
  p_from       date default null,
  p_to         date default null,
  p_duplicates boolean default null,
  p_limit      int  default 500
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  from (
    select
      r.id, r.receipt_date, r.upload_timestamp, r.uploaded_by_name,
      r.driver_id, r.driver_name, r.van_id, r.van_number, r.route_date,
      r.category, r.vendor_name, r.total_amount, r.tax_amount, r.payment_type,
      r.reconciliation_status, r.duplicate_flag, r.notes,
      r.file_storage_key, r.file_name, r.mime_type,
      r.reviewed_by, r.reviewed_at, r.ledger_sync_error
    from public.receipt_uploads r
    where r.dsp_id = private.current_dsp_id()
      and private.is_staff(private.current_dsp_id(), 'dispatcher')
      and (p_status     is null or r.reconciliation_status = p_status)
      and (p_driver_id  is null or r.driver_id = p_driver_id)
      and (p_van_id     is null or r.van_id = p_van_id)
      and (p_category   is null or r.category = p_category)
      and (p_from       is null or r.receipt_date >= p_from)
      and (p_to         is null or r.receipt_date <= p_to)
      and (p_duplicates is null or r.duplicate_flag = p_duplicates)
    order by coalesce(r.receipt_date, r.upload_timestamp::date) desc, r.upload_timestamp desc
    limit greatest(1, least(2000, coalesce(p_limit, 500)))
  ) t;
$$;
grant execute on function public.receipts_list(text, uuid, uuid, text, date, date, boolean, int) to authenticated;

-- ─── receipts_summary ───────────────────────────────────────────────────────
-- Totals by category and by month for the current DSP — the "total amount by
-- category" and "by week/month" admin figures. Dispatcher+.
create or replace function public.receipts_summary(
  p_from date default null,
  p_to   date default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_by_category jsonb;
  v_by_month    jsonb;
  v_by_status   jsonb;
  v_total       numeric;
  v_count       int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'category', category, 'count', n, 'total', total) order by total desc), '[]'::jsonb)
    into v_by_category
  from (
    select coalesce(category, 'Uncategorized') as category, count(*) n, coalesce(sum(total_amount),0) total
      from public.receipt_uploads
     where dsp_id = v_dsp
       and (p_from is null or receipt_date >= p_from)
       and (p_to   is null or receipt_date <= p_to)
     group by 1
  ) c;

  select coalesce(jsonb_agg(jsonb_build_object(
           'month', month, 'count', n, 'total', total) order by month desc), '[]'::jsonb)
    into v_by_month
  from (
    select to_char(date_trunc('month', coalesce(receipt_date, upload_timestamp::date)), 'YYYY-MM') as month,
           count(*) n, coalesce(sum(total_amount),0) total
      from public.receipt_uploads
     where dsp_id = v_dsp
       and (p_from is null or receipt_date >= p_from)
       and (p_to   is null or receipt_date <= p_to)
     group by 1
  ) m;

  select coalesce(jsonb_object_agg(reconciliation_status, n), '{}'::jsonb)
    into v_by_status
  from (
    select reconciliation_status, count(*) n
      from public.receipt_uploads
     where dsp_id = v_dsp
       and (p_from is null or receipt_date >= p_from)
       and (p_to   is null or receipt_date <= p_to)
     group by 1
  ) s;

  select coalesce(sum(total_amount),0), count(*)
    into v_total, v_count
    from public.receipt_uploads
   where dsp_id = v_dsp
     and (p_from is null or receipt_date >= p_from)
     and (p_to   is null or receipt_date <= p_to);

  return jsonb_build_object(
    'total_amount', v_total,
    'count',        v_count,
    'by_category',  v_by_category,
    'by_month',     v_by_month,
    'by_status',    v_by_status);
end;
$$;
grant execute on function public.receipts_summary(date, date) to authenticated;

-- ─── receipt_set_status ─────────────────────────────────────────────────────
-- Update a receipt's reconciliation status and/or notes from the admin UI; the
-- 0436 forward trigger reflects it into the ledger row. Dispatcher+.
create or replace function public.receipt_set_status(
  p_receipt_id uuid,
  p_status     text default null,
  p_notes      text default null
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
  if p_status is not null and p_status not in
       ('Unreconciled','Matched','Needs Review','Duplicate Possible','Rejected','Reimbursable') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;

  update public.receipt_uploads
     set reconciliation_status = coalesce(p_status, reconciliation_status),
         notes = case when p_notes is null then notes else nullif(btrim(p_notes), '') end,
         reviewed_by = case when p_status is not null then auth.uid() else reviewed_by end,
         reviewed_at = case when p_status is not null then now() else reviewed_at end
   where id = p_receipt_id and dsp_id = v_dsp
   returning * into r;

  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  return jsonb_build_object('id', r.id, 'reconciliation_status', r.reconciliation_status, 'notes', r.notes);
end;
$$;
grant execute on function public.receipt_set_status(uuid, text, text) to authenticated;

-- ─── receipt_resync ─────────────────────────────────────────────────────────
-- Retry the ledger projection for a receipt whose sync failed (or force one).
-- Dispatcher+.
create or replace function public.receipt_resync(p_receipt_id uuid)
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

  perform private.sync_receipt_to_ledger(p_receipt_id);

  select * into r from public.receipt_uploads where id = p_receipt_id;
  return jsonb_build_object('id', r.id, 'ledger_synced_at', r.ledger_synced_at, 'ledger_sync_error', r.ledger_sync_error);
end;
$$;
grant execute on function public.receipt_resync(uuid) to authenticated;

notify pgrst, 'reload schema';
