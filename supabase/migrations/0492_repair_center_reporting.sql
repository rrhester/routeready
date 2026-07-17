-- Migration 0492 · Repair Center — Phase 9: reporting & the spend ledger.
--
-- Two read-side capabilities; no new writable state:
--
--   1. repair_center_report(p_from, p_to) — every number derived at
--      query time from the raw timestamps and integer cents the earlier
--      phases stored (nothing is pre-aggregated, nothing can drift):
--      fleet summary (cases, downtime, settled spend, variance) and a
--      per-shop performance table (response hours, quote win rate,
--      promise-keeping measured against the ORIGINAL promise — a
--      revision is a delay, not a reset — days late, spend, variance,
--      disputes).
--
--   2. The "Repair Spend" Workbook ledger — a per-DSP singleton
--      workbook projected from repair_invoices, cloning the Receipt
--      Ledger pattern (0436/0438: ensure + sync + BEFORE trigger +
--      dispatcher-gated open RPC, rr.ledger_sync GUC guard).
--      Deliberately ONE-WAY: money cells are a read-only projection —
--      no reverse trigger — so a spreadsheet edit can never change an
--      invoice (docs/REPAIR-CENTER.md's "Repair Invoice Ledger" note).
--      Draft/unreviewed invoices are not projected; a draft becomes a
--      ledger row the moment a human records it.
--
-- New RPCs:   staff — repair_center_report, repair_spend_ledger_ensure
-- New objects: repair_invoices.ledger_* columns,
--              private.ensure_repair_spend_ledger,
--              private.tg_repair_invoice_sync_ledger (+ trigger)
--
-- Idempotent: safe to re-run in the SQL Editor.

-- ═══════════════════════════ 1. repair_center_report ════════════════

create or replace function public.repair_center_report(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now()
) returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  with bounds as (
    select least(coalesce(p_from, now() - interval '30 days'), coalesce(p_to, now())) as f,
           greatest(coalesce(p_from, now() - interval '30 days'), coalesce(p_to, now())) as t
  ),
  cases_opened as (
    select count(*)::int as n
    from public.repair_cases rc, bounds b
    where rc.dsp_id = private.current_dsp_id()
      and rc.reported_at >= b.f and rc.reported_at < b.t
  ),
  cases_closed as (
    select count(*)::int as n,
           round(avg(extract(epoch from (rc.actual_return_to_service_at - rc.reported_at)) / 86400.0)
                 filter (where rc.actual_return_to_service_at is not null), 1) as avg_downtime_days
    from public.repair_cases rc, bounds b
    where rc.dsp_id = private.current_dsp_id()
      and rc.closed_at >= b.f and rc.closed_at < b.t
  ),
  settled as (
    select i.*,
           coalesce(a.nte_cap_cents, a.authorized_total_cents) as authorized_cents
    from public.repair_invoices i
    left join public.repair_authorizations a on a.id = i.authorization_id
    cross join bounds b
    where i.dsp_id = private.current_dsp_id()
      and i.status = 'settled'
      and i.settled_at >= b.f and i.settled_at < b.t
  ),
  settled_sum as (
    select count(*)::int as n,
           coalesce(sum(grand_total_cents), 0)::bigint as total_cents,
           coalesce(sum(greatest(grand_total_cents - authorized_cents, 0))
                    filter (where authorized_cents is not null and grand_total_cents is not null), 0)::bigint as variance_over_cents,
           count(*) filter (where authorized_cents is not null and grand_total_cents is not null
                              and grand_total_cents > authorized_cents)::int as over_count
    from settled
  ),
  shops as (
    select vn.id, vn.name, vn.preferred_status,
      -- completion + downtime
      (select count(*)::int from public.repair_cases rc, bounds b
        where rc.dsp_id = vn.dsp_id and rc.vendor_id = vn.id
          and rc.closed_at >= b.f and rc.closed_at < b.t) as cases_completed,
      (select count(*)::int from public.repair_cases rc
        where rc.dsp_id = vn.dsp_id and rc.vendor_id = vn.id
          and rc.stage not in ('closed','cancelled') and rc.archived_at is null) as open_cases,
      -- quoting behavior
      (select count(*)::int from public.repair_quote_requests r, bounds b
        where r.dsp_id = vn.dsp_id and r.vendor_id = vn.id
          and r.sent_at >= b.f and r.sent_at < b.t) as requests_sent,
      (select count(*)::int from public.repair_quote_requests r, bounds b
        where r.dsp_id = vn.dsp_id and r.vendor_id = vn.id
          and r.submitted_at >= b.f and r.submitted_at < b.t) as quotes_submitted,
      (select round(avg(extract(epoch from (r.submitted_at - r.sent_at)) / 3600.0), 1)
        from public.repair_quote_requests r, bounds b
        where r.dsp_id = vn.dsp_id and r.vendor_id = vn.id
          and r.submitted_at >= b.f and r.submitted_at < b.t
          and r.sent_at is not null) as avg_response_hours,
      (select count(*)::int from public.repair_authorizations a, bounds b
        where a.dsp_id = vn.dsp_id and a.vendor_id = vn.id and a.quote_id is not null
          and a.authorized_at >= b.f and a.authorized_at < b.t) as quotes_won,
      -- promise-keeping: measured against the ORIGINAL promise
      (select count(*)::int from public.repair_shop_visits v, bounds b
        where v.dsp_id = vn.dsp_id and v.vendor_id = vn.id
          and v.picked_up_at >= b.f and v.picked_up_at < b.t
          and v.promised_completion_at is not null
          and v.ready_for_pickup_at is not null) as promises_measured,
      (select count(*)::int from public.repair_shop_visits v, bounds b
        where v.dsp_id = vn.dsp_id and v.vendor_id = vn.id
          and v.picked_up_at >= b.f and v.picked_up_at < b.t
          and v.promised_completion_at is not null
          and v.ready_for_pickup_at is not null
          and v.ready_for_pickup_at <= v.promised_completion_at) as promises_on_time,
      (select round(avg(greatest(extract(epoch from (v.ready_for_pickup_at - v.promised_completion_at)), 0) / 86400.0), 1)
        from public.repair_shop_visits v, bounds b
        where v.dsp_id = vn.dsp_id and v.vendor_id = vn.id
          and v.picked_up_at >= b.f and v.picked_up_at < b.t
          and v.promised_completion_at is not null
          and v.ready_for_pickup_at is not null) as avg_days_late,
      -- money
      (select coalesce(sum(s.grand_total_cents), 0)::bigint from settled s
        where s.vendor_id = vn.id) as settled_total_cents,
      (select coalesce(sum(greatest(s.grand_total_cents - s.authorized_cents, 0))
                       filter (where s.authorized_cents is not null and s.grand_total_cents is not null), 0)::bigint
        from settled s where s.vendor_id = vn.id) as variance_over_cents,
      (select count(*)::int from public.repair_invoices i, bounds b
        where i.dsp_id = vn.dsp_id and i.vendor_id = vn.id
          and i.disputed_at >= b.f and i.disputed_at < b.t) as disputes
    from public.vendors vn
    where vn.dsp_id = private.current_dsp_id()
      and coalesce(vn.paused, false) = false
  )
  select jsonb_build_object(
    'from', (select f from bounds),
    'to',   (select t from bounds),
    'summary', jsonb_build_object(
      'cases_opened', (select n from cases_opened),
      'cases_closed', (select n from cases_closed),
      'avg_downtime_days', (select avg_downtime_days from cases_closed),
      'open_now', (select count(*)::int from public.repair_cases rc
                    where rc.dsp_id = private.current_dsp_id()
                      and rc.stage not in ('closed','cancelled') and rc.archived_at is null),
      'settled_invoices', (select n from settled_sum),
      'settled_total_cents', (select total_cents from settled_sum),
      'variance_over_cents', (select variance_over_cents from settled_sum),
      'over_authorization_count', (select over_count from settled_sum)),
    'shops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'vendor_id', s.id, 'name', s.name, 'preferred_status', s.preferred_status,
        'cases_completed', s.cases_completed,
        'open_cases', s.open_cases,
        'requests_sent', s.requests_sent,
        'quotes_submitted', s.quotes_submitted,
        'avg_response_hours', s.avg_response_hours,
        'quotes_won', s.quotes_won,
        'promises_measured', s.promises_measured,
        'promises_on_time', s.promises_on_time,
        'avg_days_late', s.avg_days_late,
        'settled_total_cents', s.settled_total_cents,
        'variance_over_cents', s.variance_over_cents,
        'disputes', s.disputes)
        order by s.settled_total_cents desc, s.cases_completed desc, s.name)
      from shops s
      where s.cases_completed > 0 or s.open_cases > 0 or s.requests_sent > 0
         or s.quotes_submitted > 0 or s.settled_total_cents > 0 or s.disputes > 0),
      '[]'::jsonb)
  )
  where private.is_staff(private.current_dsp_id(), 'dispatcher');
