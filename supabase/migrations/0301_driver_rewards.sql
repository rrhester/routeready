-- Migration 0301 · RouteReady Rewards
--
-- Stands up the data layer for the Rewards system — dispatchers send
-- a digital reward (Amazon / Visa / Walmart / gas / restaurant /
-- general) to a driver from the Recognition page; the driver claims it
-- from their app.  This migration owns the table + RPCs.  Provider
-- abstraction (Tremendous + mock) lives in supabase/functions/_shared/
-- rewards/ and is invoked by the send-driver-reward edge function.
--
-- Lifecycle:
--   pending  — row inserted by the edge function before calling the
--              provider.  Never user-visible (driver app filters).
--   sent     — provider accepted the order and returned a claim_url.
--   claimed  — driver tapped the Claim button (or provider webhook
--              fired claimed in the future).
--   failed   — provider rejected the order; failure_reason carries
--              the message.
--
-- Tables added:
--   driver_rewards
--
-- RPCs added:
--   rewards_list(p_status, p_limit)         — dispatcher history feed
--   rewards_analytics(p_days)               — calm operational KPIs
--   driver_rewards_list(p_token)            — driver wallet view
--   driver_reward_open(p_token, p_id)       — driver opens a card
--   driver_reward_claim(p_token, p_id)      — driver taps Claim
--
-- Re-runnable: every DDL is guarded.


-- ── 1. driver_rewards table ─────────────────────────────────────────
create table if not exists public.driver_rewards (
  id                uuid primary key default gen_random_uuid(),
  dsp_id            uuid not null references public.dsps(id) on delete cascade,
  driver_id         uuid not null references public.drivers(id) on delete cascade,
  -- Amount stored in cents so we never round.  10000 cap = $100/reward.
  -- Bump via a future migration; the dashboard caps to the same value.
  amount_cents      int  not null check (amount_cents > 0 and amount_cents <= 100000),
  currency          text not null default 'USD',
  -- amazon | visa | walmart | gas_card | restaurant | general
  reward_type       text not null,
  -- perfect_attendance | great_rescue | safety | customer_feedback
  -- | teamwork | peak_performance | above_and_beyond | custom
  reason            text not null,
  note              text,
  -- pending | sent | claimed | failed
  status            text not null default 'pending',
  -- Provider slug (mock | tremendous | tango | giftogram | …)
  provider          text,
  -- Provider's order id (mock_xxx, trm_xxx).  Null until provider
  -- responds.
  provider_reward_id text,
  -- The claim URL the driver opens to redeem.  Null until provider
  -- responds.  The mock provider generates a placeholder URL.
  claim_url         text,
  -- Set when the driver app first fetches + displays the reward.
  delivered_at      timestamptz,
  -- Set when the driver expands the card / opens detail view.
  opened_at         timestamptz,
  -- The dispatcher (auth.users.id) who sent it.
  sent_by           uuid references auth.users(id) on delete set null,
  sent_at           timestamptz,
  claimed_at        timestamptz,
  failure_reason    text,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint driver_rewards_status_chk check (status in ('pending','sent','claimed','failed')),
  constraint driver_rewards_type_chk   check (reward_type in ('amazon','visa','walmart','gas_card','restaurant','general')),
  constraint driver_rewards_reason_chk check (reason in (
    'perfect_attendance','great_rescue','safety','customer_feedback',
    'teamwork','peak_performance','above_and_beyond','custom'
  ))
);

create index if not exists driver_rewards_dsp_idx
  on public.driver_rewards (dsp_id, sent_at desc nulls last, created_at desc);
create index if not exists driver_rewards_driver_idx
  on public.driver_rewards (driver_id, sent_at desc nulls last);
-- Hot path for the driver wallet: "unclaimed rewards for this driver".
create index if not exists driver_rewards_unclaimed_idx
  on public.driver_rewards (driver_id, sent_at desc)
  where status = 'sent' and claimed_at is null;


-- ── 2. updated_at trigger ───────────────────────────────────────────
create or replace function private.driver_rewards_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists driver_rewards_touch on public.driver_rewards;
create trigger driver_rewards_touch
  before update on public.driver_rewards
  for each row execute function private.driver_rewards_touch_updated_at();


-- ── 3. RLS ──────────────────────────────────────────────────────────
alter table public.driver_rewards enable row level security;

-- Dispatcher (and above) can see + manage every reward in their DSP.
-- The driver app reads via SECURITY DEFINER RPCs below — it never
-- touches the table directly because the driver session is anon.
drop policy if exists "driver_rewards_dispatcher_rw" on public.driver_rewards;
create policy "driver_rewards_dispatcher_rw" on public.driver_rewards
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

grant select, insert, update, delete on public.driver_rewards to authenticated;


