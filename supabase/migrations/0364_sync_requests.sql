-- On-demand "Sync to portal" requests (ROADMAP #4).
--
-- The dashboard's "Sync to portal" button inserts a pending row here; the
-- DSP's always-on sync box polls for pending requests, atomically claims one,
-- runs all enabled crawl tasks now, then marks it done/error with a short
-- result summary the dashboard can surface ("synced 42 rows just now").
--
-- RLS scopes every row to the owning DSP via private.current_dsp_id(), so the
-- dashboard (operator) and the box (signed in as the DSP via the pairing
-- session) only ever see/insert/update that DSP's requests. Idempotent.

create table if not exists public.sync_requests (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null default private.current_dsp_id()
                  references public.dsps(id) on delete cascade,
  status       text not null default 'pending',   -- pending|claimed|complete|partial|error
  requested_by uuid,                               -- auth.uid() of the operator who clicked
  claimed_by   text,                               -- desktop_agents.agent_id that took it
  claimed_at   timestamptz,
  done_at      timestamptz,
  result_rows  integer,
  result_tasks integer,
  error        text,
  created_at   timestamptz not null default now()
);

-- The box's hot path: "any pending work for my DSP?" Keep that lookup cheap.
create index if not exists sync_requests_dsp_status_idx
  on public.sync_requests (dsp_id, status, created_at);

alter table public.sync_requests enable row level security;

-- DSP-scoped access for authenticated users (the dashboard AND the box, which
-- is signed in as the DSP). insert: operator queues a request. update: the box
-- claims it and writes the result. Wrapped in do/exception so re-running is safe.
do $$ begin
  create policy sync_requests_select on public.sync_requests
    for select to authenticated using (dsp_id = private.current_dsp_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy sync_requests_insert on public.sync_requests
    for insert to authenticated with check (dsp_id = private.current_dsp_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy sync_requests_update on public.sync_requests
    for update to authenticated
    using (dsp_id = private.current_dsp_id())
    with check (dsp_id = private.current_dsp_id());
exception when duplicate_object then null; end $$;
