-- Migration 0271 · Trainee inherits the trainer's van on ride-along day
--
-- 0264 inserts a shift_kind='ride_along' row for the trainee on day 3,
-- pointing at the trainer via shifts.trainer_driver_id. But neither
-- today_roster (dispatcher's "Today's Plan") nor driver_vehicle_days
-- (the driver app's schedule) had a branch for it, so:
--
--   • On the dispatcher's view, the trainee shows up scheduled with
--     gap_kind='no_van'. A real gap, except it's not — they're
--     sharing the trainer's van.
--   • On the driver app, the trainee's ride-along card has no
--     "Vehicle ____" line at all, so they don't know what to look
--     for in the lot.
--
-- The fix is purely view-time. We don't insert into
-- vehicle_day_assignments because (a) the table's unique (vehicle_id,
-- date) constraint would block sharing the van between two drivers,
-- and (b) it would break the trainer's own resolution by stealing
-- their primary. Instead we add a "trainee_pick" branch at the end of
-- both resolution chains: when the trainee's shift_kind = 'ride_along',
-- resolve the trainer's van via the standard override → primary →
-- backup chain and return that. If the trainer's van moves between
-- activation and the ride-along day, the trainee follows.

-- ── 1. today_roster ────────────────────────────────────────────────
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
      'shift_kind',   s.shift_kind,
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
      'van_via_source', resolved.via_source,
      'covering_for', resolved.covering_for_name,
      -- Class-training shifts (Day 1+2) legitimately have no van —
      -- the trainee is in the station all day. Mark them so the UI
      -- doesn't surface a "needs van" warning. Ride-along shifts
      -- that didn't resolve a trainer's van are a real gap.
      'gap_kind',     case
                        when resolved.van_id is not null then null
                        when s.shift_kind = 'training'   then 'class_training'
                        when s.shift_kind = 'ride_along' then 'ride_along_no_trainer_van'
                        else 'no_van'
                      end
    ) j
    from public.shifts s
    join public.drivers d on d.id = s.driver_id
    left join public.stations st on st.id = s.station_id
    left join lateral (
      with override_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'override'::text as via,
               oa.source        as via_source,
               null::text       as covering_for_name
        from public.vehicle_day_assignments oa
        join public.vehicles v on v.id = oa.vehicle_id
        where oa.driver_id = d.id and oa.date = p_date
          and v.dsp_id = d.dsp_id and v.archived_at is null
        limit 1
      ),
      primary_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'primary'::text as via,
               null::text      as via_source,
               null::text      as covering_for_name
        from public.vehicle_driver_assignments a
        join public.vehicles v on v.id = a.vehicle_id
        where a.driver_id = d.id and a.rank = 0
          and v.dsp_id = d.dsp_id and v.status = 'active' and v.archived_at is null
          and coalesce(v.operational_status, 'operational') <> 'grounded'
          and not exists (
            select 1 from public.vehicle_day_assignments oa
            where oa.vehicle_id = v.id and oa.date = p_date
          )
        order by v.name limit 1
      ),
      backup_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'backup'::text as via,
               null::text     as via_source,
               coalesce(nullif(trim(pri_d.preferred_name), ''), nullif(trim(pri_d.full_name), '')) as covering_for_name
        from public.vehicle_driver_assignments a
        join public.vehicles v on v.id = a.vehicle_id
        left join public.vehicle_driver_assignments pri_a on pri_a.vehicle_id = v.id and pri_a.rank = 0
        left join public.drivers pri_d on pri_d.id = pri_a.driver_id
        where a.driver_id = d.id and a.rank > 0
          and v.dsp_id = d.dsp_id and v.status = 'active' and v.archived_at is null
          and coalesce(v.operational_status, 'operational') <> 'grounded'
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
      ),
      -- Trainee on a ride-along day: resolve the trainer's van using
      -- the same override → primary → backup chain. coalesce picks
      -- the first non-null leg, so the chain is explicit and ordered.
      -- We never recurse — the trainer's own shift is shift_kind =
      -- 'regular', so their resolution never re-enters this branch.
      trainee_pick as (
        select
          coalesce(o.id, pr.id, b.id) as van_id,
          coalesce(o.name, pr.name, b.name) as van_name,
          coalesce(o.plate, pr.plate, b.plate) as van_plate,
          'trainee'::text as via,
          null::text as via_source,
          coalesce(nullif(trim(tr.preferred_name), ''),
                   nullif(trim(tr.full_name), '')) as covering_for_name
        from public.drivers tr
        left join lateral (
          select v.id, v.name, v.plate
          from public.vehicle_day_assignments oa
          join public.vehicles v on v.id = oa.vehicle_id
          where oa.driver_id = tr.id and oa.date = p_date
            and v.dsp_id = tr.dsp_id and v.archived_at is null
          limit 1
        ) o on true
        left join lateral (
          select v.id, v.name, v.plate
          from public.vehicle_driver_assignments a
          join public.vehicles v on v.id = a.vehicle_id
          where a.driver_id = tr.id and a.rank = 0
            and v.dsp_id = tr.dsp_id and v.status = 'active' and v.archived_at is null
            and coalesce(v.operational_status, 'operational') <> 'grounded'
            and not exists (
              select 1 from public.vehicle_day_assignments oa2
              where oa2.vehicle_id = v.id and oa2.date = p_date
            )
          order by v.name limit 1
        ) pr on true
        left join lateral (
          select v.id, v.name, v.plate
          from public.vehicle_driver_assignments a
          join public.vehicles v on v.id = a.vehicle_id
          left join public.vehicle_driver_assignments pri_a on pri_a.vehicle_id = v.id and pri_a.rank = 0
          where a.driver_id = tr.id and a.rank > 0
            and v.dsp_id = tr.dsp_id and v.status = 'active' and v.archived_at is null
            and coalesce(v.operational_status, 'operational') <> 'grounded'
            and not exists (
              select 1 from public.vehicle_day_assignments oa3
              where oa3.vehicle_id = v.id and oa3.date = p_date
            )
            and (
              pri_a.driver_id is null
              or not exists (
                select 1 from public.shifts ps
                where ps.driver_id = pri_a.driver_id
                  and ps.date = p_date
                  and ps.dsp_id = tr.dsp_id
                  and ps.status in ('scheduled', 'completed', 'late')
              )
            )
          order by a.rank, v.name limit 1
        ) b on true
        where s.shift_kind = 'ride_along'
          and s.trainer_driver_id is not null
          and tr.id = s.trainer_driver_id
          and coalesce(o.id, pr.id, b.id) is not null
        limit 1
      )
      select * from override_pick
      union all
      select * from primary_pick where not exists (select 1 from override_pick)
      union all
      select * from backup_pick  where not exists (select 1 from override_pick)
                                  and not exists (select 1 from primary_pick)
      union all
      select * from trainee_pick where not exists (select 1 from override_pick)
                                  and not exists (select 1 from primary_pick)
                                  and not exists (select 1 from backup_pick)
      limit 1
    ) resolved on true
    where s.dsp_id = private.current_dsp_id()
      and private.is_staff(s.dsp_id, 'dispatcher')
      and s.date = p_date
      and s.driver_id is not null
      and d.role = 'driver'
  ) t;
