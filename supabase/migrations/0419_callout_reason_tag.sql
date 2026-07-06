-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0419 · Call-out reason (cause) tag + direct weather attribution
--
-- Until now we could only *infer* whether a call-out was weather-driven from
-- correlation (0417) and calendar-controlled lift (0418). This adds a
-- directly-recorded cause on the shift, so dispatch can say "this call-out
-- was the roads." Direct attribution beats any statistical inference.
--
--   * public.callout_reason enum: weather | illness | personal | family |
--     transport | other   (the cause; distinct from the *infraction* type
--     call-out / no-show / late, which already rides on coachings.metadata)
--   * shifts.callout_reason — nullable; set from the check-in tool when a
--     shift is marked called_off / no_show.
--
-- weather_callout_model() is re-emitted to surface, per bucket, how many of
-- the historical call-outs were explicitly tagged 'weather' (weather_callouts)
-- and how many carry any cause tag (tagged_callouts), plus a top-level
-- reason_coverage. Once coverage is meaningful the client can lead with the
-- recorded fact instead of the inferred lift.
--
-- Idempotent + self-contained. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Cause enum ─────────────────────────────────────────────────────────
do $$ begin
  create type public.callout_reason as enum (
    'weather', 'illness', 'personal', 'family', 'transport', 'other'
  );
exception when duplicate_object then null; end $$;

-- ── 2. Column on shifts ───────────────────────────────────────────────────
alter table public.shifts
  add column if not exists callout_reason public.callout_reason;

-- ── 3. Re-emit the model with direct weather attribution ──────────────────
create or replace function public.weather_callout_model(p_days int default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp       uuid := private.current_dsp_id();
  v_lookback  int  := 365;
  v_days      int  := greatest(1, least(14, coalesce(p_days, 7)));
  v_min_ref   int  := 40;
  v_buckets   jsonb;
  v_upcoming  jsonb;
  v_total_sched  int;
  v_total_co     int;
  v_total_tagged int;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with day_facts as (
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
      sd.callouts,
      sd.weather_callouts,
      sd.tagged_callouts
    from public.weather_snapshots ws
    join (
      select s.date,
             count(*) filter (
               where s.status in ('completed','late','no_show','called_off')
             ) as scheduled,
             count(*) filter (where s.status = 'called_off') as callouts,
             count(*) filter (
               where s.status = 'called_off' and s.callout_reason = 'weather'
             ) as weather_callouts,
             count(*) filter (
               where s.status = 'called_off' and s.callout_reason is not null
             ) as tagged_callouts
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
  strat_all as (
    select daytype, season, sum(scheduled) as sched, sum(callouts) as co
      from day_facts group by daytype, season
  ),
  bucket_strat as (
    select bucket, daytype, season, sum(scheduled) as sched, sum(callouts) as co
      from day_facts group by bucket, daytype, season
  ),
  ref as (
    select bs.bucket,
           bs.sched              as b_sched,
           bs.co                 as b_co,
           (sa.sched - bs.sched) as ref_sched,
           (sa.co   - bs.co)     as ref_co
      from bucket_strat bs
      join strat_all sa using (daytype, season)
  ),
  bucket_days as (
    select bucket,
           count(*)              as days,
           sum(weather_callouts) as weather_callouts,
           sum(tagged_callouts)  as tagged_callouts
      from day_facts group by bucket
  ),
  bucket_adj as (
    select r.bucket,
           sum(r.b_sched)   as scheduled,
           sum(r.b_co)      as callouts,
           sum(r.ref_sched) as ref_heads,
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
      'weather_callouts',       bd.weather_callouts,
      'tagged_callouts',        bd.tagged_callouts,
      'ref_heads',              ba.ref_heads,
      'rate',                   round(ba.callouts::numeric / nullif(ba.scheduled, 0), 4),
      'calendar_expected_rate', round(ba.expected_callouts / nullif(ba.scheduled, 0), 4),
      'weather_lift',           round(ba.callouts::numeric / nullif(ba.expected_callouts, 0), 2),
      'calendar_lift',          round((ba.expected_callouts / nullif(ba.scheduled, 0)) / nullif(t.base, 0), 2)
    ) order by (ba.callouts::numeric / nullif(ba.expected_callouts, 0)) desc nulls last), '[]'::jsonb),
    coalesce(sum(ba.callouts), 0),
    coalesce(sum(ba.scheduled), 0),
    coalesce(sum(bd.tagged_callouts), 0)
  into v_buckets, v_total_co, v_total_sched, v_total_tagged
  from bucket_adj ba
  join bucket_days bd using (bucket)
  cross join (select case when sched > 0 then co / sched else null end as base from totals) t;

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
    'reason_coverage', round(v_total_tagged::numeric / nullif(v_total_co, 0), 2),
    'buckets',       v_buckets,
    'upcoming',      coalesce(v_upcoming, '[]'::jsonb)
  );
end;
$$;

grant execute on function public.weather_callout_model(int) to authenticated;

notify pgrst, 'reload schema';
