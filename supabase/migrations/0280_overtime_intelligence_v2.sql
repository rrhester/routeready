-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0280 · Overtime Intelligence v2
--
-- Refines public.overtime_intelligence() per operator feedback:
--
--   1. Return one row for EVERY active driver, not just drivers who
--      worked this week. The page reads as a roster (like Drivers ›
--      Roster) — drivers with no shifts this week show as 0/0/0 and
--      sit at the bottom.
--
--   2. Add scheduled_hours / worked_hours / variance_hours columns.
--      Variance = worked − scheduled.
--
--   3. Compute worked_hours using the operator-supplied assumptions
--      whenever real driver_checkins data is missing:
--        · clock-in   = checked_in_at  OR  starts_at − 10 minutes
--        · clock-out  = checked_out_at OR  ends_at  (the scheduled end
--                       is the "sign out for the day" approximation)
--      Both fallbacks fire independently — a driver who checked in but
--      hasn't checked out yet still gets a real start time and the
--      assumed end. Future shifts (date > today) project the same way,
--      giving the operator a calm forward-looking variance.
--
--   4. Risk and OT-exposure math now key off worked_hours instead of
--      a separate projected total — since worked already projects via
--      the assumption, the two coincide and the column reads honestly.
--
-- Idempotent: create or replace.
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
  v_total_scheduled  numeric := 0;
  v_total_variance   numeric := 0;
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
  -- For each in-week shift compute (effective_in, effective_out) using
  -- the operator-supplied fallback assumption — 10 min early clock-in,
  -- scheduled end as "sign out for the day". Real driver_checkins data
  -- takes precedence when present.
  --
  -- called_off / no_show shifts are excluded entirely: the driver wasn't
  -- expected to work them, and counting them as 0 hours worked vs full
  -- scheduled hours would distort variance.
  with shift_rows as (
    select
      s.id              as shift_id,
      s.driver_id,
      s.date,
      s.status,
      s.shift_kind,
      s.route_code,
      s.station_id,
      s.starts_at,
      s.ends_at,
      c.checked_in_at,
      c.checked_out_at,
      -- Scheduled hours — prefer block_hours, fall back to the gap
      -- between starts_at and ends_at if both are set, then a 10h
      -- default. Same fallback ladder schedule_forecast uses.
      coalesce(
        s.block_hours::numeric,
        case when s.starts_at is not null and s.ends_at is not null
             then extract(epoch from (s.ends_at - s.starts_at)) / 3600.0
             else null end,
        10
      ) as scheduled_hrs,
      -- Effective clock-in: real check-in, or 10 minutes before
      -- scheduled start (the operator's working assumption).
      coalesce(
        c.checked_in_at,
        case when s.starts_at is not null
             then s.starts_at - interval '10 minutes' else null end
      ) as eff_in,
      -- Effective clock-out: real check-out, else the scheduled end
      -- ("sign out for the day"). If neither is available the shift
      -- doesn't contribute worked hours.
      coalesce(c.checked_out_at, s.ends_at) as eff_out
    from public.shifts s
    left join public.driver_checkins c on c.shift_id = s.id
    where s.dsp_id    = v_dsp
      and s.driver_id is not null
      and s.date     >= v_week
      and s.date     <  v_week_end
      and s.status    in ('scheduled','completed','late')
  ),
  shift_calc as (
    select
      r.*,
      case
        when r.eff_in is not null and r.eff_out is not null and r.eff_out > r.eff_in
          then extract(epoch from (r.eff_out - r.eff_in)) / 3600.0
        else 0
      end as worked_hrs,
      case
        when r.shift_kind = 'rescue'
             and r.eff_in is not null and r.eff_out is not null and r.eff_out > r.eff_in
          then extract(epoch from (r.eff_out - r.eff_in)) / 3600.0
        else 0
      end as rescue_hrs,
      case
        when r.checked_out_at is not null and r.ends_at is not null
             and r.checked_out_at > r.ends_at
          then least(240, extract(epoch from (r.checked_out_at - r.ends_at)) / 60.0)
        else 0
      end as late_minutes
    from shift_rows r
  ),
  per_driver as (
    select
      sc.driver_id,
      sum(sc.scheduled_hrs)     as scheduled_hrs,
      sum(sc.worked_hrs)        as worked_hrs,
      sum(sc.rescue_hrs)        as rescue_hrs,
      sum(sc.late_minutes)      as late_minutes,
      count(*) filter (where sc.shift_kind = 'rescue')         as rescue_count,
      count(*) filter (where sc.status = 'completed')          as completed_count,
      count(*) filter (where sc.status = 'scheduled' and sc.date >= v_today) as scheduled_remaining
    from shift_calc sc
    group by sc.driver_id
  ),
  scored as (
    -- Roster-style: one row per ACTIVE driver, even if they have no
    -- shifts this week. Drivers with zero scheduled and zero worked
    -- still surface so the page reads as a roster.
    select
      d.id   as driver_id,
      d.full_name,
      st.code as station_code,
      coalesce(d.hourly_rate, v_def_rate)         as rate,
      coalesce(d.overtime_multiplier, v_def_mult) as mult,
      coalesce(pd.scheduled_hrs, 0)::numeric      as scheduled_hours,
      coalesce(pd.worked_hrs, 0)::numeric         as worked_hours,
      (coalesce(pd.worked_hrs, 0) - coalesce(pd.scheduled_hrs, 0))::numeric as variance_hours,
      coalesce(pd.rescue_hrs, 0)::numeric         as rescue_hours,
      coalesce(pd.late_minutes, 0)::numeric       as late_minutes,
      coalesce(pd.rescue_count, 0)::int           as rescue_count,
      coalesce(pd.completed_count, 0)::int        as completed_count,
      coalesce(pd.scheduled_remaining, 0)::int    as scheduled_remaining
    from public.drivers d
    left join per_driver pd on pd.driver_id = d.id
    left join public.stations st on st.id = d.station_id
    where d.dsp_id = v_dsp
      and d.status = 'active'
  ),
  enriched as (
    select
      s.*,
      greatest(0, worked_hours - v_threshold) as ot_hours_proj,
      case
        when worked_hours >= v_threshold              then 'high_risk'
        when worked_hours >= v_threshold * 0.85       then 'watch'
        else 'safe'
      end as risk
    from scored s
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'driver_id',           e.driver_id,
        'driver_name',         e.full_name,
        'station_code',        e.station_code,
        'hourly_rate',         e.rate,
        'ot_multiplier',       e.mult,
        'scheduled_hours',     round(e.scheduled_hours, 2),
        'worked_hours',        round(e.worked_hours,    2),
        'variance_hours',      round(e.variance_hours,  2),
        'ot_hours',            round(e.ot_hours_proj,   2),
        'ot_premium_usd',      case when e.rate is null then null
                                    else round(e.ot_hours_proj * e.rate * (e.mult - 1), 2) end,
        'rescue_hours',        round(e.rescue_hours, 2),
        'rescue_count',        e.rescue_count,
        'late_clockout_minutes', round(e.late_minutes, 0),
        'completed_shifts',    e.completed_count,
        'scheduled_remaining', e.scheduled_remaining,
        'risk',                e.risk
      )
      order by
        case e.risk when 'high_risk' then 0 when 'watch' then 1 else 2 end,
        e.worked_hours desc,
        e.full_name asc
    ), '[]'::jsonb),
    coalesce(sum(e.ot_hours_proj), 0),
    coalesce(sum(case when e.rate is null then 0
                      else e.ot_hours_proj * e.rate * (e.mult - 1) end), 0),
    count(*) filter (where e.risk in ('high_risk','watch')),
    count(*) filter (where e.worked_hours >= v_threshold),
    coalesce(sum(e.rescue_hours), 0),
    coalesce(sum(e.worked_hours), 0),
    coalesce(sum(e.scheduled_hours), 0),
    coalesce(sum(e.variance_hours), 0),
    bool_or(e.rate is not null)
  into
    v_drivers,
    v_total_ot_hours,
    v_total_ot_premium,
    v_drivers_at_risk,
    v_drivers_active_ot,
    v_total_rescue_hrs,
    v_total_worked,
    v_total_scheduled,
    v_total_variance,
    v_have_rates
  from enriched e;

  -- ── 2. Top OT-creating route group ─────────────────────────────────────
  with route_rows as (
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
    from route_rows
    group by driver_id, route_group
  ),
  driver_totals as (
    -- Re-run the section-1 worked-hours formula inline. CTEs from
    -- an earlier statement aren't visible here, so we recompute
    -- rather than depend on a temp table.
    select
      s.driver_id,
      greatest(0,
        sum(
          case
            when coalesce(c.checked_in_at,  s.starts_at - interval '10 minutes') is not null
             and coalesce(c.checked_out_at, s.ends_at) is not null
             and coalesce(c.checked_out_at, s.ends_at)
                 > coalesce(c.checked_in_at, s.starts_at - interval '10 minutes')
              then extract(epoch from (
                     coalesce(c.checked_out_at, s.ends_at)
                     - coalesce(c.checked_in_at, s.starts_at - interval '10 minutes')
                   )) / 3600.0
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

  select route_group, ot_hours
    into v_top_route, v_top_route_hrs
    from jsonb_to_recordset(v_route_groups)
         as r(route_group text, ot_hours numeric)
    order by ot_hours desc nulls last
    limit 1;

  select driver_name, ot_hours
    into v_top_contributor, v_top_contributor_hrs
    from jsonb_to_recordset(v_drivers)
         as d(driver_name text, ot_hours numeric)
   where ot_hours > 0
    order by ot_hours desc nulls last
    limit 1;

  -- ── 3. Prior-week OT hours for trend (actuals + same fallback) ─────────
  select coalesce(sum(greatest(0, hrs - v_threshold)), 0)
    into v_prev_ot_hours
    from (
      select
        s.driver_id,
        sum(
          case
            when coalesce(c.checked_in_at, s.starts_at - interval '10 minutes') is not null
             and coalesce(c.checked_out_at, s.ends_at) is not null
             and coalesce(c.checked_out_at, s.ends_at) > coalesce(c.checked_in_at, s.starts_at - interval '10 minutes')
              then extract(epoch from (
                     coalesce(c.checked_out_at, s.ends_at)
                     - coalesce(c.checked_in_at, s.starts_at - interval '10 minutes')
                   )) / 3600.0
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

  -- ── 4. Predictive insights ─────────────────────────────────────────────
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

  -- ── 5. Return the full document ────────────────────────────────────────
  return jsonb_build_object(
    'week_start',         v_week,
    'week_end',           v_week_end - 1,
    'threshold_hours',    v_threshold,
    'have_rates',         coalesce(v_have_rates, false),
    'default_rate',       v_def_rate,
    'default_multiplier', v_def_mult,
    'summary', jsonb_build_object(
      'drivers_projected_ot',  coalesce(v_drivers_at_risk, 0),
      'drivers_active_ot',     coalesce(v_drivers_active_ot, 0),
      'est_ot_hours',          round(coalesce(v_total_ot_hours, 0), 1),
      'est_ot_exposure_usd',   round(coalesce(v_total_ot_premium, 0), 2),
      'total_scheduled_hours', round(coalesce(v_total_scheduled, 0), 1),
      'total_worked_hours',    round(coalesce(v_total_worked, 0), 1),
      'total_variance_hours',  round(coalesce(v_total_variance, 0), 1),
      'rescue_driven_pct',     case
                                 when coalesce(v_total_worked, 0) = 0 then null
                                 else round((coalesce(v_total_rescue_hrs,0) / v_total_worked) * 100, 0)
                               end,
      'trend_pct',             v_trend_pct,
      'prev_ot_hours',         round(coalesce(v_prev_ot_hours, 0), 1),
      'top_route_group',       v_top_route,
      'top_route_ot_hours',    round(coalesce(v_top_route_hrs, 0), 1),
      'top_contributor',       v_top_contributor,
      'top_contributor_ot',    round(coalesce(v_top_contributor_hrs, 0), 1)
    ),
    'drivers',     v_drivers,
    'route_groups', v_route_groups,
    'insights',    v_insights
  );
end;
$$;

grant execute on function public.overtime_intelligence(date) to authenticated;

notify pgrst, 'reload schema';
