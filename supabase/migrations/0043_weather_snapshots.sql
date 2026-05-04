-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0043 · Daily weather snapshots
--
-- One row per (dsp_id, date) capturing the dashboard weather card so we
-- can correlate weather with attendance / scorecard / OT later. The
-- dashboard upserts on every weather card load — idempotent, freshest
-- values win for the same day.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.weather_snapshots (
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  date            date        not null,
  high_temp_f     int,
  low_temp_f      int,
  precip_pct      int,
  peak_wind_mph   int,
  conditions      text,                    -- sunny / rain / snow / thunderstorm / cloudy / etc.
  alerts          jsonb       not null default '[]'::jsonb,
  source          text        not null default 'nws',
  captured_at     timestamptz not null default now(),
  primary key (dsp_id, date)
);

create index if not exists weather_snapshots_dsp_recent_idx
  on public.weather_snapshots (dsp_id, date desc);

alter table public.weather_snapshots enable row level security;

drop policy if exists "weather_snapshots_tenant_rw" on public.weather_snapshots;
create policy "weather_snapshots_tenant_rw"
  on public.weather_snapshots for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.weather_snapshots to authenticated;
