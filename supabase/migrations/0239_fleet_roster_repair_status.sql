-- Migration 0239 · Fleet roster shows the two repair clocks + an
-- inline RO-number entry box.
--
-- Extends vehicles_roster to return the active RO (if any) so the UI
-- can render two labelled countdowns next to a grounded van:
--
--   · "RO due"     — 2 business days from grounding
--   · "Repair due" — 14 business days from grounding
--
-- Adds vehicle_quick_set_ro_code so the dispatcher can type an RO
-- number directly into the roster row without opening the full
-- Fleet → Issues flow.  The RPC find-or-creates a draft repair_orders
-- row for the vehicle and sets its code.
--
-- Idempotent.

-- ── 1. vehicles_roster · include the active RO ──────────────────────
create or replace function public.vehicles_roster()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(v order by v->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',                 vh.id,
      'name',               vh.name,
      'nickname',           vh.nickname,
      'kind',               vh.kind,
      'status',             vh.status,
      'ownership',          vh.ownership,
      'operational_status', vh.operational_status,
      'grounded_since',     ge.grounded_at,
      'grounded_reason',    ge.reason,
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
      'backup_count',       coalesce(ch.backup_count, 0),
      'open_issue_count',   coalesce(oi.cnt, 0),
      -- NEW · most recent active RO for the vehicle (if any)
      'active_ro_id',       ro.id,
      'active_ro_code',     ro.code,
      'active_ro_status',   ro.status,
      'active_ro_opened_at',   ro.opened_at,
      'active_ro_scheduled_at',ro.scheduled_at,
      'active_ro_eta_at',      ro.eta_at,
      'active_ro_completed_at',ro.completed_at,
      'active_ro_vendor_name', vendor.name
    ) v
    from public.vehicles vh
    left join public.stations st on st.id = vh.station_id
    left join lateral (
      select a.driver_id,
             coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver') as name
      from public.vehicle_driver_assignments a
      join public.drivers d on d.id = a.driver_id
      where a.vehicle_id = vh.id and a.rank = 0
      limit 1
    ) pri on true
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
      select grounded_at, reason
      from public.vehicle_grounding_events
      where vehicle_id = vh.id and ungrounded_at is null
      order by grounded_at desc
      limit 1
    ) ge on true
    left join lateral (
      select * from public.repair_orders
      where vehicle_id = vh.id and status not in ('completed','cancelled')
      order by opened_at desc
      limit 1
    ) ro on true
    left join public.vendors vendor on vendor.id = ro.vendor_id
    where vh.dsp_id = private.current_dsp_id()
      and vh.archived_at is null
      and private.is_staff(vh.dsp_id, 'dispatcher')
  ) t;
$$;
grant execute on function public.vehicles_roster() to authenticated;


-- ── 2. vehicle_quick_set_ro_code ────────────────────────────────────
-- Inline RO-number entry from the Fleet roster.  Find-or-create a
-- draft repair_orders row for this vehicle and set its code.  Trims
-- and rejects empty input.  Returns the resulting RO row.
create or replace function public.vehicle_quick_set_ro_code(
  p_vehicle_id uuid,
  p_code       text
) returns public.repair_orders
language plpgsql security definer set search_path = public
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_ro public.repair_orders;
  v_code text := nullif(btrim(p_code), '');
  v_vehicle public.vehicles;
begin
  if v_code is null then
    raise exception 'ro_code_required' using errcode = '22023';
  end if;

  select * into v_vehicle
    from public.vehicles
   where id = p_vehicle_id and dsp_id = v_dsp and archived_at is null;
  if not found then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;

  -- Try to update the vehicle's existing open RO first.
  update public.repair_orders set
    code = v_code, updated_at = now()
   where vehicle_id = p_vehicle_id
     and dsp_id = v_dsp
     and status not in ('completed','cancelled')
   returning * into v_ro;

  if not found then
    -- No open RO yet · create a draft with this code.
    insert into public.repair_orders
      (dsp_id, vehicle_id, code, summary, status, opened_at, created_by)
    values (
      v_dsp, p_vehicle_id, v_code,
      coalesce('RO ' || v_code, 'Repair'),
      'draft', now(), auth.uid()
    )
    returning * into v_ro;
  end if;

  -- Audit
  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (
    v_dsp, 'user', auth.uid(), 'ro_code_set',
    'RO code set to ' || v_code || ' for ' || coalesce(v_vehicle.nickname, v_vehicle.name, '(unnamed)'),
    null, 'repair_order', v_ro.id
  );

  return v_ro;
end;
$$;
grant execute on function public.vehicle_quick_set_ro_code(uuid, text) to authenticated;
