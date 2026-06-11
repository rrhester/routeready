-- Client error telemetry · captures dashboard JS errors so production
-- incidents are visible without waiting for an operator report.
-- Written by the rr-client-errors hook in dashboard/live.js.
--
-- Reading: query from the Supabase SQL editor (no client SELECT
-- policy on purpose — telemetry is write-only from the app):
--   select created_at, page, message, source
--   from public.client_errors order by created_at desc limit 50;

create table if not exists public.client_errors (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  dsp_id      uuid,
  user_id     uuid,
  page        text,
  message     text not null,
  stack       text,
  source      text,          -- 'onerror' | 'unhandledrejection' | manual
  user_agent  text,
  app_version text           -- the ?v= cache-bust token (deploy commit)
);

create index if not exists client_errors_created_idx
  on public.client_errors (created_at desc);

alter table public.client_errors enable row level security;

-- Signed-in operators may INSERT their own error reports. No SELECT /
-- UPDATE / DELETE policies: the table is read via the SQL editor or
-- service role only.
do $$ begin
  create policy client_errors_insert_authed
    on public.client_errors
    for insert to authenticated
    with check (true);
exception when duplicate_object then null; end $$;
