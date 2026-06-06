-- Central crawl-task definitions (admin-managed). Phase 1 of "RouteReady
-- configures the crawl; the DSP just gets the data."
--
-- Today crawl tasks live on each box (desktop app local files). This moves
-- the DEFINITIONS into RouteReady so platform_admin (support@gorouteready.com)
-- sets each DSP's goal/URL/schedule centrally, and the DSP's box fetches +
-- runs its assigned task. DSP customers can READ their own task (so the box,
-- which signs in as the DSP, can fetch it) but can NOT create/edit/delete —
-- only platform_admin can write. This keeps the crawl config (goal prompts,
-- targets) under RouteReady's control, not the customer's.

create table if not exists public.crawl_tasks (
  id                  uuid primary key default gen_random_uuid(),
  dsp_id              uuid not null references public.dsps(id) on delete cascade,
  name                text not null,
  goal                text not null,            -- plain-English instructions for the agent
  start_url           text not null,            -- the portal page to crawl
  enabled             boolean not null default true,
  -- schedule: daily clock times (HH:MM, box-local) take precedence; else interval
  daily_times         text[] not null default '{}',
  interval_minutes    integer not null default 60,
  upload_to_routeready boolean not null default true,
  visible_browser     boolean not null default false,
  model               text,                     -- optional per-task model override
  effort              text,                     -- optional effort override
  created_by          uuid,                     -- auth.uid() of the admin who created it
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists crawl_tasks_dsp_id_idx on public.crawl_tasks (dsp_id);

alter table public.crawl_tasks enable row level security;

-- READ: the owning DSP (and its box, which authenticates as the DSP) can read
-- its own tasks; platform_admin can read every DSP's tasks.
do $$ begin
  create policy crawl_tasks_select on public.crawl_tasks
    for select to authenticated
    using (dsp_id = private.current_dsp_id() or private.is_platform_admin());
exception when duplicate_object then null; end $$;

-- WRITE: platform_admin only. DSP customers can never create/edit/delete.
do $$ begin
  create policy crawl_tasks_insert on public.crawl_tasks
    for insert to authenticated with check (private.is_platform_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy crawl_tasks_update on public.crawl_tasks
    for update to authenticated
    using (private.is_platform_admin())
    with check (private.is_platform_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy crawl_tasks_delete on public.crawl_tasks
    for delete to authenticated
    using (private.is_platform_admin());
exception when duplicate_object then null; end $$;
