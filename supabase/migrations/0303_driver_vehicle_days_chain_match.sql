-- 0303_driver_vehicle_days_chain_match.sql
-- Extend driver_vehicle_days() with chain-match metadata so the
-- driver app can surface a calm "Rotation" tag when the
-- assigned van isn't part of the driver's standing chain
-- (FEM rescue, pool fill, or a manual rotation).
--
-- This re-creates the full function body verbatim from 0274
-- (trainer-van precedence + grounded-van exclusion) and adds:
--   - capture override_id alongside override_van
--   - new "override_is_chain" classifier (does the override
--     match the driver's chain at any rank?)
--   - "via" gains "override-chain" / "rotation" in place of
--     the generic "override" for non-ride-along shifts (the
--     ride-along "trainee" via stays as-is)
--   - new "is_chain_match" boolean on each row for driver-app
--     convenience
--
-- All other behavior is unchanged from 0274:
--   - Ride-along shift  : override → trainer's van → trainee primary/backup
--   - Regular shift     : override → trainee primary/backup
--   - Grounded vans excluded from primary / backup / trainer
--     picks (coalesce(operational_status, 'operational') <> 'grounded')
--   - Archived vans excluded
--
-- No consumers of the old "override" via value exist in
-- dashboard/ or app/ (grep clean). Re-runnable: `create or
-- replace`.

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
      select sched.d, sched.trainer_id,
        -- Trainee's own override id + name + chain-match flag.
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
        -- Trainee's standing primary.
        ( select v.name from public.vehicles v
            join public.vehicle_driver_assignments a on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank = 0
           where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
             and coalesce(v.operational_status, 'operational') <> 'grounded'
             and not exists (
               select 1 from public.vehicle_day_assignments oa
                where oa.vehicle_id = v.id and oa.date = sched.d
             )
           order by v.name limit 1 ) as primary_van,
        -- Trainee's standing backup (when the primary driver isn't working).
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
        -- Trainer's resolved van on this date (override → primary → backup).
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
        -- Does the override (if any) match the driver's standing
        -- chain at any rank? null when there's no override.
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
             -- Ride-along day: explicit override → trainer's van →
             -- trainee's own primary/backup. Other days: primary → backup.
             'vehicle', case
                          when trainer_id is not null then
                            coalesce(own_override, trainer_van, primary_van, backup_van)
                          else
                            coalesce(own_override, primary_van, backup_van)
                        end,
             'via',     case
                          -- Ride-along precedence preserved.
                          when trainer_id is not null and own_override is not null then
                            case when override_is_chain then 'override-chain' else 'rotation' end
                          when trainer_id is not null and trainer_van  is not null then 'trainee'
                          -- Regular shift.
                          when own_override is not null then
                            case when override_is_chain then 'override-chain' else 'rotation' end
                          when primary_van  is not null then 'primary'
                          when backup_van   is not null then 'backup'
                          else null
                        end,
             -- Convenience flag for driver-app rendering.
             -- true ⇒ van is on the driver's chain (or it's the
             --        trainer's van on a ride-along — driver is
             --        "matched" because that's their planned ride)
             -- false ⇒ pool / FEM rescue / manual rotation
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

notify pgrst, 'reload schema';
