-- Migration 0469 · Per-tenant metering for the central Anthropic proxy.
--
-- WHY
-- ───
-- ai-proxy forwards requests to Anthropic on RouteReady's single central
-- ANTHROPIC_API_KEY. Before this it only checked that the caller held any
-- valid JWT — no app_users membership, no per-tenant quota, no spend cap.
-- A single paired box (or a leaked token) could drain the key unbounded.
-- This adds a per-DSP daily counter the edge function checks (and increments)
-- atomically before forwarding, plus best-effort token accounting for
-- observability.
--
-- The cap is per-DSP-per-day. Override a specific tenant by setting
--   dsps.metadata -> 'ai' ->> 'daily_request_cap'  (integer)
-- otherwise the default passed by the function applies.
--
-- Idempotent: create table if not exists / create or replace.

create table if not exists public.ai_usage_daily (
  dsp_id        uuid   not null references public.dsps(id) on delete cascade,
  usage_date    date   not null default current_date,
  requests      int    not null default 0,
  blocked       int    not null default 0,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (dsp_id, usage_date)
);

alter table public.ai_usage_daily enable row level security;

-- Tenant members may READ their own DSP's usage (for a future spend widget).
-- All WRITES happen through the security-definer RPCs below (service role),
-- so there is no write policy — direct writes are denied for everyone.
drop policy if exists "ai_usage_daily_tenant_select" on public.ai_usage_daily;
create policy "ai_usage_daily_tenant_select"
  on public.ai_usage_daily for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

-- Atomically record one proxied request and report whether the tenant is
-- still under its daily cap. Increments first, then compares, so a blocked
-- request stays blocked for the rest of the day (the counter is reset by the
-- date rollover in the primary key). Returns { allowed, count, cap }.
create or replace function private.ai_proxy_note_request(
  p_dsp_id uuid,
  p_default_cap int default 5000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cap   int;
  v_count int;
begin
  select coalesce(nullif(d.metadata -> 'ai' ->> 'daily_request_cap', '')::int, p_default_cap)
    into v_cap
  from public.dsps d
  where d.id = p_dsp_id;
  if v_cap is null then v_cap := p_default_cap; end if;

  insert into public.ai_usage_daily (dsp_id, usage_date, requests, updated_at)
  values (p_dsp_id, current_date, 1, now())
  on conflict (dsp_id, usage_date)
  do update set requests = ai_usage_daily.requests + 1,
                updated_at = now()
  returning ai_usage_daily.requests into v_count;

  if v_count > v_cap then
    update public.ai_usage_daily
       set blocked = blocked + 1, updated_at = now()
     where dsp_id = p_dsp_id and usage_date = current_date;
  end if;

  return jsonb_build_object('allowed', v_count <= v_cap, 'count', v_count, 'cap', v_cap);
end;
$$;

-- Best-effort token accounting for non-streaming responses. Never throws on
-- the hot path — the function calls this after a successful forward.
create or replace function private.ai_proxy_note_tokens(
  p_dsp_id uuid,
  p_input  bigint,
  p_output bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ai_usage_daily
     set input_tokens  = input_tokens  + greatest(coalesce(p_input, 0), 0),
         output_tokens = output_tokens + greatest(coalesce(p_output, 0), 0),
         updated_at    = now()
   where dsp_id = p_dsp_id and usage_date = current_date;
end;
$$;

revoke all on function private.ai_proxy_note_request(uuid, int)  from public, anon, authenticated;
revoke all on function private.ai_proxy_note_tokens(uuid, bigint, bigint) from public, anon, authenticated;

notify pgrst, 'reload schema';
