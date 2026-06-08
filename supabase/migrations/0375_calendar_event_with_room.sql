-- ───────────────────────────────────────────────────────────────────────
-- 0375 · Free-form events carry a pre-made video room + invite body
--
-- The full-page event editor mints a Whereby room (video-room edge fn) BEFORE
-- saving, so the join link can be shown in the invite body immediately. This
-- extends create_calendar_event to accept that meeting_url + the composed
-- invite body, store the link on the event, and queue the invite email to
-- each attendee right here (with the link). When meeting_url is provided the
-- AFTER INSERT room trigger no-ops (it sees a url already), so there's no
-- duplicate email. When it's null we fall back to the old async path.
-- Idempotent.
-- ───────────────────────────────────────────────────────────────────────

drop function if exists public.create_calendar_event(text, timestamptz, timestamptz, text[], text, text);

create or replace function public.create_calendar_event(
  p_title       text,
  p_starts_at   timestamptz,
  p_ends_at     timestamptz,
  p_invitees    text[]  default '{}',
  p_note        text    default null,
  p_timezone    text    default null,
  p_meeting_url text    default null,
  p_body_text   text    default null,
  p_body_html   text    default null
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
    (dsp_id, applicant_id, kind, status, provider, starts_at, ends_at, timezone, title, meeting_url, metadata)
  values
    (v_dsp, null, 'event', 'scheduled', 'routeready', p_starts_at, p_ends_at, p_timezone, btrim(p_title), p_meeting_url,
     jsonb_build_object('invitees', to_jsonb(coalesce(p_invitees, '{}'::text[])), 'note', p_note))
  returning id into v_id;

  -- When the room already exists, send the invite (with the link) now. The
  -- room trigger will see meeting_url set and skip, so no duplicate goes out.
  if p_meeting_url is not null and array_length(p_invitees, 1) is not null then
    if v_text is null then
      v_text := 'You''re invited: ' || btrim(p_title) || E'\n\nJoin the video meeting here:\n' || p_meeting_url;
    end if;
    if v_html is null then
      v_html := replace(v_text, E'\n', '<br>');
    end if;
    foreach v_email in array p_invitees loop
      if v_email is not null and position('@' in v_email) > 0 then
        insert into public.email_messages
          (dsp_id, direction, status, to_email, subject, body_text, body_html)
        values
          (v_dsp, 'outbound', 'queued', v_email, v_subject, v_text, v_html);
      end if;
    end loop;
  end if;

  return v_id;
end;
$$;

grant execute on function public.create_calendar_event(text, timestamptz, timestamptz, text[], text, text, text, text, text) to authenticated;
