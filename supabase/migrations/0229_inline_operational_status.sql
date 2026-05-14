-- Migration 0229 · Inline operational-status edit + days-grounded surface
--
-- Adds the data the Fleet roster needs to:
--
--   1. Show how many days a non-operational vehicle has been down.
--      vehicles_roster() now returns grounded_since (the open grounding
--      event's grounded_at) so the renderer can compute a "Nd" badge
--      next to the status pill without another round-trip.
--
--   2. Flip operational status without opening the record drawer.
--      vehicle_set_operational_status(p_id, p_status, p_reason?) does
--      the update; the existing _fleet_maintain_grounding_event trigger
--      (migration 0228) takes care of opening/closing the grounding
--      event row.
--
-- Idempotent: safe to re-run.


-- ── 1. vehicles_roster — extend with grounded_since + reason ───────────
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
      'open_issue_count',   coalesce(oi.cnt, 0)
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
    where vh.dsp_id = private.current_dsp_id()
      and vh.archived_at is null
      and private.is_staff(vh.dsp_id, 'dispatcher')
  ) t;
$$;
grant execute on function public.vehicles_roster() to authenticated;


-- ── 2. vehicle_set_operational_status ─────────────────────────────────
-- Lightweight RPC for the inline pill menu.  The
-- _fleet_maintain_grounding_event trigger from migration 0228 keeps
-- vehicle_grounding_events in sync; we just stamp the reason here if
-- the operator supplied one.
create or replace function public.vehicle_set_operational_status(
  p_id     uuid,
  p_status text,
  p_reason text default null
) returns public.vehicles
language plpgsql security definer set search_path = public
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vehicles;
begin
  if coalesce(p_status, '') not in ('operational','grounded') then
    raise exception 'bad_status' using errcode = '22023';
  end if;

  update public.vehicles
     set operational_status = p_status,
         updated_at         = now()
   where id = p_id and dsp_id = v_dsp
  returning * into v_row;

  if not found then
    raise exception 'vehicle_not_found' using errcode = '42704';
  end if;

  -- Attach a reason to the open grounding event if the operator gave one.
  if p_status = 'grounded' and coalesce(btrim(p_reason), '') <> '' then
    update public.vehicle_grounding_events
       set reason = btrim(p_reason)
     where vehicle_id = p_id
       and ungrounded_at is null;
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
grant execute on function public.vehicle_set_operational_status(uuid, text, text) to authenticated;
