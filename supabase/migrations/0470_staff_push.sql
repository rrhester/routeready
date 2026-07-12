-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0470 · Staff (dispatcher) Web Push
--
-- Lets a driver's direct call ring a dispatcher whose dashboard is CLOSED.
-- Mirrors driver push (migration 0056) but keyed to app_users via auth.uid()
-- instead of a driver token. REUSES the same VAPID keys/secrets as driver
-- push — no new secrets required.
--
-- Surface:
--   driver_push_vapid_key()                              → reused for the public key
--   staff_push_register(endpoint, p256dh, auth, ua)      → upsert the caller's subscription
--   staff_push_unregister(endpoint)                      → delete on sign-out
--   (delivery: the send-staff-push edge function fans out to a DSP's staff)
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Table ──
create table if not exists public.staff_push_subscriptions (
  endpoint       text primary key,
  user_id        uuid not null references public.app_users(id) on delete cascade,
  dsp_id         uuid not null references public.dsps(id)      on delete cascade,
  p256dh         text not null,
  auth           text not null,
  user_agent     text,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz not null default now(),
  last_failed_at timestamptz,
  failure_count  int not null default 0
);
create index if not exists staff_push_subs_dsp_idx  on public.staff_push_subscriptions(dsp_id);
create index if not exists staff_push_subs_user_idx on public.staff_push_subscriptions(user_id);

alter table public.staff_push_subscriptions enable row level security;

drop policy if exists "staff_push_subs_tenant_r" on public.staff_push_subscriptions;
create policy "staff_push_subs_tenant_r"
  on public.staff_push_subscriptions for select
  using (dsp_id = private.current_dsp_id());

grant select on public.staff_push_subscriptions to authenticated;


-- ── 2. staff_push_register ──
-- Staff are real Supabase auth users, so identity comes from auth.uid()
-- (not a driver token). The DSP is derived from the caller's session.
create or replace function public.staff_push_register(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_dsp uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;
  v_dsp := private.current_dsp_id();
  if v_dsp is null then
    raise exception 'no_dsp' using errcode = 'P0001';
  end if;
  if p_endpoint is null or p_endpoint = ''
     or p_p256dh is null or p_p256dh = ''
     or p_auth is null or p_auth = '' then
    raise exception 'invalid_subscription' using errcode = 'P0001';
  end if;

  insert into public.staff_push_subscriptions
    (endpoint, user_id, dsp_id, p256dh, auth, user_agent)
  values
    (p_endpoint, v_uid, v_dsp, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update set
    user_id        = excluded.user_id,
    dsp_id         = excluded.dsp_id,
    p256dh         = excluded.p256dh,
    auth           = excluded.auth,
    user_agent     = coalesce(excluded.user_agent, public.staff_push_subscriptions.user_agent),
    last_used_at   = now(),
    last_failed_at = null,
    failure_count  = 0;
end;
$$;
grant execute on function public.staff_push_register(text, text, text, text) to authenticated;


-- ── 3. staff_push_unregister ──
create or replace function public.staff_push_unregister(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.staff_push_subscriptions
  where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;
grant execute on function public.staff_push_unregister(text) to authenticated;
