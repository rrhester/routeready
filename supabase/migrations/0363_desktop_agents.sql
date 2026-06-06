-- Desktop agent health / heartbeat (ROADMAP #3).
--
-- One row per installed "sync box". The desktop app (which signs in as the
-- DSP via the pairing flow) upserts its heartbeat, portal-session health, and
-- last-run summary here; the dashboard reads it to show "is my box alive and
-- pulling?" and to alert when one goes dark / a pull fails / the portal
-- session expired. RLS scopes every row to the owning DSP via
-- private.current_dsp_id(), so the box and the dashboard (same identity) both
-- see only that DSP's boxes.

create table if not exists public.desktop_agents (
  agent_id             text primary key,             -- stable per-install id
  dsp_id               uuid not null default private.current_dsp_id()
                          references public.dsps(id) on delete cascade,
  label                text,                          -- e.g. hostname
  app_version          text,
  last_heartbeat_at    timestamptz,
  portal_session_ok    boolean,
  last_portal_check_at timestamptz,
  last_run_at          timestamptz,
  last_run_task        text,
  last_run_status      text,                          -- complete|partial|error|blocked
  last_run_error       text,
  last_run_rows        integer,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists desktop_agents_dsp_id_idx on public.desktop_agents (dsp_id);

alter table public.desktop_agents enable row level security;

-- DSP-scoped access for authenticated users (the dashboard AND the box, which
-- is signed in as the DSP). Wrapped in do/exception so re-running is safe.
do $$ begin
  create policy desktop_agents_select on public.desktop_agents
    for select to authenticated using (dsp_id = private.current_dsp_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy desktop_agents_insert on public.desktop_agents
    for insert to authenticated with check (dsp_id = private.current_dsp_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy desktop_agents_update on public.desktop_agents
    for update to authenticated
    using (dsp_id = private.current_dsp_id())
    with check (dsp_id = private.current_dsp_id());
exception when duplicate_object then null; end $$;
