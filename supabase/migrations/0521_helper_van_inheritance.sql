-- ── 0521 · Helper seats ride in the paired XL route's van ──────────────────
--
-- Operator (2026-07-19): "Helpers also need to be assigned the same van as
-- the XL route." An XL route dispatches TWO people in ONE box truck — the
-- helper seat (shift_kind 'helper', 0518) must not consume its own vehicle,
-- and every surface should show the helper riding the paired driver's van.
--
-- The client/solver side ships separately (helpers excluded from the van
-- pool in _assignVansForRange + the CP-SAT van model; the schedule grid's
-- van pill mirrors the paired driver). This migration handles the two
-- SERVER-side van-resolution views, reusing the ride-along "trainee
-- inherits the trainer's van" machinery from 0271/0274/0303 verbatim —
-- the only change is WHO the mate is:
--
--   · ride_along shift → mate = shifts.trainer_driver_id  (unchanged)
--   · helper shift     → mate = the driver of a regular, non-cushion seat
--                        in the same (date · station · wave · service type)
--                        bucket (min id — exact for the common one-XL-
--                        route-per-wave case, deterministic otherwise)
--
-- 1. public.driver_vehicle_days (driver app "Vehicle ____" line): body is
--    0303 verbatim; the `trainer_id` subquery now coalesces in the helper's
--    paired driver, so the existing trainer-van resolution, precedence
--    (override → mate's van → own primary/backup), `via` ('trainee') and
--    is_chain_match branches all apply to helper days unchanged.
-- 2. public.today_roster (dispatcher Today plan): body is 0274 verbatim;
--    trainee_pick now also matches helper shifts (mate per the bucket
--    lookup), and the precedence gates treat 'helper' like 'ride_along'
--    (override → mate's van → own primary/backup).
--
-- shift_kind comparisons for 'helper' go through ::text so this migration
-- is safe to run even before 0518 added the enum value. Idempotent:
-- create or replace throughout.

alter type public.shift_kind add value if not exists 'helper';

-- ── 1. driver_vehicle_days ───────────────────────────────────────────────
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
             -- The "mate" whose van this driver rides in that day:
             --   ride-along day → the trainer;
             --   helper day     → the paired XL driver seat's driver
             --                    (same date/station/wave/service type,
             --                    regular non-cushion, min id).
             coalesce(
               (
                 select s.trainer_driver_id from public.shifts s
                  where s.driver_id = v_drv.id and s.date = days.d and s.dsp_id = v_drv.dsp_id
                    and s.status in ('scheduled', 'completed')
                    and s.shift_kind = 'ride_along'
                  order by s.starts_at nulls last
                  limit 1
               ),
               (
                 select s2.driver_id
                   from public.shifts s
                   join public.shifts s2
                     on s2.dsp_id = s.dsp_id and s2.date = s.date
                    and coalesce(s2.station_id::text, '') = coalesce(s.station_id::text, '')
                    and coalesce(s2.wave_index, 0) = coalesce(s.wave_index, 0)
                    and s2.service_type_id is not distinct from s.service_type_id
                    and coalesce(s2.shift_kind::text, 'regular') = 'regular'
                    and coalesce(s2.is_cushion, false) = false
                    and s2.driver_id is not null
                    and s2.status in ('scheduled', 'completed')
                  where s.driver_id = v_drv.id and s.date = days.d and s.dsp_id = v_drv.dsp_id
                    and s.status in ('scheduled', 'completed')
                    and coalesce(s.shift_kind::text, 'regular') = 'helper'
                  order by s2.id
                  limit 1
               )
             ) as trainer_id
      from days
      where exists (
        select 1 from public.shifts s
         where s.driver_id = v_drv.id and s.date = days.d and s.dsp_id = v_drv.dsp_id
           and s.status in ('scheduled', 'completed')
      )
    ),
    resolved as (
      select sched.d, sched.trainer_id,
        ( select v.id from public.vehicle_day_assignments oa
            join public.vehicles v on v.id = oa.vehicle_id
           where oa.driver_id = v_drv.id and oa.date = sched.d
             and v.dsp_id = v_drv.dsp_id and v.archived_at is null
           limit 1 ) as own_override_id,
        ( select v.name from public.vehicle_day_assignments oa
            join public.vehicles v on v.id = oa.vehicle_id
           where oa.driver_id = v_drv.id and oa.date = sched.d
             and v.dsp_id = v_drv.dsp_id and v.archived_at is null
           limit 1 ) as own_override,
        ( select v.name from public.vehicles v
            join public.vehicle_driver_assignments a on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank = 0
           where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
             and coalesce(v.operational_status, 'operational') <> 'grounded'
             and not exists (
               select 1 from public.vehicle_day_assignments oa
                where oa.vehicle_id = v.id and oa.date = sched.d
             )
           order by v.name limit 1 ) as primary_van,
        ( select v.name from public.vehicles v
            join public.vehicle_driver_assignments a on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank = 1
           where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
             and coalesce(v.operational_status, 'operational') <> 'grounded'
             and not exists (
               select 1 from public.vehicle_day_assignments oa
                where oa.vehicle_id = v.id and oa.date = sched.d
             )
             and not exists (
               select 1 from public.vehicle_driver_assignments ap
                 join public.shifts sp on sp.driver_id = ap.driver_id and sp.date = sched.d
                                       and sp.dsp_id = v_drv.dsp_id and sp.status in ('scheduled', 'completed')
                where ap.vehicle_id = v.id and ap.rank = 0
             )
           order by v.name limit 1 ) as backup_van,
        -- Mate's resolved van on this date (override → primary → backup).
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
    ),
    classified as (
      select d, trainer_id, own_override_id, own_override, primary_van, backup_van, trainer_van,
        case
          when own_override_id is null then null
          when exists (
            select 1 from public.vehicle_driver_assignments a
            where a.vehicle_id = own_override_id and a.driver_id = v_drv.id
          ) then true
          else false
        end as override_is_chain
      from resolved
    )
    select jsonb_agg(jsonb_build_object(
             'date',    d::text,
             -- Ride-along / helper day: explicit override → mate's van →
             -- own primary/backup. Other days: primary → backup.
             'vehicle', case
                          when trainer_id is not null then
                            coalesce(own_override, trainer_van, primary_van, backup_van)
                          else
                            coalesce(own_override, primary_van, backup_van)
                        end,
             'via',     case
                          when trainer_id is not null and own_override is not null then
                            case when override_is_chain then 'override-chain' else 'rotation' end
                          when trainer_id is not null and trainer_van  is not null then 'trainee'
                          when own_override is not null then
                            case when override_is_chain then 'override-chain' else 'rotation' end
                          when primary_van  is not null then 'primary'
                          when backup_van   is not null then 'backup'
                          else null
                        end,
             'is_chain_match', case
                                  when own_override is not null then coalesce(override_is_chain, false)
                                  when trainer_id is not null and trainer_van is not null then true
                                  when primary_van  is not null then true
                                  when backup_van   is not null then true
                                  else null
                               end
           ) order by d)
    from classified
    where coalesce(
      case when trainer_id is not null then coalesce(own_override, trainer_van) end,
      own_override, primary_van, backup_van
    ) is not null
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.driver_vehicle_days(text, date, date) to anon, authenticated;

-- ── 2. today_roster ──────────────────────────────────────────────────────
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
      with mate as (
        -- Whose van does this shift ride in?  ride_along → the trainer;
        -- helper → the paired regular XL seat's driver (same date/station/
        -- wave/service type, non-cushion, min id).
        select case
                 when s.shift_kind = 'ride_along' then s.trainer_driver_id
                 when coalesce(s.shift_kind::text, 'regular') = 'helper' then (
                   select s2.driver_id from public.shifts s2
                    where s2.dsp_id = s.dsp_id and s2.date = s.date
                      and coalesce(s2.station_id::text, '') = coalesce(s.station_id::text, '')
                      and coalesce(s2.wave_index, 0) = coalesce(s.wave_index, 0)
                      and s2.service_type_id is not distinct from s.service_type_id
                      and coalesce(s2.shift_kind::text, 'regular') = 'regular'
                      and coalesce(s2.is_cushion, false) = false
                      and s2.driver_id is not null
                      and s2.status in ('scheduled', 'completed')
                    order by s2.id
                    limit 1
                 )
                 else null
               end as id
      ),
      override_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'override'::text as via, oa.source as via_source,
               null::text as covering_for_name
        from public.vehicle_day_assignments oa
        join public.vehicles v on v.id = oa.vehicle_id
        where oa.driver_id = d.id and oa.date = p_date
          and v.dsp_id = d.dsp_id and v.archived_at is null
        limit 1
      ),
      primary_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'primary'::text as via, null::text as via_source,
               null::text as covering_for_name
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
               'backup'::text as via, null::text as via_source,
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
      trainee_pick as (
        select
          coalesce(o.id, pr.id, b.id) as van_id,
          coalesce(o.name, pr.name, b.name) as van_name,
          coalesce(o.plate, pr.plate, b.plate) as van_plate,
          'trainee'::text as via, null::text as via_source,
          coalesce(nullif(trim(tr.preferred_name), ''),
                   nullif(trim(tr.full_name), '')) as covering_for_name
        from mate m
        join public.drivers tr on tr.id = m.id
        left join lateral (
          select v.id, v.name, v.plate from public.vehicle_day_assignments oa
          join public.vehicles v on v.id = oa.vehicle_id
          where oa.driver_id = tr.id and oa.date = p_date
            and v.dsp_id = tr.dsp_id and v.archived_at is null
          limit 1
        ) o on true
        left join lateral (
          select v.id, v.name, v.plate from public.vehicle_driver_assignments a
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
          select v.id, v.name, v.plate from public.vehicle_driver_assignments a
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
        where coalesce(o.id, pr.id, b.id) is not null
        limit 1
      )
      -- Ride-along / helper shift: override → mate's van → primary → backup.
      -- Regular shift            : override → primary → backup → mate's van.
      select * from override_pick
      union all
      select * from trainee_pick
       where coalesce(s.shift_kind::text, 'regular') in ('ride_along', 'helper')
         and not exists (select 1 from override_pick)
      union all
      select * from primary_pick
       where not exists (select 1 from override_pick)
         and not (coalesce(s.shift_kind::text, 'regular') in ('ride_along', 'helper')
                  and exists (select 1 from trainee_pick))
      union all
      select * from backup_pick
       where not exists (select 1 from override_pick)
         and not exists (select 1 from primary_pick)
         and not (coalesce(s.shift_kind::text, 'regular') in ('ride_along', 'helper')
                  and exists (select 1 from trainee_pick))
      union all
      select * from trainee_pick
       where coalesce(s.shift_kind::text, 'regular') not in ('ride_along', 'helper')
         and not exists (select 1 from override_pick)
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

notify pgrst, 'reload schema';
