-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0279 · Overtime Intelligence
--
-- This is NOT a payroll engine. It is an operational read-only RPC that
-- looks at the data RouteReady already collects (shifts, driver_checkins,
-- shift_kind, drivers, dsps.metadata.scheduling) and projects this week's
-- overtime exposure before payroll closes. The goal is one calm number
-- the owner can act on: "we have $X of OT building, here's why, here's
-- who, here's what to do about it."
--
-- The function returns a single jsonb document so the dashboard can
-- render the whole Overtime Intelligence surface from one round-trip.
--
-- Calculation rules:
--   - Week is Sunday-anchored, matching private.week_start_for() from
--     0276 — same convention the cover-shift OT calc uses.
--   - "Worked hours" for a shift uses actual driver_checkins time first
--     (checked_out_at - checked_in_at), falling back to block_hours when
--     a completed shift has no checkout row (older data + offline weeks).
--   - "Remaining hours" sums block_hours of future scheduled shifts in
--     the week — i.e. what the schedule still expects them to work.
--   - "Projected total" = worked + remaining. The risk label is derived
--     against the DSP-configured overtime_threshold_hours (default 40).
--   - "OT exposure $" = projected hours over threshold × rate × (mult-1).
--     That's the *premium only*, not total labor — same convention as
--     schedule_forecast (0202) so numbers line up across pages.
--   - "Rescue OT %" counts hours worked under shift_kind='rescue' against
--     the total OT-hour pool — surfaces whether OT is being driven by
--     planned schedule overruns or by reactive rescues (the lever the
--     dispatcher can pull).
--   - "Late-clockout minutes" counts only positive delta (checked_out_at
--     past ends_at), capped at 240 minutes per shift so one runaway log
--     doesn't poison the average.
--   - Trend vs last week is computed by re-running the OT-hour totaller
--     against the prior week's *completed* shifts (no projection — the
--     week is closed).
--
-- Idempotent: create or replace, no DDL.
-- ─────────────────────────────────────────────────────────────────────────


