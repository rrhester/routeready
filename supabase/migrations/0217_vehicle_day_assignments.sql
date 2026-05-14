-- Migration 0217 · Fleet — per-day van assignments + auto-assign tool
--
-- The standing chain (vehicle_driver_assignments, 0186) is for the
-- regular pairing of a driver and a van.  Real days have shifts the
-- chain doesn't cover — a new hire with no chain yet, a driver pulled
-- in to cover a call-off, a primary van that's grounded for the day.
-- Until now those shifts surfaced as "No van" gaps on the Today's
-- Plan roster and stayed there until the operator hand-built the
-- standing chain — even though the override was only meant for today.
--
-- This migration introduces a per-day override table and an
-- auto-assign tool that pulls from the available pool to fill every
-- gap for a given date.  The override is good for the date it's
-- written for; tomorrow re-runs cleanly against the standing chain
-- without baggage.
--
-- Resolution priority (new):
--   1. per-day override (vehicle_day_assignments) for this date
--   2. standing primary (rank 0) if the van is active
--   3. standing backup (rank 1+) when their primary isn't on today
--   4. "No van" gap


-- ── 1. Per-day overrides ────────────────────────────────────────────
create table if not exists public.vehicle_day_assignments (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  vehicle_id  uuid not null references public.vehicles(id) on delete cascade,
  driver_id   uuid not null references public.drivers(id) on delete cascade,
  date        date not null,
  source      text not null default 'manual',     -- manual | auto_assign
  notes       text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (vehicle_id, date),
  unique (driver_id, date)
);
create index if not exists vehicle_day_assignments_dsp_date_idx on public.vehicle_day_assignments (dsp_id, date);
create index if not exists vehicle_day_assignments_driver_date_idx on public.vehicle_day_assignments (driver_id, date);

alter table public.vehicle_day_assignments enable row level security;
drop policy if exists "vehicle_day_assignments_rw" on public.vehicle_day_assignments;
create policy "vehicle_day_assignments_rw" on public.vehicle_day_assignments
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));
grant select, insert, update, delete on public.vehicle_day_assignments to authenticated;


-- ── 2. today_roster — consults overrides first ──────────────────────
create or replace function public.today_roster(p_date date default current_date)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(j order by j->>'starts_at' nulls last, j->>'station_code' nulls last, j->>'driver_name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'shift_id',     s.id,
      'shift_date',   s.date,
      'starts_at',    s.starts_at,
      'ends_at',      s.ends_at,
      'route_code',   s.route_code,
      'shift_status', s.status,
      'station_id',   s.station_id,
      'station_code', st.code,
      'driver_id',    d.id,
      'driver_name',  coalesce(nullif(trim(d.preferred_name), ''), nullif(trim(d.full_name), ''), 'Driver'),
      'driver_photo_path', d.photo_path,
      'tier',         d.tier,
      'van_id',       resolved.van_id,
      'van_name',     resolved.van_name,
      'van_plate',    resolved.van_plate,
      'van_via',      resolved.via,
      'covering_for', resolved.covering_for_name,
      'gap_kind',     case when resolved.van_id is null then 'no_van' else null end
    ) j
    from public.shifts s
    join public.drivers d on d.id = s.driver_id
    left join public.stations st on st.id = s.station_id
    left join lateral (
      -- 1. per-day override (highest priority)
      with override_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'override'::text as via, null::text as covering_for_name
        from public.vehicle_day_assignments oa
        join public.vehicles v on v.id = oa.vehicle_id
        where oa.driver_id = d.id and oa.date = p_date
          and v.dsp_id = d.dsp_id and v.archived_at is null
        limit 1
      ),
      -- 2. standing primary
      primary_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'primary'::text as via, null::text as covering_for_name
        from public.vehicle_driver_assignments a
        join public.vehicles v on v.id = a.vehicle_id
        where a.driver_id = d.id and a.rank = 0
          and v.dsp_id = d.dsp_id and v.status = 'active' and v.archived_at is null
          -- skip when an override for this van+date already exists for someone else
          and not exists (
            select 1 from public.vehicle_day_assignments oa
            where oa.vehicle_id = v.id and oa.date = p_date
          )
        order by v.name limit 1
      ),
      -- 3. standing backup whose primary isn't on today
      backup_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'backup'::text as via,
               coalesce(nullif(trim(pri_d.preferred_name), ''), nullif(trim(pri_d.full_name), '')) as covering_for_name
        from public.vehicle_driver_assignments a
        join public.vehicles v on v.id = a.vehicle_id
        left join public.vehicle_driver_assignments pri_a on pri_a.vehicle_id = v.id and pri_a.rank = 0
        left join public.drivers pri_d on pri_d.id = pri_a.driver_id
        where a.driver_id = d.id and a.rank > 0
          and v.dsp_id = d.dsp_id and v.status = 'active' and v.archived_at is null
          and not exists (
            select 1 from public.vehicle_day_assignments oa
            where oa.vehicle_id = v.id and oa.date = p_date
          )
          and (
            pri_a.driver_id is null
            or not exists (
              select 1 from public.shifts ps
              where ps.driver_id = pri_a.driver_id
                and ps.date = p_date
                and ps.dsp_id = d.dsp_id
                and ps.status in ('scheduled', 'completed', 'late')
            )
          )
        order by a.rank, v.name limit 1
      )
      select * from override_pick
      union all
      select * from primary_pick where not exists (select 1 from override_pick)
      union all
      select * from backup_pick where not exists (select 1 from override_pick) and not exists (select 1 from primary_pick)
      limit 1
    ) resolved on true
    where s.dsp_id = private.current_dsp_id()
      and private.is_staff(s.dsp_id, 'dispatcher')
      and s.date = p_date
      and s.driver_id is not null
  ) t;
