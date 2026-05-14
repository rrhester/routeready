-- Migration 0230 · Grounded vehicles can't be scheduled on a route
--
-- The Fleet roster is the source of truth for a van's operational
-- state.  Operators flip a van to grounded from the inline pill menu
-- there (migration 0229) — and from this migration forward, that flip
-- has teeth:
--
--   1. vehicle_day_assignment_set refuses to assign a grounded van.
--      The dispatcher gets a clean "vehicle_grounded" error the UI can
--      translate ("KMO1-08B is grounded — unground it on the Fleet
--      roster first.")
--
--   2. today_roster_auto_assign skips grounded vans when filling gaps.
--
--   3. A trigger on vehicles, fired when operational_status flips to
--      grounded, automatically clears every same-day-or-future row in
--      vehicle_day_assignments for that vehicle and writes a
--      compliance_audit_events row per cleared assignment.  This is
--      the "status on van assignments updates when a van is grounded"
--      half of the requirement — assignments don't silently stay valid
--      against a van that can't drive.
--
-- Idempotent: safe to re-run.

-- ── 1. vehicle_day_assignment_set · refuse grounded vans ─────────────
create or replace function public.vehicle_day_assignment_set(
  p_driver_id uuid,
  p_date      date,
  p_vehicle_id uuid default null,
  p_source    text default 'manual',
  p_notes     text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vehicle_day_assignments;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_driver_id is null or p_date is null then
    raise exception 'driver_id_and_date_required' using errcode = '22023';
  end if;

  -- Clear path
  if p_vehicle_id is null then
    delete from public.vehicle_day_assignments
     where driver_id = p_driver_id and date = p_date and dsp_id = v_dsp;
    return jsonb_build_object('cleared', true);
  end if;

  -- Validate vehicle is owned by this DSP and isn't archived.
  if not exists (
    select 1 from public.vehicles
    where id = p_vehicle_id and dsp_id = v_dsp and archived_at is null
  ) then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;

  -- Refuse to assign a grounded vehicle.  Grounding is governed by
  -- the Fleet roster — operators can only flip status from there.
  if exists (
    select 1 from public.vehicles
    where id = p_vehicle_id and dsp_id = v_dsp
      and operational_status = 'grounded'
  ) then
    raise exception 'vehicle_grounded' using errcode = 'P0001';
  end if;

  -- If another driver already owns this van on this date, surface a
  -- clean error the UI can show.
  if exists (
    select 1 from public.vehicle_day_assignments
    where vehicle_id = p_vehicle_id and date = p_date and dsp_id = v_dsp
      and driver_id <> p_driver_id
  ) then
    raise exception 'vehicle_already_assigned' using errcode = '23505';
  end if;

  insert into public.vehicle_day_assignments (
    dsp_id, vehicle_id, driver_id, date, source, notes, created_by
  ) values (
    v_dsp, p_vehicle_id, p_driver_id, p_date,
    coalesce(nullif(trim(p_source), ''), 'manual'),
    nullif(trim(p_notes), ''),
    auth.uid()
  )
  on conflict (driver_id, date) do update
    set vehicle_id = excluded.vehicle_id,
        source     = excluded.source,
        notes      = excluded.notes,
        updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'id',         v_row.id,
    'driver_id',  v_row.driver_id,
    'vehicle_id', v_row.vehicle_id,
    'date',       v_row.date,
    'source',     v_row.source
  );
end;
$$;
grant execute on function public.vehicle_day_assignment_set(uuid, date, uuid, text, text) to authenticated;


-- ── 2. today_roster_auto_assign · skip grounded vans ─────────────────
-- We re-create the function as it lives in migration 0217, adding one
-- predicate: `coalesce(v.operational_status,'operational') <> 'grounded'`
-- on the candidate-van scan.  The remainder of the body is unchanged
-- so the auto-assign workflow keeps doing what it already does.
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
    select v.id, v.name, v.plate into v_van
    from public.vehicles v
    where v.dsp_id = v_dsp
      and v.archived_at is null
      and v.status in ('active', 'spare')
      and coalesce(v.operational_status,'operational') <> 'grounded'   -- NEW
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
    order by v.name
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
          'route_code', v_gap.route_code
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


-- ── 3. Trigger: on ground, clear today/future van assignments ────────
-- The Fleet roster is the source of truth for grounding state.  When
-- a van flips to grounded, every same-day-or-future van-day assignment
-- for that vehicle is removed and a compliance audit row is written
-- per cleared row.  The dispatcher will see the gap in Today's Roster
-- and pick a different van.
create or replace function public._fleet_clear_assignments_on_ground()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cleared int := 0;
  v_rec record;
begin
  if tg_op = 'UPDATE'
     and old.operational_status is distinct from new.operational_status
     and new.operational_status = 'grounded' then
    for v_rec in
      delete from public.vehicle_day_assignments
       where vehicle_id = new.id
         and date >= current_date
       returning *
    loop
      v_cleared := v_cleared + 1;
      insert into public.compliance_audit_events
        (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
      values (
        new.dsp_id, 'system', auth.uid(),
        'assignment_cleared_on_ground',
        'Cleared day-assignment for grounded vehicle ' || coalesce(new.nickname, new.name, '(unnamed)'),
        'Date: ' || v_rec.date::text,
        'vehicle_day_assignment', v_rec.id
      );
    end loop;
  end if;
  return new;
end $$;

drop trigger if exists fleet_clear_assignments_on_ground on public.vehicles;
create trigger fleet_clear_assignments_on_ground
  after update of operational_status on public.vehicles
  for each row execute function public._fleet_clear_assignments_on_ground();