$$;
grant execute on function public.today_roster(date) to authenticated;


-- ── 2. driver_vehicle_days ────────────────────────────────────────
-- Same idea on the driver-app side: when the driver's own shift on a
-- given day is a ride_along, inherit the trainer's resolved van using
-- the full override → primary → backup chain.
create or replace function public.driver_vehicle_days(
  p_token text,
  p_from  date default current_date,
  p_to    date default (current_date + 14)
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv  public.drivers;
  v_from date := least(coalesce(p_from, current_date), coalesce(p_to, current_date + 14));
  v_to   date := greatest(coalesce(p_from, current_date), coalesce(p_to, current_date + 14));
begin
  v_drv := private.driver_validate_token(p_token);
  if v_to - v_from > 92 then v_to := v_from + 92; end if;
  return coalesce((
    with days as (
      select (v_from + g.i)::date as d from generate_series(0, (v_to - v_from)) as g(i)
    ),
    sched as (
      select days.d,
             (
               select s.trainer_driver_id from public.shifts s
                where s.driver_id = v_drv.id and s.date = days.d and s.dsp_id = v_drv.dsp_id
                  and s.status in ('scheduled', 'completed')
                  and s.shift_kind = 'ride_along'
                order by s.starts_at nulls last
                limit 1
             ) as trainer_id
      from days
      where exists (
        select 1 from public.shifts s
         where s.driver_id = v_drv.id and s.date = days.d and s.dsp_id = v_drv.dsp_id
           and s.status in ('scheduled', 'completed')
      )
    ),
    resolved as (
      select sched.d,
        sched.trainer_id,
        ( select v.name from public.vehicles v
            join public.vehicle_driver_assignments a on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank = 0
           where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
           order by v.name limit 1 ) as primary_van,
        ( select v.name from public.vehicles v
            join public.vehicle_driver_assignments a on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank = 1
           where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
             and not exists (
               select 1 from public.vehicle_driver_assignments ap
                 join public.shifts sp on sp.driver_id = ap.driver_id and sp.date = sched.d
                                       and sp.dsp_id = v_drv.dsp_id and sp.status in ('scheduled', 'completed')
                where ap.vehicle_id = v.id and ap.rank = 0
             )
           order by v.name limit 1 ) as backup_van,
        -- Trainer's resolved van (only when this is a ride-along day).
        -- coalesce(override → primary → backup) on the trainer.
        case when sched.trainer_id is not null then
          coalesce(
            (select v.name from public.vehicle_day_assignments oa
               join public.vehicles v on v.id = oa.vehicle_id
              where oa.driver_id = sched.trainer_id and oa.date = sched.d
                and v.dsp_id = v_drv.dsp_id and v.archived_at is null
              limit 1),
            (select v.name from public.vehicle_driver_assignments a
               join public.vehicles v on v.id = a.vehicle_id
              where a.driver_id = sched.trainer_id and a.rank = 0
                and v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
                and coalesce(v.operational_status, 'operational') <> 'grounded'
                and not exists (
                  select 1 from public.vehicle_day_assignments oa
                   where oa.vehicle_id = v.id and oa.date = sched.d
                )
              order by v.name limit 1),
            (select v.name from public.vehicle_driver_assignments a
               join public.vehicles v on v.id = a.vehicle_id
               left join public.vehicle_driver_assignments pri_a on pri_a.vehicle_id = v.id and pri_a.rank = 0
              where a.driver_id = sched.trainer_id and a.rank > 0
                and v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
                and coalesce(v.operational_status, 'operational') <> 'grounded'
                and not exists (
                  select 1 from public.vehicle_day_assignments oa
                   where oa.vehicle_id = v.id and oa.date = sched.d
                )
                and (
                  pri_a.driver_id is null
                  or not exists (
                    select 1 from public.shifts ps
                     where ps.driver_id = pri_a.driver_id and ps.date = sched.d
                       and ps.dsp_id = v_drv.dsp_id and ps.status in ('scheduled', 'completed', 'late')
                  )
                )
              order by a.rank, v.name limit 1)
          )
        else null end as trainer_van
      from sched
    )
    select jsonb_agg(jsonb_build_object(
             'date',    d::text,
             'vehicle', coalesce(primary_van, backup_van, trainer_van),
             'via',     case
                          when primary_van is not null then 'primary'
                          when backup_van  is not null then 'backup'
                          when trainer_van is not null then 'trainee'
                          else null
                        end
           ) order by d)
    from resolved
    where coalesce(primary_van, backup_van, trainer_van) is not null
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.driver_vehicle_days(text, date, date) to anon, authenticated;


notify pgrst, 'reload schema';
