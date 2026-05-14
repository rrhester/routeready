-- Migration 0214 · Fleet — surface today's resolved driver per van
--
-- The driver app already resolves "which van do I get today" by walking
-- the standing chain against the schedule (driver_vehicle_days, 0187).
-- The dispatcher has never seen that resolution.  This migration
-- extends vehicles_roster() so the My vehicles surface can show
-- "today's driver" beside the standing primary — the first visual
-- proof that schedules and fleet are one system.
--
-- Resolution mirror (matches driver_vehicle_days): walk the chain by
-- rank ascending; the first driver in the chain who has a scheduled or
-- completed shift on the target date wins.  Drivers with time-off /
-- callouts have status <> 'scheduled' on that day, so they're skipped
-- naturally.  When no one in the chain is scheduled, the van is idle.

create or replace function public.vehicles_roster()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(v order by v->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',                 vh.id,
      'name',               vh.name,
      'nickname',           vh.nickname,
      'kind',               vh.kind,
      'status',             vh.status,
      'ownership',          vh.ownership,
      'operational_status', vh.operational_status,
      'year',               vh.year,
      'make',               vh.make,
      'model',              vh.model,
      'trim_level',         vh.trim_level,
      'color',              vh.color,
      'plate',              vh.plate,
      'plate_state',        vh.plate_state,
      'vin',                vh.vin,
      'mileage',            vh.mileage,
      'mileage_updated_at', vh.mileage_updated_at,
      'last_route_completed_at', vh.last_route_completed_at,
      'photo_path',         vh.photo_path,
      'station_id',         vh.station_id,
      'station_code',       st.code,
      'last_service_at',    vh.last_service_at,
      'next_service_due_at',vh.next_service_due_at,
      'dot_inspection_at',  vh.dot_inspection_at,
      'registration_expires_on', vh.registration_expires_on,
      'insurance_expires_on',    vh.insurance_expires_on,
      'updated_at',         vh.updated_at,
      'primary_driver_id',  pri.driver_id,
      'primary_driver_name',pri.name,
      'backup_count',       coalesce(ch.backup_count, 0),
      'open_issue_count',   coalesce(oi.cnt, 0),
      -- Today's resolved driver — first chain member scheduled today.
      -- 'via' is 'primary' when rank 0, 'backup' otherwise; the UI
      -- shows a "covering for X" chip when via = 'backup'.
      'today_driver_id',    tod.driver_id,
      'today_driver_name',  tod.name,
      'today_via',          case
                              when tod.driver_id is null then null
                              when tod.rank = 0 then 'primary'
                              else 'backup'
                            end,
      'today_primary_out_name', case
                                  when tod.driver_id is not null
                                   and tod.rank > 0
                                   then pri.name
                                  else null
                                end
    ) v
    from public.vehicles vh
    left join public.stations st on st.id = vh.station_id
    left join lateral (
      select a.driver_id,
             coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver') as name
      from public.vehicle_driver_assignments a
      join public.drivers d on d.id = a.driver_id
      where a.vehicle_id = vh.id and a.rank = 0
      limit 1
    ) pri on true
    left join lateral (
      select greatest(count(*)::int - 1, 0) as backup_count
      from public.vehicle_driver_assignments
      where vehicle_id = vh.id
    ) ch on true
    left join lateral (
      select count(*)::int as cnt
      from public.vehicle_issues
      where vehicle_id = vh.id and status <> 'completed'
    ) oi on true
    left join lateral (
      -- Walk the chain by rank; first driver actually working today wins.
      select a.driver_id, a.rank,
             coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver') as name
      from public.vehicle_driver_assignments a
      join public.drivers d on d.id = a.driver_id
      where a.vehicle_id = vh.id
        and exists (
          select 1 from public.shifts s
          where s.driver_id = a.driver_id
            and s.date = current_date
            and s.dsp_id = vh.dsp_id
            and s.status in ('scheduled', 'completed')
        )
      order by a.rank
      limit 1
    ) tod on true
    where vh.dsp_id = private.current_dsp_id()
      and vh.archived_at is null
      and private.is_staff(vh.dsp_id, 'dispatcher')
  ) t;
$$;
grant execute on function public.vehicles_roster() to authenticated;


notify pgrst, 'reload schema';
