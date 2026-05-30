-- ── Flex Capacity snapshots (optional cache) ────────────────────────────────
--
-- The Flex Capacity Engine is cheap to compute on demand in the edge function,
-- so this table is OPTIONAL — it exists so the KPI strip can read a recent
-- result without a round-trip to recompute, and so we can chart capacity over
-- time. Each row is one computed FlexResult for a DSP-week.
--
-- Additive and idempotent: safe to run / re-run. No existing objects touched.

create table if not exists public.flex_capacity_snapshots (
  id              uuid        primary key default gen_random_uuid(),
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  week_start      date        not null,
  -- Headline numbers (denormalized from the FlexResult.kpi for fast reads).
  current_routes          int     not null default 0,
  comfortable_capacity    int     not null default 0,
  stretch_capacity        int     not null default 0,
  maximum_capacity        int     not null default 0,
  comfortable_available   int     not null default 0,
  stretch_available       int     not null default 0,
  maximum_available       int     not null default 0,
  status                  text    not null default 'green',
  -- Full engine output (FlexResult) for the deep-dive / charts.
  result          jsonb       not null default '{}'::jsonb,
  computed_at     timestamptz not null default now(),
  -- One current snapshot per DSP-week (upsert on recompute).
  unique (dsp_id, week_start)
);

create index if not exists flex_capacity_snapshots_dsp_week_idx
  on public.flex_capacity_snapshots (dsp_id, week_start);

alter table public.flex_capacity_snapshots enable row level security;

-- Read: any member of the DSP. Writes happen via the edge function using the
-- service role (which bypasses RLS), so no write policy is needed here.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename  = 'flex_capacity_snapshots'
       and policyname = 'flex_capacity_snapshots_select_same_dsp'
  ) then
    create policy flex_capacity_snapshots_select_same_dsp
      on public.flex_capacity_snapshots
      for select
      using (
        dsp_id in (
          select au.dsp_id from public.app_users au where au.id = auth.uid()
        )
      );
  end if;
end $$;
