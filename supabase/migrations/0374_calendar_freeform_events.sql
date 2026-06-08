-- ───────────────────────────────────────────────────────────────────────
-- 0374 · Free-form calendar events (Outlook-style click-to-create)
--
-- Operators can click an empty calendar slot to create a free-form event
-- (title + time + invitee emails), not tied to an applicant record. On
-- create it fires the same interview-room path as a real booking, so a
-- Whereby room is made and every invitee gets a branded email with the
-- join link.
--
-- Changes:
--   • cal_events.applicant_id made NULLABLE (free-form events have no applicant)
--   • cal_events.title added (event title for free-form events)
--   • cal_event_kind gains 'event'
--   • create_calendar_event() RPC (operator-callable)
--   • fire_interview_room() also fires for kind 'event'
-- Idempotent.
-- ───────────────────────────────────────────────────────────────────────

alter table public.cal_events alter column applicant_id drop not null;
alter table public.cal_events add column if not exists title text;

-- Add the 'event' kind (safe to re-run).
alter type public.cal_event_kind add value if not exists 'event';

-- Operator-callable: create a free-form calendar event for the current DSP.
-- Returns the new cal_event id. The AFTER INSERT trigger (fire_interview_room)
-- then builds the Whereby room + emails the invitees.
create or replace function public.create_calendar_event(
  p_title     text,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_invitees  text[]  default '{}',
  p_note      text    default null,
  p_timezone  text    default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_id  uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_title is null or btrim(p_title) = '' then
    raise exception 'title_required';
  end if;
  if p_starts_at is null then
    raise exception 'starts_at_required';
  end if;

  insert into public.cal_events
    (dsp_id, applicant_id, kind, status, provider, starts_at, ends_at, timezone, title, metadata)
  values
    (v_dsp, null, 'event', 'scheduled', 'routeready', p_starts_at, p_ends_at, p_timezone, btrim(p_title),
     jsonb_build_object('invitees', to_jsonb(coalesce(p_invitees, '{}'::text[])), 'note', p_note))
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.create_calendar_event(text, timestamptz, timestamptz, text[], text, text) to authenticated;

-- Extend the room trigger to also handle free-form events.
create or replace function private.fire_interview_room()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_url text; v_token text;
begin
  if new.provider is distinct from 'routeready' or new.kind not in ('interview', 'event') then return new; end if;
  select value into v_url   from private.integration_settings where key = 'interview_room_url';
  select value into v_token from private.integration_settings where key = 'gcal_sync_token';
  if v_url is null or v_token is null then return new; end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('content-type','application/json','x-rr-sync-token', v_token),
    body    := jsonb_build_object('cal_event_id', new.id)
  );
  return new;
end; $$;

drop trigger if exists trg_cal_events_interview_room on public.cal_events;
create trigger trg_cal_events_interview_room
  after insert on public.cal_events
  for each row execute function private.fire_interview_room();
