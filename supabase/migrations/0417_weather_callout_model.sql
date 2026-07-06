-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0417 · Weather → call-out prediction (first slice)
--
-- Learns THIS DSP's own call-out sensitivity to weather from history, then
-- exposes it so the dashboard can turn an upcoming NWS forecast into an
-- expected-call-out number per day and feed Callout Exposure.
--
-- Two pieces, both idempotent + self-contained:
--   1. private.weather_callout_bucket(...) — the single source of truth for
--      how a day's weather maps to ONE bucket. The dashboard mirrors this
--      exact priority in JS (see loadWeather() in dashboard/live.js) so the
--      model is trained and applied on the same bucketing.
--   2. public.weather_callout_model(p_days) — returns the learned per-bucket
--      call-out rates (with sample sizes), the overall baseline, and the
--      count of assigned shifts on each upcoming date so the client can
--      compute expected = scheduled × rate.
--
-- No ML: buckets carry a plain empirical rate (called_off / expected). A
-- single DSP has thin history, so callers should gate display on sample
-- size — the payload returns `scheduled` per bucket for exactly that.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Shared bucketing (most-severe-wins priority) ───────────────────────
-- KEEP IN SYNC with wxCalloutBucket() in dashboard/live.js.
create or replace function private.weather_callout_bucket(
  p_conditions    text,
  p_precip_pct    int,
  p_high_temp_f   int,
  p_low_temp_f    int,
  p_peak_wind_mph int,
  p_has_alert     boolean
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_has_alert, false)                              then 'alert'
    when p_conditions = 'snow'                                     then 'snow'
    when p_conditions = 'thunderstorm'                             then 'thunderstorm'
    when p_conditions = 'rain' and coalesce(p_precip_pct,0) >= 60  then 'heavy_rain'
    when p_conditions = 'rain' or coalesce(p_precip_pct,0) >= 40   then 'rain'
    when coalesce(p_high_temp_f, -999) >= 95                       then 'heat'
    when coalesce(p_low_temp_f,  999)  <= 32                       then 'cold'
    else 'clear'
  end
$$;

-- ── 2. The model RPC ──────────────────────────────────────────────────────
create or replace function public.weather_callout_model(p_days int default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp      uuid := private.current_dsp_id();
  v_lookback int  := 365;   -- days of history to learn from
  v_days     int  := greatest(1, least(14, coalesce(p_days, 7)));
  v_buckets  jsonb;
  v_upcoming jsonb;
  v_total_sched int;
  v_total_co    int;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- One resolved (working) day per historical snapshot, tagged with its
  -- weather bucket, joined to that day's assigned-and-resolved shift counts.
  with snaps as (
    select ws.date,
           private.weather_callout_bucket(
             ws.conditions, ws.precip_pct, ws.high_temp_f, ws.low_temp_f,
             ws.peak_wind_mph,
             jsonb_array_length(coalesce(ws.alerts, '[]'::jsonb)) > 0
           ) as bucket
      from public.weather_snapshots ws
     where ws.dsp_id = v_dsp
       and ws.date >= current_date - v_lookback
       and ws.date <  current_date
  ),
  shift_days as (
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
  ),
  joined as (
    select sn.bucket, sd.scheduled, sd.callouts
      from snaps sn
      join shift_days sd on sd.date = sn.date
     where sd.scheduled > 0
  ),
  per_bucket as (
    select bucket,
           count(*)          as days,
           sum(scheduled)    as scheduled,
           sum(callouts)     as callouts
      from joined
     group by bucket
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'key',       bucket,
      'days',      days,
      'scheduled', scheduled,
      'callouts',  callouts,
      'rate',      round(callouts::numeric / nullif(scheduled,0), 4)
    ) order by (callouts::numeric / nullif(scheduled,0)) desc nulls last), '[]'::jsonb),
    coalesce(sum(scheduled), 0),
    coalesce(sum(callouts), 0)
  into v_buckets, v_total_sched, v_total_co
  from per_bucket;

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
    'baseline_rate', round(v_total_co::numeric / nullif(v_total_sched,0), 4),
    'baseline_scheduled', v_total_sched,
    'buckets',       v_buckets,
    'upcoming',      coalesce(v_upcoming, '[]'::jsonb)
  );
end;
$$;

grant execute on function public.weather_callout_model(int) to authenticated;

notify pgrst, 'reload schema';
