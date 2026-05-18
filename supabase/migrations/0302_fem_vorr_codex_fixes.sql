-- Migration 0302 · FEM/VORR correctness follow-ups
--
-- Two issues surfaced on PR #1214 by Codex review against 0301 that
-- needed cleaning up:
--
--   1. fleet_execution_summary() pulled the entire vehicles_roster()
--      payload and filtered only by is_branded.  A branded van left
--      in out_of_service or retired still fed both FEM and VORR — a
--      retired van shouldn''t inflate readiness or trigger a false
--      FEM violation.  We now also gate the slice on
--      status in ('active','spare') so dispatch-eligible vehicles
--      drive the metrics.
--
--   2. today_roster_auto_assign() ordered pool candidates by
--      days-since-deployed before considering is_branded.  An active
--      non-branded van that''s never been deployed therefore won
--      ahead of a branded van at 13 days idle — and deploying the
--      non-branded van does nothing for FEM compliance.  We now sort
--      branded ahead of non-branded so the branded fleet is always
--      protected first; non-branded assets serve as a last-resort
--      pool.
--
-- Idempotent.

set local search_path = public;


-- ── 1. fleet_execution_summary · gate by dispatchable status ─────────
create or replace function public.fleet_execution_summary()
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

  -- Branded slice now also requires a dispatchable lifecycle status.
  -- out_of_service and retired vehicles are still in the fleet table
  -- (the operator may keep history), but they're not eligible for
  -- routes — counting them would mis-state both metrics.
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

  -- Exclusion counts (informational).
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
grant execute on function public.fleet_execution_summary() to authenticated;


-- ── 2. today_roster_auto_assign · prefer branded before exempt ──────
-- Order keys, in priority:
--   1. branded first (non-branded falls to the bottom of the pool)
--   2. never-deployed before deployed-at-some-point
--   3. oldest last-deployed first
--   4. alphabetical name (stable tie-break)
create or replace function public.today_roster_auto_assign(p_date date default current_date)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_gap record;
  v_van record;
  v_assigned int := 0;
  v_unassigned int := 0;
  v_result jsonb := jsonb_build_object('assigned', '[]'::jsonb, 'unassigned', '[]'::jsonb);
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for v_gap in
    select (g->>'driver_id')::uuid as driver_id,
           (g->>'shift_id')::uuid  as shift_id,
           g->>'driver_name'       as driver_name,
           g->>'route_code'        as route_code,
           g->>'station_code'      as station_code,
           g->>'starts_at'         as starts_at
    from jsonb_array_elements(public.today_roster(p_date)) g
    where g->>'gap_kind' = 'no_van'
    order by g->>'starts_at' nulls last, g->>'station_code' nulls last, g->>'driver_name'
  loop
    select v.id, v.name, v.plate,
           coalesce(v.is_branded, true) as is_branded,
           private.vehicle_last_deployed(v.id) as last_deployed
    into v_van
    from public.vehicles v
    where v.dsp_id = v_dsp
      and v.archived_at is null
      and v.status in ('active', 'spare')
      and coalesce(v.operational_status,'operational') <> 'grounded'
      and not exists (
        select 1 from public.vehicle_day_assignments oa
        where oa.vehicle_id = v.id and oa.date = p_date
      )
      and not exists (
        select 1 from public.vehicle_driver_assignments a
        join public.shifts s on s.driver_id = a.driver_id
        where a.vehicle_id = v.id and s.date = p_date
          and s.status in ('scheduled','completed','late')
      )
    order by
      -- Branded vans win — deploying them protects FEM; non-branded
      -- assets serve as a last-resort pool.
      case when coalesce(v.is_branded, true) then 0 else 1 end,
      -- Within branded, never-deployed and oldest-deployed win.
      case when private.vehicle_last_deployed(v.id) is null then 0 else 1 end,
      private.vehicle_last_deployed(v.id) asc nulls first,
      v.name
    limit 1;

    if v_van.id is not null then
      insert into public.vehicle_day_assignments (dsp_id, vehicle_id, driver_id, date, source, created_by)
      values (v_dsp, v_van.id, v_gap.driver_id, p_date, 'auto', auth.uid())
      on conflict (driver_id, date) do update
        set vehicle_id = excluded.vehicle_id,
            source     = excluded.source,
            updated_at = now();
      v_assigned := v_assigned + 1;
      v_result := jsonb_set(v_result, '{assigned}',
        (v_result->'assigned') || jsonb_build_object(
          'driver_id',  v_gap.driver_id,
          'driver_name',v_gap.driver_name,
          'vehicle_id', v_van.id,
          'vehicle_name', v_van.name,
          'route_code', v_gap.route_code,
          'fem_protected',
            case when not v_van.is_branded then false
                 when v_van.last_deployed is null then true
                 when (current_date - v_van.last_deployed) >= 7 then true
                 else false end
        )
      );
    else
      v_unassigned := v_unassigned + 1;
      v_result := jsonb_set(v_result, '{unassigned}',
        (v_result->'unassigned') || jsonb_build_object(
          'driver_id',  v_gap.driver_id,
          'driver_name',v_gap.driver_name,
          'route_code', v_gap.route_code,
          'reason',     'no_van_available'
        )
      );
    end if;
  end loop;

  return v_result || jsonb_build_object('assigned_count', v_assigned, 'unassigned_count', v_unassigned);
end;
$$;
grant execute on function public.today_roster_auto_assign(date) to authenticated;


notify pgrst, 'reload schema';
