-- Migration 0303 · Per-DSP reward provider integrations (OAuth)
--
-- Until now the Rewards system used a single global Tremendous API
-- key (REWARD_PROVIDER + TREMENDOUS_API_KEY env vars).  That model
-- makes RouteReady the merchant of record — every reward comes out of
-- one Tremendous balance funded by one bank account, and DSPs are
-- billed separately.
--
-- This migration moves to the per-DSP model that matches our business
-- model: each DSP grants RouteReady OAuth access to *their* Tremendous
-- account.  Rewards come out of *their* balance, funded by *their*
-- bank.  RouteReady never touches the money — we're just the UI.
--
-- Tables added:
--   dsp_reward_integrations — one row per (dsp_id, provider).  Stores
--     OAuth tokens, refresh tokens, expiry, funding source id, and
--     the per-DSP webhook signing secret.  Tokens are NEVER exposed
--     to authenticated clients — the table has no SELECT grant to
--     authenticated.  Only edge functions (service role) read tokens.
--   oauth_state_nonces — short-lived CSRF tokens used during the
--     authorize → callback handshake.  10-minute TTL.  Service-role
--     only.
--
-- RPCs added:
--   dsp_reward_integration_status() — safe public view (no tokens)
--     the dashboard polls to render "Connected / Disconnected".
--   dsp_reward_disconnect() — dispatcher disconnects.  Zeros out
--     tokens but leaves the row as an audit trail of "was connected
--     once".
--
-- Re-runnable; every DDL is guarded.


-- ── 1. dsp_reward_integrations ──────────────────────────────────────
create table if not exists public.dsp_reward_integrations (
  id                   uuid primary key default gen_random_uuid(),
  dsp_id               uuid not null references public.dsps(id) on delete cascade,
  -- Always 'tremendous' today; widened when we add Tango / Giftbit.
  provider             text not null,

  -- OAuth credentials.  Nullable so we can keep the row around as an
  -- audit trail after a disconnect (zeros out the tokens).
  access_token         text,
  refresh_token        text,
  token_expires_at     timestamptz,
  -- The provider's id for the user / account that authorised us.
  -- Tremendous returns a team_id / account_id on the token exchange
  -- — we store whichever stable identifier they give us.
  provider_account_id  text,
  -- Funding source id chosen by the DSP inside Tremendous (or auto-
  -- selected from their first funding source on connect).
  funding_source_id    text,
  -- Per-DSP webhook signing secret (Tremendous returns this when we
  -- POST /webhooks during the callback flow).
  webhook_secret       text,
  webhook_id           text,

  -- Lifecycle stamps.
  connected_at         timestamptz,
  disconnected_at      timestamptz,
  connected_by         uuid references auth.users(id) on delete set null,
  last_used_at         timestamptz,

  -- Last error from the provider (refresh failure, revoked token,
  -- expired credentials).  Surfaced to the dispatcher so a broken
  -- connection is visible without digging through logs.
  last_error           text,
  last_error_at        timestamptz,

  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint dsp_reward_integrations_unique unique (dsp_id, provider)
);

create index if not exists dsp_reward_integrations_dsp_idx
  on public.dsp_reward_integrations (dsp_id);

-- ── updated_at trigger ─────────────────────────────────────────────
create or replace function private.dsp_reward_integrations_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists dsp_reward_integrations_touch on public.dsp_reward_integrations;
create trigger dsp_reward_integrations_touch
  before update on public.dsp_reward_integrations
  for each row execute function private.dsp_reward_integrations_touch();


-- ── 2. RLS · service-role-only ──────────────────────────────────────
alter table public.dsp_reward_integrations enable row level security;

-- No grants to anon/authenticated.  Every dispatcher-facing read goes
-- through dsp_reward_integration_status() below, which never returns
-- secret material.  Service role retains full access via the role
-- bypass in Postgres.
revoke all on public.dsp_reward_integrations from public, anon, authenticated;
grant  all on public.dsp_reward_integrations to service_role;


-- ── 3. oauth_state_nonces ───────────────────────────────────────────
-- Short-lived nonces for CSRF protection on the OAuth handshake.
-- Inserted by tremendous-oauth-start (service role), deleted by
-- tremendous-oauth-callback after validation.  Anything older than 10
-- minutes is junk and can be GC'd.
create table if not exists public.oauth_state_nonces (
  state         text primary key,
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,
  -- 'tremendous' for now.
  provider      text not null,
  return_url    text,
  expires_at    timestamptz not null default (now() + interval '10 minutes'),
  created_at    timestamptz not null default now()
);
create index if not exists oauth_state_nonces_expires_idx
  on public.oauth_state_nonces (expires_at);

alter table public.oauth_state_nonces enable row level security;
revoke all on public.oauth_state_nonces from public, anon, authenticated;
grant  all on public.oauth_state_nonces to service_role;


-- ── 4. dsp_reward_integration_status() ──────────────────────────────
-- Safe view the dashboard polls to render the Rewards setup card.
-- Returns the calling DSP's integration status WITHOUT exposing any
-- token material.  Anyone (dispatcher or higher) can read their own
-- DSP's status — RLS-equivalent via private.is_staff.
create or replace function public.dsp_reward_integration_status()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.dsp_reward_integrations;
begin
  if v_dsp is null then return jsonb_build_object('connected', false); end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_row
  from public.dsp_reward_integrations
  where dsp_id = v_dsp and provider = 'tremendous'
  limit 1;

  if v_row.id is null then
    return jsonb_build_object('connected', false, 'provider', 'tremendous');
  end if;

  return jsonb_build_object(
    'connected',            v_row.access_token is not null,
    'provider',             v_row.provider,
    'provider_account_id',  v_row.provider_account_id,
    'funding_source_id',    v_row.funding_source_id,
    'connected_at',         v_row.connected_at,
    'disconnected_at',      v_row.disconnected_at,
    'last_used_at',         v_row.last_used_at,
    'last_error',           v_row.last_error,
    'last_error_at',        v_row.last_error_at,
    'webhook_registered',   v_row.webhook_id is not null
  );
end;
$$;
grant execute on function public.dsp_reward_integration_status() to authenticated;


-- ── 5. dsp_reward_disconnect() ──────────────────────────────────────
-- Dispatcher hit Disconnect.  Zeros out the tokens but keeps the row
-- so we have an audit trail.  Doesn't deregister the webhook on
-- Tremendous's side from here — that's the edge function's job
-- (calls Tremendous DELETE /webhooks/<id> with the still-valid
-- access_token before this RPC clears it).
create or replace function public.dsp_reward_disconnect()
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then return false; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.dsp_reward_integrations
     set access_token     = null,
         refresh_token    = null,
         token_expires_at = null,
         webhook_id       = null,
         webhook_secret   = null,
         disconnected_at  = now(),
         last_error       = null,
         last_error_at    = null
   where dsp_id = v_dsp and provider = 'tremendous';

  return true;
end;
$$;
grant execute on function public.dsp_reward_disconnect() to authenticated;


-- ── 6. Stamp last_used_at after a successful send ───────────────────
-- send-driver-reward calls this via service role after a successful
-- provider response, so dispatchers can see "last used" on the setup
-- card.
create or replace function public.dsp_reward_integration_mark_used(p_dsp_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  update public.dsp_reward_integrations
     set last_used_at = now(),
         last_error   = null,
         last_error_at = null
   where dsp_id = p_dsp_id and provider = 'tremendous';
$$;
revoke all on function public.dsp_reward_integration_mark_used(uuid) from public, anon, authenticated;
grant execute on function public.dsp_reward_integration_mark_used(uuid) to service_role;


notify pgrst, 'reload schema';
