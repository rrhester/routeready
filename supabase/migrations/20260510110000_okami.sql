-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510110000 · OKAMI capacity planning
-- The 13-week rolling capacity plan. Drives:
--   - Schedule shift counts (routes × cushion = shifts to schedule)
--   - Pipeline coverage projection (drivers needed vs roster + projected hires)
--   - Performance Management staffing-risk band
-- ─────────────────────────────────────────────────────────────────────────

create table public.okami_weeks (
  id            uuid          primary key default gen_random_uuid(),
  dsp_id        uuid          not null references public.dsps(id) on delete cascade,
  station_id    uuid          references public.stations(id) on delete cascade,    -- null = whole DSP
  iso_year      int           not null,
  iso_week      int           not null
                check (iso_week between 1 and 53),
  week_start    date          not null,
  routes_max    int           not null
                check (routes_max >= 0),
  daily_targets jsonb         not null default '{}'::jsonb,
                                          -- { mon: 35, tue: 38, wed: 38, thu: 40,
                                          --   fri: 38, sat: 28, sun: 18 }
  cushion_mode  text          not null default 'percent'
                check (cushion_mode in ('percent','count')),
  cushion_value numeric(5,2)  not null default 10
                check (cushion_value >= 0 and cushion_value <= 100),
  dpr           numeric(4,2)  not null default 2.0      -- drivers per route
                check (dpr > 0 and dpr <= 5),
  adw           numeric(4,2)  not null default 5.0      -- average days/wk per driver
                check (adw > 0 and adw <= 7),
  ot_hours      int           not null default 0
                check (ot_hours >= 0 and ot_hours <= 40),
  is_hve        boolean       not null default false,
  is_peak       boolean       not null default false,
  notes         text,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now(),
  updated_by    uuid          references public.app_users(id),

  constraint okami_weeks_unique
    unique (dsp_id, station_id, iso_year, iso_week)
);

-- Allow null station_id while still enforcing uniqueness (Postgres NULL ≠
-- NULL means the unique above would let multi-rows-with-null-station
-- through). Use a coalesce-based unique index for that case.
create unique index okami_weeks_unique_per_dsp_no_station
  on public.okami_weeks (dsp_id, iso_year, iso_week)
  where station_id is null;

create index okami_weeks_dsp_week_start_idx
  on public.okami_weeks (dsp_id, week_start);

create trigger trg_okami_weeks_updated_at
  before update on public.okami_weeks
  for each row execute function moddatetime(updated_at);

comment on table public.okami_weeks is
  '13-week rolling capacity plan, one row per (DSP, optional station, ISO week). ' ||
  'routes_max = highest day in the week (the OKAMI summary number). ' ||
  'daily_targets is the per-day breakdown for the next 3 weeks (editable in UI).';

alter table public.okami_weeks enable row level security;

create policy "okami_tenant_select"
  on public.okami_weeks for select
  using (dsp_id = private.current_dsp_id());

create policy "okami_ops_write"
  on public.okami_weeks for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update, delete on public.okami_weeks to authenticated;

-- ─── Pure compute: cushion shifts for a given route count ───────────────

create or replace function public.okami_shifts_needed(
  p_routes        int,
  p_cushion_mode  text,
  p_cushion_value numeric
)
returns int
language sql immutable
as $$
  select case
    when p_cushion_mode = 'count'
      then greatest(0, p_routes + coalesce(p_cushion_value, 0)::int)
    else
      greatest(0, ceil(p_routes * (1 + coalesce(p_cushion_value, 0) / 100.0))::int)
  end
$$;

comment on function public.okami_shifts_needed(int, text, numeric) is
  'Pure compute: routes × (1 + cushion%) for percent mode, or routes + cushion for count mode.';

-- ─── Cushion recommendation from attendance signal ──────────────────────
-- Reads RR_ATTENDANCE_LOG-equivalent (real attendance_events) and computes
-- a cushion suggestion bracketed by callout/no-show rate (push up) and
-- VTO rate (push down). Mirrors the JS recommendation engine in the mockup.

