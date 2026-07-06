-- ───────────────────────────────────────────────────────────────────────
-- 0429 · Wire up real .ics calendar invites (METHOD:REQUEST / CANCEL)
--
-- 0377 linked queued invite emails to their cal_event so send-email could
-- attach a real calendar invite — but the attachment was never wired in,
-- so invitees only ever got the HTML email. This adds the two pieces the
-- send path needs to attach a standards-correct invite:
--
--   1. email_messages.calendar_method — 'request' | 'cancel'. Explicitly
--      marks a queued email as a calendar invite (or a cancellation) so
--      send-email knows to attach the .ics with the right METHOD. This is
--      an explicit column rather than inferred from cal_event_id because
--      interview reminder emails (0406/0410) also carry cal_event_id and
--      must NOT re-attach the invite.
--   2. cal_events.ics_sequence — RFC 5545 SEQUENCE. Bumped by trigger when
--      a schedule-relevant field moves, so Gmail/Outlook treat the next
--      invite email as an update to the existing event instead of a
--      duplicate. Cancellations send SEQUENCE + 1 at send time (the email
--      row can be queued before cancel_cal_event_silent flips the status,
--      so the trigger can't be relied on to have bumped it yet).
--
-- create_calendar_event() is re-created (same signature as 0382) with the
-- queued invite emails stamped calendar_method = 'request'. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

alter table public.email_messages
  add column if not exists calendar_method text;

alter table public.email_messages
  drop constraint if exists email_messages_calendar_method_check;
alter table public.email_messages
  add constraint email_messages_calendar_method_check
  check (calendar_method is null or calendar_method in ('request', 'cancel'));

alter table public.cal_events
  add column if not exists ics_sequence integer not null default 0;

-- Bump SEQUENCE whenever a field that changes the meeting itself moves.
-- Writebacks from google-calendar-sync (google_* columns) and status/rsvp
-- flips don't bump, mirroring the 0368 loop-guard field list.
create or replace function private.bump_ics_sequence()
returns trigger
language plpgsql
as $$
begin
  if new.starts_at   is distinct from old.starts_at
  or new.ends_at     is distinct from old.ends_at
  or new.location    is distinct from old.location
  or new.meeting_url is distinct from old.meeting_url
  or new.title       is distinct from old.title then
    new.ics_sequence := coalesce(old.ics_sequence, 0) + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bump_ics_sequence on public.cal_events;
create trigger trg_bump_ics_sequence
  before update on public.cal_events
  for each row execute function private.bump_ics_sequence();

-- create_calendar_event: unchanged from 0382 except the queued invite
-- emails are stamped calendar_method = 'request' so send-email attaches
-- the .ics.
create or replace function public.create_calendar_event(
  p_title       text,
  p_starts_at   timestamptz,
  p_ends_at     timestamptz,
  p_invitees    text[]  default '{}',
  p_note        text    default null,
  p_timezone    text    default null,
  p_meeting_url text    default null,
  p_body_text   text    default null,
  p_body_html   text    default null,
  p_rsvp_token  text    default null,
  p_calendar_id uuid    default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_id      uuid;
  v_email   text;
  v_subject text := coalesce(nullif(btrim(p_title), ''), 'You''re invited');
  v_text    text := p_body_text;
  v_html    text := p_body_html;
  v_has_inv boolean := array_length(p_invitees, 1) is not null;
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
  -- A calendar_id, if given, must belong to this DSP.
  if p_calendar_id is not null and not exists (
    select 1 from public.calendars c where c.id = p_calendar_id and c.dsp_id = v_dsp
  ) then
    raise exception 'calendar_not_found';
  end if;

  insert into public.cal_events
    (dsp_id, applicant_id, kind, status, provider, starts_at, ends_at, timezone, title, meeting_url, calendar_id, rsvp, rsvp_token, metadata)
  values
    (v_dsp, null, 'event', 'scheduled', 'routeready', p_starts_at, p_ends_at, p_timezone, btrim(p_title), p_meeting_url, p_calendar_id,
     case when v_has_inv then 'pending' else 'accepted' end, p_rsvp_token,
     jsonb_build_object('invitees', to_jsonb(coalesce(p_invitees, '{}'::text[])), 'note', p_note))
  returning id into v_id;

  if v_has_inv then
    if v_text is null then
      v_text := 'You''re invited: ' || btrim(p_title)
        || case when p_meeting_url is not null then E'\n\nJoin the video meeting here:\n' || p_meeting_url else '' end;
    end if;
    if v_html is null then
      v_html := replace(v_text, E'\n', '<br>');
    end if;
    foreach v_email in array p_invitees loop
      if v_email is not null and position('@' in v_email) > 0 then
        insert into public.email_messages
          (dsp_id, cal_event_id, calendar_method, direction, status, to_email, subject, body_text, body_html)
        values
          (v_dsp, v_id, 'request', 'outbound', 'queued', v_email, v_subject, v_text, v_html);
      end if;
    end loop;
  end if;

  return v_id;
end;
$$;

grant execute on function public.create_calendar_event(text, timestamptz, timestamptz, text[], text, text, text, text, text, text, uuid) to authenticated;
