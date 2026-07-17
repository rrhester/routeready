-- Migration 0489 · Repair Center — Phase 6: the In-Shop Tracker.
--
-- 0486 created repair_shop_visits and every READ projection (queue
-- promise clocks, shop-status pills, waiting-on-parts / past-promise
-- summary counts, the drawer's visit facts). This migration adds the
-- WRITE path — the visit lifecycle:
--
--   schedule → check in → status updates (diagnosing / awaiting auth /
--   parts hold / in repair / delayed / ready) → pickup → (existing)
--   return-to-service QC.
--
-- Design notes:
--   · One OPEN visit per case (picked_up_at is null); a comeback after
--     pickup starts a new row, so shop history stays honest.
--   · The promise clock is data, not vibes: promised_completion_at is
--     evented when first set, and every revision is evented with the
--     old date, the new date, and the delay reason. The queue's
--     overdue math (repair-engine.js promiseState) reads these fields
--     raw — durations are always derived, never stored.
--   · Stage/availability side effects go through the same rules as
--     repair_case_set_stage (only ALLOWED transitions are applied;
--     otherwise the stage is left alone and only the visit moves).
--   · Work-order identity + ETA mirror into the linked repair_orders
--     row so the older compliance clocks keep ticking (0486 §6 note).
--   · shop_status 'picked_up' can NOT be set through the generic
--     update — repair_visit_pickup owns it, keeping timestamps sane.
--
-- New RPCs:  repair_visit_schedule, repair_visit_checkin,
--            repair_visit_update, repair_visit_pickup
-- Replaced:  repair_case_return_to_service (now also closes the open
--            visit, so direct return-to-service can't strand one)
--
-- Idempotent: safe to re-run in the SQL Editor.

-- ═══════════════════════════ 1. Helpers ═════════════════════════════

-- Human label for a shop status (event messages; mirrors
-- SHOP_STATUS_LABEL in repair-engine.js).
create or replace function private._repair_shop_status_label(p text)
returns text
language sql
immutable
as $$
  select case p
    when 'awaiting_dropoff'       then 'Awaiting drop-off'
    when 'checked_in'             then 'Checked in'
    when 'diagnosing'             then 'Diagnosis in progress'
    when 'awaiting_authorization' then 'Awaiting authorization'
    when 'parts_hold'             then 'Waiting on parts'
    when 'in_repair'              then 'Repair in progress'
    when 'delayed'                then 'Delayed'
    when 'ready'                  then 'Ready for pickup'
    when 'picked_up'              then 'Picked up'
    else coalesce(p, '—')
  end;
$$;

-- The case's open visit (picked_up_at is null), or null row.
create or replace function private._repair_open_visit(p_case_id uuid)
returns public.repair_shop_visits
language sql
stable
as $$
  select * from public.repair_shop_visits
  where repair_case_id = p_case_id and picked_up_at is null
  order by created_at desc limit 1;
$$;

-- Apply a stage move ONLY when the transition is allowed; returns true
-- when applied. Mirrors repair_case_set_stage's side effects (single
-- code path for availability + timestamps + event).
create or replace function private._repair_stage_apply(
  p_dsp uuid, p_case_id uuid, p_from text, p_to text, p_message text
) returns boolean
language plpgsql
security definer set search_path = ''
as $$
begin
  if p_from = p_to then return false; end if;
  if not (p_to = any (public._repair_stage_next_allowed(p_from))) then
    return false;
  end if;
  update public.repair_cases set
    stage = p_to,
    availability = coalesce(public._repair_stage_availability(p_to), availability),
    actual_return_to_service_at =
      case when p_to = 'returned' and actual_return_to_service_at is null
           then now() else actual_return_to_service_at end,
    updated_at = now()
  where id = p_case_id;
  perform private.repair_case_event(
    p_dsp, p_case_id, 'stage_changed', p_message,
    p_from, p_to, 'system', false, true, '{}'::jsonb);
  return true;
end;
$$;

-- Mirror visit scheduling/ETA into the linked repair_orders row so the
-- pre-Repair-Center compliance clocks keep ticking.
create or replace function private._repair_visit_mirror_ro(p_case_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_case public.repair_cases;
  v_visit public.repair_shop_visits;
begin
  select * into v_case from public.repair_cases where id = p_case_id;
  if v_case.repair_order_id is null then return; end if;
  v_visit := private._repair_open_visit(p_case_id);
  if v_visit.id is null then return; end if;
  update public.repair_orders set
    vendor_id    = coalesce(v_visit.vendor_id, vendor_id),
    scheduled_at = coalesce(v_visit.appointment_at, scheduled_at),
    eta_at       = coalesce(v_visit.revised_completion_at,
                            v_visit.promised_completion_at, eta_at),
    status       = case when status in ('completed','cancelled') then status
                        when v_visit.shop_status = 'parts_hold' then 'awaiting_parts'
                        when v_visit.dropped_off_at is not null then 'in_progress'
                        when v_visit.appointment_at is not null then 'scheduled'
                        else status end,
    updated_at   = now()
  where id = v_case.repair_order_id;
end;
$$;


-- ═══════════════════════════ 2. repair_visit_schedule ═══════════════
-- Book the drop-off. Creates the open visit when none exists; a case
-- already at (or past) the shop refuses — that's an update, not a
-- schedule.
create or replace function public.repair_visit_schedule(
  p_case_id        uuid,
  p_appointment_at timestamptz,
  p_vendor_id      uuid default null,
  p_tow_provider   text default null,
  p_tow_reference  text default null,
  p_note           text default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_case public.repair_cases;
  v_visit public.repair_shop_visits;
  v_vendor public.vendors;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_appointment_at is null then
    raise exception 'appointment_required' using errcode = '22023';
  end if;
  select * into v_case from public.repair_cases
   where id = p_case_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if v_case.stage in ('closed','cancelled') then
    raise exception 'case_closed' using errcode = '22023';
  end if;

  select * into v_vendor from public.vendors
   where id = coalesce(p_vendor_id, v_case.vendor_id) and dsp_id = v_dsp;
  if v_vendor.id is null then
    raise exception 'vendor_required' using errcode = '22023';
  end if;
  if v_vendor.preferred_status = 'blocked' then
    raise exception 'vendor_blocked' using errcode = '22023';
  end if;

  v_visit := private._repair_open_visit(p_case_id);
  if v_visit.id is not null and v_visit.dropped_off_at is not null then
    raise exception 'already_at_shop' using errcode = '22023';
  end if;

  if v_visit.id is null then
    insert into public.repair_shop_visits
      (dsp_id, repair_case_id, vendor_id, repair_order_id, shop_status,
       appointment_at, tow_provider, tow_reference)
    values
      (v_dsp, p_case_id, v_vendor.id, v_case.repair_order_id, 'awaiting_dropoff',
       p_appointment_at,
       left(nullif(btrim(coalesce(p_tow_provider,'')),''), 120),
       left(nullif(btrim(coalesce(p_tow_reference,'')),''), 80))
    returning * into v_visit;
  else
    update public.repair_shop_visits set
      vendor_id      = v_vendor.id,
      appointment_at = p_appointment_at,
      tow_provider   = coalesce(left(nullif(btrim(coalesce(p_tow_provider,'')),''), 120), tow_provider),
      tow_reference  = coalesce(left(nullif(btrim(coalesce(p_tow_reference,'')),''), 80), tow_reference),
      updated_at     = now()
    where id = v_visit.id
    returning * into v_visit;
  end if;

  update public.repair_cases
     set vendor_id = v_vendor.id, updated_at = now()
   where id = p_case_id;

  perform private._repair_stage_apply(
    v_dsp, p_case_id, v_case.stage, 'scheduled', 'Drop-off scheduled');

  perform private.repair_case_event(
    v_dsp, p_case_id, 'visit_scheduled',
    'Drop-off scheduled at ' || v_vendor.name || ' · '
      || to_char(p_appointment_at, 'Dy, Mon FMDD · FMHH12:MI AM')
      || case when coalesce(btrim(p_note),'') = '' then '' else ' — ' || left(btrim(p_note), 200) end,
    null, null, 'dsp', false, false,
    jsonb_build_object('visit_id', v_visit.id, 'vendor_id', v_vendor.id,
                       'appointment_at', p_appointment_at));

  perform private._repair_visit_mirror_ro(p_case_id);

  return public.repair_case_get(p_case_id);
end;
$$;


-- ═══════════════════════════ 3. repair_visit_checkin ════════════════
-- The van is physically at the shop. Creates the visit when the van
-- went in unscheduled (tow-in, walk-in).
create or replace function public.repair_visit_checkin(
  p_case_id       uuid,
  p_dropped_off_at timestamptz default null,
  p_vendor_id     uuid default null,
  p_note          text default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_case public.repair_cases;
  v_visit public.repair_shop_visits;
  v_vendor public.vendors;
  v_when timestamptz := coalesce(p_dropped_off_at, now());
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_case from public.repair_cases
   where id = p_case_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if v_case.stage in ('closed','cancelled') then
    raise exception 'case_closed' using errcode = '22023';
  end if;

  v_visit := private._repair_open_visit(p_case_id);
  if v_visit.id is not null and v_visit.dropped_off_at is not null then
    raise exception 'already_checked_in' using errcode = '22023';
  end if;

  select * into v_vendor from public.vendors
   where id = coalesce(p_vendor_id, v_visit.vendor_id, v_case.vendor_id)
     and dsp_id = v_dsp;
  if v_vendor.id is null then
    raise exception 'vendor_required' using errcode = '22023';
  end if;

  if v_visit.id is null then
    insert into public.repair_shop_visits
      (dsp_id, repair_case_id, vendor_id, repair_order_id, shop_status,
       dropped_off_at, checked_in_at)
    values
      (v_dsp, p_case_id, v_vendor.id, v_case.repair_order_id, 'checked_in',
       v_when, now())
    returning * into v_visit;
  else
    update public.repair_shop_visits set
      vendor_id      = v_vendor.id,
      shop_status    = 'checked_in',
      dropped_off_at = v_when,
      checked_in_at  = now(),
      updated_at     = now()
    where id = v_visit.id
    returning * into v_visit;
  end if;

  update public.repair_cases
     set vendor_id = v_vendor.id, updated_at = now()
   where id = p_case_id;

  perform private._repair_stage_apply(
    v_dsp, p_case_id, v_case.stage, 'at_shop', 'Checked in at the shop');

  perform private.repair_case_event(
    v_dsp, p_case_id, 'visit_checked_in',
    'Checked in at ' || v_vendor.name
      || case when coalesce(btrim(p_note),'') = '' then '' else ' — ' || left(btrim(p_note), 200) end,
    null, null, 'dsp', false, false,
    jsonb_build_object('visit_id', v_visit.id, 'vendor_id', v_vendor.id,
                       'dropped_off_at', v_when));

  perform private._repair_visit_mirror_ro(p_case_id);

  return public.repair_case_get(p_case_id);
end;
$$;


-- ═══════════════════════════ 4. repair_visit_update ═════════════════
-- The working update: shop status, WO identity, promise dates, delay
-- reasons. Promise changes are evented with old → new + reason so the
-- delay history is queryable later (shop performance phase).
create or replace function public.repair_visit_update(
  p_case_id uuid,
  p_patch   jsonb,
  p_note    text default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_case public.repair_cases;
  v_visit public.repair_shop_visits;
  v_status text;
  v_promised timestamptz;
  v_revised timestamptz;
  v_reason text;
  v_evented boolean := false;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_case from public.repair_cases
   where id = p_case_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  v_visit := private._repair_open_visit(p_case_id);
  if v_visit.id is null then
    raise exception 'no_open_visit' using errcode = 'P0002';
  end if;

  v_status := nullif(p_patch->>'shop_status', '');
  if v_status is not null then
    if v_status = 'picked_up' then
      raise exception 'use_pickup_action' using errcode = '22023';
    end if;
    if v_status not in ('awaiting_dropoff','checked_in','diagnosing',
                        'awaiting_authorization','parts_hold','in_repair',
                        'delayed','ready') then
      raise exception 'bad_shop_status' using errcode = '22023';
    end if;
  end if;

  v_promised := case when p_patch ? 'promised_completion_at'
                     then nullif(p_patch->>'promised_completion_at','')::timestamptz
                     else v_visit.promised_completion_at end;
  v_revised  := case when p_patch ? 'revised_completion_at'
                     then nullif(p_patch->>'revised_completion_at','')::timestamptz
                     else v_visit.revised_completion_at end;
  v_reason   := case when p_patch ? 'current_delay_reason'
                     then left(nullif(btrim(coalesce(p_patch->>'current_delay_reason','')),''), 300)
                     else v_visit.current_delay_reason end;

  update public.repair_shop_visits set
    shop_status = coalesce(v_status, shop_status),
    appointment_at        = case when p_patch ? 'appointment_at'        then nullif(p_patch->>'appointment_at','')::timestamptz        else appointment_at end,
    diagnosis_expected_at = case when p_patch ? 'diagnosis_expected_at' then nullif(p_patch->>'diagnosis_expected_at','')::timestamptz else diagnosis_expected_at end,
    diagnosis_received_at = case when p_patch ? 'diagnosis_received_at' then nullif(p_patch->>'diagnosis_received_at','')::timestamptz
                                 when v_status = 'awaiting_authorization' then coalesce(diagnosis_received_at, now())
                                 else diagnosis_received_at end,
    repair_started_at     = case when v_status = 'in_repair' then coalesce(repair_started_at, now()) else repair_started_at end,
    promised_completion_at = v_promised,
    revised_completion_at  = v_revised,
    completed_at          = case when v_status = 'ready' then coalesce(completed_at, now()) else completed_at end,
    ready_for_pickup_at   = case when v_status = 'ready' then coalesce(ready_for_pickup_at, now()) else ready_for_pickup_at end,
    shop_work_order_number   = case when p_patch ? 'shop_work_order_number'   then left(nullif(btrim(coalesce(p_patch->>'shop_work_order_number','')),''), 80)   else shop_work_order_number end,
    shop_repair_order_number = case when p_patch ? 'shop_repair_order_number' then left(nullif(btrim(coalesce(p_patch->>'shop_repair_order_number','')),''), 80) else shop_repair_order_number end,
    service_advisor       = case when p_patch ? 'service_advisor' then left(nullif(btrim(coalesce(p_patch->>'service_advisor','')),''), 120) else service_advisor end,
    tow_provider          = case when p_patch ? 'tow_provider'    then left(nullif(btrim(coalesce(p_patch->>'tow_provider','')),''), 120)    else tow_provider end,
    tow_reference         = case when p_patch ? 'tow_reference'   then left(nullif(btrim(coalesce(p_patch->>'tow_reference','')),''), 80)    else tow_reference end,
    current_delay_reason  = v_reason,
    notes                 = case when p_patch ? 'notes' then left(nullif(btrim(coalesce(p_patch->>'notes','')),''), 1000) else notes end,
    updated_at = now()
  where id = v_visit.id;

  update public.repair_cases set updated_at = now() where id = p_case_id;

  -- Event synthesis — the timeline is the delay log.
  if v_status is not null and v_status <> v_visit.shop_status then
    perform private.repair_case_event(
      v_dsp, p_case_id, 'shop_status_changed',
      private._repair_shop_status_label(v_visit.shop_status) || ' → '
        || private._repair_shop_status_label(v_status)
        || case when v_status = 'delayed' and coalesce(v_reason,'') <> ''
                then ' — ' || v_reason else '' end
        || case when coalesce(btrim(p_note),'') = '' then '' else ' — ' || left(btrim(p_note), 200) end,
      v_visit.shop_status, v_status, 'dsp', false, false,
      jsonb_build_object('visit_id', v_visit.id));
    v_evented := true;
    if v_status = 'ready' then
      perform private._repair_stage_apply(
        v_dsp, p_case_id, (select stage from public.repair_cases where id = p_case_id),
        'ready_for_pickup', 'Shop reports the vehicle ready');
    end if;
  end if;

  if v_promised is distinct from v_visit.promised_completion_at
     and v_visit.promised_completion_at is null and v_promised is not null then
    perform private.repair_case_event(
      v_dsp, p_case_id, 'promise_set',
      'Shop promised completion ' || to_char(v_promised, 'Dy, Mon FMDD'),
      null, to_char(v_promised, 'YYYY-MM-DD'), 'dsp', false, false,
      jsonb_build_object('visit_id', v_visit.id, 'promised_completion_at', v_promised));
    v_evented := true;
  end if;

  if v_revised is distinct from v_visit.revised_completion_at and v_revised is not null then
    perform private.repair_case_event(
      v_dsp, p_case_id, 'promise_revised',
      'Completion revised '
        || coalesce(to_char(coalesce(v_visit.revised_completion_at,
                                     v_visit.promised_completion_at), 'Mon FMDD'), '—')
        || ' → ' || to_char(v_revised, 'Mon FMDD')
        || case when coalesce(v_reason,'') <> '' then ' — ' || v_reason else '' end,
      to_char(coalesce(v_visit.revised_completion_at, v_visit.promised_completion_at), 'YYYY-MM-DD'),
      to_char(v_revised, 'YYYY-MM-DD'), 'dsp', false, false,
      jsonb_build_object('visit_id', v_visit.id, 'revised_completion_at', v_revised,
                         'reason', v_reason));
    v_evented := true;
  end if;

  if not v_evented and coalesce(btrim(p_note),'') <> '' then
    perform private.repair_case_event(
      v_dsp, p_case_id, 'shop_update', left(btrim(p_note), 500),
      null, null, 'dsp', false, false,
      jsonb_build_object('visit_id', v_visit.id));
  end if;

  perform private._repair_visit_mirror_ro(p_case_id);

  return public.repair_case_get(p_case_id);
end;
$$;


-- ═══════════════════════════ 5. repair_visit_pickup ═════════════════
-- The van leaves the shop → quality check. The ONLY way shop_status
-- becomes picked_up (keeps the timestamp trail consistent).
create or replace function public.repair_visit_pickup(
  p_case_id uuid,
  p_note    text default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_case public.repair_cases;
  v_visit public.repair_shop_visits;
  v_vendor_name text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_case from public.repair_cases
   where id = p_case_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  v_visit := private._repair_open_visit(p_case_id);
  if v_visit.id is null or v_visit.dropped_off_at is null then
    raise exception 'not_at_shop' using errcode = '22023';
  end if;

  update public.repair_shop_visits set
    shop_status = 'picked_up',
    completed_at        = coalesce(completed_at, now()),
    ready_for_pickup_at = coalesce(ready_for_pickup_at, now()),
    picked_up_at        = now(),
    updated_at          = now()
  where id = v_visit.id;

  update public.repair_cases set updated_at = now() where id = p_case_id;

  -- at_shop → ready_for_pickup → quality_check (whichever applies).
  perform private._repair_stage_apply(
    v_dsp, p_case_id, (select stage from public.repair_cases where id = p_case_id),
    'ready_for_pickup', 'Ready for pickup');
  perform private._repair_stage_apply(
    v_dsp, p_case_id, (select stage from public.repair_cases where id = p_case_id),
    'quality_check', 'Picked up — quality check before return to service');

  select name into v_vendor_name from public.vendors where id = v_visit.vendor_id;
  perform private.repair_case_event(
    v_dsp, p_case_id, 'vehicle_picked_up',
    'Picked up from ' || coalesce(v_vendor_name, 'the shop')
      || case when coalesce(btrim(p_note),'') = '' then '' else ' — ' || left(btrim(p_note), 200) end,
    null, null, 'dsp', false, false,
    jsonb_build_object('visit_id', v_visit.id, 'vendor_id', v_visit.vendor_id));

  return public.repair_case_get(p_case_id);
end;
$$;

grant execute on function public.repair_visit_schedule(uuid, timestamptz, uuid, text, text, text) to authenticated;
grant execute on function public.repair_visit_checkin(uuid, timestamptz, uuid, text) to authenticated;
grant execute on function public.repair_visit_update(uuid, jsonb, text) to authenticated;
grant execute on function public.repair_visit_pickup(uuid, text) to authenticated;


-- ═══════════════════════════ 6. return_to_service (replaced) ════════
-- Identical to 0486's version plus ONE addition: the open shop visit is
-- closed out (picked_up_at stamped) so a direct return-to-service can't
-- strand a visit as forever-open — shop metrics stay honest.
create or replace function public.repair_case_return_to_service(
  p_id       uuid,
  p_odometer int default null,
  p_note     text default null,
  p_close    boolean default true
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_case public.repair_cases;
  v_vehicle public.vehicles;
  v_other_open int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_case from public.repair_cases
   where id = p_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if v_case.stage in ('closed','cancelled') then
    raise exception 'case_already_closed' using errcode = '22023';
  end if;

  select * into v_vehicle from public.vehicles
   where id = v_case.vehicle_id and dsp_id = v_dsp;

  -- 0489: close the open visit (if the van was tracked at a shop).
  update public.repair_shop_visits set
    shop_status = 'picked_up',
    completed_at        = coalesce(completed_at, now()),
    ready_for_pickup_at = coalesce(ready_for_pickup_at, now()),
    picked_up_at        = coalesce(picked_up_at, now()),
    updated_at          = now()
  where repair_case_id = p_id and picked_up_at is null;

  update public.repair_cases set
    stage = 'returned',
    availability = 'returned',
    actual_return_to_service_at = coalesce(actual_return_to_service_at, now()),
    odometer = coalesce(p_odometer, odometer),
    updated_at = now()
  where id = p_id;

  perform private.repair_case_event(
    v_dsp, p_id, 'returned_to_service',
    coalesce(nullif(btrim(coalesce(p_note,'')),''), 'Vehicle returned to service'),
    v_case.stage, 'returned', 'dsp', false, false,
    jsonb_build_object('odometer', p_odometer));

  -- Record the mileage reading through the existing log (bumps
  -- vehicles.mileage when higher).
  if p_odometer is not null then
    begin
      perform public.vehicle_mileage_log_save(v_case.vehicle_id, p_odometer, now(), 'service');
    exception when others then null; -- best-effort; older envs may lack the RPC
    end;
  end if;

  -- Unground through the sanctioned path — but only when no OTHER open
  -- case still grounds this vehicle.
  if v_vehicle.operational_status = 'grounded' then
    select count(*)::int into v_other_open
      from public.repair_cases
     where dsp_id = v_dsp and vehicle_id = v_case.vehicle_id
       and id <> p_id
       and stage not in ('returned','closed','cancelled')
       and availability = 'grounded';
    if v_other_open = 0 then
      perform public.vehicle_set_operational_status(
        v_case.vehicle_id, 'operational',
        'Repair complete · ' || v_case.case_number, null);
      perform private.repair_case_event(
        v_dsp, p_id, 'ungrounded', 'Vehicle restored to operational',
        'grounded', 'operational', 'dsp', false, false, '{}'::jsonb);
    end if;
  end if;

  if coalesce(p_close, true) then
    update public.repair_cases set stage = 'closed', closed_at = now(), updated_at = now()
     where id = p_id;
    perform private.repair_case_event(
      v_dsp, p_id, 'stage_changed', 'Case closed',
      'returned', 'closed', 'dsp', false, false, '{}'::jsonb);
    -- Close any linked issues + complete the linked RO
    update public.vehicle_issues
       set status = 'completed', resolved_at = coalesce(resolved_at, now()), updated_at = now()
     where repair_case_id = p_id and dsp_id = v_dsp and status <> 'completed';
    if v_case.repair_order_id is not null then
      update public.repair_orders
         set status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now()
       where id = v_case.repair_order_id and status not in ('completed','cancelled');
    end if;
  end if;

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, object_type, object_id)
  values
    (v_dsp, 'user', auth.uid(), 'repair_case_returned',
     v_case.case_number || ' returned to service', 'repair_case', p_id);

  return public.repair_case_get(p_id);
end;
$$;


notify pgrst, 'reload schema';
