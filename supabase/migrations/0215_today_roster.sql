-- Migration 0215 · Today's Plan — driver + van roster RPC
--
-- For each driver scheduled (or already completed) today, return the
-- van they're rolling — resolved by the same rules as the driver app
-- (driver_vehicle_days, 0187): their primary van if they have one and
-- it's active, otherwise the highest-rank backup van whose primary
-- isn't on today's schedule, otherwise null (a "no van" gap).
--
-- This is the dispatcher-side day view: who is working today + which
-- van each one is in + where the gaps are.  Sits on the Today's Plan
-- home page and surfaces unresolved problems (driver scheduled with no
-- assignable van) before they bite at the lot.

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
      'van_via',      resolved.via,                -- 'primary' | 'backup' | null
      'covering_for', resolved.covering_for_name,  -- only when via = 'backup'
      'gap_kind',     case when resolved.van_id is null then 'no_van' else null end
    ) j
    from public.shifts s
    join public.drivers d on d.id = s.driver_id
    left join public.stations st on st.id = s.station_id
    left join lateral (
      -- Primary pick: driver is rank-0 on an active, in-service van.
      with primary_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'primary'::text as via, null::text as covering_for_name
        from public.vehicle_driver_assignments a
        join public.vehicles v on v.id = a.vehicle_id
        where a.driver_id = d.id and a.rank = 0
          and v.dsp_id = d.dsp_id
          and v.status = 'active'
          and v.archived_at is null
        order by v.name
        limit 1
      ),
      -- Backup pick: driver is rank>0 on an active, in-service van whose
      -- primary (rank 0) isn't scheduled today.  Picks the lowest rank
      -- (i.e., backup 1 before backup 2).
      backup_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'backup'::text as via,
               coalesce(nullif(trim(pri_d.preferred_name), ''), nullif(trim(pri_d.full_name), '')) as covering_for_name
        from public.vehicle_driver_assignments a
        join public.vehicles v on v.id = a.vehicle_id
        left join public.vehicle_driver_assignments pri_a on pri_a.vehicle_id = v.id and pri_a.rank = 0
        left join public.drivers pri_d on pri_d.id = pri_a.driver_id
        where a.driver_id = d.id and a.rank > 0
          and v.dsp_id = d.dsp_id
          and v.status = 'active'
          and v.archived_at is null
          and (
            pri_a.driver_id is null
            or not exists (
              select 1 from public.shifts ps
              where ps.driver_id = pri_a.driver_id
                and ps.date = p_date
                and ps.dsp_id = d.dsp_id
                and ps.status in ('scheduled', 'completed')
            )
          )
        order by a.rank, v.name
        limit 1
      )
      select * from primary_pick
      union all
      select * from backup_pick where not exists (select 1 from primary_pick)
      limit 1
    ) resolved on true
    where s.dsp_id = private.current_dsp_id()
      and private.is_staff(s.dsp_id, 'dispatcher')
      and s.date = p_date
      and s.driver_id is not null
      and s.status in ('scheduled', 'completed')
  ) t;
$$;
grant execute on function public.today_roster(date) to authenticated;


notify pgrst, 'reload schema';
