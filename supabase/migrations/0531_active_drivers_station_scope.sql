-- Migration 0531 · active_drivers_for_week / _for_horizon · per-station pool
--
-- Multi-station lens: the Targets 13-week table's "Available" column is the
-- per-week driver pool from active_drivers_for_horizon (0329). It counted the
-- whole DSP, so a station-scoped view still showed the FLEET headcount —
-- operator report: "my second station shows my first station's driver count."
--
-- This re-issues both functions (0329) verbatim plus an optional p_station_id.
-- When supplied, the active pool is narrowed to drivers who belong to that
-- station — either a driver_stations membership row (floating-aware, 0525) OR
-- their primary drivers.station_id (covers drivers with no membership row yet).
-- NULL (the default, "All stations") = byte-identical to before.
--
-- Adding the parameter changes each function's signature; drop the old
-- overloads first so a 2-/1-arg call can't become ambiguous. Safe: both are
-- only ever called as PostgREST RPCs from the Targets/Risk-Forecast client.

drop function if exists public.active_drivers_for_horizon(date, integer);
drop function if exists public.active_drivers_for_week(date);

create or replace function public.active_drivers_for_week(
  p_week_start date,
  p_station_id uuid default null
) returns table (
  week_start        date,
  total_active      integer,
  on_time_off       integer,
  on_pto            integer,
  available         integer,
  driver_ids        uuid[],
  off_driver_ids    uuid[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + interval '6 days';
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with active_set as (
    select d.id
      from public.drivers d
     where d.dsp_id = v_dsp
       and d.status in ('active', 'onboarding')
       and (
         p_station_id is null
         or d.station_id = p_station_id
         or exists (
              select 1 from public.driver_stations ds
               where ds.driver_id = d.id and ds.station_id = p_station_id
            )
       )
  ),
  off_set as (
    select distinct tor.driver_id as id, bool_or(coalesce(tor.is_pto, false)) as any_pto
      from public.time_off_requests tor
      join active_set a on a.id = tor.driver_id
     where tor.dsp_id = v_dsp
       and tor.status = 'approved'
       and tor.start_date <= v_week_end
       and tor.end_date   >= p_week_start
     group by tor.driver_id
  )
  select
    p_week_start                                                    as week_start,
    (select count(*) from active_set)::int                          as total_active,
    (select count(*) from off_set)::int                             as on_time_off,
    (select count(*) from off_set where any_pto)::int               as on_pto,
    ((select count(*) from active_set) - (select count(*) from off_set))::int as available,
    array(
      select a.id from active_set a
       where a.id not in (select o.id from off_set o)
    )                                                               as driver_ids,
    array(select o.id from off_set o)                               as off_driver_ids;
end;
$$;
grant execute on function public.active_drivers_for_week(date, uuid) to authenticated;

create or replace function public.active_drivers_for_horizon(
  p_first_week_start date,
  p_weeks            integer default 13,
  p_station_id       uuid default null
) returns table (
  week_start        date,
  total_active      integer,
  on_time_off       integer,
  on_pto            integer,
  available         integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_n   integer := greatest(1, least(coalesce(p_weeks, 13), 26));
  i     integer;
  v_start date;
  v_row record;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for i in 0 .. v_n - 1 loop
    v_start := p_first_week_start + (i * 7);
    for v_row in
      select * from public.active_drivers_for_week(v_start, p_station_id)
    loop
      week_start   := v_row.week_start;
      total_active := v_row.total_active;
      on_time_off  := v_row.on_time_off;
      on_pto       := v_row.on_pto;
      available    := v_row.available;
      return next;
    end loop;
  end loop;
  return;
end;
$$;
grant execute on function public.active_drivers_for_horizon(date, integer, uuid) to authenticated;

notify pgrst, 'reload schema';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0531_active_drivers_station_scope.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
