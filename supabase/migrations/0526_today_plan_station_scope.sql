-- Migration 0526 · today_plan · optional per-station scope
--
-- Multi-station lens: the Today's Plan coverage rail (open shifts + expiring
-- credentials) is the last station-relevant Today surface that still
-- aggregated DSP-wide. Add an optional p_station_id so the dispatcher can see
-- ONE station's coverage gaps (matching the roster, which already scopes).
--
--   · open_shifts     → filtered by the shift's own station_id (NOT NULL)
--   · dl_expiring     → drivers who are a MEMBER of the station (driver_stations)
--                        or homed there (drivers.station_id) — floating-aware
--   · not_dot_certified → same membership/home rule
--
-- p_station_id NULL = every station (byte-identical to the old today_plan()).
-- The fleet-readiness + hiring-pipeline tiles stay DSP-wide on purpose (vans
-- are pooled; hiring is DSP-wide).
--
-- The old no-arg today_plan() is dropped first so the defaulted-arg version
-- doesn't create an ambiguous overload; clients calling today_plan with no
-- args resolve to the new signature via the default. Idempotent.

drop function if exists public.today_plan();

create or replace function public.today_plan(p_station_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_today date := current_date;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'open_shifts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'shift_id',          s.id,
        'station_code',      st.code,
        'starts_at',         to_jsonb(s.starts_at),
        'wave_index',        s.wave_index,
        'service_type_code', svc.code,
        'service_type_color',svc.color,
        'is_cushion',        s.is_cushion
      ) order by s.starts_at nulls last)
        from public.shifts s
        left join public.stations st on st.id = s.station_id
        left join public.service_types svc on svc.id = s.service_type_id
       where s.dsp_id = v_dsp
         and s.date = v_today
         and s.driver_id is null
         and s.status = 'scheduled'
         and (p_station_id is null or s.station_id = p_station_id)
    ), '[]'::jsonb),

    'dl_expiring', coalesce((
      select jsonb_agg(jsonb_build_object(
        'driver_id',   d.id,
        'driver_name', coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
        'expires_on',  to_jsonb(d.dl_expires_on::text),
        'days_left',   (d.dl_expires_on - v_today)
      ) order by d.dl_expires_on)
        from public.drivers d
       where d.dsp_id = v_dsp
         and d.status in ('active','onboarding')
         and d.dl_expires_on is not null
         and d.dl_expires_on between v_today - 1 and v_today + 7
         and (p_station_id is null
              or d.station_id = p_station_id
              or exists (select 1 from public.driver_stations ds
                          where ds.driver_id = d.id and ds.station_id = p_station_id))
    ), '[]'::jsonb),

    'not_dot_certified', coalesce((
      select jsonb_agg(jsonb_build_object(
        'driver_id',   d.id,
        'driver_name', coalesce(nullif(trim(d.preferred_name), ''), d.full_name)
      ) order by d.full_name)
        from public.drivers d
       where d.dsp_id = v_dsp
         and d.status = 'active'
         and coalesce(d.dot_certified, false) = false
         and (p_station_id is null
              or d.station_id = p_station_id
              or exists (select 1 from public.driver_stations ds
                          where ds.driver_id = d.id and ds.station_id = p_station_id))
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.today_plan(uuid) to authenticated;

notify pgrst, 'reload schema';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0526_today_plan_station_scope.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
