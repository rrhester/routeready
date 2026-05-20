-- Migration 0308 · Fleet — grounding categories
--
-- When a van is grounded the operator now picks a category:
--   warranty | preventive | body_damage | other
--
-- "warranty" is the one that drives the RO-request + repair clock on
-- the fleet roster; the others just record why the van is down.
--
--   · vehicle_grounding_events.category — new column
--   · vehicles_roster()                 — returns grounded_category
--   · vehicle_set_operational_status()  — accepts p_category

alter table public.vehicle_grounding_events
  add column if not exists category text;


-- ── vehicles_roster — surface the open grounding event's category ───
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
      ),

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
      select grounded_at, reason, category
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


-- ── vehicle_set_operational_status — accept a grounding category ────
-- New p_category parameter, so drop the old 3-arg signature first.
drop function if exists public.vehicle_set_operational_status(uuid, text, text);
create or replace function public.vehicle_set_operational_status(
  p_id       uuid,
  p_status   text,
  p_reason   text default null,
  p_category text default null
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

  -- Stamp the reason + category onto the open grounding event (the
  -- 0228 trigger created/closed the row from the status change above).
  if p_status = 'grounded' then
    update public.vehicle_grounding_events
       set reason   = coalesce(nullif(btrim(p_reason), ''), reason),
           category = coalesce(v_cat, category)
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
grant execute on function public.vehicle_set_operational_status(uuid, text, text, text) to authenticated;


notify pgrst, 'reload schema';
