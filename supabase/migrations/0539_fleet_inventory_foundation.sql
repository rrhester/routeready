-- Migration 0539 · Fleet inventory foundation
--
-- Operator directive (2026-07-25): "a top of the line tool that tracks
-- fleet inventory — ground a van, store information, preventative
-- maintenance schedules, inventory. I want a world class fleet system."
--
-- This migration is the server half of that push:
--
--   1. vehicles — richer asset record: fuel type, tire size, telematics
--      + fuel-card + toll-tag identifiers, acquisition (date + cost),
--      warranty (date + miles), lease/rental terms, metadata jsonb.
--   2. vehicle_documents — kind list broadened beyond
--      insurance/registration: title, lease, warranty, other.
--   3. Grounding — vehicle_grounding_events gains expected_return_on +
--      unground_note; vehicle_set_operational_status accepts
--      p_expected_return_on and stamps the note on un-ground.
--   4. vehicles_roster() — REGRESSION FIX. 0345 was rebuilt from 0213's
--      body and silently dropped every decoration added by
--      0239/0297/0301/0308 (is_branded, fem_status, days_since_deployed,
--      grounded_since/reason/category/days, active RO fields, document
--      badges, driver_reported_open_count, backup driver) — which also
--      starved fleet_execution_summary()'s is_branded filter, blanking
--      the FEM/VORR strip. Per the standing hazard note in
--      docs/REPAIR-CENTER.md §1, this re-issue starts from the FULL 0308
--      body and adds: van_type (0345's one real addition) and
--      expected_return_on (new here). Any future redefinition must start
--      from THIS body.
--   5. fleet_execution_summary(p_station_id) — the multi-station lens
--      reaches the FEM/VORR strip (0302 body + an optional station
--      filter; no-arg call unchanged = DSP-wide).
--   6. Preventive maintenance — fleet_pm_rules (interval by miles and/or
--      months) + fleet_pm_completions + RPCs: install defaults, save
--      rule, log completion, and fleet_pm_board() (due/overdue engine).
--   7. vehicle_cost_summary() — per-van spend rollup (settled repair
--      invoices + legacy ROs + service logs + part purchases) and
--      cost-per-mile from the mileage ledger.
--
-- Idempotent: add column if not exists / create or replace / drop
-- function if exists before signature changes. Safe to re-run.

-- ── 1 · vehicles: richer asset record ───────────────────────────────

alter table public.vehicles add column if not exists fuel_type            text;
alter table public.vehicles add column if not exists tire_size            text;
alter table public.vehicles add column if not exists telematics_id        text;
alter table public.vehicles add column if not exists fuel_card            text;
alter table public.vehicles add column if not exists toll_tag             text;
alter table public.vehicles add column if not exists acquired_on          date;
alter table public.vehicles add column if not exists acquired_cost_cents  int;
alter table public.vehicles add column if not exists warranty_expires_on  date;
alter table public.vehicles add column if not exists warranty_miles       int;
alter table public.vehicles add column if not exists lease_provider       text;
alter table public.vehicles add column if not exists lease_expires_on     date;
alter table public.vehicles add column if not exists lease_monthly_cents  int;
alter table public.vehicles add column if not exists metadata             jsonb not null default '{}'::jsonb;


-- ── 2 · vehicle_documents: broadened kinds ──────────────────────────
-- The one-active-per-(vehicle, kind) unique index (0297) already covers
-- the new kinds. Only insurance/registration ever drive the roster's
-- doc-exception badge — the new kinds are record storage, not alerts.

alter table public.vehicle_documents
  drop constraint if exists vehicle_documents_kind_check;
alter table public.vehicle_documents
  add constraint vehicle_documents_kind_check
  check (kind in ('insurance','registration','title','lease','warranty','other'));

-- vehicle_document_save — 0297 body verbatim, kind list broadened.
create or replace function public.vehicle_document_save(
  p_id              uuid    default null,
  p_vehicle_id      uuid    default null,
  p_kind            text    default null,
  p_document_number text    default null,
  p_expiration_date date    default null,
  p_file_path       text    default null,
  p_file_name       text    default null,
  p_file_mime       text    default null,
  p_file_size_bytes int     default null,
  p_notes           text    default null
) returns public.vehicle_documents
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vehicle_documents;
  v_prior_id uuid;
  v_event_kind text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_kind, '') not in ('insurance','registration','title','lease','warranty','other') then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if p_id is null then
    if p_vehicle_id is null then raise exception 'vehicle_id_required' using errcode = '22023'; end if;
    if not exists (select 1 from public.vehicles where id = p_vehicle_id and dsp_id = v_dsp) then
      raise exception 'vehicle_not_found' using errcode = 'P0002';
    end if;

    if p_file_path is not null and p_file_path <> ''
       and not (p_file_path like v_dsp::text || '/' || p_vehicle_id::text || '/%') then
      raise exception 'invalid_file_path' using errcode = '42501';
    end if;

    update public.vehicle_documents
       set replaced_at = now(), updated_at = now()
     where vehicle_id = p_vehicle_id and kind = p_kind
       and dsp_id = v_dsp and replaced_at is null
    returning id into v_prior_id;

    insert into public.vehicle_documents (
      dsp_id, vehicle_id, kind, document_number, expiration_date,
      file_path, file_name, file_mime, file_size_bytes, notes,
      replaces_id, uploaded_by, uploaded_at
    ) values (
      v_dsp, p_vehicle_id, p_kind,
      nullif(trim(p_document_number), ''),
      p_expiration_date,
      nullif(p_file_path, ''),
      nullif(trim(p_file_name), ''),
      nullif(trim(p_file_mime), ''),
      p_file_size_bytes,
      nullif(trim(p_notes), ''),
      v_prior_id,
      auth.uid(),
      case when p_file_path is not null and p_file_path <> '' then now() else null end
    ) returning * into v_row;

    v_event_kind := case when v_prior_id is not null then 'fleet_replaced' else 'fleet_uploaded' end;
    insert into public.vehicle_document_events
      (dsp_id, vehicle_id, vehicle_document_id, doc_kind, kind, actor_kind, actor_user_id, payload)
    values (
      v_dsp, p_vehicle_id, v_row.id, p_kind, v_event_kind, 'staff', auth.uid(),
      jsonb_build_object(
        'expiration_date', p_expiration_date,
        'file_uploaded',   p_file_path is not null and p_file_path <> '',
        'document_number_set', nullif(trim(p_document_number), '') is not null,
        'previous_id', v_prior_id
      )
    );
  else
    update public.vehicle_documents set
      document_number = nullif(trim(p_document_number), ''),
      expiration_date = coalesce(p_expiration_date, expiration_date),
      file_path       = coalesce(nullif(p_file_path, ''), file_path),
      file_name       = coalesce(nullif(trim(p_file_name), ''), file_name),
      file_mime       = coalesce(nullif(trim(p_file_mime), ''), file_mime),
      file_size_bytes = coalesce(p_file_size_bytes, file_size_bytes),
      notes           = nullif(trim(p_notes), ''),
      updated_at      = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then raise exception 'document_not_found' using errcode = 'P0002'; end if;
    insert into public.vehicle_document_events
      (dsp_id, vehicle_id, vehicle_document_id, doc_kind, kind, actor_kind, actor_user_id, payload)
    values (
      v_dsp, v_row.vehicle_id, v_row.id, v_row.kind, 'fleet_uploaded', 'staff', auth.uid(),
      jsonb_build_object('edit_only', true)
    );
  end if;
  return v_row;
