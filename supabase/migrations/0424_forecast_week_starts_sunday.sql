-- 0424_forecast_week_starts_sunday.sql
-- Move the route-forecast + schedule-forecast RPCs to Sunday-anchored
-- weeks, finishing the migration that 0276 started.
--
-- Background: 0276 switched the whole app to Sunday-anchored weeks (Amazon
-- DSP convention) and backfilled route_forecasts rows Monday -> preceding
-- Sunday (week_start - 1). But it explicitly deferred the forecast RPCs,
-- which still keyed weeks with Postgres' date_trunc('week', ...) = MONDAY.
-- Because the dashboard round-trips whatever week_start route_forecast_get
-- returns straight back into route_forecast_set, the forecast feature has
-- been a self-consistent "Monday island" ever since — while every other
-- surface (shifts, scheduling_settings, cover/pickup hour caps) is Sunday.
-- Net effect for the operator: forecast weeks are labeled one day off from
-- the schedule weeks they describe, and the rows 0276 shifted to Sunday
-- became invisible to the Monday-based reader.
--
-- This migration makes the forecast RPCs Sunday-anchored via
-- private.week_start_for(), so route_forecast_get now emits Sunday
-- week_starts and route_forecast_set stores them, matching the rest of the
-- app. It then re-homes any remaining Monday-keyed rows to the Sunday that
-- starts the same operational week (week_start - 1, the same rule 0276
-- used), dropping stale orphaned Sunday rows first so the shift can't hit
-- a PK collision. Idempotent: create-or-replace + a backfill that only
-- touches Monday-keyed rows (a no-op once none remain).

-- ── 1. route_forecast_set — store the Sunday-anchored week key ──
create or replace function public.route_forecast_set(p_week_start date, p_route_slots int)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.route_forecasts (dsp_id, week_start, route_slots)
  values (v_dsp, private.week_start_for(p_week_start), greatest(0, least(100000, coalesce(p_route_slots, 0))))
  on conflict (dsp_id, week_start) do update set route_slots = excluded.route_slots, updated_at = now();
end;
$$;
grant execute on function public.route_forecast_set(date, int) to authenticated;

-- ── 2. route_forecast_get — emit Sunday-anchored weeks (peak-input form, 0139) ──
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

  select private.week_start_for(max(s.date)) into v_last_wk
    from public.shifts s where s.dsp_id = v_dsp and s.status = 'scheduled';

  v_start := coalesce(v_last_wk + 7, private.week_start_for(current_date));

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

