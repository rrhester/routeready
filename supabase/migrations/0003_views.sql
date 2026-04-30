-- ================================================================
-- RouteReady — Performance views and aggregation functions
-- Migration: 0003_views.sql
--
-- Replaces the heavy in-JS aggregations from the Apps Script with
-- Postgres set-returning functions. Each runs SECURITY INVOKER so
-- RLS on the underlying tables (scoped by current_dsp_id()) applies
-- automatically — every result is already DSP-isolated.
--
-- Source-of-truth functions ported here (from Apps Script project):
--   getDecisionViewTiered    -> decision_view_tiered(window_days int)
--   getCoachingQueueForDate  -> coaching_queue_for_date(target_date date)
--   getWeeklyTotals          -> weekly_totals(week_start date)
--   getMorningPerformance    -> morning_performance()
--
-- Quality thresholds (match DVT_* constants in perf_backend_tiered.gs):
--   DCR < 98.5%   -> quality issue
--   POD < 95.0%   -> quality issue
--   CDF DPMO threshold (5000) is dropped — schema doesn't carry that
--   column yet. Add later if Amazon CSV import starts capturing it.
--
-- Tier definitions:
--   Tier 1: safety AND quality issues   (stay/go conversations)
--   Tier 2: safety only                 (cap-the-DSP, coach hard)
--   Tier 3: quality only                (coach normally)
-- ================================================================

-- ================================================================
-- decision_view_tiered(window_days)
--
-- Returns one row per active driver who has at least one safety
-- event or quality issue in the window, classified into Tier 1/2/3.
-- Clean drivers (no safety, no quality issue) are NOT returned —
-- the caller derives the clean count by subtracting from fleet size.
--
-- Pass window_days = 0 to mean "all time".
-- ================================================================

