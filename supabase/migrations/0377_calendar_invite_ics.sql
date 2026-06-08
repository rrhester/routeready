-- ───────────────────────────────────────────────────────────────────────
-- 0377 · Calendar (.ics) invites
--
-- Links a queued email to its cal_event so send-email can attach a real
-- calendar invite (METHOD:REQUEST). The recipient's mail client (Gmail/
-- Outlook) then shows native Accept/Decline buttons and adds it to their
-- Google Calendar; their reply routes back to webhook-email-inbound which
-- updates cal_events.rsvp. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

alter table public.email_messages
  add column if not exists cal_event_id uuid references public.cal_events(id) on delete set null;

create index if not exists email_messages_cal_event_idx
  on public.email_messages (cal_event_id) where cal_event_id is not null;

-- create_calendar_event: tag the queued invite emails with the new event id
-- so send-email knows to attach the .ics. Same signature as 0376; only the
-- email insert changes.
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
  p_rsvp_token  text    default null
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

  insert into public.cal_events
    (dsp_id, applicant_id, kind, status, provider, starts_at, ends_at, timezone, title, meeting_url, rsvp, rsvp_token, metadata)
  values
    (v_dsp, null, 'event', 'scheduled', 'routeready', p_starts_at, p_ends_at, p_timezone, btrim(p_title), p_meeting_url,
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
          (dsp_id, cal_event_id, direction, status, to_email, subject, body_text, body_html)
        values
          (v_dsp, v_id, 'outbound', 'queued', v_email, v_subject, v_text, v_html);
      end if;
    end loop;
  end if;

  return v_id;
end;
$$;

grant execute on function public.create_calendar_event(text, timestamptz, timestamptz, text[], text, text, text, text, text, text) to authenticated;