$$;
grant execute on function public.today_roster(date) to authenticated;


-- ── 3. Auto-assign tool ─────────────────────────────────────────────
-- Greedy gap-fill: for each scheduled driver who currently has no
-- resolved van on p_date (per the new resolver), pull the lowest-name
-- available van from the active+spare pool and write a per-day
-- override.  Returns a structured payload so the UI can show what
-- happened.
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

  -- Step 1: find every gap (scheduled driver, no van resolved by today_roster)
  -- We compute the gaps by querying today_roster and filtering for gap_kind.
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
    -- Step 2: find an available van — not archived, status active or
    -- spare, and not already taken today (either via the chain or via
    -- an override we just wrote in this loop).
    select v.id, v.name, v.plate into v_van
    from public.vehicles v
    where v.dsp_id = v_dsp
      and v.archived_at is null
      and v.status in ('active', 'spare')
      and not exists (
        select 1 from public.vehicle_day_assignments oa
        where oa.vehicle_id = v.id and oa.date = p_date
      )
      and not exists (
        -- Van is the standing primary of someone who's on today.
        select 1
        from public.vehicle_driver_assignments a
        join public.shifts s on s.driver_id = a.driver_id
        where a.vehicle_id = v.id and a.rank = 0
          and s.date = p_date and s.dsp_id = v_dsp
          and s.status in ('scheduled', 'completed', 'late')
      )
      and not exists (
        -- Van is being used by a backup today (no primary scheduled,
        -- backup picked it up).
        select 1
        from public.vehicle_driver_assignments backup_a
        join public.shifts backup_s on backup_s.driver_id = backup_a.driver_id
        where backup_a.vehicle_id = v.id and backup_a.rank > 0
          and backup_s.date = p_date and backup_s.dsp_id = v_dsp
          and backup_s.status in ('scheduled', 'completed', 'late')
          and not exists (
            select 1
            from public.vehicle_driver_assignments pri_a
            join public.shifts pri_s on pri_s.driver_id = pri_a.driver_id
            where pri_a.vehicle_id = v.id and pri_a.rank = 0
              and pri_s.date = p_date and pri_s.dsp_id = v_dsp
              and pri_s.status in ('scheduled', 'completed', 'late')
          )
      )
    order by v.name
    limit 1;

    if v_van.id is not null then
      insert into public.vehicle_day_assignments (dsp_id, vehicle_id, driver_id, date, source, created_by)
      values (v_dsp, v_van.id, v_gap.driver_id, p_date, 'auto_assign', auth.uid());
      v_assigned := v_assigned + 1;
      v_result := jsonb_set(
        v_result, '{assigned}',
        (v_result->'assigned') || jsonb_build_object(
          'driver_id',   v_gap.driver_id,
          'driver_name', v_gap.driver_name,
          'van_id',      v_van.id,
          'van_name',    v_van.name,
          'van_plate',   v_van.plate,
          'shift_id',    v_gap.shift_id,
          'route_code',  v_gap.route_code,
          'station_code',v_gap.station_code
        )
      );
    else
      v_unassigned := v_unassigned + 1;
      v_result := jsonb_set(
        v_result, '{unassigned}',
        (v_result->'unassigned') || jsonb_build_object(
          'driver_id',   v_gap.driver_id,
          'driver_name', v_gap.driver_name,
          'shift_id',    v_gap.shift_id,
          'route_code',  v_gap.route_code,
          'station_code',v_gap.station_code,
          'reason',      'no_van_available'
        )
      );
    end if;
  end loop;

  return v_result
       || jsonb_build_object('assigned_count', v_assigned)
       || jsonb_build_object('unassigned_count', v_unassigned)
       || jsonb_build_object('date', p_date);
end;
$$;
grant execute on function public.today_roster_auto_assign(date) to authenticated;


-- ── 4. Clear / set helpers ──────────────────────────────────────────
-- Operator can delete a single override (e.g. to undo auto-assign for
-- one driver) without clearing the whole day.
create or replace function public.vehicle_day_assignment_clear(p_driver_id uuid, p_date date)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.vehicle_day_assignments
   where driver_id = p_driver_id and date = p_date and dsp_id = v_dsp;
end;
$$;
grant execute on function public.vehicle_day_assignment_clear(uuid, date) to authenticated;

-- Bulk clear for a date (e.g. "undo all auto-assignments for today").
create or replace function public.vehicle_day_assignments_clear_date(p_date date, p_source text default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_n int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.vehicle_day_assignments
   where date = p_date and dsp_id = v_dsp
     and (p_source is null or source = p_source);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
grant execute on function public.vehicle_day_assignments_clear_date(date, text) to authenticated;


notify pgrst, 'reload schema';