$$;
grant execute on function public.repair_center_report(timestamptz, timestamptz) to authenticated;


-- ═══════════════════════════ 2. Repair Spend ledger ═════════════════
-- Clone of the Receipt Ledger projection (0436/0438).

alter table public.repair_invoices
  add column if not exists ledger_workbook_id uuid,
  add column if not exists ledger_sheet_id    uuid,
  add column if not exists ledger_row_index   integer,
  add column if not exists ledger_synced_at   timestamptz,
  add column if not exists ledger_sync_error  text;

-- One Repair Spend workbook per DSP.
create unique index if not exists uq_workbooks_repair_spend_ledger
  on public.workbooks (dsp_id)
  where template_key = 'repair-spend-ledger' and archived_at is null;

-- ─── ensure_repair_spend_ledger ─────────────────────────────────────
-- Ledger column order (0-based):
--   0 Date  1 Case #  2 Vehicle  3 Shop  4 Invoice #  5 Status
--   6 Invoice $  7 Authorized $  8 Variance $  9 Variance Note  10 Notes
-- NB: OUT params are prefixed out_ (deviating from 0436) — PostgreSQL 16's
-- PL/pgSQL flags bare `on conflict (sheet_id, …)` as ambiguous against a
-- variable of the same name.
create or replace function private.ensure_repair_spend_ledger(p_dsp_id uuid)
returns table(out_workbook_id uuid, out_sheet_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wb    uuid;
  v_block uuid;
  v_sheet uuid;
  v_headers text[] := array[
    'Date','Case #','Vehicle','Shop','Invoice #','Status',
    'Invoice $','Authorized $','Variance $','Variance Note','Notes'];
  v_meta jsonb := jsonb_build_object(
    'validation', jsonb_build_array(jsonb_build_object(
      'type',  'list',
      'style', 'chip',
      'mode',  'warn',
      'r0', 1, 'c0', 5, 'r1', 9999, 'c1', 5,
      'list',   jsonb_build_array('Recorded','Disputed','Settled','Superseded'),
      'colors', jsonb_build_array('#DBEAFE','#FEF3C7','#DCFCE7','#E5E7EB')
    ))
  );
  i int;
begin
  perform pg_advisory_xact_lock(hashtext('rr_repair_spend_ledger:' || p_dsp_id::text));

  select w.id into v_wb
    from public.workbooks w
   where w.dsp_id = p_dsp_id
     and w.template_key = 'repair-spend-ledger'
     and w.archived_at is null
   limit 1;

  if v_wb is null then
    insert into public.workbooks (dsp_id, title, description, visibility, template_key)
    values (p_dsp_id, 'Repair Spend',
            'Every reviewed repair invoice, projected live from the Repair Center — invoice vs authorized with variance. Read-only: edit invoices in the Repair Center, not here.',
            'org', 'repair-spend-ledger')
    returning id into v_wb;

    insert into public.workbook_blocks (dsp_id, workbook_id, type, title, position)
    values (p_dsp_id, v_wb, 'sheet', '', 0)
    returning id into v_block;

    insert into public.workbook_sheets
      (dsp_id, workbook_id, block_id, name, position, row_count, col_count, frozen_rows, meta)
    values (p_dsp_id, v_wb, v_block, 'Repair Spend', 0, 500, 11, 1, v_meta)
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
     where s.workbook_id = v_wb and s.name = 'Repair Spend'
     order by s.position
     limit 1;
  end if;

  out_workbook_id := v_wb;
  out_sheet_id    := v_sheet;
  return next;
end;
$$;

-- ─── Forward trigger: invoice change → ledger cells ─────────────────
-- BEFORE INSERT/UPDATE (stamps NEW.ledger_* without a self-UPDATE).
-- Drafts are NOT projected — a ledger row appears when a human records
-- the invoice. One-way by design: no reverse trigger, money cells are
-- a read-only projection of the source of truth.
create or replace function private.tg_repair_invoice_sync_ledger()
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
  v_case public.repair_cases;
  v_vehicle_name text;
  v_vendor_name text;
  v_authorized int;
begin
  -- unreviewed drafts stay out of the ledger
  if new.status = 'draft' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_changed :=
         new.status                 is distinct from old.status
      or new.grand_total_cents      is distinct from old.grand_total_cents
      or new.invoice_number         is distinct from old.invoice_number
      or new.invoice_date           is distinct from old.invoice_date
      or new.vendor_id              is distinct from old.vendor_id
      or new.authorization_id       is distinct from old.authorization_id
      or new.variance_note          is distinct from old.variance_note
      or new.dispute_note           is distinct from old.dispute_note
      or new.notes                  is distinct from old.notes
      or new.ledger_synced_at is null;
    if not v_changed then
      return new;
    end if;
    v_row   := new.ledger_row_index;
    v_sheet := new.ledger_sheet_id;
  end if;

  begin
    select out_workbook_id, out_sheet_id into v_wb, v_sheet
      from private.ensure_repair_spend_ledger(new.dsp_id);
    if v_sheet is null then
      new.ledger_sync_error := 'no ledger sheet';
      return new;
    end if;

    if v_row is null or new.ledger_sheet_id is distinct from v_sheet then
      select coalesce(max(ledger_row_index), 0) + 1 into v_row
        from public.repair_invoices where ledger_sheet_id = v_sheet;
      if v_row is null then v_row := 1; end if;
    end if;

    select * into v_case from public.repair_cases where id = new.repair_case_id;
    select coalesce(vh.nickname, vh.name, '') into v_vehicle_name
      from public.vehicles vh where vh.id = v_case.vehicle_id;
    select vn.name into v_vendor_name from public.vendors vn where vn.id = new.vendor_id;
    select coalesce(a.nte_cap_cents, a.authorized_total_cents) into v_authorized
      from public.repair_authorizations a where a.id = new.authorization_id;

    v_cells := jsonb_build_array(
      jsonb_build_object('c', 0, 'v', coalesce(to_char(coalesce(new.invoice_date, new.created_at), 'YYYY-MM-DD'), ''), 't', 'date'),
      jsonb_build_object('c', 1, 'v', coalesce(v_case.case_number, ''), 't', 'text'),
      jsonb_build_object('c', 2, 'v', coalesce(v_vehicle_name, ''), 't', 'text'),
      jsonb_build_object('c', 3, 'v', coalesce(v_vendor_name, ''), 't', 'text'),
      jsonb_build_object('c', 4, 'v', coalesce(new.invoice_number, ''), 't', 'text'),
      jsonb_build_object('c', 5, 'v', initcap(new.status), 't', 'text'),
      jsonb_build_object('c', 6, 'v', coalesce(to_char(new.grand_total_cents::numeric / 100, 'FM999999990.00'), ''), 't', 'currency'),
      jsonb_build_object('c', 7, 'v', coalesce(to_char(v_authorized::numeric / 100, 'FM999999990.00'), ''), 't', 'currency'),
      jsonb_build_object('c', 8, 'v', case when v_authorized is null or new.grand_total_cents is null then ''
                                           else to_char((new.grand_total_cents - v_authorized)::numeric / 100, 'FM999999990.00') end, 't', 'currency'),
      jsonb_build_object('c', 9, 'v', coalesce(new.variance_note, new.dispute_note, ''), 't', 'text'),
      jsonb_build_object('c', 10, 'v', coalesce(new.notes, ''), 't', 'text')
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

drop trigger if exists trg_repair_invoice_sync_ledger on public.repair_invoices;
create trigger trg_repair_invoice_sync_ledger
  before insert or update on public.repair_invoices
  for each row execute function private.tg_repair_invoice_sync_ledger();

-- ─── Open/provision RPC (the workbook template button) ──────────────
create or replace function public.repair_spend_ledger_ensure()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_wb uuid;
  v_sheet uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select out_workbook_id, out_sheet_id into v_wb, v_sheet
    from private.ensure_repair_spend_ledger(v_dsp);
  return jsonb_build_object('workbook_id', v_wb, 'sheet_id', v_sheet);
end;
$$;
grant execute on function public.repair_spend_ledger_ensure() to authenticated;


notify pgrst, 'reload schema';