-- ── 3. schedule_forecast — Sunday-anchor the null-default week ──
--     (verbatim from 0202 with only the v_week default changed.)
create or replace function public.schedule_forecast(p_week_start date default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_week       date := coalesce(p_week_start, private.week_start_for(current_date));
  v_week_end   date := (v_week + interval '7 days')::date;
  v_m          jsonb;
  v_threshold  int;
  v_def_rate   numeric;
  v_def_mult   numeric;
  v_total      int;
  v_assigned   int;
  v_open       int;
  v_ot_drivers int;
  v_reg_hours   numeric;
  v_ot_hours    numeric;
  v_reg_cost    numeric;
  v_ot_base     numeric;   -- hours-worth-at-regular-rate portion of OT
  v_ot_premium  numeric;   -- premium-only portion (rate × (mult-1))
  v_have_rates  boolean;
begin
  if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(metadata->'scheduling', '{}'::jsonb) into v_m
    from public.dsps where id = v_dsp;
  v_threshold := coalesce((v_m->>'overtime_threshold_hours')::int, 40);
  v_def_rate  := (v_m->>'default_hourly_rate')::numeric;
  v_def_mult  := coalesce((v_m->>'default_overtime_multiplier')::numeric, 1.5);

  -- ── Coverage ─────────────────────────────────────────────────────────
  select
    count(*),
    count(*) filter (where driver_id is not null),
    count(*) filter (where driver_id is null)
  into v_total, v_assigned, v_open
  from public.shifts
  where dsp_id = v_dsp
    and date >= v_week
    and date <  v_week_end
    and status in ('scheduled','completed','late');

  -- ── Per-driver weekly hour buckets (used by OT count + cost calc) ───
  with per_driver as (
    select
      s.driver_id,
      coalesce(d.hourly_rate, v_def_rate)         as rate,
      coalesce(d.overtime_multiplier, v_def_mult) as mult,
      sum(coalesce(s.block_hours, 10))::numeric   as hours
    from public.shifts s
    join public.drivers d on d.id = s.driver_id
    where s.dsp_id = v_dsp
      and s.driver_id is not null
      and s.date >= v_week
      and s.date <  v_week_end
      and s.status in ('scheduled','completed','late')
    group by s.driver_id, d.hourly_rate, d.overtime_multiplier
  ),
  split as (
    select
      driver_id, rate, mult,
      least(hours, v_threshold)              as reg_hrs,
      greatest(hours - v_threshold, 0)::numeric as ot_hrs
    from per_driver
  )
  select
    count(*) filter (where ot_hrs > 0),
    coalesce(sum(reg_hrs), 0),
    coalesce(sum(ot_hrs),  0),
    coalesce(sum(case when rate is null then 0 else reg_hrs * rate end), 0),
    coalesce(sum(case when rate is null then 0 else ot_hrs  * rate end), 0),
    coalesce(sum(case when rate is null then 0 else ot_hrs  * rate * (mult - 1) end), 0),
    bool_or(rate is not null)
  into v_ot_drivers, v_reg_hours, v_ot_hours, v_reg_cost, v_ot_base, v_ot_premium, v_have_rates
  from split;

  return jsonb_build_object(
    'week_start', v_week,
    'week_end',   v_week_end - 1,
    'coverage', jsonb_build_object(
      'total_shifts',   coalesce(v_total, 0),
      'assigned_shifts',coalesce(v_assigned, 0),
      'open_shifts',    coalesce(v_open, 0),
      'pct',            case when coalesce(v_total, 0) = 0 then null
                             else round(v_assigned::numeric * 100.0 / v_total, 0) end
    ),
    'overtime', jsonb_build_object(
      'threshold_hours', v_threshold,
      'drivers_over',    coalesce(v_ot_drivers, 0),
      'ot_hours',        round(coalesce(v_ot_hours, 0), 1)
    ),
    'cost', jsonb_build_object(
      'have_rates',  coalesce(v_have_rates, false),
      'reg_hours',   round(coalesce(v_reg_hours, 0), 1),
      'ot_hours',    round(coalesce(v_ot_hours, 0), 1),
      'reg_cost',    round(coalesce(v_reg_cost, 0), 2),
      'ot_premium',  round(coalesce(v_ot_premium, 0), 2),
      -- Total = regular hours at rate + OT hours at rate × multiplier
      --       = reg_cost + (ot_base + ot_premium)
      'total_cost',  round(
        coalesce(v_reg_cost, 0) + coalesce(v_ot_base, 0) + coalesce(v_ot_premium, 0), 2)
    )
  );
end;
$$;
grant execute on function public.schedule_forecast(date) to authenticated;

-- ── 4. Backfill: re-home Monday-keyed route_forecasts rows to Sunday ──
-- Drop any orphaned pre-0276 Sunday row that a Monday row would collide
-- with (the Monday row is the newer, operator-visible value), then shift
-- all Monday-keyed rows back one day to the Sunday that starts the same
-- operational week — the same Monday->Sunday rule migration 0276 applied.
delete from public.route_forecasts s
 where extract(dow from s.week_start) = 0
   and exists (
     select 1 from public.route_forecasts m
     where m.dsp_id = s.dsp_id
       and extract(dow from m.week_start) = 1
       and m.week_start - 1 = s.week_start
   );

update public.route_forecasts
   set week_start = week_start - 1
 where extract(dow from week_start) = 1;

notify pgrst, 'reload schema';
