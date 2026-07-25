-- Migration 0570 · Fleet-wide cost report
--
-- The last deferred item from the fleet-inventory push
-- (docs/FLEET-SYSTEM.md §5b): vehicle_cost_summary (0539) answers "what
-- did THIS van cost?" one van at a time — nothing answered "which vans
-- are eating the budget?" across the fleet. This RPC is the set-based
-- version: one row per non-archived van with windowed spend by bucket,
-- miles driven, and cost-per-mile, plus fleet totals.
--
-- Buckets mirror vehicle_cost_summary exactly (keep the two in sync):
--   repair  = settled Repair Center invoices (via the case's van)
--           + completed legacy repair_orders NOT linked to a case
--   service = vehicle_service_logs + fleet_pm_completions
--   parts   = part_purchases (not returned/cancelled)
--           + consumed shelf stock (parts_stock_movements consume −
--             returns, priced at the movement's captured unit cost)
-- Miles = max−min of vehicle_mileage_log readings inside the window.
-- Optional tables (0485/0486/0491/0539/0540 may be unapplied) fail soft
-- to zero via per-source exception guards. Station lens filters by
-- vehicles.station_id; null = DSP-wide. Idempotent — safe to re-run.

create or replace function public.fleet_cost_report(
  p_months     int  default 12,
  p_station_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_from date := (current_date - make_interval(months => greatest(coalesce(p_months, 12), 1)))::date;
  v_repair  jsonb := '{}'::jsonb;  -- vehicle_id → cents, one guarded map per source
  v_ro      jsonb := '{}'::jsonb;
  v_service jsonb := '{}'::jsonb;
  v_pm      jsonb := '{}'::jsonb;
  v_parts   jsonb := '{}'::jsonb;
  v_stock   jsonb := '{}'::jsonb;
  v_miles   jsonb := '{}'::jsonb;
  v_vans    jsonb;
  v_summary jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  begin
    select coalesce(jsonb_object_agg(t.vid::text, t.cents), '{}'::jsonb) into v_repair
    from (
      select rc.vehicle_id as vid, sum(i.grand_total_cents)::bigint as cents
      from public.repair_invoices i
      join public.repair_cases rc on rc.id = i.repair_case_id
      where rc.dsp_id = v_dsp and rc.vehicle_id is not null
        and i.status = 'settled'
        and coalesce(i.settled_at, i.created_at)::date >= v_from
      group by rc.vehicle_id
    ) t;
  exception when undefined_table then null; end;

  begin
    select coalesce(jsonb_object_agg(t.vid::text, t.cents), '{}'::jsonb) into v_ro
    from (
      select ro.vehicle_id as vid, sum(ro.cost_cents)::bigint as cents
      from public.repair_orders ro
      where ro.dsp_id = v_dsp and ro.vehicle_id is not null
        and ro.status = 'completed' and ro.cost_cents is not null
        and coalesce(ro.completed_at, ro.opened_at)::date >= v_from
        and not exists (select 1 from public.repair_cases rc2 where rc2.repair_order_id = ro.id)
      group by ro.vehicle_id
    ) t;
  exception when undefined_table then null; end;

  select coalesce(jsonb_object_agg(t.vid::text, t.cents), '{}'::jsonb) into v_service
  from (
    select l.vehicle_id as vid, sum(l.cost_cents)::bigint as cents
    from public.vehicle_service_logs l
    where l.dsp_id = v_dsp and l.cost_cents is not null
      and l.occurred_at >= v_from
    group by l.vehicle_id
  ) t;

  begin
    select coalesce(jsonb_object_agg(t.vid::text, t.cents), '{}'::jsonb) into v_pm
    from (
      select c.vehicle_id as vid, sum(c.cost_cents)::bigint as cents
      from public.fleet_pm_completions c
      where c.dsp_id = v_dsp and c.cost_cents is not null
        and c.completed_on >= v_from
      group by c.vehicle_id
    ) t;
  exception when undefined_table then null; end;

  begin
    select coalesce(jsonb_object_agg(t.vid::text, t.cents), '{}'::jsonb) into v_parts
    from (
      select pp.vehicle_id as vid,
             sum(coalesce(pp.final_cost_cents, 0) + coalesce(pp.labor_cost_cents, 0))::bigint as cents
      from public.part_purchases pp
      where pp.dsp_id = v_dsp and pp.vehicle_id is not null
        and pp.status not in ('returned','cancelled')
        and pp.created_at::date >= v_from
      group by pp.vehicle_id
    ) t;
  exception when undefined_table then null; end;

  begin
    select coalesce(jsonb_object_agg(t.vid::text, t.cents), '{}'::jsonb) into v_stock
    from (
      select m.vehicle_id as vid,
             greatest(sum((-m.qty_delta)::bigint * coalesce(m.unit_cost_cents, 0)), 0) as cents
      from public.parts_stock_movements m
      where m.dsp_id = v_dsp and m.vehicle_id is not null
        and m.kind in ('consume','return')
        and m.created_at::date >= v_from
      group by m.vehicle_id
    ) t;
  exception when undefined_table then null; end;

  select coalesce(jsonb_object_agg(t.vid::text, t.mi), '{}'::jsonb) into v_miles
  from (
    select m.vehicle_id as vid, greatest(max(m.mileage) - min(m.mileage), 0)::bigint as mi
    from public.vehicle_mileage_log m
    where m.dsp_id = v_dsp
      and m.reading_at::date >= v_from
    group by m.vehicle_id
  ) t;

  select
    coalesce(jsonb_agg(vrow order by (vrow->>'total_cents')::bigint desc, vrow->>'name'), '[]'::jsonb),
    jsonb_build_object(
      'vans',               count(*),
      'vans_with_spend',    count(*) filter (where (vrow->>'total_cents')::bigint > 0),
      'repair_cents',       coalesce(sum((vrow->>'repair_cents')::bigint), 0),
      'service_cents',      coalesce(sum((vrow->>'service_cents')::bigint), 0),
      'parts_cents',        coalesce(sum((vrow->>'parts_cents')::bigint), 0),
      'total_cents',        coalesce(sum((vrow->>'total_cents')::bigint), 0),
      'miles',              coalesce(sum((vrow->>'miles')::bigint), 0),
      'cost_per_mile_cents',
        case when coalesce(sum((vrow->>'miles')::bigint), 0) > 0
             then round(coalesce(sum((vrow->>'total_cents')::bigint), 0)::numeric
                        / sum((vrow->>'miles')::bigint), 1) end
    )
  into v_vans, v_summary
  from (
    select jsonb_build_object(
      'id',                 v.id,
      'name',               v.name,
      'nickname',           v.nickname,
      'van_type',           v.van_type,
      'ownership',          v.ownership,
      'status',             v.status,
      'operational_status', v.operational_status,
      'station_id',         v.station_id,
      'station_code',       st.code,
      'lease_monthly_cents', v.lease_monthly_cents,
      'repair_cents',       x.repair_c,
      'service_cents',      x.service_c,
      'parts_cents',        x.parts_c,
      'total_cents',        x.repair_c + x.service_c + x.parts_c,
      'miles',              x.mi,
      'cost_per_mile_cents',
        case when x.mi > 0
             then round((x.repair_c + x.service_c + x.parts_c)::numeric / x.mi, 1) end
    ) as vrow
    from public.vehicles v
    left join public.stations st on st.id = v.station_id
    cross join lateral (
      select coalesce((v_repair  ->> v.id::text)::bigint, 0)
           + coalesce((v_ro      ->> v.id::text)::bigint, 0) as repair_c,
             coalesce((v_service ->> v.id::text)::bigint, 0)
           + coalesce((v_pm      ->> v.id::text)::bigint, 0) as service_c,
             coalesce((v_parts   ->> v.id::text)::bigint, 0)
           + coalesce((v_stock   ->> v.id::text)::bigint, 0) as parts_c,
             coalesce((v_miles   ->> v.id::text)::bigint, 0) as mi
    ) x
    where v.dsp_id = v_dsp
      and v.archived_at is null
      and (p_station_id is null or v.station_id = p_station_id)
  ) t;

  return jsonb_build_object(
    'window_months', greatest(coalesce(p_months, 12), 1),
    'vans',          v_vans,
    'summary',       coalesce(v_summary, jsonb_build_object(
                       'vans',0,'vans_with_spend',0,'repair_cents',0,'service_cents',0,
                       'parts_cents',0,'total_cents',0,'miles',0,'cost_per_mile_cents',null)),
    'generated_at',  now()
  );
end;
$$;
grant execute on function public.fleet_cost_report(int, uuid) to authenticated;


notify pgrst, 'reload schema';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0570_fleet_cost_report.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
