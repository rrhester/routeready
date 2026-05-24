-- 0325_driver_affinity.sql
--
-- Workforce Optimization Engine — Step 3: persisted driver affinity.
--
-- Precomputes the per-driver, per-weekday affinity score that the
-- existing in-browser _rrComputeWeekdayAffinity() builds on every
-- Smart Fill run. Persisting it server-side lets us:
--   1. Surface "Ryan worked Wed 10/12 weeks" in the driver record UI
--      without computing on render.
--   2. Skip recomputation on every Smart Fill click.
--   3. Feed it into the CP-SAT solver later (it needs the values as
--      a precomputed input — recomputing inside the solver is wrong).
--
-- Algorithm matches _rrComputeWeekdayAffinity exactly so the persisted
-- values and the legacy in-app calculation agree byte-for-byte:
--
--   affinity[dow] = min(N, distinct_dates_in_dow) / N * 100  (0-100 int)
--
-- Window N defaults to 12 weeks but is configurable per call.
--
-- Idempotent.

-- ── 1. Table ──────────────────────────────────────────────────────
create table if not exists public.driver_affinity (
  driver_id      uuid primary key references public.drivers(id) on delete cascade,
  dsp_id         uuid not null references public.dsps(id) on delete cascade,
  -- 7 integers in [0,100]: Sun=0, Mon=1, ... Sat=6.
  dow_affinity   integer[] not null default '{0,0,0,0,0,0,0}',
  -- Average start minute on each DOW (0..1439), null if no signal.
  dow_start_min  integer[] not null default '{NULL,NULL,NULL,NULL,NULL,NULL,NULL}',
  -- Most-recent consecutive weeks where the DOW pattern hasn't
  -- changed. "Pattern" = the set of DOWs the driver worked that week.
  pattern_runlen integer not null default 0,
  -- Total shifts inside the window that fed this row (signal strength).
  sample_size    integer not null default 0,
  window_weeks   integer not null default 12,
  computed_at    timestamptz not null default now()
);
create index if not exists idx_driver_affinity_dsp on public.driver_affinity (dsp_id);
create index if not exists idx_driver_affinity_computed on public.driver_affinity (computed_at);


