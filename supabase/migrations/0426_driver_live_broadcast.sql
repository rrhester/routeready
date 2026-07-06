-- 0426_driver_live_broadcast.sql
-- Instant (realtime) delivery of directed driver events, replacing the
-- 15–30s polling latency for cover offers, swaps, and 5th-day
-- confirmations while the driver has the app open.
--
-- Drivers auth by token and have no auth.uid, so RLS-filtered
-- postgres_changes can't reach them (that's why the app polls). Instead we
-- use Supabase Realtime *Broadcast*, which is channel-based, not
-- RLS-filtered: whenever one of these events is created for a driver, the
-- trigger broadcasts a content-free "refresh" ping to the public topic
-- rr-driver-live-<driver_id>. The app subscribes to that topic and
-- re-fetches immediately, so the card appears at once instead of on the
-- next poll tick. The pollers stay running as a fallback, so if Realtime
-- is unavailable nothing regresses.
--
-- The ping carries NO shift data — only a { kind } hint — so a leaked
-- topic name (a driver UUID) reveals nothing sensitive; the real data is
-- still fetched through the token-gated RPCs. This extends the 0425
-- notify triggers (which insert the driver_messages row that fires Web
-- Push) with an additional live broadcast; it is fully self-contained and
-- idempotent (create-or-replace + drop-if-exists).

-- ── Broadcast helper — never let a Realtime failure touch the caller ──
-- realtime.send(payload, event, topic, private). Wrapped so that if
-- realtime.send is absent or errors (older Realtime, local Postgres,
-- transient failure) it is a silent no-op: the exception is caught inside
-- this function's own block, so it never rolls back the caller's insert.
create or replace function private.driver_live_ping(p_driver_id uuid, p_kind text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object('kind', p_kind),
    'refresh',
    'rr-driver-live-' || p_driver_id::text,
    false
  );
exception when others then
  null;  -- Realtime unavailable → silent no-op; push + polling still cover it
end;
$$;

-- ── 1. Cover offer → message (push) + live ping to the offered driver ──
create or replace function private.notify_cover_offer()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_date date;
  v_body text;
begin
  if NEW.status <> 'pending' then return NEW; end if;

  select s.date into v_date from public.shifts s where s.id = NEW.shift_id;

  v_body := '📩 New shift offer'
    || case when v_date is not null then ' for ' || to_char(v_date, 'Dy Mon FMDD') else '' end
    || '. Open RouteReady to accept or pass before it expires.';

  insert into public.driver_messages (driver_id, dsp_id, sender_kind, body)
  values (NEW.driver_id, NEW.dsp_id, 'dispatch', v_body);

  perform private.driver_live_ping(NEW.driver_id, 'cover_offer');

  return NEW;
exception when others then
  return NEW;  -- never block offer creation
end;
$$;

drop trigger if exists trg_shift_offers_notify on public.shift_offers;
create trigger trg_shift_offers_notify
  after insert on public.shift_offers
  for each row execute function private.notify_cover_offer();

-- ── 2. Swap request → message + live ping to the target driver ──
create or replace function private.notify_swap_request()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name      text;
  v_their_day date;
  v_your_day  date;
  v_body      text;
begin
  if NEW.status <> 'pending' then return NEW; end if;

  v_name := private.driver_display_name(NEW.requester_driver_id);
  select s.date into v_their_day from public.shifts s where s.id = NEW.requester_shift_id;
  select s.date into v_your_day  from public.shifts s where s.id = NEW.target_shift_id;

  v_body := '🔄 ' || v_name || ' wants to swap shifts with you'
    || case
         when v_their_day is not null and v_your_day is not null
           then ': their ' || to_char(v_their_day, 'Dy Mon FMDD')
             || ' for your ' || to_char(v_your_day, 'Dy Mon FMDD')
         else ''
       end
    || '. Open RouteReady to accept or decline.';

  insert into public.driver_messages (driver_id, dsp_id, sender_kind, body)
  values (NEW.target_driver_id, NEW.dsp_id, 'dispatch', v_body);

  perform private.driver_live_ping(NEW.target_driver_id, 'swap');

  return NEW;
exception when others then
  return NEW;  -- never block swap creation
end;
$$;

drop trigger if exists trg_shift_swap_requests_notify on public.shift_swap_requests;
create trigger trg_shift_swap_requests_notify
  after insert on public.shift_swap_requests
  for each row execute function private.notify_swap_request();

-- ── 3. 5th-day shift confirmation → message + live ping to the driver ──
create or replace function private.notify_shift_confirmation()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_date date;
  v_body text;
begin
  if NEW.status <> 'pending' then return NEW; end if;

  v_date := (NEW.proposed_shift->>'date')::date;

  v_body := '📅 Please confirm a shift'
    || case when v_date is not null then ' on ' || to_char(v_date, 'Dy Mon FMDD') else '' end
    || '. Open RouteReady to accept or decline.';

  insert into public.driver_messages (driver_id, dsp_id, sender_kind, body)
  values (NEW.driver_id, NEW.dsp_id, 'dispatch', v_body);

  perform private.driver_live_ping(NEW.driver_id, 'confirmation');

  return NEW;
exception when others then
  return NEW;  -- never block confirmation creation
end;
$$;

drop trigger if exists trg_shift_confirmation_requests_notify on public.shift_confirmation_requests;
create trigger trg_shift_confirmation_requests_notify
  after insert on public.shift_confirmation_requests
  for each row execute function private.notify_shift_confirmation();

notify pgrst, 'reload schema';