create or replace function public.okami_recommend_cushion(p_dsp uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_window_days        int := 30;
  v_total_scheduled    int;
  v_callouts_noshows   int;
  v_vtos               int;
  v_absence_rate       numeric;
  v_vto_rate           numeric;
  v_recommended        int;
  v_note               text := '';
begin
  -- Authorize: caller must belong to this DSP
  if private.current_dsp_id() <> p_dsp then
    raise exception 'okami_recommend_cushion: caller not in DSP %', p_dsp;
  end if;

  -- Total scheduled approximation: count of active drivers × ~22 working days
  select coalesce(sum(case when status = 'active' then 22 else 0 end), 0)
    into v_total_scheduled
    from public.drivers where dsp_id = p_dsp;

  if v_total_scheduled = 0 then
    return jsonb_build_object(
      'percent', 8,
      'note', 'No active roster — using DSP default 8%'
    );
  end if;

  select
    count(*) filter (where event_type in ('callout','noshow') and not exempt),
    count(*) filter (where event_type = 'vto')
   into v_callouts_noshows, v_vtos
   from public.attendance_events
  where dsp_id = p_dsp
    and event_date >= current_date - v_window_days;

  v_absence_rate := v_callouts_noshows::numeric / v_total_scheduled;
  v_vto_rate     := v_vtos::numeric / v_total_scheduled;

  -- Base recommendation: absence rate × 1.5 safety factor; floor 5%, ceiling 20%
  v_recommended := greatest(5, least(20, round(v_absence_rate * 100 * 1.5)::int));

  -- VTO push-down: if VTO rate > 4%, cushion is too high
  if v_vto_rate > 0.04 then
    declare excess int := round((v_vto_rate - 0.04) * 100 * 1.5)::int;
    begin
      v_recommended := greatest(5, v_recommended - excess);
      v_note := v_vtos || ' VTO event(s) (' || round(v_vto_rate * 100, 1)
              || '%) suggests cushion is too high — lowered ' || excess || '%';
    end;
  elsif v_vto_rate > 0 then
    v_note := v_vtos || ' VTO event(s) (' || round(v_vto_rate * 100, 1)
            || '%) within healthy band';
  end if;

  return jsonb_build_object(
    'percent', v_recommended,
    'window_days', v_window_days,
    'absences', v_callouts_noshows,
    'vtos', v_vtos,
    'total_scheduled', v_total_scheduled,
    'absence_rate', v_absence_rate,
    'vto_rate', v_vto_rate,
    'note', case when v_note = '' then v_callouts_noshows || ' callout/no-show over ' || v_total_scheduled || ' shifts last ' || v_window_days || 'd → ' || v_recommended || '%'
                 else v_callouts_noshows || ' callout/no-show + ' || v_note end
  );
end $$;

revoke execute on function public.okami_recommend_cushion(uuid) from public, anon;
grant execute on function public.okami_recommend_cushion(uuid) to authenticated;

comment on function public.okami_recommend_cushion(uuid) is
  'Computes a cushion % recommendation from attendance signal. ' ||
  'Push UP from callouts/no-shows; push DOWN from high VTO rate.';

-- ─── Demand vs supply view ──────────────────────────────────────────────
-- Per (DSP, week_start), materialized-style view of demand and current
-- coverage. Drives the Pipeline Coverage panel and the schedule banner.

create or replace view public.weekly_demand_vs_supply
with (security_invoker = true)
as
select
  o.dsp_id,
  o.station_id,
  o.iso_year,
  o.iso_week,
  o.week_start,
  o.routes_max,
  o.cushion_mode,
  o.cushion_value,
  public.okami_shifts_needed(o.routes_max, o.cushion_mode, o.cushion_value)
    as shifts_to_schedule,
  ceil(o.routes_max * o.dpr)::int                              as drivers_needed,
  (select count(*) from public.drivers d
    where d.dsp_id = o.dsp_id and d.status = 'active')         as drivers_active,
  o.is_hve,
  o.is_peak
from public.okami_weeks o;

comment on view public.weekly_demand_vs_supply is
  'Per-week demand math for the dashboard. drivers_needed = routes × DPR; ' ||
  'shifts_to_schedule = cushion math; drivers_active = current roster.';