end;
$$;
grant execute on function public.vehicle_document_save(
  uuid, uuid, text, text, date, text, text, text, int, text
) to authenticated;


-- ── 3 · Grounding: expected return + un-ground note ─────────────────

alter table public.vehicle_grounding_events
  add column if not exists expected_return_on date;
alter table public.vehicle_grounding_events
  add column if not exists unground_note text;

-- vehicle_set_operational_status — 0308 body + p_expected_return_on.
-- New parameter ⇒ drop the old 4-arg signature first (existing SQL
-- callers use ≤4 positional args and still resolve via the default).
drop function if exists public.vehicle_set_operational_status(uuid, text, text, text);
create or replace function public.vehicle_set_operational_status(
  p_id                 uuid,
  p_status             text,
  p_reason             text default null,
  p_category           text default null,
  p_expected_return_on date default null
) returns public.vehicles
language plpgsql security definer set search_path = public
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vehicles;
  v_cat text := nullif(btrim(p_category), '');
begin
  if coalesce(p_status, '') not in ('operational','grounded') then
    raise exception 'bad_status' using errcode = '22023';
  end if;
  if v_cat is not null and v_cat not in ('warranty','preventive','body_damage','other') then
    raise exception 'bad_category' using errcode = '22023';
  end if;

  update public.vehicles
     set operational_status = p_status,
         updated_at         = now()
   where id = p_id and dsp_id = v_dsp
  returning * into v_row;

  if not found then
    raise exception 'vehicle_not_found' using errcode = '42704';
  end if;

  if p_status = 'grounded' then
    -- Stamp reason/category/expected-return onto the open grounding
    -- event (the 0228 trigger created/kept the row from the status
    -- change above).
    update public.vehicle_grounding_events
       set reason             = coalesce(nullif(btrim(p_reason), ''), reason),
           category           = coalesce(v_cat, category),
           expected_return_on = coalesce(p_expected_return_on, expected_return_on)
     where vehicle_id = p_id
       and ungrounded_at is null;
  elsif nullif(btrim(p_reason), '') is not null then
    -- Un-grounding with a note: stamp it on the event the trigger just
    -- closed (the latest closed event for this van).
    update public.vehicle_grounding_events
       set unground_note = nullif(btrim(p_reason), '')
     where id = (
       select id from public.vehicle_grounding_events
        where vehicle_id = p_id and ungrounded_at is not null
        order by ungrounded_at desc limit 1
     );
  end if;

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (
    v_dsp, 'user', auth.uid(),
    case when p_status = 'grounded' then 'vehicle_grounded' else 'vehicle_ungrounded' end,
    'Vehicle ' || coalesce(v_row.nickname, v_row.name, '(unnamed)') || ' set to ' || p_status,
    nullif(btrim(p_reason), ''),
    'vehicle', p_id
  );

  return v_row;
end $$;
grant execute on function public.vehicle_set_operational_status(uuid, text, text, text, date) to authenticated;


