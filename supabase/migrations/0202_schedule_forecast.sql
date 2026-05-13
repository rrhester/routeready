-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0202 · schedule_forecast RPC
--
-- Returns a calm at-a-glance forecast for the current operating week:
-- projected coverage rate, count of drivers trending into overtime, and
-- estimated labor cost (regular + OT premium). All derived from data
-- that already lives in shifts / drivers / dsps.metadata.scheduling —
-- no new tables. Reads the per-DSP overtime threshold and pay rates
-- introduced in 0198 + 0199.
--
-- Week boundary: Monday-anchored, matching scheduling_settings.
-- Surface: Schedule view, behind an Insights-style toggle (calm by
-- default; one click reveals).
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.schedule_forecast(p_week_start date default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_week       date := coalesce(p_week_start, date_trunc('week', current_date)::date);
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

notify pgrst, 'reload schema';