-- ── 4. rewards_list(p_status, p_limit) ──────────────────────────────
-- Dispatcher history feed for the Recognition → Rewards tab.  Joins
-- the driver name + photo so the table renders in one fetch.  Sorted
-- newest-first by (sent_at, created_at).
create or replace function public.rewards_list(
  p_status text default null,
  p_limit  int  default 200
) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(j order by j->>'occurs_at' desc nulls last), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',              r.id,
      'driver_id',       r.driver_id,
      'driver_name',     coalesce(nullif(trim(d.preferred_name), ''), nullif(trim(d.full_name), ''), 'Driver'),
      'photo_path',      d.photo_path,
      'amount_cents',    r.amount_cents,
      'currency',        r.currency,
      'reward_type',     r.reward_type,
      'reason',          r.reason,
      'note',            r.note,
      'status',          r.status,
      'provider',        r.provider,
      'provider_reward_id', r.provider_reward_id,
      'claim_url',       r.claim_url,
      'delivered_at',    r.delivered_at,
      'opened_at',       r.opened_at,
      'sent_at',         r.sent_at,
      'claimed_at',      r.claimed_at,
      'failure_reason',  r.failure_reason,
      'sender_name',     coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'), ''), u.email, 'A teammate'),
      'occurs_at',       coalesce(r.sent_at, r.created_at),
      'created_at',      r.created_at
    ) j
    from public.driver_rewards r
    join public.drivers d on d.id = r.driver_id
    left join auth.users u on u.id = r.sent_by
    where r.dsp_id = private.current_dsp_id()
      and private.is_staff(r.dsp_id, 'dispatcher')
      and (p_status is null or p_status = 'all' or r.status = p_status)
    order by coalesce(r.sent_at, r.created_at) desc
    limit greatest(p_limit, 1)
  ) t;
$$;
grant execute on function public.rewards_list(text, int) to authenticated;


-- ── 5. rewards_analytics(p_days) ────────────────────────────────────
-- Operational KPIs for the Rewards tab.  Calm and focused — no KPI
-- soup.  Defaults to a 30-day window.
--
-- Returns:
--   sent_count          — rewards in (sent | claimed) in the window
--   claimed_count       — rewards in claimed in the window
--   total_sent_cents    — sum of amounts in (sent | claimed) in window
--   claim_rate          — claimed_count / sent_count (0–1, null if 0)
--   recipients_count    — distinct drivers who received a reward
--   active_driver_count — total active drivers in the DSP (for the
--                         participation rate readout)
--   by_type             — [{ reward_type, count, total_cents }]
--   by_reason           — [{ reason, count }]
--   top_recipients      — [{ driver_id, name, photo_path, count,
--                            total_cents }]  (top 5)
--   recent              — last 8 sent rewards (compact feed)
create or replace function public.rewards_analytics(p_days int default 30)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_since timestamptz := now() - (greatest(coalesce(p_days, 30), 1) || ' days')::interval;
  v_sent int;
  v_claimed int;
  v_total bigint;
  v_recipients int;
  v_active_drivers int;
  v_by_type jsonb;
  v_by_reason jsonb;
  v_top jsonb;
  v_recent jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select
    count(*) filter (where status in ('sent','claimed')),
    count(*) filter (where status = 'claimed'),
    coalesce(sum(amount_cents) filter (where status in ('sent','claimed')), 0),
    count(distinct driver_id) filter (where status in ('sent','claimed'))
    into v_sent, v_claimed, v_total, v_recipients
  from public.driver_rewards
  where dsp_id = v_dsp
    and coalesce(sent_at, created_at) >= v_since;

  select count(*) into v_active_drivers
  from public.drivers
  where dsp_id = v_dsp and role = 'driver' and status = 'active';

  select coalesce(jsonb_agg(jsonb_build_object(
    'reward_type', reward_type,
    'count',       cnt,
    'total_cents', total_cents
  ) order by cnt desc), '[]'::jsonb)
    into v_by_type
  from (
    select reward_type, count(*)::int as cnt, coalesce(sum(amount_cents), 0)::bigint as total_cents
    from public.driver_rewards
    where dsp_id = v_dsp
      and status in ('sent','claimed')
      and coalesce(sent_at, created_at) >= v_since
    group by reward_type
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object(
    'reason', reason,
    'count',  cnt
  ) order by cnt desc), '[]'::jsonb)
    into v_by_reason
  from (
    select reason, count(*)::int as cnt
    from public.driver_rewards
    where dsp_id = v_dsp
      and status in ('sent','claimed')
      and coalesce(sent_at, created_at) >= v_since
    group by reason
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object(
    'driver_id',   driver_id,
    'name',        name,
    'photo_path',  photo_path,
    'count',       cnt,
    'total_cents', total_cents
  ) order by cnt desc, total_cents desc), '[]'::jsonb)
    into v_top
  from (
    select r.driver_id,
           coalesce(nullif(trim(d.preferred_name), ''), nullif(trim(d.full_name), ''), 'Driver') as name,
           d.photo_path,
           count(*)::int as cnt,
           coalesce(sum(r.amount_cents), 0)::bigint as total_cents
    from public.driver_rewards r
    join public.drivers d on d.id = r.driver_id
    where r.dsp_id = v_dsp
      and r.status in ('sent','claimed')
      and coalesce(r.sent_at, r.created_at) >= v_since
    group by r.driver_id, d.preferred_name, d.full_name, d.photo_path
    order by cnt desc, total_cents desc
    limit 5
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',           r.id,
    'driver_id',    r.driver_id,
    'driver_name',  coalesce(nullif(trim(d.preferred_name), ''), nullif(trim(d.full_name), ''), 'Driver'),
    'photo_path',   d.photo_path,
    'reward_type',  r.reward_type,
    'reason',       r.reason,
    'amount_cents', r.amount_cents,
    'status',       r.status,
    'sent_at',      r.sent_at
  ) order by r.sent_at desc nulls last), '[]'::jsonb)
    into v_recent
  from (
    select * from public.driver_rewards
    where dsp_id = v_dsp and status in ('sent','claimed')
    order by sent_at desc nulls last
    limit 8
  ) r
  join public.drivers d on d.id = r.driver_id;

  return jsonb_build_object(
    'sent_count',          v_sent,
    'claimed_count',       v_claimed,
    'total_sent_cents',    v_total,
    'claim_rate',          case when v_sent > 0 then v_claimed::numeric / v_sent::numeric else null end,
    'recipients_count',    v_recipients,
    'active_driver_count', v_active_drivers,
    'participation_rate',  case when v_active_drivers > 0 then v_recipients::numeric / v_active_drivers::numeric else null end,
    'window_days',         greatest(coalesce(p_days, 30), 1),
    'by_type',             v_by_type,
    'by_reason',           v_by_reason,
    'top_recipients',      v_top,
    'recent',              v_recent
  );