create or replace function public.overtime_intelligence(p_week_start date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_week       date;
  v_week_end   date;
  v_prev_start date;
  v_prev_end   date;
  v_m          jsonb;
  v_threshold  numeric;
  v_def_rate   numeric;
  v_def_mult   numeric;
  v_today      date := current_date;

  v_drivers          jsonb;
  v_route_groups     jsonb;
  v_insights         jsonb := '[]'::jsonb;
  v_total_ot_hours   numeric := 0;
  v_total_ot_premium numeric := 0;
  v_drivers_at_risk  int     := 0;
  v_drivers_active_ot int    := 0;
  v_total_rescue_hrs numeric := 0;
  v_total_worked     numeric := 0;
  v_prev_ot_hours    numeric := 0;
  v_trend_pct        numeric;
  v_top_route        text;
  v_top_route_hrs    numeric;
  v_top_contributor  text;
  v_top_contributor_hrs numeric;
  v_have_rates       boolean := false;
begin
  if v_dsp is null then
    raise exception 'dsp_id_required' using errcode = '22023';
  end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_week       := coalesce(p_week_start, private.week_start_for(v_today));
  v_week_end   := v_week + 7;
  v_prev_start := v_week - 7;
  v_prev_end   := v_week;

  select coalesce(metadata->'scheduling', '{}'::jsonb) into v_m
    from public.dsps where id = v_dsp;
  v_threshold := coalesce((v_m->>'overtime_threshold_hours')::numeric, 40);
  v_def_rate  := (v_m->>'default_hourly_rate')::numeric;
  v_def_mult  := coalesce((v_m->>'default_overtime_multiplier')::numeric, 1.5);

  -- ── 1. Per-shift contribution rollup for this week ─────────────────────
  -- For each driver-shift we resolve hours_worked vs hours_remaining vs
  -- rescue_hours vs late_clockout_minutes, then aggregate at the driver
  -- level. shifts with status in ('scheduled','completed','late') count;
  -- 'called_off' and 'no_show' are excluded — they don't contribute to
  -- labor exposure.
  with shift_rows as (
    select
      s.id              as shift_id,
      s.driver_id,
      s.date,
      s.status,
      s.shift_kind,
      s.route_code,
      s.station_id,
      coalesce(s.block_hours, 10)::numeric as planned_hours,
      s.starts_at,
      s.ends_at,
      c.checked_in_at,
      c.checked_out_at,
      -- worked hours: prefer real punch-out → punch-in; fall back to
      -- block_hours when the shift is completed but no checkout row
      -- (older weeks / offline rosters). Future-dated scheduled shifts
      -- contribute 0 to worked and `planned_hours` to remaining.
      case
        when c.checked_in_at is not null and c.checked_out_at is not null
          then greatest(0, extract(epoch from (c.checked_out_at - c.checked_in_at)) / 3600.0)
        when c.checked_in_at is not null
             and s.date <= v_today
          then greatest(0, extract(epoch from (now() - c.checked_in_at)) / 3600.0)
        when s.status = 'completed' and s.date <= v_today
          then coalesce(s.block_hours, 10)::numeric
        when s.status = 'late' and s.date < v_today
          then coalesce(s.block_hours, 10)::numeric
        else 0
      end as worked_hours,
      case
        when s.status in ('scheduled','late')
             and s.date >= v_today
             and (c.checked_in_at is null or c.checked_out_at is null)
          then coalesce(s.block_hours, 10)::numeric
        else 0
      end as remaining_hours,
      case
        when s.shift_kind = 'rescue'
             and (c.checked_in_at is not null or s.status = 'completed')
          then coalesce(
                 case when c.checked_in_at is not null and c.checked_out_at is not null
                      then extract(epoch from (c.checked_out_at - c.checked_in_at)) / 3600.0
                      else null end,
                 coalesce(s.block_hours, 10))::numeric
        else 0
      end as rescue_hours,
      case
        when c.checked_out_at is not null and s.ends_at is not null
             and c.checked_out_at > s.ends_at
          then least(240,
                 extract(epoch from (c.checked_out_at - s.ends_at)) / 60.0)::numeric
        else 0
      end as late_clockout_minutes
    from public.shifts s
    left join public.driver_checkins c on c.shift_id = s.id
    where s.dsp_id    = v_dsp
      and s.driver_id is not null
      and s.date     >= v_week
      and s.date     <  v_week_end
      and s.status    in ('scheduled','completed','late')
  ),
  per_driver as (
    select
      r.driver_id,
      sum(r.worked_hours)          as worked_hours,
      sum(r.remaining_hours)       as remaining_hours,
      sum(r.rescue_hours)          as rescue_hours,
      sum(r.late_clockout_minutes) as late_minutes,
      count(*) filter (where r.shift_kind = 'rescue')      as rescue_count,
      count(*) filter (where r.status = 'completed')       as completed_count,
      count(*) filter (where r.status = 'scheduled'
                         and r.date >= v_today)            as scheduled_remaining
    from shift_rows r
    group by r.driver_id
  ),
  scored as (
    select
      d.id   as driver_id,
      d.full_name,
      st.code as station_code,
      coalesce(d.hourly_rate, v_def_rate)         as rate,
      coalesce(d.overtime_multiplier, v_def_mult) as mult,
      coalesce(pd.worked_hours, 0)::numeric       as worked_hours,
      coalesce(pd.remaining_hours, 0)::numeric    as remaining_hours,
      (coalesce(pd.worked_hours, 0) + coalesce(pd.remaining_hours, 0))::numeric as projected_hours,
      coalesce(pd.rescue_hours, 0)::numeric       as rescue_hours,
      coalesce(pd.late_minutes, 0)::numeric       as late_minutes,
      coalesce(pd.rescue_count, 0)::int           as rescue_count,
      coalesce(pd.completed_count, 0)::int        as completed_count,
      coalesce(pd.scheduled_remaining, 0)::int    as scheduled_remaining
    from public.drivers d
    left join per_driver pd on pd.driver_id = d.id
    left join public.stations st on st.id = d.station_id
    where d.dsp_id = v_dsp
      and d.status = 'active'
      -- Only include drivers actually touching the week — anything else
      -- is noise on the table.
      and (pd.worked_hours > 0 or pd.remaining_hours > 0)
  ),
  enriched as (
    select
      s.*,
      greatest(0, projected_hours - v_threshold) as ot_hours_proj,
      greatest(0, worked_hours    - v_threshold) as ot_hours_so_far,
      case
        when worked_hours >= v_threshold                       then 'active_ot'
        when projected_hours >= v_threshold                    then 'high_risk'
        when projected_hours >= v_threshold * 0.85             then 'watch'
        else 'safe'
      end as risk
    from scored s
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'driver_id',       e.driver_id,
        'driver_name',     e.full_name,
        'station_code',    e.station_code,
        'hourly_rate',     e.rate,
        'ot_multiplier',   e.mult,
        'worked_hours',    round(e.worked_hours, 1),
        'remaining_hours', round(e.remaining_hours, 1),
        'projected_hours', round(e.projected_hours, 1),
        'ot_hours',        round(e.ot_hours_proj, 1),
        'ot_premium_usd',  case when e.rate is null then null
                                else round(e.ot_hours_proj * e.rate * (e.mult - 1), 2) end,
        'rescue_hours',    round(e.rescue_hours, 1),
        'rescue_count',    e.rescue_count,
        'late_clockout_minutes', round(e.late_minutes, 0),
        'completed_shifts',     e.completed_count,
        'scheduled_remaining',  e.scheduled_remaining,
        'risk',                 e.risk,
        'contributors', (
          select coalesce(jsonb_agg(c), '[]'::jsonb) from (
            select 'rescues' as kind, round(e.rescue_hours,1) as value
              where e.rescue_hours > 0
            union all
            select 'late_clockouts', round(e.late_minutes/60.0, 1)
              where e.late_minutes >= 30
            union all
            select 'over_threshold', round(e.ot_hours_proj, 1)
              where e.ot_hours_proj > 0
          ) c
        )
      )
      order by e.projected_hours desc, e.full_name asc
    ), '[]'::jsonb),
    coalesce(sum(e.ot_hours_proj), 0),
    coalesce(sum(case when e.rate is null then 0
                      else e.ot_hours_proj * e.rate * (e.mult - 1) end), 0),
    count(*) filter (where e.risk in ('high_risk','active_ot','watch')),
    count(*) filter (where e.risk = 'active_ot'),
    coalesce(sum(e.rescue_hours), 0),
    coalesce(sum(e.worked_hours), 0),
    bool_or(e.rate is not null)
  into
    v_drivers,
    v_total_ot_hours,
    v_total_ot_premium,
    v_drivers_at_risk,
    v_drivers_active_ot,
    v_total_rescue_hrs,
    v_total_worked,
    v_have_rates
  from enriched e;

  -- ── 2. Top OT-creating route group ─────────────────────────────────────
  -- Group by the route_code prefix (first chunk before a digit/dash) so
  -- "CX-401" and "CX-402" roll up to "CX". Falls back to the raw
  -- route_code when no prefix exists.
  with shift_rows as (
    select
      s.driver_id,
      coalesce(
        nullif(regexp_replace(coalesce(s.route_code, ''), '[-_ ]?[0-9].*$', ''), ''),
        s.route_code,
        '—'
      ) as route_group,
      coalesce(s.block_hours, 10)::numeric as planned_hours
    from public.shifts s
    where s.dsp_id    = v_dsp
      and s.driver_id is not null
      and s.date     >= v_week
      and s.date     <  v_week_end
      and s.status    in ('scheduled','completed','late')
  ),
  by_driver as (
    select driver_id, route_group, sum(planned_hours) as hrs
    from shift_rows
    group by driver_id, route_group
  ),
  driver_totals as (
    -- Per-driver OT hours projected for the week (mirrors section 1's
    -- formula). Computed here from raw shifts so the route-group block
    -- doesn't have to depend on a temporary table.
    select
      s.driver_id,
      greatest(0,
        sum(
          case
            when c.checked_in_at is not null and c.checked_out_at is not null
              then extract(epoch from (c.checked_out_at - c.checked_in_at))/3600.0
            when s.status in ('completed','late') and s.date <= v_today
              then coalesce(s.block_hours, 10)
            when s.status = 'scheduled' and s.date >= v_today
              then coalesce(s.block_hours, 10)
            else 0
          end
        )::numeric - v_threshold
      ) as ot_hours_proj
    from public.shifts s
    left join public.driver_checkins c on c.shift_id = s.id
    where s.dsp_id    = v_dsp
      and s.driver_id is not null
      and s.date     >= v_week
      and s.date     <  v_week_end
      and s.status    in ('scheduled','completed','late')
    group by s.driver_id
  ),
  driver_route_share as (
    -- A driver's OT hours get attributed pro-rata across their route
    -- groups by hours-worked share. Window function isolated to its own
    -- CTE so it's not nested inside an aggregate (which Postgres forbids).
    select
      bd.driver_id,
      bd.route_group,
      bd.hrs
        / nullif(sum(bd.hrs) over (partition by bd.driver_id), 0)
        * coalesce(dt.ot_hours_proj, 0)
        as group_ot_hours
    from by_driver bd
    left join driver_totals dt on dt.driver_id = bd.driver_id
  ),
  driver_share as (
    select route_group, sum(group_ot_hours) as ot_hrs
    from driver_route_share
    group by route_group
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'route_group', route_group,
        'ot_hours',    round(ot_hrs, 1)
      ) order by ot_hrs desc
    ) filter (where ot_hrs > 0), '[]'::jsonb)
  into v_route_groups
  from driver_share;

  -- Pull the top-1 out for the summary card.
  select route_group, ot_hours
    into v_top_route, v_top_route_hrs
    from jsonb_to_recordset(v_route_groups)
         as r(route_group text, ot_hours numeric)
    order by ot_hours desc nulls last
    limit 1;

  -- ── 3. Top single contributor for the mobile widget ────────────────────
  select driver_name, ot_hours
    into v_top_contributor, v_top_contributor_hrs
    from jsonb_to_recordset(v_drivers)
         as d(driver_name text, ot_hours numeric)
    order by ot_hours desc nulls last
    limit 1;

  -- ── 4. Prior-week OT hours (actuals only, for trend) ───────────────────
  select coalesce(sum(greatest(0, hrs - v_threshold)), 0)
    into v_prev_ot_hours
    from (
      select
        s.driver_id,
        sum(
          case
            when c.checked_in_at is not null and c.checked_out_at is not null
              then extract(epoch from (c.checked_out_at - c.checked_in_at))/3600.0
            when s.status in ('completed','late')
              then coalesce(s.block_hours, 10)
            else 0
          end
        )::numeric as hrs
      from public.shifts s
      left join public.driver_checkins c on c.shift_id = s.id
      where s.dsp_id    = v_dsp
        and s.driver_id is not null
        and s.date     >= v_prev_start
        and s.date     <  v_prev_end
        and s.status    in ('completed','late')
      group by s.driver_id
    ) prev;

  v_trend_pct := case
    when v_prev_ot_hours is null or v_prev_ot_hours = 0 then null
    else round(((v_total_ot_hours - v_prev_ot_hours) / v_prev_ot_hours) * 100, 0)
  end;

  -- ── 5. Predictive insights ─────────────────────────────────────────────
  -- Short, sharp, executive — each insight is one sentence the owner can
  -- act on. We only emit the ones that have a signal; an empty list is
  -- a calm signal in itself.
  if v_total_ot_hours > 0 and v_total_rescue_hrs > 0 then
    declare
      v_rescue_pct numeric := round((v_total_rescue_hrs / nullif(v_total_worked, 0)) * 100, 0);
    begin
      if v_rescue_pct >= 15 then
        v_insights := v_insights || jsonb_build_array(jsonb_build_object(
          'severity', 'high',
          'kind',     'rescues',
          'title',    'Rescues are driving labor exposure',
          'body',     'Rescues account for ' || v_rescue_pct || '% of hours worked this week — reactive coverage is the dominant OT contributor.'
        ));
      end if;
    end;
  end if;

  if v_drivers_at_risk >= 3 then
    v_insights := v_insights || jsonb_build_array(jsonb_build_object(
      'severity', 'med',
      'kind',     'risk_cluster',
      'title',    v_drivers_at_risk || ' drivers trending into overtime',
      'body',     'Projected weekly totals put ' || v_drivers_at_risk || ' drivers at or above the ' || v_threshold || '-hour threshold. Re-shuffling tomorrow''s assignments now is cheaper than premium hours later.'
    ));
  end if;

  if v_top_route is not null and v_top_route_hrs >= 4 then
    v_insights := v_insights || jsonb_build_array(jsonb_build_object(
      'severity', 'med',
      'kind',     'route_group',
      'title',    'Route group ' || v_top_route || ' is the largest OT source',
      'body',     'Drivers working ' || v_top_route || ' routes are projected to contribute ' || round(v_top_route_hrs, 1) || ' OT hours this week.'
    ));
  end if;

  if v_trend_pct is not null and v_trend_pct >= 25 then
    v_insights := v_insights || jsonb_build_array(jsonb_build_object(
      'severity', 'high',
      'kind',     'trend',
      'title',    'OT exposure up ' || v_trend_pct || '% vs last week',
      'body',     'This week is on pace to materially exceed last week''s overtime totals. Check rescue load and late clock-outs before Friday.'
    ));
  elsif v_trend_pct is not null and v_trend_pct <= -15 then
    v_insights := v_insights || jsonb_build_array(jsonb_build_object(
      'severity', 'good',
      'kind',     'trend',
      'title',    'OT exposure down ' || abs(v_trend_pct) || '% vs last week',
      'body',     'The current schedule is trending cleaner than the prior week. Keep the rescue load contained to hold the gain.'
    ));
  end if;

  if v_have_rates is not true then
    v_insights := v_insights || jsonb_build_array(jsonb_build_object(
      'severity', 'info',
      'kind',     'config',
      'title',    'Set hourly rates to unlock dollar exposure',
      'body',     'Add a default hourly rate in Settings → Scheduling, or per-driver rates on each driver, to see projected OT premiums in dollars.'
    ));
  end if;

  -- ── 6. Return the full document ────────────────────────────────────────
  return jsonb_build_object(
    'week_start',         v_week,
    'week_end',           v_week_end - 1,
    'threshold_hours',    v_threshold,
    'have_rates',         coalesce(v_have_rates, false),
    'default_rate',       v_def_rate,
    'default_multiplier', v_def_mult,
    'summary', jsonb_build_object(
      'drivers_projected_ot', coalesce(v_drivers_at_risk, 0),
      'drivers_active_ot',    coalesce(v_drivers_active_ot, 0),
      'est_ot_hours',         round(coalesce(v_total_ot_hours, 0), 1),
      'est_ot_exposure_usd',  round(coalesce(v_total_ot_premium, 0), 2),
      'rescue_driven_pct',    case
                                when coalesce(v_total_worked, 0) = 0 then null
                                else round((coalesce(v_total_rescue_hrs,0) / v_total_worked) * 100, 0)
                              end,
      'trend_pct',            v_trend_pct,
      'prev_ot_hours',        round(coalesce(v_prev_ot_hours, 0), 1),
      'top_route_group',      v_top_route,
      'top_route_ot_hours',   round(coalesce(v_top_route_hrs, 0), 1),
      'top_contributor',      v_top_contributor,
      'top_contributor_ot',   round(coalesce(v_top_contributor_hrs, 0), 1)
    ),
    'drivers',     v_drivers,
    'route_groups', v_route_groups,
    'insights',    v_insights
  );
end;
$$;

grant execute on function public.overtime_intelligence(date) to authenticated;

notify pgrst, 'reload schema';
