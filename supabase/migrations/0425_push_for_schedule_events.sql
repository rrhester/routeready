-- 0425_push_for_schedule_events.sql
-- Real push notifications for the three driver-facing schedule events that
-- previously only surfaced via 15–30s in-app polling: cover offers, swap
-- requests, and 5th-day shift confirmations.
--
-- Drivers authenticate by token and have no auth.uid, so Supabase realtime
-- (postgres_changes) never reaches them — the app polls. That means a
-- driver with the app closed learned about a time-sensitive offer/swap
-- only when they next opened it. This wires those events into the proven
-- driver_messages → push pipeline (0056): an AFTER INSERT trigger on each
-- event table inserts a dispatch→driver message, which fires
-- trg_driver_messages_fire_push → the send-driver-push edge function. Same
-- pattern the license-expiry reminders (0359) and schedule publish (0421)
-- already use, so the driver gets a Web Push and an in-app record.
--
-- Each trigger:
--   • fires only for a NEW row in 'pending' state (a genuine new event),
--   • notifies the RECIPIENT (never the initiator),
--   • is wrapped so a messaging failure can NEVER block the core insert
--     (offer/swap/confirmation creation must still succeed).
--
-- Idempotent: create-or-replace functions, drop-if-exists before create
-- trigger.

-- ── helper: short driver display name ──
create or replace function private.driver_display_name(p_driver_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    nullif(trim(d.preferred_name), ''),
    nullif(trim(d.first_name), ''),
    nullif(trim(d.full_name), ''),
    'A teammate'
  )
  from public.drivers d where d.id = p_driver_id;
$$;

-- ── 1. Cover offer → notify the offered driver ──
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

  return NEW;
exception when others then
  return NEW;  -- never block offer creation
end;
$$;

drop trigger if exists trg_shift_offers_notify on public.shift_offers;
create trigger trg_shift_offers_notify
  after insert on public.shift_offers
  for each row execute function private.notify_cover_offer();

-- ── 2. Swap request → notify the target driver ──
create or replace function private.notify_swap_request()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name      text;
  v_their_day date;   -- the shift the target would receive (requester's)
  v_your_day  date;   -- the shift the target would give up
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

  return NEW;
exception when others then
  return NEW;  -- never block swap creation
end;
$$;

drop trigger if exists trg_shift_swap_requests_notify on public.shift_swap_requests;
create trigger trg_shift_swap_requests_notify
  after insert on public.shift_swap_requests
  for each row execute function private.notify_swap_request();

-- ── 3. 5th-day shift confirmation → notify the driver ──
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
