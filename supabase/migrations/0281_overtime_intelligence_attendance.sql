-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0281 · Overtime Intelligence — respect attendance outcomes
--
-- Refines public.overtime_intelligence() so attendance decisions affect
-- worked hours the way an operator expects:
--
--   · Scheduled hours include EVERY shift on the week's roster —
--     status in ('scheduled','completed','late','no_show','called_off','vto').
--     The shift was on the plan; it counts toward what we expected.
--
--   · Worked hours only accrue for ('scheduled','completed','late').
--     For 'no_show', 'called_off', 'vto' worked = 0. A driver scheduled
--     40h who NCNS's one 10h shift now reads: scheduled 40, worked 30,
--     variance −10 — clear signal that the driver was missing.
--
--   · Rescue hours and late-clockout minutes keep their existing rules
--     (require an eff_in/eff_out pair), so an NCNS rescue can't
--     accidentally inflate the rescue contribution.
--
-- attendance_decide() already writes the resolved outcome onto
-- shifts.status (migration 0099 maps ncns → no_show, deny → excused
-- which the operator treats as worked, etc.), so reading shifts.status
-- as the source of truth is correct — no join into attendance_decisions
-- is needed.
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

  -- Statuses that count toward scheduled hours (the week's plan).
  v_sched_statuses text[] := array['scheduled','completed','late','no_show','called_off','vto'];
  -- Statuses where the driver actually accrued worked hours. NCNS, VTO,
  -- and called-off do NOT — they make variance negative on purpose.
  v_worked_statuses text[] := array['scheduled','completed','late'];

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
  v_total_no_show    int     := 0;
  v_total_vto        int     := 0;
  v_total_called_off int     := 0;
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
  with shift_rows as (
    select
      s.id              as shift_id,
      s.driver_id,
      s.date,
      s.status::text     as status,
      s.shift_kind,
      s.route_code,
      s.station_id,
      s.starts_at,
      s.ends_at,
      c.checked_in_at,
      c.checked_out_at,
      coalesce(
        s.block_hours::numeric,
        case when s.starts_at is not null and s.ends_at is not null
             then extract(epoch from (s.ends_at - s.starts_at)) / 3600.0
             else null end,
        10
      ) as scheduled_hrs,
      -- Effective clock-in / clock-out only resolve when the status
      -- indicates the driver actually worked. For no_show/called_off/
      -- vto these stay NULL so worked_hrs computes to 0.
      case
        when s.status::text = any(v_worked_statuses) then
          coalesce(
            c.checked_in_at,
            case when s.starts_at is not null
                 then s.starts_at - interval '10 minutes' else null end
          )
      end as eff_in,
      case
        when s.status::text = any(v_worked_statuses) then
          coalesce(c.checked_out_at, s.ends_at)
      end as eff_out
    from public.shifts s
    left join public.driver_checkins c on c.shift_id = s.id
    where s.dsp_id    = v_dsp
      and s.driver_id is not null
      and s.date     >= v_week
      and s.date     <  v_week_end
      and s.status::text = any(v_sched_statuses)
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
      count(*) filter (where sc.shift_kind = 'rescue')             as rescue_count,
      count(*) filter (where sc.status = 'completed')              as completed_count,
      count(*) filter (where sc.status = 'no_show')                as no_show_count,
      count(*) filter (where sc.status = 'called_off')             as called_off_count,
      count(*) filter (where sc.status = 'vto')                    as vto_count,
      count(*) filter (where sc.status = 'scheduled' and sc.date >= v_today) as scheduled_remaining
    from shift_calc sc
    group by sc.driver_id
  ),
  scored as (
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
      coalesce(pd.no_show_count, 0)::int          as no_show_count,
      coalesce(pd.called_off_count, 0)::int       as called_off_count,
      coalesce(pd.vto_count, 0)::int              as vto_count,
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
        'driver_id',             e.driver_id,
        'driver_name',           e.full_name,
        'station_code',          e.station_code,
        'hourly_rate',           e.rate,
        'ot_multiplier',         e.mult,
        'scheduled_hours',       round(e.scheduled_hours, 2),
        'worked_hours',          round(e.worked_hours,    2),
        'variance_hours',        round(e.variance_hours,  2),
        'ot_hours',              round(e.ot_hours_proj,   2),
        'ot_premium_usd',        case when e.rate is null then null
                                      else round(e.ot_hours_proj * e.rate * (e.mult - 1), 2) end,
        'rescue_hours',          round(e.rescue_hours, 2),
        'rescue_count',          e.rescue_count,
        'late_clockout_minutes', round(e.late_minutes, 0),
        'completed_shifts',      e.completed_count,
        'no_show_count',         e.no_show_count,
        'called_off_count',      e.called_off_count,
        'vto_count',             e.vto_count,
        'scheduled_remaining',   e.scheduled_remaining,
        'risk',                  e.risk
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
    coalesce(sum(e.no_show_count), 0),
    coalesce(sum(e.vto_count), 0),
    coalesce(sum(e.called_off_count), 0),
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
    v_total_no_show,
    v_total_vto,
    v_total_called_off,
    v_have_rates
  from enriched e;

  -- ── 2. Top OT-creating route group ─────────────────────────────────────
  -- Inline-recompute per-driver OT hours using the same status filter so
  -- route-group attribution lines up with the table totals.
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
      and s.status::text = any(v_worked_statuses)
  ),
  by_driver as (
    select driver_id, route_group, sum(planned_hours) as hrs
    from route_rows
    group by driver_id, route_group
  ),
  driver_totals as (
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
      and s.status::text = any(v_worked_statuses)
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

  -- ── 3. Prior-week OT hours for trend ───────────────────────────────────
  select coalesce(sum(greatest(0, hrs - v_threshold)), 0)
    into v_prev_ot_hours
    from (
      select
        s.driver_id,
        sum(
          case
            when s.status::text = any(v_worked_statuses)
             and coalesce(c.checked_in_at, s.starts_at - interval '10 minutes') is not null
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
        and s.status::text = any(v_sched_statuses)
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
          'severity', 'high', 'kind', 'rescues',
          'title', 'Rescues are driving labor exposure',
          'body',  'Rescues account for ' || v_rescue_pct || '% of hours worked this week — reactive coverage is the dominant OT contributor.'
        ));
      end if;
    end;
  end if;

  if v_drivers_at_risk >= 3 then
    v_insights := v_insights || jsonb_build_array(jsonb_build_object(
      'severity', 'med', 'kind', 'risk_cluster',
      'title', v_drivers_at_risk || ' drivers trending into overtime',
      'body',  'Projected weekly totals put ' || v_drivers_at_risk || ' drivers at or above the ' || v_threshold || '-hour threshold.'
    ));
  end if;

  if (v_total_no_show + v_total_called_off) >= 3 then
    v_insights := v_insights || jsonb_build_array(jsonb_build_object(
      'severity', 'med', 'kind', 'attendance',
      'title',    (v_total_no_show + v_total_called_off) || ' attendance gaps this week',
      'body',     v_total_no_show || ' no-shows · ' || v_total_called_off || ' call-offs · ' || v_total_vto || ' VTO — each one widens the worked-vs-scheduled variance.'
    ));
  end if;

  if v_top_route is not null and v_top_route_hrs >= 4 then
    v_insights := v_insights || jsonb_build_array(jsonb_build_object(
      'severity', 'med', 'kind', 'route_group',
      'title', 'Route group ' || v_top_route || ' is the largest OT source',
      'body',  'Drivers working ' || v_top_route || ' routes are projected to contribute ' || round(v_top_route_hrs, 1) || ' OT hours this week.'
    ));
  end if;

  if v_trend_pct is not null and v_trend_pct >= 25 then
    v_insights := v_insights || jsonb_build_array(jsonb_build_object(
      'severity', 'high', 'kind', 'trend',
      'title', 'OT exposure up ' || v_trend_pct || '% vs last week',
      'body',  'This week is on pace to materially exceed last week''s overtime totals.'
    ));
  elsif v_trend_pct is not null and v_trend_pct <= -15 then
    v_insights := v_insights || jsonb_build_array(jsonb_build_object(
      'severity', 'good', 'kind', 'trend',
      'title', 'OT exposure down ' || abs(v_trend_pct) || '% vs last week',
      'body',  'The current schedule is trending cleaner than the prior week.'
    ));
  end if;

  if v_have_rates is not true then
    v_insights := v_insights || jsonb_build_array(jsonb_build_object(
      'severity', 'info', 'kind', 'config',
      'title', 'Set hourly rates to unlock dollar exposure',
      'body',  'Add a default hourly rate in Settings → Scheduling, or per-driver rates on each driver, to see projected OT premiums in dollars.'
    ));
  end if;

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
      'attendance_gaps',       coalesce(v_total_no_show, 0)
                                + coalesce(v_total_called_off, 0)
                                + coalesce(v_total_vto, 0),
      'no_show_count',         coalesce(v_total_no_show, 0),
      'called_off_count',      coalesce(v_total_called_off, 0),
      'vto_count',             coalesce(v_total_vto, 0),
      'rescue_driven_pct',     case when coalesce(v_total_worked, 0) = 0 then null
                                    else round((coalesce(v_total_rescue_hrs,0) / v_total_worked) * 100, 0) end,
      'trend_pct',             v_trend_pct,
      'prev_ot_hours',         round(coalesce(v_prev_ot_hours, 0), 1),
      'top_route_group',       v_top_route,
      'top_route_ot_hours',    round(coalesce(v_top_route_hrs, 0), 1),
      'top_contributor',       v_top_contributor,
      'top_contributor_ot',    round(coalesce(v_top_contributor_hrs, 0), 1)
    ),
    'drivers',      v_drivers,
    'route_groups', v_route_groups,
    'insights',     v_insights
  );
end;
$$;

grant execute on function public.overtime_intelligence(date) to authenticated;

notify pgrst, 'reload schema';
