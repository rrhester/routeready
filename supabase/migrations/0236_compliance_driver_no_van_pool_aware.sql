-- Migration 0236 · Compliance "driver has no van" risk is pool-aware.
--
-- The original synthesis (migration 0235) emitted a risk for every
-- scheduled driver whose primary/backup chain didn't resolve to a
-- van — even when there were plenty of unassigned vans in the pool
-- that auto-assign would happily hand them.  Result: drivers appear
-- on the Compliance board's Exceptions table even though the DSP
-- has more than enough vans.
--
-- New rule: a scheduled driver only counts as a real "no_van" risk
-- when the available pool for that date is empty.  An "available"
-- van is:
--
--   · owned by this DSP
--   · status in ('active','spare')
--   · not archived
--   · not grounded
--   · no per-day override already assigning it to anyone on that date
--   · not committed by a chain belonging to a driver who IS scheduled
--     on that date (taking that van would steal it from its owner)
--
-- If pool_size >= 1, the driver is auto-fillable → no risk row.
-- This honors the DSP-wide rule "assign by chain first, then random
-- from the pool" and stops surfacing noise when the rule will hold.
--
-- Idempotent.

create or replace function public.compliance_workspace_bundle(p_dsp_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_dsp_id uuid := coalesce(p_dsp_id, private.current_dsp_id());
  v_posture jsonb;
  v_grounded jsonb;
  v_vendors jsonb;
  v_cures jsonb;
  v_fmcsa jsonb;
  v_docs jsonb;
  v_audit jsonb;
  v_monitors jsonb;
  v_fleet jsonb;
  v_risks jsonb;
  v_gaps jsonb;
  v_g_count int;
  v_over_amazon int;
  v_open_cures int;
  v_repair_overdue int;
  v_vendor_stalls int;
  v_total_v int;
  v_op_v int;
begin
  if v_dsp_id is null then return jsonb_build_object('error','no_dsp'); end if;
  if v_dsp_id <> private.current_dsp_id() then return jsonb_build_object('error','forbidden'); end if;

  -- ── Grounded vehicles (unchanged from 0235) ──
  with g as (
    select v.id, coalesce(v.nickname, v.name) as label, v.vin,
           v.operational_status, ge.grounded_at, ge.reason,
           ro.id as ro_id, ro.code as ro_code, ro.status as ro_status,
           ro.eta_at as ro_eta_at, ro.scheduled_at as ro_scheduled_at,
           ven.id as vendor_id, ven.name as vendor_name,
           ven.accountability_score as vendor_score,
           ven.last_message_at as vendor_last_msg,
           public.business_days_between(ge.grounded_at, v_now) as bd_grounded,
           extract(epoch from (v_now - ge.grounded_at)) / 86400.0 as days_grounded
    from public.vehicles v
    join lateral (
      select * from public.vehicle_grounding_events
      where vehicle_id = v.id and ungrounded_at is null
      order by grounded_at desc limit 1
    ) ge on true
    left join lateral (
      select * from public.repair_orders
      where vehicle_id = v.id and status not in ('completed','cancelled')
      order by opened_at desc limit 1
    ) ro on true
    left join public.vendors ven on ven.id = ro.vendor_id
    where v.dsp_id = v_dsp_id
  )
  select
    jsonb_agg(jsonb_build_object(
      'vehicle_id', id, 'label', label, 'vin', vin,
      'grounded_at', grounded_at,
      'days_grounded', round(days_grounded, 1),
      'bd_grounded',   round(bd_grounded, 1),
      'reason', reason,
      'ro_id', ro_id, 'ro_code', ro_code, 'ro_status', ro_status,
      'ro_eta_at', ro_eta_at, 'ro_scheduled_at', ro_scheduled_at,
      'vendor_id', vendor_id, 'vendor_name', vendor_name,
      'vendor_score', vendor_score, 'vendor_last_msg', vendor_last_msg,
      'over_amazon_threshold', days_grounded > 14,
      'in_amazon_warn', days_grounded > 7
    ) order by days_grounded desc),
    count(*),
    count(*) filter (where days_grounded > 14)
  into v_grounded, v_g_count, v_over_amazon
  from g;
  v_grounded := coalesce(v_grounded, '[]'::jsonb);

  -- ── Vendors ──
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', v.id, 'name', v.name, 'kind', v.kind,
    'accountability_score', v.accountability_score,
    'open_ros', coalesce(r.open_ros, 0),
    'on_time_pct', v.on_time_pct,
    'avg_eta_confirm_days', v.avg_eta_confirm_days,
    'last_message_at', v.last_message_at,
    'reassignment_threshold', v.reassignment_threshold,
    'paused', v.paused, 'distance_mi', v.distance_mi
  ) order by v.accountability_score asc), '[]'::jsonb)
  into v_vendors
  from public.vendors v
  left join (
    select vendor_id, count(*) as open_ros
    from public.repair_orders
    where dsp_id = v_dsp_id and status not in ('completed','cancelled')
    group by vendor_id
  ) r on r.vendor_id = v.id
  where v.dsp_id = v_dsp_id;

  select count(*) into v_vendor_stalls
  from public.vendors
  where dsp_id = v_dsp_id and accountability_score < reassignment_threshold;

  -- ── Cures ──
  with c as (
    select cu.id, cu.code, cu.source, cu.title, cu.description, cu.status,
           cu.deadline_at, cu.opened_at, cu.submitted_at, cu.closed_at,
           extract(epoch from (cu.deadline_at - v_now)) / 86400.0 as days_to_deadline,
           (select coalesce(jsonb_agg(jsonb_build_object(
              'id', s.id, 'ord', s.ord, 'title', s.title, 'sub', s.sub,
              'done', s.done_at is not null, 'done_at', s.done_at
            ) order by s.ord), '[]'::jsonb)
            from public.compliance_cure_steps s where s.cure_id = cu.id) as steps,
           (select coalesce(jsonb_agg(jsonb_build_object(
              'object_type', l.object_type, 'object_id', l.object_id, 'label', l.label
            )), '[]'::jsonb)
            from public.compliance_cure_links l where l.cure_id = cu.id) as links,
           (select au.full_name from public.app_users au where au.id = cu.owner_id) as owner_name,
           (select count(*) from public.compliance_cure_steps s where s.cure_id = cu.id) as step_total,
           (select count(*) from public.compliance_cure_steps s where s.cure_id = cu.id and s.done_at is not null) as step_done
    from public.compliance_cures cu
    where cu.dsp_id = v_dsp_id and cu.status <> 'closed'
    order by cu.deadline_at nulls last
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'code', c.code, 'source', c.source, 'title', c.title,
    'description', c.description, 'status', c.status,
    'deadline_at', c.deadline_at,
    'days_to_deadline', round(c.days_to_deadline, 1),
    'opened_at', c.opened_at, 'owner_name', c.owner_name,
    'steps', c.steps, 'links', c.links,
    'step_total', c.step_total, 'step_done', c.step_done
  )), '[]'::jsonb)
  into v_cures
  from c;

  select count(*) into v_open_cures
  from public.compliance_cures
  where dsp_id = v_dsp_id and status <> 'closed';

  -- ── FMCSA ──
  select to_jsonb(f.*) into v_fmcsa from public.fmcsa_records f where f.dsp_id = v_dsp_id;

  -- ── Documents ──
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'kind', d.kind, 'name', d.name,
    'attached_object_type', d.attached_object_type,
    'attached_object_id', d.attached_object_id,
    'uploaded_at', d.uploaded_at,
    'uploaded_by_name', (select full_name from public.app_users where id = d.uploaded_by),
    'verified', d.verified, 'size_bytes', d.size_bytes
  ) order by d.uploaded_at desc), '[]'::jsonb)
  into v_docs
  from (select * from public.compliance_documents
        where dsp_id = v_dsp_id order by uploaded_at desc limit 24) d;

  -- ── Audit ──
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'occurred_at', e.occurred_at,
    'actor_type', e.actor_type, 'actor_label', e.actor_label,
    'kind', e.kind, 'summary', e.summary, 'sub', e.sub,
    'object_type', e.object_type, 'object_id', e.object_id
  ) order by e.occurred_at desc), '[]'::jsonb)
  into v_audit
  from (select * from public.compliance_audit_events
        where dsp_id = v_dsp_id order by occurred_at desc limit 40) e;

  -- ── Monitors ──
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'code', m.code, 'name', m.name,
    'description', m.description, 'category', m.category,
    'state', m.state, 'severity_reach', m.severity_reach,
    'data_source', m.data_source, 'rule_expr', m.rule_expr,
    'automation', m.automation, 'escalation', m.escalation,
    'last_check_at', m.last_check_at, 'paused', m.paused
  ) order by m.severity_reach desc, m.name), '[]'::jsonb)
  into v_monitors
  from public.compliance_monitors m
  where m.dsp_id = v_dsp_id;

  -- ── Fleet posture ──
  select count(*), count(*) filter (where operational_status = 'operational')
  into v_total_v, v_op_v
  from public.vehicles where dsp_id = v_dsp_id;

  select jsonb_build_object(
    'total', v_total_v, 'operational', v_op_v, 'grounded', v_g_count,
    'in_repair', greatest(0, (
      select count(distinct ro.vehicle_id)
      from public.repair_orders ro
      where ro.dsp_id = v_dsp_id
        and ro.status not in ('completed','cancelled')
        and ro.vehicle_id is not null
        and not exists (
          select 1 from public.vehicle_grounding_events ge
          where ge.vehicle_id = ro.vehicle_id and ge.ungrounded_at is null
        )
    ))
  ) into v_fleet;

  -- ── Driver "no_van" risk · pool-aware ──
  -- 1. candidate_shifts: every scheduled/late shift in horizon
  -- 2. resolved_van:     whether the chain or an override resolves a van
  -- 3. unresolved:       candidate_shifts that have no van resolved
  -- 4. per_date_pool:    free pool size per date (auto-fillable count)
  -- 5. real_gaps:        only emit a gap when per_date_pool[date] = 0
  with horizon as (
    select current_date as d0, current_date + 14 as d1
  ),
  candidate_shifts as (
    select s.id as shift_id, s.driver_id, s.date, s.starts_at, s.route_code,
           s.station_id, s.status,
           coalesce(nullif(trim(d.preferred_name), ''), nullif(trim(d.full_name), ''), 'Driver') as driver_name,
           extract(epoch from (s.starts_at - v_now)) / 3600.0 as hrs_until,
           st.code as station_code
    from public.shifts s
    join public.drivers d on d.id = s.driver_id
    left join public.stations st on st.id = s.station_id
    where s.dsp_id = v_dsp_id
      and s.date >= (select d0 from horizon)
      and s.date <= (select d1 from horizon)
      and s.status in ('scheduled','late')
      and d.role = 'driver'
  ),
  resolved_van as (
    select cs.shift_id,
           exists (
             select 1 from public.vehicle_day_assignments oa
             join public.vehicles v on v.id = oa.vehicle_id
             where oa.driver_id = cs.driver_id and oa.date = cs.date
               and v.dsp_id = v_dsp_id and v.archived_at is null
           )
           or exists (
             select 1 from public.vehicle_driver_assignments a
             join public.vehicles v on v.id = a.vehicle_id
             where a.driver_id = cs.driver_id and a.rank = 0
               and v.dsp_id = v_dsp_id and v.status = 'active' and v.archived_at is null
               and coalesce(v.operational_status,'operational') <> 'grounded'
               and not exists (
                 select 1 from public.vehicle_day_assignments oa
                 where oa.vehicle_id = v.id and oa.date = cs.date
               )
           )
           or exists (
             select 1 from public.vehicle_driver_assignments a
             join public.vehicles v on v.id = a.vehicle_id
             left join public.vehicle_driver_assignments pri on pri.vehicle_id = v.id and pri.rank = 0
             where a.driver_id = cs.driver_id and a.rank > 0
               and v.dsp_id = v_dsp_id and v.status = 'active' and v.archived_at is null
               and coalesce(v.operational_status,'operational') <> 'grounded'
               and not exists (
                 select 1 from public.vehicle_day_assignments oa
                 where oa.vehicle_id = v.id and oa.date = cs.date
               )
               and (
                 pri.driver_id is null
                 or not exists (
                   select 1 from public.shifts ps
                   where ps.driver_id = pri.driver_id and ps.date = cs.date
                     and ps.dsp_id = v_dsp_id
                     and ps.status in ('scheduled','completed','late')
                 )
               )
           ) as has_van
    from candidate_shifts cs
  ),
  unresolved as (
    select cs.*
    from candidate_shifts cs
    join resolved_van rv on rv.shift_id = cs.shift_id
    where rv.has_van = false
  ),
  per_date_pool as (
    select u.date,
           (
             select count(*)
             from public.vehicles v
             where v.dsp_id = v_dsp_id
               and v.status in ('active','spare')
               and v.archived_at is null
               and coalesce(v.operational_status,'operational') <> 'grounded'
               and not exists (
                 select 1 from public.vehicle_day_assignments oa
                 where oa.vehicle_id = v.id and oa.date = u.date
               )
               and not exists (
                 select 1 from public.vehicle_driver_assignments a
                 join public.shifts s on s.driver_id = a.driver_id
                 where a.vehicle_id = v.id and s.date = u.date
                   and s.dsp_id = v_dsp_id
                   and s.status in ('scheduled','completed','late')
               )
           ) as pool_size
    from (select distinct date from unresolved) u
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'shift_id', u.shift_id, 'driver_id', u.driver_id,
    'driver_name', u.driver_name, 'date', u.date,
    'starts_at', u.starts_at, 'station_code', u.station_code,
    'route_code', u.route_code, 'hrs_until', round(u.hrs_until, 1),
    'pool_size', p.pool_size
  ) order by u.starts_at), '[]'::jsonb)
  into v_gaps
  from unresolved u
  join per_date_pool p on p.date = u.date
  where p.pool_size = 0;
  -- NOTE: when pool_size > 0, the driver is auto-fillable and is NOT
  -- a gap.  This honors the DSP's "chain first, then random" rule.

  -- ── Risk synthesis ──
  v_risks := '[]'::jsonb;

  v_risks := v_risks || coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind','grounded_vehicle',
      'severity', case
                    when (g->>'ro_id') is null and (g->>'bd_grounded')::numeric > 2 then 'critical'
                    when (g->>'ro_id') is null then 'high'
                    else 'high'
                  end,
      'cite','amazon',
      'title', case when (g->>'ro_id') is null
                    then 'Vehicle grounded ' || round((g->>'days_grounded')::numeric)::text || ' days · no active RO'
                    else 'Vehicle grounded ' || round((g->>'days_grounded')::numeric)::text || ' days · RO ' || coalesce(g->>'ro_code','open')
               end,
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','VIN', 'val', coalesce(g->>'vin','—')),
        jsonb_build_object('lbl','UNIT','val', coalesce(g->>'label','—'))
      ),
      'meta', jsonb_build_object(
        'days_grounded', (g->>'days_grounded')::numeric,
        'bd_grounded',   (g->>'bd_grounded')::numeric,
        'vendor', g->>'vendor_name',
        'vendor_score', g->>'vendor_score',
        'ro_code', g->>'ro_code',
        'ro_id', g->>'ro_id'
      ),
      'object_type','vehicle', 'object_id', g->>'vehicle_id'
    ))
    from jsonb_array_elements(v_grounded) g
  ), '[]'::jsonb);

  v_risks := v_risks || coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind','cure_deadline',
      'severity', case when (c->>'days_to_deadline')::numeric < 3 then 'critical'
                       when (c->>'days_to_deadline')::numeric < 14 then 'high'
                       else 'medium' end,
      'cite', c->>'source',
      'title', 'Cure deadline · ' || coalesce(c->>'title','(no title)'),
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','CURE','val', coalesce(c->>'code',''))
      ),
      'meta', jsonb_build_object(
        'days_to_deadline', (c->>'days_to_deadline')::numeric,
        'deadline_at', c->>'deadline_at',
        'step_done', (c->>'step_done')::int,
        'step_total', (c->>'step_total')::int
      ),
      'object_type','cure', 'object_id', c->>'id'
    ))
    from jsonb_array_elements(v_cures) c
  ), '[]'::jsonb);

  v_risks := v_risks || coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind','vendor_stall',
      'severity', case when (v->>'accountability_score')::int < 60 then 'high' else 'medium' end,
      'cite','internal',
      'title','Vendor accountability below reassignment threshold · ' || (v->>'name'),
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','VENDOR','val', v->>'name'),
        jsonb_build_object('lbl','OPEN ROs','val', coalesce(v->>'open_ros','0'))
      ),
      'meta', jsonb_build_object(
        'score', (v->>'accountability_score')::int,
        'threshold', (v->>'reassignment_threshold')::int,
        'open_ros', (v->>'open_ros')::int
      ),
      'object_type','vendor', 'object_id', v->>'id'
    ))
    from jsonb_array_elements(v_vendors) v
    where (v->>'accountability_score')::int < (v->>'reassignment_threshold')::int
  ), '[]'::jsonb);

  if v_fmcsa is not null and (v_fmcsa->>'cure_required')::boolean then
    v_risks := v_risks || jsonb_build_array(jsonb_build_object(
      'kind','fmcsa_mcs150', 'severity','high', 'cite','fmcsa',
      'title','MCS-150 cure required · CMV reclassification + proof of submission',
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','USDOT','val', coalesce(v_fmcsa->>'usdot','—'))
      ),
      'meta', jsonb_build_object(
        'cure_deadline_at', v_fmcsa->>'cure_deadline_at',
        'mcs150_cmv_declared', v_fmcsa->>'mcs150_cmv_declared'
      ),
      'object_type','fmcsa', 'object_id', v_dsp_id
    ));
  end if;

  v_risks := v_risks || coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind','driver_no_van',
      'severity', case when (g->>'hrs_until')::numeric <= 48 then 'critical' else 'high' end,
      'cite','internal',
      'title','Scheduled driver has no van · ' || (g->>'driver_name'),
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','DRIVER','val', g->>'driver_name'),
        jsonb_build_object('lbl','DATE','val', g->>'date')
      ),
      'meta', jsonb_build_object(
        'hrs_until', (g->>'hrs_until')::numeric,
        'shift_id', g->>'shift_id',
        'starts_at', g->>'starts_at',
        'station_code', g->>'station_code',
        'route_code', g->>'route_code',
        'pool_size', (g->>'pool_size')::int
      ),
      'object_type','shift', 'object_id', g->>'shift_id'
    ))
    from jsonb_array_elements(v_gaps) g
  ), '[]'::jsonb);

  v_repair_overdue := 0;
  select count(*) into v_repair_overdue
  from (
    select g->>'ro_id' as ro,
           (g->>'days_grounded')::numeric as dg,
           (g->>'bd_grounded')::numeric  as bd
    from jsonb_array_elements(v_grounded) g
  ) x
  where x.dg > 14 or (x.ro is null and x.bd > 2);

  v_posture := jsonb_build_object(
    'readiness_score', greatest(0, least(100, 100
                            - coalesce(v_over_amazon,0)*15
                            - coalesce(v_open_cures,0)*8
                            - greatest(0, coalesce(v_vendor_stalls,0))*6
                            - greatest(0, coalesce(v_g_count,0))*3
                            - greatest(0, jsonb_array_length(v_gaps))*4)),
    'grounded_count', coalesce(v_g_count, 0),
    'over_amazon_threshold', coalesce(v_over_amazon, 0),
    'repairs_overdue', coalesce(v_repair_overdue, 0),
    'vendor_stalls', coalesce(v_vendor_stalls, 0),
    'open_cures', coalesce(v_open_cures, 0),
    'no_van_count', jsonb_array_length(v_gaps),
    'last_sweep_at', v_now,
    'fleet', v_fleet
  );

  return jsonb_build_object(
    'posture', v_posture,
    'risks', v_risks,
    'cures', v_cures,
    'grounded_vehicles', v_grounded,
    'vendors', v_vendors,
    'fmcsa', v_fmcsa,
    'documents', v_docs,
    'audit_events', v_audit,
    'monitors', v_monitors,
    'fleet', v_fleet,
    'driver_no_van', v_gaps,
    'generated_at', v_now
  );
end;
$$;
grant execute on function public.compliance_workspace_bundle(uuid) to authenticated;