-- ── 4 · vehicle_record_save: extended full-record save ──────────────
-- 0231 body + the new asset-record fields + van_type (van_type was
-- previously written by a raw client-side table UPDATE — it now rides
-- the RPC like every other field). Same full-record PUT semantics as
-- before. New params ⇒ drop the old signature first.
drop function if exists public.vehicle_record_save(
  uuid, text, text, text, text, text, text,
  int, text, text, text, text, text, text, text,
  int, uuid, date, date, text, date, date, date, date, text
);
create or replace function public.vehicle_record_save(
  p_id                     uuid    default null,
  p_name                   text    default null,
  p_nickname               text    default null,
  p_kind                   text    default 'van',
  p_status                 text    default 'active',
  p_ownership              text    default 'dsp_owned',
  p_operational_status     text    default 'operational',
  p_year                   int     default null,
  p_make                   text    default null,
  p_model                  text    default null,
  p_trim                   text    default null,
  p_color                  text    default null,
  p_vin                    text    default null,
  p_plate                  text    default null,
  p_plate_state            text    default null,
  p_mileage                int     default null,
  p_station_id             uuid    default null,
  p_in_service_on          date    default null,
  p_last_service_at        date    default null,
  p_last_service_note      text    default null,
  p_next_service_due_at    date    default null,
  p_dot_inspection_at      date    default null,
  p_registration_expires_on date   default null,
  p_insurance_expires_on   date    default null,
  p_notes                  text    default null,
  p_van_type               text    default null,
  p_fuel_type              text    default null,
  p_tire_size              text    default null,
  p_telematics_id          text    default null,
  p_fuel_card              text    default null,
  p_toll_tag               text    default null,
  p_acquired_on            date    default null,
  p_acquired_cost_cents    int     default null,
  p_warranty_expires_on    date    default null,
  p_warranty_miles         int     default null,
  p_lease_provider         text    default null,
  p_lease_expires_on       date    default null,
  p_lease_monthly_cents    int     default null
) returns public.vehicles
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_v public.vehicles;
  v_mileage_updated timestamptz;
  v_van_type text := nullif(trim(coalesce(p_van_type, '')), '');
  v_fuel_type text := nullif(trim(coalesce(p_fuel_type, '')), '');
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if coalesce(p_status, 'active') not in ('active','spare','out_of_service','retired') then
    raise exception 'bad_status' using errcode = '22023';
  end if;
  if coalesce(p_ownership, 'dsp_owned') not in ('amazon_owned','dsp_owned','rental','leased') then
    raise exception 'bad_ownership' using errcode = '22023';
  end if;
  if p_operational_status is not null
     and coalesce(p_operational_status, 'operational') not in ('operational','grounded') then
    raise exception 'bad_op_status' using errcode = '22023';
  end if;
  if v_van_type is not null and v_van_type not in ('edv','step_van','cargo_van','box_truck') then
    raise exception 'bad_van_type' using errcode = '22023';
  end if;
  if v_fuel_type is not null and v_fuel_type not in ('gas','diesel','ev','hybrid','propane','other') then
    raise exception 'bad_fuel_type' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.vehicles (
      dsp_id, name, nickname, kind, status, ownership, operational_status,
      year, make, model, trim_level, color, vin, plate, plate_state,
      mileage, mileage_updated_at, station_id, in_service_on,
      last_service_at, last_service_note, next_service_due_at,
      dot_inspection_at, registration_expires_on, insurance_expires_on,
      notes, van_type, fuel_type, tire_size, telematics_id, fuel_card,
      toll_tag, acquired_on, acquired_cost_cents, warranty_expires_on,
      warranty_miles, lease_provider, lease_expires_on,
      lease_monthly_cents, created_by
    ) values (
      v_dsp,
      trim(p_name),
      nullif(trim(p_nickname), ''),
      coalesce(nullif(trim(p_kind), ''), 'van'),
      coalesce(p_status, 'active'),
      coalesce(p_ownership, 'dsp_owned'),
      coalesce(p_operational_status, 'operational'),
      p_year, nullif(trim(p_make), ''), nullif(trim(p_model), ''),
      nullif(trim(p_trim), ''), nullif(trim(p_color), ''),
      nullif(upper(trim(p_vin)), ''), nullif(upper(trim(p_plate)), ''), nullif(upper(trim(p_plate_state)), ''),
      p_mileage,
      case when p_mileage is not null then now() else null end,
      p_station_id,
      p_in_service_on,
      p_last_service_at, nullif(trim(p_last_service_note), ''), p_next_service_due_at,
      p_dot_inspection_at, p_registration_expires_on, p_insurance_expires_on,
      nullif(trim(p_notes), ''),
      v_van_type, v_fuel_type,
      nullif(trim(coalesce(p_tire_size, '')), ''),
      nullif(trim(coalesce(p_telematics_id, '')), ''),
      nullif(trim(coalesce(p_fuel_card, '')), ''),
      nullif(trim(coalesce(p_toll_tag, '')), ''),
      p_acquired_on, p_acquired_cost_cents, p_warranty_expires_on,
      p_warranty_miles,
      nullif(trim(coalesce(p_lease_provider, '')), ''),
      p_lease_expires_on, p_lease_monthly_cents,
      auth.uid()
    )
    returning * into v_v;
  else
    select case when p_mileage is distinct from mileage and p_mileage is not null then now() else mileage_updated_at end
      into v_mileage_updated
      from public.vehicles where id = p_id and dsp_id = v_dsp;

    -- Update path · operational_status is intentionally NOT touched
    -- here (0231). Use vehicle_set_operational_status for that.
    update public.vehicles set
      name                   = trim(p_name),
      nickname               = nullif(trim(p_nickname), ''),
      kind                   = coalesce(nullif(trim(p_kind), ''), 'van'),
      status                 = coalesce(p_status, 'active'),
      ownership              = coalesce(p_ownership, 'dsp_owned'),
      year                   = p_year,
      make                   = nullif(trim(p_make), ''),
      model                  = nullif(trim(p_model), ''),
      trim_level             = nullif(trim(p_trim), ''),
      color                  = nullif(trim(p_color), ''),
      vin                    = nullif(upper(trim(p_vin)), ''),
      plate                  = nullif(upper(trim(p_plate)), ''),
      plate_state            = nullif(upper(trim(p_plate_state)), ''),
      mileage                = p_mileage,
      mileage_updated_at     = v_mileage_updated,
      station_id             = p_station_id,
      in_service_on          = p_in_service_on,
      last_service_at        = p_last_service_at,
      last_service_note      = nullif(trim(p_last_service_note), ''),
      next_service_due_at    = p_next_service_due_at,
      dot_inspection_at      = p_dot_inspection_at,
      registration_expires_on= p_registration_expires_on,
      insurance_expires_on   = p_insurance_expires_on,
      notes                  = nullif(trim(p_notes), ''),
      van_type               = v_van_type,
      fuel_type              = v_fuel_type,
      tire_size              = nullif(trim(coalesce(p_tire_size, '')), ''),
      telematics_id          = nullif(trim(coalesce(p_telematics_id, '')), ''),
      fuel_card              = nullif(trim(coalesce(p_fuel_card, '')), ''),
      toll_tag               = nullif(trim(coalesce(p_toll_tag, '')), ''),
      acquired_on            = p_acquired_on,
      acquired_cost_cents    = p_acquired_cost_cents,
      warranty_expires_on    = p_warranty_expires_on,
      warranty_miles         = p_warranty_miles,
      lease_provider         = nullif(trim(coalesce(p_lease_provider, '')), ''),
      lease_expires_on       = p_lease_expires_on,
      lease_monthly_cents    = p_lease_monthly_cents,
      updated_at             = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_v;
    if v_v.id is null then raise exception 'vehicle_not_found' using errcode = 'P0002'; end if;
  end if;

  return v_v;
end;
$$;
grant execute on function public.vehicle_record_save(
  uuid, text, text, text, text, text, text,
  int, text, text, text, text, text, text, text,
  int, uuid, date, date, text, date, date, date, date, text,
  text, text, text, text, text, text, date, int, date, int, text, date, int
) to authenticated;


