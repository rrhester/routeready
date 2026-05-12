-- Migration 0187 · Van assignments — the driver's resolved van per day
--
-- driver_vehicle_days(token, from, to): for the calling driver, the van
-- they hold on each day in the range they're scheduled to work — used by
-- the driver app's schedule.  Resolution mirrors the dashboard's: the
-- driver gets their *primary* van when they're scheduled and that van is
-- in service; if that van is out of service (or they have no primary
-- van) but they're the *backup* (rank 1) on another in-service van whose
-- primary isn't scheduled that day, they get that one; otherwise no van.

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
  if v_to - v_from > 92 then v_to := v_from + 92; end if;   -- cap the range
  return coalesce((
    with days as (
      select (v_from + g.i)::date as d from generate_series(0, (v_to - v_from)) as g(i)
    ),
    sched as (   -- the days this driver actually works
      select d from days
      where exists (
        select 1 from public.shifts s
         where s.driver_id = v_drv.id and s.date = days.d and s.dsp_id = v_drv.dsp_id
           and s.status in ('scheduled', 'completed')
      )
    ),
    resolved as (
      select sched.d,
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
           order by v.name limit 1 ) as backup_van
      from sched
    )
    select jsonb_agg(jsonb_build_object(
             'date',    d::text,
             'vehicle', coalesce(primary_van, backup_van),
             'via',     case when primary_van is not null then 'primary' else 'backup' end
           ) order by d)
    from resolved
    where coalesce(primary_van, backup_van) is not null
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.driver_vehicle_days(text, date, date) to anon, authenticated;

notify pgrst, 'reload schema';