create or replace function public.decision_view_tiered(p_window_days int default 30)
returns table (
  tier               int,
  transporter_id     text,
  driver_name        text,
  safety_event_count bigint,
  days_with_flags    bigint,
  last_event_date    date,
  event_mix          jsonb,
  disputes_denied    bigint,
  dcr_avg            numeric,
  pod_avg            numeric,
  quality_issues     text[],
  sms_count          bigint,
  inperson_count     bigint,
  last_sms_date      timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with cutoff as (
    select case
      when p_window_days is null or p_window_days <= 0 then date '0001-01-01'
      else current_date - (p_window_days - 1)
    end as d
  ),
  active_drivers as (
    select dr.dsp_id, dr.transporter_id, dr.driver_name
    from public.driver_roster dr
    where dr.status <> 'terminated'
  ),
  windowed_events as (
    select se.*
    from public.safety_events se
    cross join cutoff c
    where se.event_date >= c.d
  ),
  windowed_quality as (
    select qd.*
    from public.quality_daily qd
    cross join cutoff c
    where qd.event_date >= c.d
  ),
  safety_agg as (
    select
      we.dsp_id,
      we.transporter_id,
      count(*) as event_count,
      count(distinct we.event_date) as days_with_flags,
      max(we.event_date) as last_event_date,
      count(*) filter (
        where lower(coalesce(we.review_status, '')) like '%denied%'
      ) as disputes_denied
    from windowed_events we
    group by we.dsp_id, we.transporter_id
  ),
  event_mix_agg as (
    select
      m.dsp_id,
      m.transporter_id,
      jsonb_agg(
        jsonb_build_object('type', m.metric_type, 'count', m.cnt)
        order by m.cnt desc
      ) as event_mix
    from (
      select
        dsp_id,
        transporter_id,
        coalesce(metric_type, 'Unknown') as metric_type,
        count(*) as cnt
      from windowed_events
      group by dsp_id, transporter_id, coalesce(metric_type, 'Unknown')
    ) m
    group by m.dsp_id, m.transporter_id
  ),
  quality_agg as (
    select
      wq.dsp_id,
      wq.transporter_id,
      avg(wq.dcr_pct) filter (where wq.dcr_pct is not null and wq.dcr_pct > 0) as dcr_avg,
      avg(wq.pod_pct) filter (where wq.pod_pct is not null and wq.pod_pct > 0) as pod_avg
    from windowed_quality wq
    group by wq.dsp_id, wq.transporter_id
  ),
  coaching_agg as (
    select
      cl.dsp_id,
      cl.transporter_id,
      count(*) filter (where cl.type = 'SMS')      as sms_count,
      count(*) filter (where cl.type = 'InPerson') as inperson_count,
      max(cl.created_at) filter (where cl.type = 'SMS') as last_sms_date
    from public.coaching_log cl
    group by cl.dsp_id, cl.transporter_id
  ),
  classified as (
    select
      ad.transporter_id,
      ad.driver_name,
      coalesce(sa.event_count, 0)     as safety_event_count,
      coalesce(sa.days_with_flags, 0) as days_with_flags,
      sa.last_event_date,
      coalesce(em.event_mix, '[]'::jsonb) as event_mix,
      coalesce(sa.disputes_denied, 0) as disputes_denied,
      qa.dcr_avg,
      qa.pod_avg,
      coalesce(ca.sms_count, 0)       as sms_count,
      coalesce(ca.inperson_count, 0)  as inperson_count,
      ca.last_sms_date,
      (coalesce(sa.event_count, 0) > 0) as has_safety,
      (
        (qa.dcr_avg is not null and qa.dcr_avg < 98.5)
        or (qa.pod_avg is not null and qa.pod_avg < 95.0)
      ) as has_quality
    from active_drivers ad
    left join safety_agg     sa on sa.dsp_id = ad.dsp_id and sa.transporter_id = ad.transporter_id
    left join event_mix_agg  em on em.dsp_id = ad.dsp_id and em.transporter_id = ad.transporter_id
    left join quality_agg    qa on qa.dsp_id = ad.dsp_id and qa.transporter_id = ad.transporter_id
    left join coaching_agg   ca on ca.dsp_id = ad.dsp_id and ca.transporter_id = ad.transporter_id
  )
  select
    case
      when has_safety and has_quality then 1
      when has_safety                 then 2
      when has_quality                then 3
    end as tier,
    transporter_id,
    driver_name,
    safety_event_count,
    days_with_flags,
    last_event_date,
    event_mix,
    disputes_denied,
    round(dcr_avg, 1) as dcr_avg,
    round(pod_avg, 1) as pod_avg,
    array_remove(array[
      case when dcr_avg is not null and dcr_avg < 98.5
           then 'DCR ' || to_char(round(dcr_avg, 1), 'FM990.0') || '%' end,
      case when pod_avg is not null and pod_avg < 95.0
           then 'POD ' || to_char(round(pod_avg, 1), 'FM990.0') || '%' end
    ], null) as quality_issues,
    sms_count,
    inperson_count,
    last_sms_date
  from classified
  where has_safety or has_quality
  order by
    case when has_safety and has_quality then 1
         when has_safety then 2
         when has_quality then 3 end,
    safety_event_count desc nulls last,
    dcr_avg asc nulls last;
$$;

-- Helper for the counts payload {tier_1, tier_2, tier_3, total_flagged, clean, fleet_size}.
-- The Edge Function will combine this with a `select * from decision_view_tiered(...)` to
-- build the full {counts, tier_1[], tier_2[], tier_3[]} response shape the dashboard expects.

create or replace function public.decision_view_tiered_counts(p_window_days int default 30)
returns table (
  tier_1        bigint,
  tier_2        bigint,
  tier_3        bigint,
  total_flagged bigint,
  clean         bigint,
  fleet_size    bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with classified as (
    select tier from public.decision_view_tiered(p_window_days)
  ),
  fleet as (
    select count(*) as fleet_size
    from public.driver_roster
    where status <> 'terminated'
  ),
  flagged as (
    select
      count(*) filter (where tier = 1) as t1,
      count(*) filter (where tier = 2) as t2,
      count(*) filter (where tier = 3) as t3,
      count(*) as total
    from classified
  )
  select
    flagged.t1,
    flagged.t2,
    flagged.t3,
    flagged.total,
    greatest(fleet.fleet_size - flagged.total, 0) as clean,
    fleet.fleet_size
  from flagged, fleet;
$$;

-- ================================================================
-- coaching_queue_for_date(target_date)
--
-- One row per driver with at least one safety event on the target
-- date. Defaults to the most recent date that has any events.
-- already_coached = true when every event on that date already has
-- a coaching_log row referencing it via triggered_by_event_id.
-- ================================================================

create or replace function public.coaching_queue_for_date(p_target_date date default null)
returns table (
  target_date     date,
  transporter_id  text,
  driver_name     text,
  event_count     bigint,
  metric_types    text[],
  already_coached boolean,
  pattern_tag     text
)
language sql
stable
security invoker
set search_path = public
as $$
  with target as (
    select coalesce(
      p_target_date,
      (select max(event_date) from public.safety_events)
    ) as d
  ),
  day_events as (
    select se.*
    from public.safety_events se
    cross join target t
    where se.event_date = t.d
  ),
  coached_event_ids as (
    select distinct cl.dsp_id, cl.triggered_by_event_id
    from public.coaching_log cl
    where cl.triggered_by_event_id is not null
  ),
  -- 14-day pattern tag (matches computePatternTag_ in perf_backend_v2.gs):
  --   CHRONIC    : 6+ events in last 14 days
  --   PATTERN    : 3-5 events in last 14 days
  --   FIRST_WEEK : 1-2 events ever, all in last 14 days
  --   CLEAR      : 0 events in last 14 days
  last14 as (
    select dsp_id, transporter_id, count(*) as cnt
    from public.safety_events
    where event_date >= current_date - interval '13 days'
    group by dsp_id, transporter_id
  ),
  older as (
    select dsp_id, transporter_id, count(*) as cnt
    from public.safety_events
    where event_date < current_date - interval '13 days'
    group by dsp_id, transporter_id
  )
  select
    (select d from target) as target_date,
    de.transporter_id,
    max(de.driver_name) as driver_name,
    count(*) as event_count,
    array_agg(distinct coalesce(de.metric_type, 'Unknown')) as metric_types,
    bool_and(c.triggered_by_event_id is not null) as already_coached,
    case
      when coalesce(l.cnt, 0) = 0                                        then 'CLEAR'
      when l.cnt >= 6                                                    then 'CHRONIC'
      when coalesce(o.cnt, 0) = 0 and l.cnt <= 2                         then 'FIRST_WEEK'
      else 'PATTERN'
    end as pattern_tag
  from day_events de
  left join coached_event_ids c
         on c.dsp_id = de.dsp_id and c.triggered_by_event_id = de.event_id
  left join last14 l on l.dsp_id = de.dsp_id and l.transporter_id = de.transporter_id
  left join older  o on o.dsp_id = de.dsp_id and o.transporter_id = de.transporter_id
  group by de.transporter_id, l.cnt, o.cnt
  order by already_coached asc, event_count desc;
$$;

-- ================================================================
-- weekly_totals(week_start)
--
-- Single-row aggregate of the current (or specified) Mon-Sun week.
-- Mirrors getWeeklyTotals() in perf_backend_v2.gs.
-- ================================================================

create or replace function public.weekly_totals(p_week_start date default null)
returns table (
  week_start          date,
  week_end            date,
  incidents           bigint,
  drivers_involved    bigint,
  quality_list_count  bigint,
  by_type             jsonb,
  days_uploaded_flags boolean[]
)
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select
      coalesce(
        p_week_start,
        -- ISO week start (Monday) for current_date
        (current_date - ((extract(isodow from current_date)::int - 1)))::date
      ) as ws
  ),
  range as (
    select ws as week_start, (ws + 6) as week_end from bounds
  ),
  week_events as (
    select se.*
    from public.safety_events se, range r
    where se.event_date between r.week_start and r.week_end
  ),
  week_quality as (
    select qd.*
    from public.quality_daily qd, range r
    where qd.event_date between r.week_start and r.week_end
  ),
  by_type_agg as (
    select coalesce(jsonb_object_agg(metric_type, cnt), '{}'::jsonb) as by_type
    from (
      select coalesce(metric_type, 'Unknown') as metric_type, count(*) as cnt
      from week_events
      group by coalesce(metric_type, 'Unknown')
    ) t
  ),
  day_flags as (
    select array_agg(has_data order by day_offset) as flags
    from (
      select
        gs as day_offset,
        exists (
          select 1 from week_events we, range r
          where we.event_date = r.week_start + gs
        ) as has_data
      from generate_series(0, 6) gs
    ) d
  ),
  quality_issue_drivers as (
    select distinct transporter_id
    from week_quality
    where (dcr_pct is not null and dcr_pct < 99.0)
       or (pod_pct is not null and pod_pct < 98.0)
  )
  select
    r.week_start,
    r.week_end,
    (select count(*) from week_events)                                as incidents,
    (select count(distinct transporter_id) from week_events)          as drivers_involved,
    (select count(*) from quality_issue_drivers)                      as quality_list_count,
    (select by_type from by_type_agg)                                 as by_type,
    (select flags from day_flags)                                     as days_uploaded_flags
  from range r;
$$;

-- ================================================================
-- morning_performance()
--
-- The 7AM performance briefing: yesterday's safety events grouped
-- by driver, plus drivers who newly crossed into Tier 1 in the past
-- week. Mirrors getMorningPerformance() in perf_backend_morning.gs.
-- Returns a single JSON object so the Edge Function can forward it
-- as-is to the dashboard.
-- ================================================================

create or replace function public.morning_performance()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with d as (
    select
      current_date as today,
      current_date - 1 as yesterday
  ),
  yest_events as (
    select
      se.transporter_id,
      max(se.driver_name) as event_driver_name,
      count(*) as event_count,
      array_agg(distinct coalesce(se.metric_type, 'Unknown')) as event_types
    from public.safety_events se, d
    where se.event_date = d.yesterday
    group by se.transporter_id
  ),
  todays_coaching as (
    select jsonb_agg(
      jsonb_build_object(
        'transporter_id', ye.transporter_id,
        'name', coalesce(dr.driver_name, ye.event_driver_name, 'Unknown'),
        'event_count', ye.event_count,
        'event_types', ye.event_types
      )
      order by ye.event_count desc
    ) as drivers,
    count(*) as cnt
    from yest_events ye
    left join public.driver_roster dr
           on dr.transporter_id = ye.transporter_id
    group by ()
  ),
  fleet as (
    select count(*) as fleet_size
    from public.driver_roster
    where status <> 'terminated'
  ),
  -- Tier crossings: currently Tier 1 (safety + quality issues over last 30 days),
  -- but NOT Tier 1 in the prior 30-day window ending 7 days ago.
  current_classification as (
    select dr.transporter_id,
           dr.driver_name,
           (select count(*) from public.safety_events se
              where se.transporter_id = dr.transporter_id
                and se.dsp_id = dr.dsp_id
                and se.event_date >= current_date - 29) as safety_30d,
           (select avg(dcr_pct) from public.quality_daily qd
              where qd.transporter_id = dr.transporter_id
                and qd.dsp_id = dr.dsp_id
                and qd.event_date >= current_date - 29
                and qd.dcr_pct > 0) as dcr_30d,
           (select avg(pod_pct) from public.quality_daily qd
              where qd.transporter_id = dr.transporter_id
                and qd.dsp_id = dr.dsp_id
                and qd.event_date >= current_date - 29
                and qd.pod_pct > 0) as pod_30d
    from public.driver_roster dr
    where dr.status <> 'terminated'
  ),
  prior_classification as (
    select dr.transporter_id,
           (select count(*) from public.safety_events se
              where se.transporter_id = dr.transporter_id
                and se.dsp_id = dr.dsp_id
                and se.event_date between current_date - 36 and current_date - 7) as safety_prior,
           (select avg(dcr_pct) from public.quality_daily qd
              where qd.transporter_id = dr.transporter_id
                and qd.dsp_id = dr.dsp_id
                and qd.event_date between current_date - 36 and current_date - 7
                and qd.dcr_pct > 0) as dcr_prior,
           (select avg(pod_pct) from public.quality_daily qd
              where qd.transporter_id = dr.transporter_id
                and qd.dsp_id = dr.dsp_id
                and qd.event_date between current_date - 36 and current_date - 7
                and qd.pod_pct > 0) as pod_prior
    from public.driver_roster dr
    where dr.status <> 'terminated'
  ),
  crossings as (
    select c.transporter_id, c.driver_name, c.safety_30d,
           (c.safety_30d > 0) as cur_safety,
           ((c.dcr_30d is not null and c.dcr_30d < 98.5)
             or (c.pod_30d is not null and c.pod_30d < 95.0)) as cur_quality,
           (p.safety_prior > 0) as prior_safety,
           ((p.dcr_prior is not null and p.dcr_prior < 98.5)
             or (p.pod_prior is not null and p.pod_prior < 95.0)) as prior_quality
    from current_classification c
    join prior_classification p using (transporter_id)
  ),
  tier_crossings as (
    select jsonb_agg(
      jsonb_build_object(
        'transporter_id', transporter_id,
        'name', driver_name,
        'crossed_into', 'Tier 1',
        'reason', case
          when not prior_safety and not prior_quality then 'New safety AND quality issues this week'
          when not prior_safety then 'Safety issues now stack on existing quality issues'
          when not prior_quality then 'Quality issues now stack on existing safety issues'
        end,
        'safety_event_count', safety_30d
      )
      order by safety_30d desc
    ) as items
    from crossings
    where cur_safety and cur_quality
      and not (prior_safety and prior_quality)
  )
  select jsonb_build_object(
    'date',       (select today from d),
    'yesterday',  (select yesterday from d),
    'fleet_size', (select fleet_size from fleet),
    'all_clear',  coalesce((select cnt from todays_coaching), 0) = 0,
    'todays_coaching', jsonb_build_object(
      'drivers', coalesce((select drivers from todays_coaching), '[]'::jsonb),
      'count',   coalesce((select cnt from todays_coaching), 0)
    ),
    'tier_crossings', coalesce((select items from tier_crossings), '[]'::jsonb)
  );
$$;