-- ── 2. compute_driver_affinity (private) ───────────────────────────
-- Recompute a single driver. Idempotent (UPSERT).
create or replace function private.compute_driver_affinity(
  p_driver_id     uuid,
  p_window_weeks  integer default 12
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp            uuid;
  v_today          date := current_date;
  v_window_start   date;
  v_dow_affinity   integer[] := array[0,0,0,0,0,0,0];
  v_dow_start_min  integer[] := array[null,null,null,null,null,null,null];
  v_sample_size    integer   := 0;
  v_runlen         integer   := 0;
  v_rec            record;
begin
  if p_window_weeks is null or p_window_weeks < 1 then
    p_window_weeks := 12;
  end if;
  if p_window_weeks > 26 then p_window_weeks := 26; end if;

  select dsp_id into v_dsp from public.drivers where id = p_driver_id;
  if v_dsp is null then return; end if;

  v_window_start := v_today - (p_window_weeks * 7);

  -- Per-DOW affinity (matches _rrComputeWeekdayAffinity).
  for v_rec in
    select extract(dow from s.date)::integer as dow,
           count(distinct s.date) as worked_dates,
           round(avg(extract(hour from s.starts_at) * 60
                   + extract(minute from s.starts_at)))::integer as start_min
      from public.shifts s
     where s.driver_id = p_driver_id
       and s.shift_kind = 'regular'
       and s.date >= v_window_start
       and s.date <  v_today
     group by extract(dow from s.date)::integer
  loop
    v_dow_affinity[v_rec.dow + 1] :=
      round(least(p_window_weeks, v_rec.worked_dates)::numeric / p_window_weeks * 100);
    v_dow_start_min[v_rec.dow + 1] := v_rec.start_min;
  end loop;

  -- Sample size: total shifts in the window.
  select count(*) into v_sample_size
    from public.shifts s
   where s.driver_id = p_driver_id
     and s.shift_kind = 'regular'
     and s.date >= v_window_start
     and s.date <  v_today;

  -- Pattern runlen: walk back week-by-week from the most recent
  -- complete week. Stop counting as soon as the pattern changes.
  -- "Pattern" = the sorted distinct DOWs worked that week.
  with weeks as (
    select w as wk_offset,
           v_today - (((w + 1) * 7))::integer as week_start
      from generate_series(0, p_window_weeks - 1) as w
  ),
  per_week as (
    select wk.wk_offset,
           coalesce(
             (select array_agg(distinct extract(dow from s.date)::integer order by 1)
                from public.shifts s
               where s.driver_id = p_driver_id
                 and s.shift_kind = 'regular'
                 and s.date >= wk.week_start
                 and s.date <  wk.week_start + 7),
             '{}'::integer[]
           ) as pattern
      from weeks wk
  ),
  base as (select pattern from per_week where wk_offset = 0),
  diffs as (
    select min(p.wk_offset) as first_diff
      from per_week p
     cross join base b
     where p.wk_offset > 0
       and p.pattern is distinct from b.pattern
  )
  select coalesce((select first_diff from diffs), p_window_weeks)
    into v_runlen;

  insert into public.driver_affinity (
    driver_id, dsp_id, dow_affinity, dow_start_min,
    pattern_runlen, sample_size, window_weeks, computed_at
  ) values (
    p_driver_id, v_dsp, v_dow_affinity, v_dow_start_min,
    v_runlen, v_sample_size, p_window_weeks, now()
  )
  on conflict (driver_id) do update set
    dsp_id        = excluded.dsp_id,
    dow_affinity  = excluded.dow_affinity,
    dow_start_min = excluded.dow_start_min,
    pattern_runlen = excluded.pattern_runlen,
    sample_size   = excluded.sample_size,
    window_weeks  = excluded.window_weeks,
    computed_at   = excluded.computed_at;
end;
$$;


-- ── 3. recompute_driver_affinity (public RPC) ─────────────────────
-- One-driver refresh, callable from the dashboard.
create or replace function public.recompute_driver_affinity(
  p_driver_id     uuid,
  p_window_weeks  integer default 12
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv_dsp uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select dsp_id into v_drv_dsp from public.drivers where id = p_driver_id;
  if v_drv_dsp is null or v_drv_dsp <> v_dsp then
    raise exception 'driver_not_found';
  end if;
  perform private.compute_driver_affinity(p_driver_id, p_window_weeks);
end;
$$;
grant execute on function public.recompute_driver_affinity(uuid, integer) to authenticated;


-- ── 4. recompute_all_driver_affinity (public RPC) ─────────────────
-- Bulk refresh for the current DSP. Intended targets:
--   • Nightly via pg_cron or a Vercel cron job.
--   • Operator on demand from the Smart Fill rules popover.
--   • Edge function after a bulk shift import.
-- Returns the count of drivers refreshed.
create or replace function public.recompute_all_driver_affinity(
  p_window_weeks  integer default 12
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_count integer := 0;
  v_drv record;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  for v_drv in
    select id from public.drivers
     where dsp_id = v_dsp
       and status in ('active','onboarding')
  loop
    perform private.compute_driver_affinity(v_drv.id, p_window_weeks);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
grant execute on function public.recompute_all_driver_affinity(integer) to authenticated;


-- ── 5. RLS · DSP-scoped reads ─────────────────────────────────────
alter table public.driver_affinity enable row level security;
drop policy if exists driver_affinity_dsp_read on public.driver_affinity;
create policy driver_affinity_dsp_read on public.driver_affinity
  for select using (dsp_id = private.current_dsp_id());


-- ── 6. Trigger · keep affinity fresh on shift writes ──────────────
-- When a shift's driver_id changes (assigned / unassigned), enqueue
-- a refresh for the affected driver(s). Best-effort — wrapped so the
-- shift write isn't blocked by an affinity recompute.
create or replace function private.tg_shifts_refresh_affinity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' and NEW.driver_id is not null then
    perform private.compute_driver_affinity(NEW.driver_id);
  elsif TG_OP = 'UPDATE' then
    if NEW.driver_id is distinct from OLD.driver_id then
      if NEW.driver_id is not null then
        perform private.compute_driver_affinity(NEW.driver_id);
      end if;
      if OLD.driver_id is not null then
        perform private.compute_driver_affinity(OLD.driver_id);
      end if;
    end if;
  elsif TG_OP = 'DELETE' and OLD.driver_id is not null then
    perform private.compute_driver_affinity(OLD.driver_id);
  end if;
  return coalesce(NEW, OLD);
exception when others then
  -- Never fail a shift write because affinity recompute hiccupped.
  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists trg_shifts_refresh_affinity on public.shifts;
create trigger trg_shifts_refresh_affinity
  after insert or update or delete on public.shifts
  for each row execute function private.tg_shifts_refresh_affinity();


notify pgrst, 'reload schema';
