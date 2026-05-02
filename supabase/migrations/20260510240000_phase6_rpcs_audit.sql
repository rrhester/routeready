-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510240000 · Phase 6 RPCs + audit
-- assign_asset (close prior open assignment, open new), return_asset,
-- record_maintenance, bulk_import_vehicles. Plus audit triggers.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── assign_asset: close open assignment, open new ──────────────────────

create or replace function public.assign_asset(
  p_asset_id     uuid,
  p_driver_id    uuid    default null,
  p_vehicle_id   uuid    default null,
  p_notes        text    default null
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
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'assign_asset: caller is not staff';
  end if;

  if p_driver_id is null and p_vehicle_id is null then
    raise exception 'assign_asset: must provide driver_id or vehicle_id';
  end if;

  -- Verify asset belongs to this DSP
  perform 1 from public.assets where id = p_asset_id and dsp_id = v_dsp;
  if not found then
    raise exception 'assign_asset: asset % not in DSP %', p_asset_id, v_dsp;
  end if;

  -- Auto-close prior open assignment for this asset (if any)
  update public.asset_assignments
     set returned_at = now(),
         notes = coalesce(notes, '') ||
                 case when notes is null or notes = '' then '' else ' · ' end ||
                 'Auto-closed when reassigned'
   where asset_id = p_asset_id and returned_at is null;

  insert into public.asset_assignments
    (dsp_id, asset_id, driver_id, vehicle_id, notes, assigned_by)
  values
    (v_dsp, p_asset_id, p_driver_id, p_vehicle_id, p_notes, v_caller)
  returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.assign_asset(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.assign_asset(uuid, uuid, uuid, text) to authenticated;

-- ─── return_asset ──────────────────────────────────────────────────────

create or replace function public.return_asset(
  p_assignment_id      uuid,
  p_condition_on_return text default null,
  p_notes              text default null
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'return_asset: caller is not staff';
  end if;

  update public.asset_assignments
     set returned_at         = now(),
         condition_on_return = coalesce(p_condition_on_return, condition_on_return),
         notes               = coalesce(notes,'') ||
                               case when notes is null or notes = '' then '' else ' · ' end ||
                               coalesce(p_notes, 'Returned')
   where id = p_assignment_id and dsp_id = v_dsp and returned_at is null;

  if not found then
    raise exception 'return_asset: assignment % not in DSP % or already closed', p_assignment_id, v_dsp;
  end if;
end $$;

revoke execute on function public.return_asset(uuid, text, text) from public, anon;
grant execute on function public.return_asset(uuid, text, text) to authenticated;

-- ─── record_maintenance ────────────────────────────────────────────────

create or replace function public.record_maintenance(
  p_vehicle_id     uuid,
  p_service_type   text,
  p_performed_at   date,
  p_mileage        int     default null,
  p_cost_cents     int     default null,
  p_vendor         text    default null,
  p_notes          text    default null,
  p_attached_files text[]  default null
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
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'record_maintenance: caller is not staff';
  end if;

  perform 1 from public.vehicles where id = p_vehicle_id and dsp_id = v_dsp;
  if not found then
    raise exception 'record_maintenance: vehicle % not in DSP %', p_vehicle_id, v_dsp;
  end if;

  insert into public.maintenance_records
    (dsp_id, vehicle_id, service_type, performed_at, mileage,
     cost_cents, vendor, notes, attached_files, created_by)
  values
    (v_dsp, p_vehicle_id, p_service_type, p_performed_at, p_mileage,
     p_cost_cents, p_vendor, p_notes, p_attached_files, v_caller)
  returning id into v_id;

  -- Update vehicle mileage if provided + newer
  if p_mileage is not null then
    update public.vehicles
       set mileage = greatest(coalesce(mileage, 0), p_mileage),
           dot_inspection_at = case when p_service_type = 'dot_inspection'
                                    then p_performed_at else dot_inspection_at end
     where id = p_vehicle_id;
  end if;

  return v_id;
end $$;

revoke execute on function public.record_maintenance(uuid, text, date, int, int, text, text, text[]) from public, anon;
grant execute on function public.record_maintenance(uuid, text, date, int, int, text, text, text[]) to authenticated;

-- ─── bulk_import_vehicles ──────────────────────────────────────────────

create or replace function public.bulk_import_vehicles(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_caller     uuid := auth.uid();
  rec          jsonb;
  inserted_n   int := 0;
  skipped_n    int := 0;
  errs         jsonb := '[]'::jsonb;
  v_station_id uuid;
  v_van        text;
  i            int := 0;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'bulk_import_vehicles: ops only';
  end if;
  if jsonb_typeof(payload) <> 'array' then
    raise exception 'bulk_import_vehicles: payload must be a JSON array';
  end if;

  for rec in select * from jsonb_array_elements(payload)
  loop
    i := i + 1;
    begin
      v_van := nullif(trim(rec->>'van_number'), '');
      if v_van is null then
        skipped_n := skipped_n + 1;
        errs := errs || jsonb_build_object('row', i, 'reason', 'van_number required');
        continue;
      end if;

      v_station_id := null;
      if rec ? 'station_code' and (rec->>'station_code') is not null then
        select id into v_station_id from public.stations
         where dsp_id = v_dsp and code = rec->>'station_code';
        if v_station_id is null then
          errs := errs || jsonb_build_object('row', i, 'reason', 'unknown station_code: ' || (rec->>'station_code'));
        end if;
      end if;

      insert into public.vehicles
        (dsp_id, station_id, van_number, vin, plate, make, model, year,
         status, mileage, dot_inspection_at, created_by)
      values
        (v_dsp, v_station_id, v_van,
         nullif(trim(rec->>'vin'), ''),
         nullif(trim(rec->>'plate'), ''),
         nullif(trim(rec->>'make'), ''),
         nullif(trim(rec->>'model'), ''),
         nullif(rec->>'year', '')::int,
         coalesce(nullif(rec->>'status', '')::public.vehicle_status, 'active'),
         nullif(rec->>'mileage', '')::int,
         nullif(rec->>'dot_inspection_at', '')::date,
         v_caller);

      inserted_n := inserted_n + 1;
    exception when others then
      skipped_n := skipped_n + 1;
      errs := errs || jsonb_build_object('row', i, 'reason', sqlerrm);
    end;
  end loop;

  return jsonb_build_object(
    'inserted', inserted_n, 'skipped', skipped_n, 'errors', errs
  );
end $$;

revoke execute on function public.bulk_import_vehicles(jsonb) from public, anon;
grant execute on function public.bulk_import_vehicles(jsonb) to authenticated;

-- ─── Audit triggers ────────────────────────────────────────────────────

create trigger trg_audit_vehicles
  after insert or update or delete on public.vehicles
  for each row execute function private.fn_audit_log();

create trigger trg_audit_assets
  after insert or update or delete on public.assets
  for each row execute function private.fn_audit_log();

create trigger trg_audit_asset_assignments
  after insert or update or delete on public.asset_assignments
  for each row execute function private.fn_audit_log();

create trigger trg_audit_maintenance_records
  after insert or update or delete on public.maintenance_records
  for each row execute function private.fn_audit_log();

create trigger trg_audit_documents
  after insert or update or delete on public.documents
  for each row execute function private.fn_audit_log();
