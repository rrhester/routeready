-- Migration 0473 · Product usage analytics (adoption / activation signal).
--
-- WHY
-- ───
-- The 2026-07 audit flagged that RouteReady has error telemetry but no product
-- analytics — no way to answer "is this customer actually using it?", which is
-- the earliest churn signal once you have paying tenants. This adds a minimal,
-- privacy-safe event log: event name + tenant + user + timestamp + small
-- non-PII props (e.g. role). NEVER put record contents / PII in props.
--
-- Append-only for clients (no update/delete policy). Reads are for the vendor
-- (platform admin, across tenants) and a tenant's own staff (their DSP only).
--
-- Idempotent.

create table if not exists public.usage_events (
  id          bigint      generated always as identity primary key,
  dsp_id      uuid        references public.dsps(id) on delete cascade,
  user_id     uuid,       -- auth.uid(); no FK to auth.users (kept light)
  event       text        not null,
  props       jsonb       not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists usage_events_dsp_time_idx   on public.usage_events (dsp_id, occurred_at desc);
create index if not exists usage_events_event_time_idx on public.usage_events (event, occurred_at desc);

alter table public.usage_events enable row level security;

-- INSERT: any authenticated user, but dsp_id/user_id must be null or match the
-- caller — no cross-tenant or cross-user spoofing (mirrors client_errors, 0445).
drop policy if exists "usage_events_insert_self" on public.usage_events;
create policy "usage_events_insert_self"
  on public.usage_events for insert
  to authenticated
  with check (
    (dsp_id  is null or dsp_id  = private.current_dsp_id())
    and (user_id is null or user_id = auth.uid())
  );

-- SELECT: platform admins see everything (product adoption across tenants);
-- a tenant's staff see only their own DSP's events; drivers/non-staff see none.
drop policy if exists "usage_events_select" on public.usage_events;
create policy "usage_events_select"
  on public.usage_events for select
  to authenticated
  using (
    private.is_platform_admin()
    or (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  );

-- No UPDATE/DELETE policies → immutable to clients. The service role prunes old
-- rows out-of-band (a retention job is a later add).
grant select, insert on public.usage_events to authenticated;

notify pgrst, 'reload schema';
