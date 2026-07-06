-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0418 · Weather → call-out prediction, calendar-controlled
--
-- v1 (0417) reported a flat call-out rate per weather bucket — but that rate
-- silently absorbs *when* those weather days fell on the calendar. Snow
-- clusters in winter; call-outs also spike on Mondays, weekends and in
-- winter for reasons that have nothing to do with snow. So "snow = 15% vs a
-- 3% baseline" overstates weather.
--
-- This replaces public.weather_callout_model() with a version that splits
-- each bucket's lift into a CALENDAR part and a WEATHER part via indirect
-- standardization:
--
--   * Stratify history by (daytype × season), where
--       daytype = monday | weekend | midweek   (the big weekly call-out
--                 rhythm without over-slicing a single DSP's ~1yr of data)
--       season  = winter | spring | summer | fall
--   * For each weather bucket B, the "calendar-expected" call-outs are what
--     you'd expect on B's exact days if they behaved like *comparable
--     non-B days of the same daytype & season* (reference = the stratum
--     total minus B's own contribution, so B never benchmarks against
--     itself). Thin strata (< MIN_REF_HEADS reference heads) fall back to
--     the global baseline.
--   * naive_lift = weather_lift × calendar_lift, where
--       calendar_lift  = calendar_expected_rate / baseline   (weekday/season)
--       weather_lift   = raw_rate / calendar_expected_rate    (what's left)
--
-- weather_lift is the honest "how much is actually the weather" number.
-- ref_heads is returned so the client can tell when the split is trustworthy.
--
-- private.weather_callout_bucket() is unchanged from 0417. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.weather_callout_model(p_days int default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp       uuid := private.current_dsp_id();
  v_lookback  int  := 365;   -- days of history to learn from
  v_days      int  := greatest(1, least(14, coalesce(p_days, 7)));
  v_min_ref   int  := 40;    -- reference heads (non-B, same stratum) needed
                             -- before we trust the calendar split for a day
  v_buckets   jsonb;
  v_upcoming  jsonb;
  v_total_sched int;
  v_total_co    int;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with day_facts as (
    -- one row per historical day with both a weather snapshot and resolved,
    -- assigned shifts — tagged with its weather bucket + calendar stratum.
    select
      ws.date,
      case extract(dow from ws.date)::int
        when 0 then 'weekend' when 6 then 'weekend'
        when 1 then 'monday'
        else 'midweek'
      end as daytype,
      case
        when extract(month from ws.date)::int in (12, 1, 2) then 'winter'
        when extract(month from ws.date)::int in (3, 4, 5)  then 'spring'
        when extract(month from ws.date)::int in (6, 7, 8)  then 'summer'
        else 'fall'
      end as season,
      private.weather_callout_bucket(
        ws.conditions, ws.precip_pct, ws.high_temp_f, ws.low_temp_f,
        ws.peak_wind_mph,
        jsonb_array_length(coalesce(ws.alerts, '[]'::jsonb)) > 0
      ) as bucket,
      sd.scheduled,
      sd.callouts
    from public.weather_snapshots ws
    join (
      select s.date,
             count(*) filter (
               where s.status in ('completed','late','no_show','called_off')
             ) as scheduled,
             count(*) filter (where s.status = 'called_off') as callouts
        from public.shifts s
       where s.dsp_id = v_dsp
         and s.date >= current_date - v_lookback
         and s.date <  current_date
       group by s.date
    ) sd on sd.date = ws.date
    where ws.dsp_id = v_dsp
      and ws.date >= current_date - v_lookback
      and ws.date <  current_date
      and sd.scheduled > 0
  ),
  totals as (
    select sum(scheduled)::numeric as sched, sum(callouts)::numeric as co
      from day_facts
  ),
  strat_all as (   -- all days, by calendar stratum
    select daytype, season,
           sum(scheduled) as sched, sum(callouts) as co
      from day_facts group by daytype, season
  ),
  bucket_strat as ( -- bucket × calendar stratum
    select bucket, daytype, season,
           sum(scheduled) as sched, sum(callouts) as co
      from day_facts group by bucket, daytype, season
  ),
  ref as (          -- reference = same stratum, minus the bucket's own days
    select bs.bucket,
           bs.sched              as b_sched,
           bs.co                 as b_co,
           (sa.sched - bs.sched) as ref_sched,
           (sa.co   - bs.co)     as ref_co
      from bucket_strat bs
      join strat_all sa using (daytype, season)
  ),
  bucket_days as (
    select bucket, count(*) as days from day_facts group by bucket
  ),
  bucket_adj as (
    select r.bucket,
           sum(r.b_sched)  as scheduled,
           sum(r.b_co)     as callouts,
           sum(r.ref_sched) as ref_heads,
           -- expected call-outs on B's days at the calendar-only rate:
           -- per-stratum reference rate, or the global baseline when thin.
           sum(
             r.b_sched * coalesce(
               case when r.ref_sched >= v_min_ref
                    then r.ref_co::numeric / nullif(r.ref_sched, 0)
               end,
               (select case when sched > 0 then co / sched else null end from totals)
             )
           ) as expected_callouts
      from ref r
      group by r.bucket
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'key',                    ba.bucket,
      'days',                   bd.days,
      'scheduled',              ba.scheduled,
      'callouts',               ba.callouts,
      'ref_heads',              ba.ref_heads,
      'rate',                   round(ba.callouts::numeric / nullif(ba.scheduled, 0), 4),
      'calendar_expected_rate', round(ba.expected_callouts / nullif(ba.scheduled, 0), 4),
      -- how much of the lift survives once weekday-type + season are removed
      'weather_lift',           round(ba.callouts::numeric / nullif(ba.expected_callouts, 0), 2),
      -- how much of the naive lift was just the calendar
      'calendar_lift',          round((ba.expected_callouts / nullif(ba.scheduled, 0)) / nullif(t.base, 0), 2)
    ) order by (ba.callouts::numeric / nullif(ba.expected_callouts, 0)) desc nulls last), '[]'::jsonb),
    coalesce(sum(ba.scheduled), 0),
    coalesce(sum(ba.callouts), 0)
  into v_buckets, v_total_sched, v_total_co
  from bucket_adj ba
  join bucket_days bd using (bucket)
  cross join (select case when sched > 0 then co / sched else null end as base from totals) t;

  -- Assigned head-count per upcoming date (today .. +N). 'vto' is company-
  -- offered time off, not an expected working head, so it's excluded.
  select coalesce(jsonb_agg(jsonb_build_object(
           'date',      d.date,
           'scheduled', d.scheduled
         ) order by d.date), '[]'::jsonb)
    into v_upcoming
  from (
    select s.date,
           count(*) filter (
             where s.driver_id is not null and s.status <> 'vto'
           ) as scheduled
      from public.shifts s
     where s.dsp_id = v_dsp
       and s.date >= current_date
       and s.date <= current_date + v_days
     group by s.date
  ) d
  where d.scheduled > 0;

  return jsonb_build_object(
    'dsp_id',        v_dsp,
    'lookback_days', v_lookback,
    'sample_days',   (select count(*) from public.weather_snapshots ws
                       where ws.dsp_id = v_dsp
                         and ws.date >= current_date - v_lookback
                         and ws.date <  current_date),
    'baseline_rate', round(v_total_co::numeric / nullif(v_total_sched, 0), 4),
    'baseline_scheduled', v_total_sched,
    'buckets',       v_buckets,
    'upcoming',      coalesce(v_upcoming, '[]'::jsonb)
  );
end;
$$;

grant execute on function public.weather_callout_model(int) to authenticated;

notify pgrst, 'reload schema';
