-- Migration 0139 · Route forecast input is the week's PEAK daily route count
--
-- The DSP enters the highest single-day route count they expect each week
-- ("our busiest day next week is ~50 routes") and plans staffing to that.
-- Same route_forecasts.route_slots column, new meaning — so the only
-- change is the "baseline" we suggest: instead of the last scheduled
-- week's total route-days, it's that week's busiest day's shift count.

create or replace function public.route_forecast_get(p_weeks int default 9)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp      uuid := private.current_dsp_id();
  v_n        int  := greatest(1, least(26, coalesce(p_weeks, 9)));
  v_last_wk  date;
  v_start    date;
  v_baseline int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  select date_trunc('week', max(s.date))::date into v_last_wk
    from public.shifts s where s.dsp_id = v_dsp and s.status = 'scheduled';

  v_start := coalesce(v_last_wk + 7, date_trunc('week', current_date)::date);

  -- Baseline = the busiest day's scheduled-shift count in the last
  -- scheduled week (the run rate to carry forward).  0 if nothing scheduled.
  v_baseline := coalesce((
    select max(c)::int from (
      select count(*) c from public.shifts s
       where s.dsp_id = v_dsp and s.status = 'scheduled'
         and s.date >= v_last_wk and s.date < v_last_wk + 7
       group by s.date
    ) d
  ), 0);

  return jsonb_build_object(
    'starts_after', v_last_wk,
    'baseline',     v_baseline,
    'weeks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'week_start',  w.ws,
        'route_slots', f.route_slots,
        'baseline',    v_baseline
      ) order by w.ws)
      from (select (v_start + g * 7)::date as ws from generate_series(0, v_n - 1) g) w
      left join public.route_forecasts f on f.dsp_id = v_dsp and f.week_start = w.ws
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.route_forecast_get(int) to authenticated;

notify pgrst, 'reload schema';
