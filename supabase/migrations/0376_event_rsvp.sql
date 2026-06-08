-- ───────────────────────────────────────────────────────────────────────
-- 0376 · Event RSVP (accept / decline) + tentative state
--
-- Operator-sent calendar invites are TENTATIVE until the recipient accepts.
-- Adds an rsvp state + a per-event token the recipient uses on a public page
-- (/rsvp/<token>) to accept or decline. Self-booked interviews stay 'accepted'
-- (the applicant chose the slot); only operator-created events start 'pending'.
-- Idempotent.
-- ───────────────────────────────────────────────────────────────────────

alter table public.cal_events add column if not exists rsvp text not null default 'accepted';
alter table public.cal_events add column if not exists rsvp_token text;
create unique index if not exists cal_events_rsvp_token_idx
  on public.cal_events (rsvp_token) where rsvp_token is not null;

do $$ begin
  alter table public.cal_events
    add constraint cal_events_rsvp_chk check (rsvp in ('pending','accepted','declined'));
exception when duplicate_object then null; end $$;

-- create_calendar_event gains p_rsvp_token + sets rsvp='pending' when there are
-- invitees to hear back from (else 'accepted'). Otherwise unchanged from 0375.
drop function if exists public.create_calendar_event(text, timestamptz, timestamptz, text[], text, text, text, text, text);

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

  if p_meeting_url is not null and v_has_inv then
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

grant execute on function public.create_calendar_event(text, timestamptz, timestamptz, text[], text, text, text, text, text, text) to authenticated;

-- Public RSVP: load the event for a token, and (when p_response is given)
-- record accept/decline. Anon-callable — recipients aren't logged in.
create or replace function public.rsvp_respond(p_token text, p_response text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ev  public.cal_events;
  v_new text;
  v_dsp_name text;
begin
  if p_token is null or btrim(p_token) = '' then
    return jsonb_build_object('ok', false, 'error', 'token_required');
  end if;
  v_new := case lower(coalesce(p_response, ''))
             when 'accept' then 'accepted' when 'yes' then 'accepted'
             when 'decline' then 'declined' when 'no' then 'declined'
             else null end;

  select * into v_ev from public.cal_events where rsvp_token = p_token;
  if v_ev.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_new is not null and v_ev.status in ('scheduled','rescheduled') then
    update public.cal_events set rsvp = v_new where id = v_ev.id;
    v_ev.rsvp := v_new;
  end if;

  select coalesce(name, 'RouteReady') into v_dsp_name from public.dsps where id = v_ev.dsp_id;

  return jsonb_build_object(
    'ok', true,
    'rsvp', v_ev.rsvp,
    'status', v_ev.status,
    'title', v_ev.title,
    'starts_at', v_ev.starts_at,
    'ends_at', v_ev.ends_at,
    'timezone', v_ev.timezone,
    'meeting_url', v_ev.meeting_url,
    'dsp_name', v_dsp_name
  );
end;
$$;

grant execute on function public.rsvp_respond(text, text) to anon, authenticated;
