-- 0427_push_deep_links.sql
-- Deep-link push notifications: tapping a schedule event opens the card
-- the driver needs, not the chat.
--
-- Every driver push currently opens /app/#/chat (hardcoded in the
-- send-driver-push edge function), so a "new shift offer" notification
-- drops the driver in the chat thread instead of on the offer's Accept /
-- Pass card. This adds an optional per-message target: driver_messages
-- gets a link_url column, the schedule-event notify triggers + the publish
-- blast set it to /app/#/schedule, and the edge function uses it (falling
-- back to /app/#/chat when null, so chat messages are unchanged). The
-- service worker already navigates to whatever url the payload carries, so
-- no SW change is needed.
--
-- Idempotent: add-column-if-not-exists + create-or-replace. The existing
-- triggers point at these same-named functions, so replacing the bodies is
-- enough — no trigger recreation required.

-- ── 1. Where a notification's tap should land ──
alter table public.driver_messages
  add column if not exists link_url text;

-- ── 2. Schedule-event notifiers now tag their message with /schedule ──
--     (unchanged from 0426 except the added link_url on the insert)
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

  insert into public.driver_messages (driver_id, dsp_id, sender_kind, body, link_url)
  values (NEW.driver_id, NEW.dsp_id, 'dispatch', v_body, '/app/#/schedule');

  perform private.driver_live_ping(NEW.driver_id, 'cover_offer');

  return NEW;
exception when others then
  return NEW;
end;
$$;

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

  insert into public.driver_messages (driver_id, dsp_id, sender_kind, body, link_url)
  values (NEW.target_driver_id, NEW.dsp_id, 'dispatch', v_body, '/app/#/schedule');

  perform private.driver_live_ping(NEW.target_driver_id, 'swap');

  return NEW;
exception when others then
  return NEW;
end;
$$;

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

  insert into public.driver_messages (driver_id, dsp_id, sender_kind, body, link_url)
  values (NEW.driver_id, NEW.dsp_id, 'dispatch', v_body, '/app/#/schedule');

  perform private.driver_live_ping(NEW.driver_id, 'confirmation');

  return NEW;
exception when others then
  return NEW;
end;
$$;

-- ── 3. Publish blast also deep-links to the schedule ──
--     (unchanged from 0421 except the added link_url on the insert)
create or replace function public.set_schedule_finalized(p_week_start date, p_finalized boolean)
returns public.scheduling_settings
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp           uuid := private.current_dsp_id();
  v_row           public.scheduling_settings;
  v_eff           public.scheduling_settings;
  v_was_finalized boolean;
  v_notify        record;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_row from public.scheduling_settings
   where dsp_id = v_dsp and week_start = p_week_start;
  if not found then
    v_was_finalized := false;
    v_eff := private.get_week_settings(v_dsp, p_week_start);
    insert into public.scheduling_settings
      (dsp_id, week_start, default_block_hours, cushion_pct, max_days_per_week, waves, timezone, allow_availability_override, finalized)
    values
      (v_dsp, p_week_start, v_eff.default_block_hours, v_eff.cushion_pct, v_eff.max_days_per_week, v_eff.waves, v_eff.timezone, v_eff.allow_availability_override, coalesce(p_finalized, false))
    returning * into v_row;
  else
    v_was_finalized := coalesce(v_row.finalized, false);
    update public.scheduling_settings
       set finalized = coalesce(p_finalized, false), updated_at = now()
     where dsp_id = v_dsp and week_start = p_week_start
     returning * into v_row;
  end if;

  if coalesce(p_finalized, false) and not v_was_finalized then
    for v_notify in
      select driver_id,
             string_agg(dow, ', ' order by d) as days
      from (
        select distinct s.driver_id,
               s.date               as d,
               to_char(s.date, 'Dy') as dow
        from public.shifts s
        where s.dsp_id    = v_dsp
          and s.driver_id is not null
          and s.date     >= p_week_start
          and s.date     <  p_week_start + 7
          and s.status    in ('scheduled', 'completed', 'late')
      ) x
      group by driver_id
    loop
      insert into public.driver_messages (driver_id, dsp_id, sender_kind, sender_user_id, body, link_url)
      values (
        v_notify.driver_id,
        v_dsp,
        'dispatch',
        auth.uid(),
        '📅 Your schedule for the week of ' || to_char(p_week_start, 'Mon FMDD') ||
        ' is posted. You''re scheduled ' || v_notify.days ||
        '. Open RouteReady to see your times.',
        '/app/#/schedule'
      );
    end loop;
  end if;

  return v_row;
end;
$$;
grant execute on function public.set_schedule_finalized(date, boolean) to authenticated;

notify pgrst, 'reload schema';
