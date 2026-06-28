-- ───────────────────────────────────────────────────────────────────────
-- 0398 · ADP / HRIS sync via Finch (unified employment API)
--   public.finch_connections · one per DSP, access token encrypted at rest
--   public.finch_employees   · synced worker roster (staging), service-role only
--   public.finch_status()    · safe {connected, provider, …} for the browser
-- Modeled on 0367 (Google Calendar): the token table is service-role-only
-- (RLS on, no policies, grants revoked), and clients see status only through a
-- security-definer function. The edge functions (finch-oauth-callback /
-- finch-sync) reach these tables with the service-role key. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

-- ── Connection / token store ──
-- Lives in `public` so the edge functions can reach it via PostgREST with the
-- service-role key. Locked to service-role only: RLS ON with NO policies and
-- all grants revoked from anon/authenticated, so the browser can never read a
-- token. The service role bypasses RLS. Clients see status via finch_status().
create table if not exists public.finch_connections (
  dsp_id            uuid primary key references public.dsps(id) on delete cascade,
  provider_id       text,                       -- Finch payroll_provider_id, e.g. 'adp_workforce_now'
  provider_name     text,                       -- human label, e.g. 'ADP Workforce Now'
  finch_account_id  text,
  finch_company_id  text,
  -- AES-GCM ciphertext (base64) + iv (base64); the Finch access token is
  -- long-lived, so it is the only secret stored. Plaintext never persists.
  access_token_enc  text not null,
  access_token_iv   text not null,
  status            text not null default 'connected',  -- 'connected' | 'error' | 'disconnected'
  last_synced_at    timestamptz,
  last_sync_status  text,                        -- 'ok' | 'error'
  last_error        text,
  employee_count    integer not null default 0,
  connected_by      uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.finch_connections enable row level security;
revoke all on public.finch_connections from anon, authenticated;

-- ── Synced worker roster (staging) ──
-- Where finch-sync lands the ADP roster. Service-role only for now (the app
-- reads only the count via finch_status()); a future migration can add a
-- read policy + a mapping into the driver/onboarding tables.
create table if not exists public.finch_employees (
  dsp_id              uuid not null references public.dsps(id) on delete cascade,
  finch_individual_id text not null,
  first_name          text,
  last_name           text,
  email               text,
  department          text,
  manager_name        text,
  title               text,
  employment_status   text,                      -- 'active' | 'terminated' | etc.
  is_active           boolean,
  start_date          date,
  raw                 jsonb,                      -- full Finch payload for later mapping
  synced_at           timestamptz not null default now(),
  primary key (dsp_id, finch_individual_id)
);
alter table public.finch_employees enable row level security;
revoke all on public.finch_employees from anon, authenticated;
create index if not exists finch_employees_dsp_idx on public.finch_employees (dsp_id);

-- ── Client-facing status (security definer; returns only safe fields) ──
create or replace function public.finch_status()
returns table (
  connected      boolean,
  provider_id    text,
  provider_name  text,
  status         text,
  last_synced_at timestamptz,
  employee_count integer
)
language sql stable security definer set search_path = '' as $$
  select true, c.provider_id, c.provider_name, c.status, c.last_synced_at, c.employee_count
  from public.finch_connections c
  where c.dsp_id = private.current_dsp_id()
  union all
  select false, null, null, null, null, 0
  where not exists (
    select 1 from public.finch_connections c
    where c.dsp_id = private.current_dsp_id()
  )
  limit 1;
$$;
grant execute on function public.finch_status() to authenticated;