end;
$$;
grant execute on function public.rewards_analytics(int) to authenticated;


-- ── 6. driver_rewards_list(p_token) ─────────────────────────────────
-- Driver wallet view.  Returns every reward (sent | claimed) for the
-- driver behind p_token, newest first.  Filters out pending/failed
-- rows — drivers should never see in-flight orders or provider errors.
--
-- Stamps delivered_at on the first call so dispatchers can see "the
-- driver opened the wallet" without a second round trip.
create or replace function public.driver_rewards_list(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_rows jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  update public.driver_rewards
     set delivered_at = coalesce(delivered_at, now())
   where driver_id = v_drv.id
     and status in ('sent','claimed')
     and delivered_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',              id,
    'amount_cents',    amount_cents,
    'currency',        currency,
    'reward_type',     reward_type,
    'reason',          reason,
    'note',            note,
    'status',          status,
    'claim_url',       claim_url,
    'sent_at',         sent_at,
    'claimed_at',      claimed_at,
    'sender_name',     coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'), ''), u.email, 'Your team')
  ) order by sent_at desc nulls last), '[]'::jsonb)
    into v_rows
  from public.driver_rewards r
  left join auth.users u on u.id = r.sent_by
  where r.driver_id = v_drv.id
    and r.status in ('sent','claimed');

  return jsonb_build_object(
    'driver_id', v_drv.id,
    'rewards',   v_rows
  );
end;
$$;
grant execute on function public.driver_rewards_list(text) to anon, authenticated;


-- ── 7. driver_reward_open(p_token, p_id) ────────────────────────────
-- Idempotent.  Driver expanded a reward card.  Stamps opened_at so
-- dispatchers can see "viewed but not claimed".  Returns true if the
-- row exists for this driver.
create or replace function public.driver_reward_open(p_token text, p_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_n int;
begin
  v_drv := private.driver_validate_token(p_token);
  update public.driver_rewards
     set opened_at    = coalesce(opened_at, now()),
         delivered_at = coalesce(delivered_at, now())
   where id = p_id and driver_id = v_drv.id;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
grant execute on function public.driver_reward_open(text, uuid) to anon, authenticated;


-- ── 8. driver_reward_claim(p_token, p_id) ───────────────────────────
-- Driver tapped Claim.  Marks claimed_at (idempotent — won't move the
-- timestamp on re-claim) and returns the claim_url so the app can
-- open it in a new tab.  In a future provider-webhook world this RPC
-- would flip to "request claim from provider" — today we trust the
-- tap because the underlying claim URL is what actually does the
-- redemption.
create or replace function public.driver_reward_claim(p_token text, p_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_row public.driver_rewards;
begin
  v_drv := private.driver_validate_token(p_token);

  update public.driver_rewards
     set claimed_at  = coalesce(claimed_at, now()),
         status      = case when status = 'sent' then 'claimed' else status end,
         opened_at   = coalesce(opened_at, now()),
         delivered_at= coalesce(delivered_at, now())
   where id = p_id and driver_id = v_drv.id
     and status in ('sent','claimed')
   returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  return jsonb_build_object(
    'ok',         true,
    'id',         v_row.id,
    'claim_url',  v_row.claim_url,
    'status',     v_row.status,
    'claimed_at', v_row.claimed_at
  );
end;
$$;
grant execute on function public.driver_reward_claim(text, uuid) to anon, authenticated;


notify pgrst, 'reload schema';