-- ── 5 · vehicles_roster: consolidated re-issue (regression fix) ─────
-- FULL 0308 body + van_type (0345's addition) + expected_return_on.
-- ⚠ Future edits must start from THIS body — never rebuild from 0213.
-- NB the row is built as TWO concatenated jsonb_build_object calls:
-- 0308's single call sat at exactly Postgres's 100-argument ceiling, so
-- ANY added field must go in the second object (CI caught the overflow).
create or replace function public.vehicles_roster()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with thresh as (
    select private.vehicle_doc_threshold(private.current_dsp_id()) as days
  ),
  active_docs as (
    select d.vehicle_id, d.kind, d.expiration_date, d.file_path,
           case when d.expiration_date is null then null else (d.expiration_date - current_date) end as days_until,
           case
             when d.file_path is null then 'missing'
             when d.expiration_date is not null and d.expiration_date < current_date then 'expired'
             when d.expiration_date is not null and d.expiration_date <= current_date + (select days from thresh) then 'expiring_soon'
             else 'active'
           end as status
    from public.vehicle_documents d
    where d.dsp_id = private.current_dsp_id()
      and d.replaced_at is null
  ),
  doc_rolled as (
    select v.id as vehicle_id,
           (select jsonb_build_object(
                     'status', coalesce(ad.status, 'missing'),
                     'expiration_date', ad.expiration_date,
                     'days_until', ad.days_until)
              from active_docs ad where ad.vehicle_id = v.id and ad.kind = 'insurance') as ins,
           (select jsonb_build_object(
                     'status', coalesce(ad.status, 'missing'),
                     'expiration_date', ad.expiration_date,
                     'days_until', ad.days_until)
              from active_docs ad where ad.vehicle_id = v.id and ad.kind = 'registration') as reg
    from public.vehicles v
    where v.dsp_id = private.current_dsp_id() and v.archived_at is null
  )
  select coalesce(jsonb_agg(v order by v->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',                 vh.id,
      'name',               vh.name,
      'nickname',           vh.nickname,
      'kind',               vh.kind,
      'status',             vh.status,
      'ownership',          vh.ownership,
      'van_type',           vh.van_type,
      'operational_status', vh.operational_status,
      'is_branded',         coalesce(vh.is_branded, true),
      'year',               vh.year,
      'make',               vh.make,
      'model',              vh.model,
      'trim_level',         vh.trim_level,
      'color',              vh.color,
      'plate',              vh.plate,
      'plate_state',        vh.plate_state,
      'vin',                vh.vin,
      'mileage',            vh.mileage,
      'mileage_updated_at', vh.mileage_updated_at,
      'last_route_completed_at', vh.last_route_completed_at,
      'photo_path',         vh.photo_path,
      'station_id',         vh.station_id,
      'station_code',       st.code,
      'last_service_at',    vh.last_service_at,
      'next_service_due_at',vh.next_service_due_at,
      'dot_inspection_at',  vh.dot_inspection_at,
      'registration_expires_on', vh.registration_expires_on,
      'insurance_expires_on',    vh.insurance_expires_on,
      'updated_at',         vh.updated_at,
      'primary_driver_id',  pri.driver_id,
      'primary_driver_name',pri.name,
      'backup_driver_id',   bkp.driver_id,
      'backup_driver_name', bkp.name,
      'backup_count',       coalesce(ch.backup_count, 0),
      'open_issue_count',   coalesce(oi.cnt, 0),
      'driver_reported_open_count', coalesce(dri.cnt, 0),
      'doc_insurance',      coalesce(dr.ins, jsonb_build_object('status','missing')),
      'doc_registration',   coalesce(dr.reg, jsonb_build_object('status','missing')),
      'doc_exception_state', (
        select case
                 when (dr.ins->>'status') = 'expired'      or (dr.reg->>'status') = 'expired'      then 'expired'
                 when (dr.ins->>'status') = 'missing'      or (dr.reg->>'status') = 'missing'      then 'missing'
                 when (dr.ins->>'status') = 'expiring_soon' or (dr.reg->>'status') = 'expiring_soon' then 'expiring_soon'
                 else 'active'
               end
      ),
      'doc_exception_label', (
        select case
          when (dr.ins->>'status') = 'expired'      then 'Insurance Expired'
          when (dr.reg->>'status') = 'expired'      then 'Registration Expired'
          when (dr.ins->>'status') = 'missing'      then 'Insurance Missing'
          when (dr.reg->>'status') = 'missing'      then 'Registration Missing'
          when (dr.ins->>'status') = 'expiring_soon' then
            'Insurance Expires in ' || (dr.ins->>'days_until') || (case when (dr.ins->>'days_until') = '1' then ' Day' else ' Days' end)
          when (dr.reg->>'status') = 'expiring_soon' then
            'Registration Expires in ' || (dr.reg->>'days_until') || (case when (dr.reg->>'days_until') = '1' then ' Day' else ' Days' end)
          else null
        end
      )
    ) || jsonb_build_object(
      -- ── FEM / VORR decoration ──────────────────────────────────────
      'last_deployed_at',   dep.last_deployed,
      'days_since_deployed',
        case when dep.last_deployed is null then null
             else (current_date - dep.last_deployed)::int end,
      'fem_status',
        case
          when coalesce(vh.is_branded, true) = false                  then 'excluded'
          when coalesce(vh.operational_status,'operational') = 'grounded' then 'excluded'
          when dep.last_deployed is null                              then 'violation'
          when (current_date - dep.last_deployed) >= 14               then 'violation'
          when (current_date - dep.last_deployed) >= 11               then 'at_risk'
          when (current_date - dep.last_deployed) >=  7               then 'warning'
          else 'healthy'
        end,

      -- ── Grounding / RO drill-down for VORR ─────────────────────────
      'grounded_since',     ge.grounded_at,
      'grounded_reason',    ge.reason,
      'grounded_category',  ge.category,
      'expected_return_on', ge.expected_return_on,
      'days_grounded',
        case when ge.grounded_at is null then null
             else greatest(0, (current_date - ge.grounded_at::date))::int end,
      'active_ro_code',     ro.code,
      'active_ro_status',   ro.status::text,
      'active_ro_eta',      ro.eta_at,
      'active_ro_vendor_name', vn.name
    ) v
    from public.vehicles vh
    left join public.stations st on st.id = vh.station_id
    left join doc_rolled dr on dr.vehicle_id = vh.id
    left join lateral (
      select a.driver_id,
             coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver') as name
      from public.vehicle_driver_assignments a
      join public.drivers d on d.id = a.driver_id
      where a.vehicle_id = vh.id and a.rank = 0
      limit 1
    ) pri on true
    left join lateral (
      select a.driver_id,
             coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver') as name
      from public.vehicle_driver_assignments a
      join public.drivers d on d.id = a.driver_id
      where a.vehicle_id = vh.id and a.rank > 0
      order by a.rank
      limit 1
    ) bkp on true
    left join lateral (
      select greatest(count(*)::int - 1, 0) as backup_count
      from public.vehicle_driver_assignments
      where vehicle_id = vh.id
    ) ch on true
    left join lateral (
      select count(*)::int as cnt
      from public.vehicle_issues
      where vehicle_id = vh.id and status <> 'completed'
    ) oi on true
    left join lateral (
      select count(*)::int as cnt
      from public.vehicle_issues
      where vehicle_id = vh.id and status <> 'completed' and source = 'driver_self_report'
    ) dri on true
    left join lateral (
      select private.vehicle_last_deployed(vh.id) as last_deployed
    ) dep on true
    left join lateral (
      select grounded_at, reason, category, expected_return_on
      from public.vehicle_grounding_events
      where vehicle_id = vh.id and ungrounded_at is null
      order by grounded_at desc
      limit 1
    ) ge on true
    left join lateral (
      select ro2.code, ro2.status, ro2.eta_at, ro2.vendor_id
      from public.repair_orders ro2
      where ro2.vehicle_id = vh.id
        and ro2.status not in ('completed','cancelled')
      order by ro2.opened_at desc
      limit 1
    ) ro on true
    left join public.vendors vn on vn.id = ro.vendor_id
    where vh.dsp_id = private.current_dsp_id()
      and vh.archived_at is null
      and private.is_staff(vh.dsp_id, 'dispatcher')
  ) t;
$$;
grant execute on function public.vehicles_roster() to authenticated;


-- ── 6 · fleet_execution_summary(p_station_id) ───────────────────────
-- 0302 body + optional station filter over the roster slice. No-arg
-- calls resolve via the default (DSP-wide, byte-identical to before).
drop function if exists public.fleet_execution_summary();
create or replace function public.fleet_execution_summary(p_station_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_roster jsonb;
  v_branded jsonb;
  v_fem_in_scope jsonb;
  v_compliant int;
  v_warning int;
  v_at_risk int;
  v_violation int;
  v_excluded_grounded int;
  v_excluded_non_branded int;
  v_total_in_scope int;
  v_fem_pct numeric;
  v_active int;
  v_grounded int;
  v_total_branded int;
  v_vorr_pct numeric;
  v_vorr_status text;
  v_fem_vans jsonb;
  v_grounded_vans jsonb;
  v_recs jsonb := '[]'::jsonb;
  v_long_grounded int;
  v_next_at_risk jsonb;
  v_rental_count int;
  v_rental_pct numeric;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_roster := public.vehicles_roster();

  -- Optional station lens (the sidebar switcher): scope every metric to
  -- one station's vans. Null = DSP-wide = identical to the old no-arg.
  if p_station_id is not null then
    select coalesce(jsonb_agg(v), '[]'::jsonb) into v_roster
      from jsonb_array_elements(v_roster) v
      where v->>'station_id' = p_station_id::text;
  end if;

  select coalesce(jsonb_agg(v), '[]'::jsonb) into v_branded
    from jsonb_array_elements(v_roster) v
    where (v->>'is_branded')::boolean is true
      and coalesce(v->>'status','active') in ('active','spare');

  select coalesce(jsonb_agg(v), '[]'::jsonb) into v_fem_in_scope
    from jsonb_array_elements(v_branded) v
    where coalesce(v->>'operational_status','operational') <> 'grounded';

  select
    count(*) filter (where v->>'fem_status' = 'healthy')::int,
    count(*) filter (where v->>'fem_status' = 'warning')::int,
    count(*) filter (where v->>'fem_status' = 'at_risk')::int,
    count(*) filter (where v->>'fem_status' = 'violation')::int,
    count(*)::int
  into v_compliant, v_warning, v_at_risk, v_violation, v_total_in_scope
  from jsonb_array_elements(v_fem_in_scope) v;

  select
    count(*) filter (where coalesce(v->>'operational_status','operational') = 'grounded')::int,
    count(*) filter (where (v->>'is_branded')::boolean is false)::int
  into v_excluded_grounded, v_excluded_non_branded
  from jsonb_array_elements(v_roster) v;

  v_fem_pct := case when v_total_in_scope = 0 then null
                    else round(((v_compliant + v_warning + v_at_risk)::numeric / v_total_in_scope) * 100, 1) end;

  select
    count(*) filter (where coalesce(v->>'operational_status','operational') <> 'grounded')::int,
    count(*) filter (where coalesce(v->>'operational_status','operational') = 'grounded')::int,
    count(*)::int
  into v_active, v_grounded, v_total_branded
  from jsonb_array_elements(v_branded) v;

  v_vorr_pct := case when v_total_branded = 0 then null
                     else round((v_active::numeric / v_total_branded) * 100, 1) end;
  v_vorr_status := case
    when v_vorr_pct is null      then 'healthy'
    when v_vorr_pct >= 95        then 'healthy'
    when v_vorr_pct >= 90        then 'warning'
    else                              'critical'
  end;

  select coalesce(jsonb_agg(v order by
            case when v->>'days_since_deployed' is null then 1 else 0 end,
            ((v->>'days_since_deployed')::int) desc nulls last,
            v->>'name'), '[]'::jsonb)
  into v_fem_vans
  from jsonb_array_elements(v_fem_in_scope) v
  where v->>'fem_status' in ('warning','at_risk','violation');

  select coalesce(jsonb_agg(v order by
            case when v->>'days_grounded' is null then 1 else 0 end,
            ((v->>'days_grounded')::int) desc nulls last,
            v->>'name'), '[]'::jsonb)
  into v_grounded_vans
  from jsonb_array_elements(v_branded) v
  where coalesce(v->>'operational_status','operational') = 'grounded';

  if v_violation > 0 then
    v_recs := v_recs || jsonb_build_object(
      'kind','fem_violation','severity','critical',
      'message', v_violation || ' van' || (case when v_violation = 1 then '' else 's' end)
                 || ' in FEM violation — deploy immediately.'
    );
  end if;

  if v_at_risk > 0 then
    v_recs := v_recs || jsonb_build_object(
      'kind','fem_at_risk','severity','warning',
      'message', v_at_risk || ' van' || (case when v_at_risk = 1 then '' else 's' end)
                 || ' approaching FEM violation (3 days or less).'
    );
  end if;

  select to_jsonb(v) into v_next_at_risk
  from jsonb_array_elements(v_fem_in_scope) v
  where v->>'fem_status' in ('at_risk','warning')
  order by ((v->>'days_since_deployed')::int) desc nulls last
  limit 1;
  if v_next_at_risk is not null then
    v_recs := v_recs || jsonb_build_object(
      'kind','fem_next_deploy','severity','info',
      'message', 'Deploy ' || coalesce(v_next_at_risk->>'name', 'next at-risk van')
                 || ' tomorrow to protect FEM compliance.'
    );
  end if;

  if v_vorr_pct is not null and v_vorr_pct < 90 then
    v_recs := v_recs || jsonb_build_object(
      'kind','vorr_critical','severity','critical',
      'message','VORR below 90% — review grounded fleet to recover readiness.'
    );
  elsif v_vorr_pct is not null and v_vorr_pct < 95 then
    v_recs := v_recs || jsonb_build_object(
      'kind','vorr_warning','severity','warning',
      'message','Current grounding trend may push VORR below 90%.'
    );
  end if;

  select count(*)::int into v_long_grounded
  from jsonb_array_elements(v_grounded_vans) v
  where (v->>'days_grounded')::int >= 14;
  if v_long_grounded > 0 then
    v_recs := v_recs || jsonb_build_object(
      'kind','long_grounded','severity','warning',
      'message', v_long_grounded || ' van' || (case when v_long_grounded = 1 then '' else 's' end)
                 || ' grounded over 14 days — escalate with vendor.'
    );
  end if;

  select count(*) filter (where v->>'ownership' = 'rental')::int into v_rental_count
  from jsonb_array_elements(v_branded) v;
  v_rental_pct := case when v_total_branded = 0 then 0
                       else (v_rental_count::numeric / v_total_branded) * 100 end;
  if v_rental_pct >= 15 then
    v_recs := v_recs || jsonb_build_object(
      'kind','rental_dependency','severity','info',
      'message','Rental dependency at ' || round(v_rental_pct, 0)
                || '% of branded fleet — monitor return targets.'
    );
  end if;

  return jsonb_build_object(
    'fem', jsonb_build_object(
      'percent',               v_fem_pct,
      'compliant',             v_compliant + v_warning + v_at_risk,
      'healthy',               v_compliant,
      'warning',               v_warning,
      'at_risk',               v_at_risk,
      'violation',             v_violation,
      'excluded_grounded',     v_excluded_grounded,
      'excluded_non_branded',  v_excluded_non_branded,
      'total_in_scope',        v_total_in_scope,
      'vans',                  v_fem_vans
    ),
    'vorr', jsonb_build_object(
      'percent',          v_vorr_pct,
      'active',           v_active,
      'grounded',         v_grounded,
      'total_branded',    v_total_branded,
      'threshold_status', v_vorr_status,
      'grounded_vans',    v_grounded_vans
    ),
    'recommendations', v_recs,
    'generated_at',    now()
  );
end;
$$;
grant execute on function public.fleet_execution_summary(uuid) to authenticated;


-- ── 7 · Preventive maintenance: rules + completions ─────────────────

create table if not exists public.fleet_pm_rules (
  id              uuid        primary key default gen_random_uuid(),
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  name            text        not null,
  interval_miles  int         check (interval_miles is null or interval_miles > 0),
  interval_months int         check (interval_months is null or interval_months > 0),
  warn_miles      int         not null default 500 check (warn_miles >= 0),
  warn_days       int         not null default 14 check (warn_days >= 0),
  van_type        text        check (van_type is null or van_type in ('edv','step_van','cargo_van','box_truck')),
  active          boolean     not null default true,
  sort_order      int         not null default 100,
  notes           text,
  created_by      uuid        references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint fleet_pm_rules_interval_check
    check (interval_miles is not null or interval_months is not null)
);
create index if not exists fleet_pm_rules_dsp_idx
  on public.fleet_pm_rules (dsp_id, active, sort_order);

create table if not exists public.fleet_pm_completions (
  id           uuid        primary key default gen_random_uuid(),
  dsp_id       uuid        not null references public.dsps(id) on delete cascade,
  vehicle_id   uuid        not null references public.vehicles(id) on delete cascade,
  rule_id      uuid        not null references public.fleet_pm_rules(id) on delete cascade,
  completed_on date        not null default current_date,
  mileage      int         check (mileage is null or mileage >= 0),
  cost_cents   int         check (cost_cents is null or cost_cents >= 0),
  vendor       text,
  notes        text,
  source       text        not null default 'manual',
  created_by   uuid        references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists fleet_pm_completions_vehicle_idx
  on public.fleet_pm_completions (vehicle_id, rule_id, completed_on desc);
create index if not exists fleet_pm_completions_dsp_idx
  on public.fleet_pm_completions (dsp_id, completed_on desc);

alter table public.fleet_pm_rules       enable row level security;
alter table public.fleet_pm_completions enable row level security;

drop policy if exists fleet_pm_rules_tenant_select on public.fleet_pm_rules;
create policy fleet_pm_rules_tenant_select
  on public.fleet_pm_rules for select
  using (dsp_id = private.current_dsp_id());
drop policy if exists fleet_pm_rules_staff_write on public.fleet_pm_rules;
create policy fleet_pm_rules_staff_write
  on public.fleet_pm_rules for all
  using      (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists fleet_pm_completions_tenant_select on public.fleet_pm_completions;
create policy fleet_pm_completions_tenant_select
  on public.fleet_pm_completions for select
  using (dsp_id = private.current_dsp_id());
drop policy if exists fleet_pm_completions_staff_write on public.fleet_pm_completions;
create policy fleet_pm_completions_staff_write
  on public.fleet_pm_completions for all
  using      (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

grant select, insert, update, delete on public.fleet_pm_rules       to authenticated;
grant select, insert, update, delete on public.fleet_pm_completions to authenticated;


-- Install a standard PM program (skips names that already exist, so a
-- DSP can re-run safely and keep its customizations).
create or replace function public.fleet_pm_install_defaults()
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_n int := 0;
  r record;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  for r in
    select * from (values
      ('Oil & filter change',    6000::int,  6::int, 500::int, 14::int, 10::int),
      ('Tire rotation',          7500,       6,      500,      14,      20),
      ('Brake inspection',      15000,      12,      750,      21,      30),
      ('Coolant & fluids check',15000,      12,      750,      21,      40),
      ('DOT annual inspection',  null,      12,        0,      30,      50)
    ) as d(name, interval_miles, interval_months, warn_miles, warn_days, sort_order)
  loop
    if not exists (select 1 from public.fleet_pm_rules p where p.dsp_id = v_dsp and lower(p.name) = lower(r.name)) then
      insert into public.fleet_pm_rules
        (dsp_id, name, interval_miles, interval_months, warn_miles, warn_days, sort_order, created_by)
      values (v_dsp, r.name, r.interval_miles, r.interval_months,
              coalesce(r.warn_miles, 500), coalesce(r.warn_days, 14), r.sort_order, auth.uid());
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
grant execute on function public.fleet_pm_install_defaults() to authenticated;


-- Create/update one PM rule.
create or replace function public.fleet_pm_rule_save(
  p_id              uuid    default null,
  p_name            text    default null,
  p_interval_miles  int     default null,
  p_interval_months int     default null,
  p_warn_miles      int     default null,
  p_warn_days       int     default null,
  p_van_type        text    default null,
  p_active          boolean default true,
  p_notes           text    default null,
  p_sort_order      int     default null
) returns public.fleet_pm_rules
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.fleet_pm_rules;
  v_vt text := nullif(trim(coalesce(p_van_type, '')), '');
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if p_interval_miles is null and p_interval_months is null then
    raise exception 'interval_required' using errcode = '22023';
  end if;
  if v_vt is not null and v_vt not in ('edv','step_van','cargo_van','box_truck') then
    raise exception 'bad_van_type' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.fleet_pm_rules
      (dsp_id, name, interval_miles, interval_months, warn_miles, warn_days,
       van_type, active, notes, sort_order, created_by)
    values
      (v_dsp, trim(p_name), p_interval_miles, p_interval_months,
       coalesce(p_warn_miles, 500), coalesce(p_warn_days, 14),
       v_vt, coalesce(p_active, true), nullif(trim(coalesce(p_notes,'')), ''),
       coalesce(p_sort_order, 100), auth.uid())
    returning * into v_row;
  else
    update public.fleet_pm_rules set
      name            = trim(p_name),
      interval_miles  = p_interval_miles,
      interval_months = p_interval_months,
      warn_miles      = coalesce(p_warn_miles, warn_miles),
      warn_days       = coalesce(p_warn_days, warn_days),
      van_type        = v_vt,
      active          = coalesce(p_active, true),
      notes           = nullif(trim(coalesce(p_notes,'')), ''),
      sort_order      = coalesce(p_sort_order, sort_order),
      updated_at      = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then raise exception 'rule_not_found' using errcode = 'P0002'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.fleet_pm_rule_save(
  uuid, text, int, int, int, int, text, boolean, text, int
) to authenticated;


-- Log a PM completion. Feeds the mileage ledger (source 'service') and
-- bumps vehicles.last_service_at so the legacy fields stay truthful.
create or replace function public.fleet_pm_log_completion(
  p_vehicle_id   uuid,
  p_rule_id      uuid,
  p_completed_on date default current_date,
  p_mileage      int  default null,
  p_cost_cents   int  default null,
  p_vendor       text default null,
  p_notes        text default null
) returns public.fleet_pm_completions
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.fleet_pm_completions;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.vehicles v where v.id = p_vehicle_id and v.dsp_id = v_dsp) then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.fleet_pm_rules r where r.id = p_rule_id and r.dsp_id = v_dsp) then
    raise exception 'rule_not_found' using errcode = 'P0002';
  end if;

  insert into public.fleet_pm_completions
    (dsp_id, vehicle_id, rule_id, completed_on, mileage, cost_cents, vendor, notes, source, created_by)
  values
    (v_dsp, p_vehicle_id, p_rule_id, coalesce(p_completed_on, current_date),
     p_mileage, p_cost_cents,
     nullif(trim(coalesce(p_vendor,'')), ''), nullif(trim(coalesce(p_notes,'')), ''),
     'manual', auth.uid())
  returning * into v_row;

  if p_mileage is not null then
    begin
      perform public.vehicle_mileage_log_save(
        p_vehicle_id, p_mileage,
        coalesce(p_completed_on, current_date)::timestamptz, 'service');
    exception when others then null;  -- best-effort; the completion row is the record
    end;
  end if;

  update public.vehicles
     set last_service_at = greatest(coalesce(last_service_at, v_row.completed_on), v_row.completed_on),
         updated_at      = now()
   where id = p_vehicle_id and dsp_id = v_dsp;

  return v_row;
end;
$$;
grant execute on function public.fleet_pm_log_completion(
  uuid, uuid, date, int, int, text, text
) to authenticated;


-- The due/overdue engine. Per dispatchable vehicle × applicable active
-- rule: latest completion, next due (date and/or miles), and a status:
--   no_baseline — never completed (or the completion can't anchor any
--                 configured axis, e.g. a miles-only rule logged with
--                 no odometer reading)
--   overdue     — past the due date OR past the due mileage
--   due_soon    — inside the rule's warn window on either axis
--   ok          — otherwise
-- Mirrored in dashboard/fleet-pm-core.mjs — keep the two in sync.
create or replace function public.fleet_pm_board(p_station_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_rules jsonb;
  v_vehicles jsonb;
  v_summary jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'name', r.name,
           'interval_miles', r.interval_miles, 'interval_months', r.interval_months,
           'warn_miles', r.warn_miles, 'warn_days', r.warn_days,
           'van_type', r.van_type, 'active', r.active,
           'sort_order', r.sort_order, 'notes', r.notes
         ) order by r.sort_order, r.name), '[]'::jsonb)
    into v_rules
    from public.fleet_pm_rules r
   where r.dsp_id = v_dsp and r.active;

  with veh as (
    select v.*
    from public.vehicles v
    where v.dsp_id = v_dsp
      and v.archived_at is null
      and v.status in ('active','spare')
      and (p_station_id is null or v.station_id = p_station_id)
  ),
  pairs as (
    select v.id as vehicle_id,
           r.id as rule_id, r.name as rule_name, r.sort_order,
           r.interval_miles, r.interval_months, r.warn_miles, r.warn_days,
           v.mileage as current_miles,
           lc.completed_on as last_done_on,
           lc.mileage      as last_done_miles
    from veh v
    join public.fleet_pm_rules r
      on r.dsp_id = v_dsp and r.active
     and (r.van_type is null or r.van_type = v.van_type)
    left join lateral (
      select c.completed_on, c.mileage
      from public.fleet_pm_completions c
      where c.vehicle_id = v.id and c.rule_id = r.id
      order by c.completed_on desc, c.created_at desc
      limit 1
    ) lc on true
  ),
  calc as (
    select p.*,
      case when p.last_done_on is not null and p.interval_months is not null
           then (p.last_done_on + make_interval(months => p.interval_months))::date end as due_on,
      case when p.last_done_miles is not null and p.interval_miles is not null
           then p.last_done_miles + p.interval_miles end as due_miles
    from pairs p
  ),
  scored as (
    select c.*,
      case
        when c.last_done_on is null then 'no_baseline'
        when c.due_on is null and c.due_miles is null then 'no_baseline'
        when (c.due_on is not null and current_date > c.due_on)
          or (c.due_miles is not null and c.current_miles is not null and c.current_miles > c.due_miles)
          then 'overdue'
        when (c.due_on is not null and current_date >= c.due_on - c.warn_days)
          or (c.due_miles is not null and c.current_miles is not null and c.current_miles >= c.due_miles - c.warn_miles)
          then 'due_soon'
        else 'ok'
      end as status
    from calc c
  )
  select
    coalesce(jsonb_agg(vrow order by vrow->>'name'), '[]'::jsonb),
    jsonb_build_object(
      'overdue',     coalesce(sum((vrow->>'n_overdue')::int), 0),
      'due_soon',    coalesce(sum((vrow->>'n_due_soon')::int), 0),
      'no_baseline', coalesce(sum((vrow->>'n_no_baseline')::int), 0),
      'ok',          coalesce(sum((vrow->>'n_ok')::int), 0),
      'vehicles_overdue', count(*) filter (where vrow->>'worst' = 'overdue')
    )
  into v_vehicles, v_summary
  from (
    select jsonb_build_object(
      'id', v.id, 'name', v.name, 'nickname', v.nickname,
      'van_type', v.van_type,
      'station_id', v.station_id, 'station_code', st.code,
      'operational_status', v.operational_status,
      'mileage', v.mileage, 'mileage_updated_at', v.mileage_updated_at,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'rule_id', s.rule_id, 'rule_name', s.rule_name,
                 'last_done_on', s.last_done_on, 'last_done_miles', s.last_done_miles,
                 'due_on', s.due_on, 'due_miles', s.due_miles,
                 'days_remaining',  case when s.due_on is not null then (s.due_on - current_date) end,
                 'miles_remaining', case when s.due_miles is not null and s.current_miles is not null
                                         then s.due_miles - s.current_miles end,
                 'status', s.status
               ) order by s.sort_order, s.rule_name)
        from scored s where s.vehicle_id = v.id), '[]'::jsonb),
      'worst', (
        select case min(case s.status when 'overdue' then 1 when 'due_soon' then 2
                                      when 'no_baseline' then 3 when 'ok' then 4 end)
                 when 1 then 'overdue' when 2 then 'due_soon'
                 when 3 then 'no_baseline' when 4 then 'ok' end
        from scored s where s.vehicle_id = v.id),
      'n_overdue',     (select count(*) from scored s where s.vehicle_id = v.id and s.status = 'overdue'),
      'n_due_soon',    (select count(*) from scored s where s.vehicle_id = v.id and s.status = 'due_soon'),
      'n_no_baseline', (select count(*) from scored s where s.vehicle_id = v.id and s.status = 'no_baseline'),
      'n_ok',          (select count(*) from scored s where s.vehicle_id = v.id and s.status = 'ok')
    ) as vrow
    from veh v
    left join public.stations st on st.id = v.station_id
  ) t;

  return jsonb_build_object(
    'rules',    v_rules,
    'vehicles', v_vehicles,
    'summary',  coalesce(v_summary, jsonb_build_object(
                  'overdue',0,'due_soon',0,'no_baseline',0,'ok',0,'vehicles_overdue',0)),
    'generated_at', now()
  );
