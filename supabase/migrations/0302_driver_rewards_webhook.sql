-- Migration 0302 · Reward provider webhook surface
--
-- Layers webhook-driven truth onto the driver_rewards table from 0301.
--
-- Today: when a driver taps Claim, we mark `claimed_at` immediately
-- so the wallet card flips to "Claimed" without waiting on the
-- provider.  That's great UX but it conflates "driver acknowledged"
-- with "driver actually redeemed a gift card".
--
-- New columns (all nullable, idempotent stamps):
--   link_clicked_at — provider says the driver opened the redemption
--                     page (Tremendous: REWARDS.LINK_CLICKED).
--   redeemed_at     — provider confirms the driver chose a brand and
--                     redeemed (Tremendous: REWARDS.REDEEMED).  This
--                     is the "true claim" signal.
--   last_webhook_at — last time any webhook touched this row.  Pure
--                     debug surface.
--   webhook_events  — append-only log of every webhook the row has
--                     received, capped at the last 10.  Lets the
--                     dispatcher see the lifecycle without a separate
--                     events table.
--
-- New helpers:
--   reward_webhook_apply(p_provider_reward_id, p_event_type, p_payload)
--     SECURITY DEFINER stamp called by the webhook-tremendous edge
--     function (service role only).  Idempotent — re-deliveries of
--     the same event don't move timestamps backwards.
--
-- Updated:
--   rewards_list                 — surfaces redeemed_at / link_clicked_at
--   rewards_analytics            — adds redeemed_count + true_claim_rate

-- ── 1. Columns + index ──────────────────────────────────────────────
alter table public.driver_rewards
  add column if not exists link_clicked_at timestamptz,
  add column if not exists redeemed_at     timestamptz,
  add column if not exists last_webhook_at timestamptz,
  add column if not exists webhook_events  jsonb not null default '[]'::jsonb;

-- Hot path for the analytics RPC: "rewards redeemed in the window".
create index if not exists driver_rewards_redeemed_idx
  on public.driver_rewards (dsp_id, redeemed_at desc)
  where redeemed_at is not null;


-- ── 2. reward_webhook_apply(...) ────────────────────────────────────
-- The webhook-tremendous edge function authenticates with the service
-- role (it's a public function — auth is via the provider's HMAC
-- signature, not a JWT).  This helper is SECURITY DEFINER so its
-- caller sees only its grants — we grant to service_role and nothing
-- else.  Driver / dispatcher paths never hit this RPC.
--
-- Returns the updated row id (or null if no row matched the provider
-- reward id — e.g. an event for a reward that came from a different
-- environment).  Always succeeds; the webhook returns 200 even on
-- "no match" so the provider doesn't retry forever.
create or replace function public.reward_webhook_apply(
  p_provider          text,
  p_provider_reward_id text,
  p_event_type        text,
  p_payload           jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_row    public.driver_rewards;
  v_evt    text := upper(coalesce(p_event_type, ''));
  v_now    timestamptz := now();
  v_log_entry jsonb;
begin
  select * into v_row
  from public.driver_rewards
  where provider = p_provider
    and provider_reward_id = p_provider_reward_id
  limit 1;

  if v_row.id is null then
    return null;
  end if;

  -- Append a capped event log so we can see the lifecycle without
  -- needing a separate audit table.  Keep last 10 entries — webhooks
  -- can fan out (delivered → clicked → redeemed × several retries)
  -- and we don't want the row to bloat.
  v_log_entry := jsonb_build_object(
    'event',      v_evt,
    'at',         v_now,
    'payload',    coalesce(p_payload, '{}'::jsonb)
  );

  update public.driver_rewards
     set
       last_webhook_at = v_now,
       webhook_events  = (
         (coalesce(webhook_events, '[]'::jsonb) || jsonb_build_array(v_log_entry))
       ) #- (case
             when jsonb_array_length(coalesce(webhook_events, '[]'::jsonb)) >= 10
             then '{0}'
             else null
           end),

       -- Tremendous event names use the pattern OBJECT.ACTION.  We
       -- match on the action suffix so future renames of the OBJECT
       -- side don't break us.  Each branch is idempotent: coalesce on
       -- the timestamp means a retry never moves the clock backwards.
       link_clicked_at = case
         when v_evt like '%LINK_CLICKED%' or v_evt like '%LINK.CLICKED%'
              or v_evt like '%REWARD.LINK_CLICKED%' or v_evt like '%REWARDS.LINK_CLICKED%'
           then coalesce(link_clicked_at, v_now)
         else link_clicked_at
       end,
       opened_at = case
         when v_evt like '%LINK_CLICKED%' or v_evt like '%LINK.CLICKED%'
              or v_evt like '%REWARD.LINK_CLICKED%' or v_evt like '%REWARDS.LINK_CLICKED%'
           then coalesce(opened_at, v_now)
         else opened_at
       end,
       redeemed_at = case
         when v_evt like '%REDEEM%' or v_evt = 'REWARDS.REDEEMED' or v_evt = 'REWARD.REDEEMED'
           then coalesce(redeemed_at, v_now)
         else redeemed_at
       end,
       -- A REDEEMED webhook is also the strongest "claimed" signal
       -- we'll ever get, so flip status / claimed_at if the driver
       -- redeemed straight from the email link without going through
       -- our app's Claim tap.
       claimed_at = case
         when (v_evt like '%REDEEM%' or v_evt = 'REWARDS.REDEEMED' or v_evt = 'REWARD.REDEEMED')
           then coalesce(claimed_at, v_now)
         else claimed_at
       end,
       status = case
         when (v_evt like '%REDEEM%' or v_evt = 'REWARDS.REDEEMED' or v_evt = 'REWARD.REDEEMED')
              and status = 'sent'
           then 'claimed'
         else status
       end,
       updated_at = v_now
   where id = v_row.id;

  return v_row.id;
end;
$$;
revoke all on function public.reward_webhook_apply(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.reward_webhook_apply(text, text, text, jsonb) to service_role;


-- ── 3. rewards_list — surface redeemed_at / link_clicked_at ─────────
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
      'link_clicked_at', r.link_clicked_at,
      'sent_at',         r.sent_at,
      'claimed_at',      r.claimed_at,
      'redeemed_at',     r.redeemed_at,
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


-- ── 4. rewards_analytics — add redeemed_count + true_claim_rate ─────
create or replace function public.rewards_analytics(p_days int default 30)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_since timestamptz := now() - (greatest(coalesce(p_days, 30), 1) || ' days')::interval;
  v_sent int;
  v_claimed int;
  v_redeemed int;
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
    count(*) filter (where redeemed_at is not null),
    coalesce(sum(amount_cents) filter (where status in ('sent','claimed')), 0),
    count(distinct driver_id) filter (where status in ('sent','claimed'))
    into v_sent, v_claimed, v_redeemed, v_total, v_recipients
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
    'redeemed_count',      v_redeemed,
    'total_sent_cents',    v_total,
    'claim_rate',          case when v_sent > 0 then v_claimed::numeric  / v_sent::numeric else null end,
    'true_claim_rate',     case when v_sent > 0 then v_redeemed::numeric / v_sent::numeric else null end,
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


notify pgrst, 'reload schema';
