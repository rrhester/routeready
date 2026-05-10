-- Migration 0138 · Route forecast starts after the last scheduled week
--
-- The schedule page already covers the weeks that have generated shifts;
-- the staffing outlook is for what comes *after* that — so the 9-week
-- forecast horizon begins the Monday after the last scheduled week (or
-- this week, if nothing's scheduled).  Each row also carries a "baseline":
-- the route-day count of that last scheduled week, so unfilled forecast
-- weeks pre-fill with the current run rate instead of 0.
--
-- Return shape changes from a bare array to:
--   { starts_after: date|null, baseline: int,
--     weeks: [ { week_start, route_slots|null, baseline }, ... ] }

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

  v_baseline := coalesce((
    select count(*)::int from public.shifts s
     where s.dsp_id = v_dsp and s.status = 'scheduled'
       and s.date >= v_last_wk and s.date < v_last_wk + 7
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
