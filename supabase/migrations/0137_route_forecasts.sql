-- Migration 0137 · Route forecasts — "how many drivers do I need to hire?"
--
-- The DSP enters how many routes they expect to dispatch each week, up to
-- ~9 weeks out; the Staffing-outlook page turns that into a headcount —
-- routes ÷ (weekly day-cap × show-rate) — and the gap vs. the current
-- roster (plus anyone in onboarding by that week) is what they need to
-- hire.  Stored per (dsp_id, week_start); Monday-aligned.

create table if not exists public.route_forecasts (
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  week_start  date not null,
  route_slots int  not null default 0 check (route_slots between 0 and 100000),  -- total route-days dispatched that week
  updated_at  timestamptz not null default now(),
  primary key (dsp_id, week_start)
);
alter table public.route_forecasts enable row level security;
drop policy if exists "route_forecasts_tenant_rw" on public.route_forecasts;
create policy "route_forecasts_tenant_rw" on public.route_forecasts for all
  using (dsp_id = private.current_dsp_id()) with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.route_forecasts to authenticated;


-- ── route_forecast_set(week_start, route_slots) — upsert one week ──────
create or replace function public.route_forecast_set(p_week_start date, p_route_slots int)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.route_forecasts (dsp_id, week_start, route_slots)
  values (v_dsp, date_trunc('week', p_week_start)::date, greatest(0, least(100000, coalesce(p_route_slots, 0))))
  on conflict (dsp_id, week_start) do update set route_slots = excluded.route_slots, updated_at = now();
end;
$$;
grant execute on function public.route_forecast_set(date, int) to authenticated;


-- ── route_forecast_get(weeks) ─────────────────────────────────────────
-- The next N Monday-aligned weeks, each with the saved route_slots (null
-- if not set yet) and a count of currently-scheduled shifts in that week
-- as a starting suggestion.
create or replace function public.route_forecast_get(p_weeks int default 9)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_n   int  := greatest(1, least(26, coalesce(p_weeks, 9)));
  v_mon date := date_trunc('week', current_date)::date;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'week_start',  w.ws,
      'route_slots', f.route_slots,
      'scheduled',   coalesce((select count(*)::int from public.shifts s
                                where s.dsp_id = v_dsp and s.status = 'scheduled' and s.date >= w.ws and s.date < w.ws + 7), 0)
    ) order by w.ws)
    from (select (v_mon + g * 7)::date as ws from generate_series(0, v_n - 1) g) w
    left join public.route_forecasts f on f.dsp_id = v_dsp and f.week_start = w.ws
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.route_forecast_get(int) to authenticated;

notify pgrst, 'reload schema';
