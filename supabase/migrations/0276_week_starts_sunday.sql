-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0276 · Schedule weeks start on Sunday (Amazon DSP convention)
--
-- Amazon DSPs run their week Sunday → Saturday. The dashboard had been
-- using Monday-anchored weeks (PG's date_trunc('week', d) default + a
-- JS startOfWeekMonday helper). This migration:
--
--   1. Redefines private.week_start_for(date) to return the Sunday
--      on-or-before the input — this is the canonical helper used by
--      get_week_settings, apply_cushion_to_week, set_okami_week_demand,
--      and other RPCs that look up a week's row.
--
--   2. Redefines private.cover_driver_week_hours(...) to use the
--      Sunday-anchored helper for its [week_start, week_end) range.
--      Without this, the OT calculator inside cover_shift_candidates
--      would split a driver's Sun+Sat shifts across two different
--      weeks (Sunday → week N under JS, week N-1 under SQL), under-
--      counting weekly hours and producing wrong OT premiums.
--
--   3. Backfills the two tables that persist a week_start key (the
--      composite PK in scheduling_settings, and route_forecasts) by
--      shifting any Monday-anchored rows back one day to the preceding
--      Sunday. Existing per-day data (okami_demand.date, shifts.date)
--      is unaffected — only the "week container" label changes.
--
-- Idempotent: create-or-replace for the functions; the backfill only
-- shifts rows whose week_start is a Monday, so re-running is a no-op.
--
-- Functions whose default-when-null branch still computes Monday via
-- inline date_trunc (route_forecast_set, schedule_forecast,
-- route_forecasts_after_schedule, route_forecast_set_peak) are not
-- touched here because the dashboard always passes a value — those
-- branches are dead in practice. They can be migrated in a follow-up.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.week_start_for(p_date date)
returns date
language sql
immutable
as $$
  -- extract(dow) is 0=Sun..6=Sat — subtract that many days to land on
  -- the Sunday on-or-before p_date.
  select (p_date - (extract(dow from p_date)::int))::date;
$$;


create or replace function private.cover_driver_week_hours(
  p_driver_id     uuid,
  p_date          date,
  p_exclude_shift uuid default null
) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(coalesce(s.block_hours, 10)), 0)::numeric
  from public.shifts s
  where s.driver_id = p_driver_id
    and (p_exclude_shift is null or s.id <> p_exclude_shift)
    and s.status in ('scheduled', 'completed', 'late')
    and s.date >= private.week_start_for(p_date)
    and s.date <  private.week_start_for(p_date) + 7;
$$;


-- ── Backfill: persisted week_start columns ────────────────────────────
-- Shift any Monday-anchored rows back to the preceding Sunday so the
-- new Sunday-based JS + week_start_for() find them at the same key.
-- Pre-migration data was uniformly Monday-anchored; post-shift it
-- becomes uniformly Sunday-anchored. No collisions with existing rows
-- because no Sunday-anchored rows could have existed yet.

update public.scheduling_settings
   set week_start = week_start - 1
 where extract(dow from week_start) = 1;  -- 1 = Monday

update public.route_forecasts
   set week_start = week_start - 1
 where extract(dow from week_start) = 1;
