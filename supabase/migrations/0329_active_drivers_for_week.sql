-- 0329_active_drivers_for_week.sql
--
-- Risk forecast simulation · per-week driver-pool projection.
--
-- Powers the "Simulate next 13 weeks" button on the Targets planner
-- card. For each of the next 13 weeks, the dashboard calls this RPC
-- to count drivers actually available that week — current active
-- pool minus anyone with an approved time-off request overlapping
-- the week. Those numbers feed the Risk Forecast view, replacing the
-- static OKAMI planning numbers with a real-data projection that
-- accounts for PTO and unpaid time-off.
--
-- v1 ships the headcount projection only. A follow-up will wire the
-- CP-SAT solver per week using these same active-driver lists, so the
-- forecast can also catch constraint-level breaks (cert mismatch,
-- max-days, wave fit). Until then, the math here is enough to surface
-- the "you'll be short bodies on Week 24 because 4 PTO requests
-- cover it" type of break before it bites.
--
-- Idempotent.

create or replace function public.active_drivers_for_week(
  p_week_start date
) returns table (
  week_start        date,
  total_active      integer,
  on_time_off       integer,
  on_pto            integer,    -- subset of on_time_off where is_pto=true
  available         integer,    -- total_active minus on_time_off
  driver_ids        uuid[],     -- ids of the drivers counted as available
  off_driver_ids    uuid[]      -- ids of the drivers counted as off
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + interval '6 days';
begin
  -- Dispatcher+ may read · same gate as every other Smart Fill / OKAMI
  -- RPC. Not a write op (no inserts/updates), but the underlying data
  -- (driver pool, time-off requests) is staff-scoped already, so we
  -- match the read-gate rather than open it wider.
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with active_set as (
    select d.id
      from public.drivers d
     where d.dsp_id = v_dsp
       and d.status in ('active', 'onboarding')
  ),
  off_set as (
    -- Any approved time-off request whose [start_date, end_date]
    -- range intersects the [p_week_start, v_week_end] week range.
    -- Distinct because one driver could have multiple overlapping
    -- requests; we want to count them once.
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
grant execute on function public.active_drivers_for_week(date) to authenticated;


-- Convenience companion · returns one row per week across N weeks
-- starting from p_first_week_start. Avoids the dashboard issuing 13
-- RPC calls in a loop and lets the planner card render a single
-- result table from one round-trip.
create or replace function public.active_drivers_for_horizon(
  p_first_week_start date,
  p_weeks            integer default 13
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
      select * from public.active_drivers_for_week(v_start)
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
grant execute on function public.active_drivers_for_horizon(date, integer) to authenticated;


notify pgrst, 'reload schema';