end;
$$;
grant execute on function public.fleet_pm_board(uuid) to authenticated;


-- ── 8 · vehicle_cost_summary: per-van spend + cost-per-mile ─────────
-- Sources: settled Repair Center invoices (via the case's vehicle),
-- completed legacy repair_orders NOT linked to a case (no double
-- count), vehicle_service_logs, PM completions, and part_purchases.
-- Optional tables (0485/0486/0491 may be unapplied) fail soft to 0.
create or replace function public.vehicle_cost_summary(
  p_vehicle_id uuid,
  p_months     int default 12
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_from date := (current_date - make_interval(months => greatest(coalesce(p_months, 12), 1)))::date;
  v_repair bigint := 0;   v_repair_n int := 0;
  v_ro bigint := 0;       v_ro_n int := 0;
  v_service bigint := 0;  v_service_n int := 0;
  v_pm bigint := 0;       v_pm_n int := 0;
  v_parts bigint := 0;    v_parts_n int := 0;
  v_stock bigint := 0;    v_stock_n int := 0;
  v_first_mi int; v_last_mi int; v_miles int;
  v_total bigint;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.vehicles v where v.id = p_vehicle_id and v.dsp_id = v_dsp) then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;

  begin
    select coalesce(sum(i.grand_total_cents), 0), count(*)::int
      into v_repair, v_repair_n
      from public.repair_invoices i
      join public.repair_cases rc on rc.id = i.repair_case_id
     where rc.dsp_id = v_dsp and rc.vehicle_id = p_vehicle_id
       and i.status = 'settled'
       and coalesce(i.settled_at, i.created_at)::date >= v_from;
  exception when undefined_table then null; end;

  begin
    select coalesce(sum(ro.cost_cents), 0), count(*) filter (where ro.cost_cents is not null)::int
      into v_ro, v_ro_n
      from public.repair_orders ro
     where ro.dsp_id = v_dsp and ro.vehicle_id = p_vehicle_id
       and ro.status = 'completed'
       and coalesce(ro.completed_at, ro.opened_at)::date >= v_from
       and not exists (select 1 from public.repair_cases rc2 where rc2.repair_order_id = ro.id);
  exception when undefined_table then null; end;

  select coalesce(sum(l.cost_cents), 0), count(*) filter (where l.cost_cents is not null)::int
    into v_service, v_service_n
    from public.vehicle_service_logs l
   where l.dsp_id = v_dsp and l.vehicle_id = p_vehicle_id
     and l.occurred_at >= v_from;

  select coalesce(sum(c.cost_cents), 0), count(*) filter (where c.cost_cents is not null)::int
    into v_pm, v_pm_n
    from public.fleet_pm_completions c
   where c.dsp_id = v_dsp and c.vehicle_id = p_vehicle_id
     and c.completed_on >= v_from;

  begin
    select coalesce(sum(coalesce(pp.final_cost_cents, 0) + coalesce(pp.labor_cost_cents, 0)), 0),
           count(*)::int
      into v_parts, v_parts_n
      from public.part_purchases pp
     where pp.dsp_id = v_dsp and pp.vehicle_id = p_vehicle_id
       and pp.status not in ('returned','cancelled')
       and pp.created_at::date >= v_from;
  exception when undefined_table then null; end;

  -- Shelf stock consumed on this van (0540): consume rows are negative
  -- deltas priced at the item's moving-average cost captured on the
  -- movement; returns net back out. Table may not exist yet — soft 0.
  begin
    select coalesce(sum((-m.qty_delta)::bigint * coalesce(m.unit_cost_cents, 0)), 0),
           count(*) filter (where m.kind = 'consume')::int
      into v_stock, v_stock_n
      from public.parts_stock_movements m
     where m.dsp_id = v_dsp and m.vehicle_id = p_vehicle_id
       and m.kind in ('consume','return')
       and m.created_at::date >= v_from;
  exception when undefined_table then null; end;
  v_stock := greatest(v_stock, 0);

  select min(m.mileage), max(m.mileage)
    into v_first_mi, v_last_mi
    from public.vehicle_mileage_log m
   where m.dsp_id = v_dsp and m.vehicle_id = p_vehicle_id
     and m.reading_at::date >= v_from;
  v_miles := case when v_first_mi is null then null else greatest(v_last_mi - v_first_mi, 0) end;

  v_total := v_repair + v_ro + v_service + v_pm + v_parts + v_stock;

  return jsonb_build_object(
    'window_months',       greatest(coalesce(p_months, 12), 1),
    'repair_cents',        v_repair,      'repair_count',  v_repair_n,
    'legacy_ro_cents',     v_ro,          'legacy_ro_count', v_ro_n,
    'service_cents',       v_service,     'service_count', v_service_n,
    'pm_cents',            v_pm,          'pm_count',      v_pm_n,
    'parts_cents',         v_parts,       'parts_count',   v_parts_n,
    'stock_cents',         v_stock,       'stock_count',   v_stock_n,
    'total_cents',         v_total,
    'miles_driven',        v_miles,
    'cost_per_mile_cents', case when v_miles is not null and v_miles > 0
                                then round(v_total::numeric / v_miles, 1) end,
    'generated_at',        now()
  );
end;
$$;
grant execute on function public.vehicle_cost_summary(uuid, int) to authenticated;


notify pgrst, 'reload schema';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0539_fleet_inventory_foundation.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
