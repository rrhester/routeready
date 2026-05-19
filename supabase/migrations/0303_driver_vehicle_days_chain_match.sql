-- 0303_driver_vehicle_days_chain_match.sql
-- Extend driver_vehicle_days() to expose whether the assigned
-- van matches the driver's standing chain. When `via` is an
-- override but the override DOES NOT match the chain, the
-- driver app surfaces a calm "(rotation)" sub-note so the
-- driver understands they're on a non-default van today (FEM
-- rescue, pool fill, or manual rotation).
--
-- Wire-compatible: the existing `vehicle` field is unchanged;
-- the `via` field now reports "override-chain" / "rotation"
-- in place of the old generic "override" value, and a new
-- `is_chain_match` boolean is added for convenience. No
-- consumers reference the old "override" string today (grep
-- in dashboard/, app/ — clean).

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
  if v_drv.role is distinct from 'driver' then
    return '[]'::jsonb;
  end if;
  if v_to - v_from > 92 then v_to := v_from + 92; end if;

  return coalesce((
    with days as (
      select (v_from + g.i)::date as d from generate_series(0, (v_to - v_from)) as g(i)
    ),
    sched as (
      select d from days
      where exists (
        select 1 from public.shifts s
         where s.driver_id = v_drv.id and s.date = days.d and s.dsp_id = v_drv.dsp_id
           and s.status in ('scheduled', 'completed', 'late')
      )
    ),
    resolved as (
      select sched.d,
        ( select v.id from public.vehicles v
            join public.vehicle_day_assignments oa
              on oa.vehicle_id = v.id and oa.driver_id = v_drv.id and oa.date = sched.d
           where v.dsp_id = v_drv.dsp_id and v.archived_at is null
           limit 1 ) as override_id,
        ( select v.name from public.vehicles v
            join public.vehicle_day_assignments oa
              on oa.vehicle_id = v.id and oa.driver_id = v_drv.id and oa.date = sched.d
           where v.dsp_id = v_drv.dsp_id and v.archived_at is null
           limit 1 ) as override_van,
        ( select v.name from public.vehicles v
            join public.vehicle_driver_assignments a on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank = 0
           where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
             and not exists (
               select 1 from public.vehicle_day_assignments oa
               where oa.vehicle_id = v.id and oa.date = sched.d
             )
           order by v.name limit 1 ) as primary_van,
        ( select v.name from public.vehicles v
            join public.vehicle_driver_assignments a on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank > 0
           where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
             and not exists (
               select 1 from public.vehicle_day_assignments oa
               where oa.vehicle_id = v.id and oa.date = sched.d
             )
             and not exists (
               select 1 from public.vehicle_driver_assignments ap
                 join public.shifts sp on sp.driver_id = ap.driver_id and sp.date = sched.d
                                       and sp.dsp_id = v_drv.dsp_id and sp.status in ('scheduled','completed','late')
                where ap.vehicle_id = v.id and ap.rank = 0
             )
           order by v.name limit 1 ) as backup_van
      from sched
    ),
    classified as (
      select d, override_van, primary_van, backup_van,
        case
          when override_id is null then null
          when exists (
            select 1 from public.vehicle_driver_assignments a
            where a.vehicle_id = override_id and a.driver_id = v_drv.id
          ) then true
          else false
        end as override_is_chain
      from resolved
    )
    select jsonb_agg(jsonb_build_object(
             'date',    d::text,
             'vehicle', coalesce(override_van, primary_van, backup_van),
             'via',     case
                          when override_van is not null and override_is_chain then 'override-chain'
                          when override_van is not null then 'rotation'
                          when primary_van  is not null then 'primary'
                          when backup_van   is not null then 'backup'
                          else null
                        end,
             'is_chain_match', case
                                  when override_van is not null then coalesce(override_is_chain, false)
                                  when primary_van  is not null then true
                                  when backup_van   is not null then true
                                  else null
                               end
           ) order by d)
    from classified
    where coalesce(override_van, primary_van, backup_van) is not null
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.driver_vehicle_days(text, date, date) to anon, authenticated;

notify pgrst, 'reload schema';
