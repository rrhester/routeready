-- ─────────────────────────────────────────────────────────────────────────
-- 0492 · Per-invitee RSVP + proposed times + meeting lock
--
-- 1. Per-invitee RSVP (calendar 100-list #37): invite emails can now carry a
--    per-recipient token — "<anchor>.<n>" — so each guest's Accept/Decline is
--    recorded under their own email in metadata.rsvp_by, and the event-level
--    rsvp becomes an aggregate (all accepted → accepted, all declined →
--    declined, anything partial → pending). The anchor token keeps working
--    exactly as before (single-recipient events are unchanged).
--    create_calendar_event / create_calendar_series gain p_invitee_tokens
--    (jsonb {token: email}); when present the queued invite emails have the
--    anchor token string-replaced with each recipient's own token, and the
--    map is stored on the (anchor) event's metadata.invitee_tokens.
--
-- 2. Propose a new time (#38): rsvp_respond accepts p_proposal
--    ({starts_at, note}) from the public RSVP page. Proposals append to
--    metadata.rsvp_proposals and surface on the operator's reading pane.
--
-- 3. Meeting lock (#40): meetings.locked + meet_set_locked(code, locked);
--    meet_lookup now reports it so the meeting page can hold guests out of
--    a locked room.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1+2 · rsvp_respond with per-invitee identity + proposals ────────────

drop function if exists public.rsvp_respond(text, text);

create or replace function public.rsvp_respond(
  p_token    text,
  p_response text  default null,
  p_proposal jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_anchor   text := split_part(coalesce(p_token, ''), '.', 1);
  v_ev       public.cal_events;
  v_new      text;
  v_dsp_name text;
  v_email    text;
  v_md       jsonb;
  v_prop_at  timestamptz;
  v_states   text[];
  v_agg      text;
begin
  if v_anchor = '' then
    return jsonb_build_object('ok', false, 'error', 'token_required');
  end if;
  v_new := case lower(coalesce(p_response, ''))
             when 'accept' then 'accepted' when 'yes' then 'accepted'
             when 'decline' then 'declined' when 'no' then 'declined'
             else null end;

  select * into v_ev from public.cal_events where rsvp_token = v_anchor;
  if v_ev.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- Per-invitee token ("<anchor>.<n>") → the guest's email, minted at
  -- create time into metadata.invitee_tokens. An unknown suffix is treated
  -- as a bad link rather than silently acting as the whole event.
  if p_token <> v_anchor then
    v_email := v_ev.metadata->'invitee_tokens'->>p_token;
    if v_email is null then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;
  end if;

  v_md := coalesce(v_ev.metadata, '{}'::jsonb);

  if v_new is not null and v_ev.status in ('scheduled','rescheduled') then
    if v_email is not null then
      v_md := jsonb_set(v_md, array['rsvp_by', v_email],
                        jsonb_build_object('r', v_new, 'at', now()), true);
      -- Aggregate event-level state across every tokened invitee: accepted /
      -- declined only when EVERYONE has said the same thing; otherwise the
      -- chip stays "awaiting reply" and the pane shows the per-guest rollup.
      select array_agg(coalesce(v_md->'rsvp_by'->em->>'r', 'pending'))
        into v_states
        from (select distinct value as em from jsonb_each_text(coalesce(v_md->'invitee_tokens', '{}'::jsonb))) t(em);
      v_agg := case
        when v_states is null then v_new
        when 'pending' = any(v_states) then 'pending'
        when 'declined' = any(v_states) and 'accepted' = any(v_states) then 'pending'
        when 'declined' = any(v_states) then 'declined'
        else 'accepted' end;
    else
      v_agg := v_new;
    end if;
    update public.cal_events set rsvp = v_agg, metadata = v_md where id = v_ev.id;
    v_ev.rsvp := v_agg;
    v_ev.metadata := v_md;
  end if;

  -- Proposed new time: appended, never destructive. The operator accepts or
  -- ignores it from the calendar's reading pane.
  if p_proposal is not null and v_ev.status in ('scheduled','rescheduled') then
    begin
      v_prop_at := (p_proposal->>'starts_at')::timestamptz;
    exception when others then
      v_prop_at := null;
    end;
    if v_prop_at is not null then
      v_md := jsonb_set(v_md, '{rsvp_proposals}',
        coalesce(v_md->'rsvp_proposals', '[]'::jsonb)
          || jsonb_build_array(jsonb_build_object(
               'starts_at', v_prop_at,
               'note', left(coalesce(p_proposal->>'note', ''), 500),
               'email', v_email,
               'at', now())), true);
      update public.cal_events set metadata = v_md where id = v_ev.id;
      v_ev.metadata := v_md;
    end if;
  end if;

  select coalesce(name, 'RouteReady') into v_dsp_name from public.dsps where id = v_ev.dsp_id;

  return jsonb_build_object(
    'ok', true,
    'rsvp', v_ev.rsvp,
    'my_rsvp', case when v_email is not null then coalesce(v_ev.metadata->'rsvp_by'->v_email->>'r', 'pending') else v_ev.rsvp end,
    'invitee_email', v_email,
    'proposed', p_proposal is not null and v_prop_at is not null,
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

grant execute on function public.rsvp_respond(text, text, jsonb) to anon, authenticated;

-- ── 1 · create_calendar_event gains p_invitee_tokens ────────────────────

drop function if exists public.create_calendar_event(text, timestamptz, timestamptz, text[], text, text, text, text, text, text, uuid);

create or replace function public.create_calendar_event(
  p_title          text,
  p_starts_at      timestamptz,
  p_ends_at        timestamptz,
  p_invitees       text[]  default '{}',
  p_note           text    default null,
  p_timezone       text    default null,
  p_meeting_url    text    default null,
  p_body_text      text    default null,
  p_body_html      text    default null,
  p_rsvp_token     text    default null,
  p_calendar_id    uuid    default null,
  p_invitee_tokens jsonb   default null
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
  v_meta    jsonb;
  v_tok     text;
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
  if p_calendar_id is not null and not exists (
    select 1 from public.calendars c where c.id = p_calendar_id and c.dsp_id = v_dsp
  ) then
    raise exception 'calendar_not_found';
  end if;

  v_meta := jsonb_build_object('invitees', to_jsonb(coalesce(p_invitees, '{}'::text[])), 'note', p_note);
  if p_invitee_tokens is not null and p_rsvp_token is not null then
    v_meta := v_meta || jsonb_build_object('invitee_tokens', p_invitee_tokens);
  end if;

  insert into public.cal_events
    (dsp_id, applicant_id, kind, status, provider, starts_at, ends_at, timezone, title, meeting_url, calendar_id, rsvp, rsvp_token, metadata)
  values
    (v_dsp, null, 'event', 'scheduled', 'routeready', p_starts_at, p_ends_at, p_timezone, btrim(p_title), p_meeting_url, p_calendar_id,
     case when v_has_inv then 'pending' else 'accepted' end, p_rsvp_token,
     v_meta)
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
        -- Per-invitee RSVP links: swap the anchor token for this guest's own
        -- token in their copy of the invite (the URLs embed the raw token).
        v_tok := null;
        if p_invitee_tokens is not null and p_rsvp_token is not null then
          select key into v_tok
            from jsonb_each_text(p_invitee_tokens)
           where value = v_email
           limit 1;
        end if;
        insert into public.email_messages
          (dsp_id, cal_event_id, calendar_method, direction, status, to_email, subject, body_text, body_html)
        values
          (v_dsp, v_id, 'request', 'outbound', 'queued', v_email, v_subject,
           case when v_tok is not null then replace(v_text, p_rsvp_token, v_tok) else v_text end,
           case when v_tok is not null then replace(v_html, p_rsvp_token, v_tok) else v_html end);
      end if;
    end loop;
  end if;

  return v_id;
end;
$$;

grant execute on function public.create_calendar_event(text, timestamptz, timestamptz, text[], text, text, text, text, text, text, uuid, jsonb) to authenticated;

-- ── 1 · create_calendar_series gains p_invitee_tokens ───────────────────

drop function if exists public.create_calendar_series(text, jsonb, jsonb, text[], text, text, text, text, text, text, uuid, jsonb);

create or replace function public.create_calendar_series(
  p_title          text,
  p_occurrences    jsonb,
  p_rule           jsonb   default null,
  p_invitees       text[]  default '{}',
  p_note           text    default null,
  p_timezone       text    default null,
  p_meeting_url    text    default null,
  p_body_text      text    default null,
  p_body_html      text    default null,
  p_rsvp_token     text    default null,
  p_calendar_id    uuid    default null,
  p_extra          jsonb   default null,
  p_invitee_tokens jsonb   default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp       uuid := private.current_dsp_id();
  v_series    uuid;
  v_id        uuid;
  v_anchor    uuid;
  v_email     text;
  v_subject   text := coalesce(nullif(btrim(p_title), ''), 'You''re invited');
  v_text      text := p_body_text;
  v_html      text := p_body_html;
  v_has_inv   boolean := array_length(p_invitees, 1) is not null;
  v_occ       jsonb;
  v_i         int := 0;
  v_n         int;
  v_meta      jsonb;
  v_tok       text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_title is null or btrim(p_title) = '' then
    raise exception 'title_required';
  end if;
  if p_occurrences is null or jsonb_typeof(p_occurrences) <> 'array' then
    raise exception 'occurrences_required';
  end if;
  v_n := jsonb_array_length(p_occurrences);
  if v_n < 1 or v_n > 366 then
    raise exception 'occurrence_count_out_of_range';
  end if;
  if p_calendar_id is not null and not exists (
    select 1 from public.calendars c where c.id = p_calendar_id and c.dsp_id = v_dsp
  ) then
    raise exception 'calendar_not_found';
  end if;

  insert into public.cal_series (dsp_id, rule, timezone, created_by)
  values (v_dsp, coalesce(p_rule, '{}'::jsonb), p_timezone, auth.uid())
  returning id into v_series;

  for v_occ in select * from jsonb_array_elements(p_occurrences) loop
    if v_occ->>'s' is null then
      raise exception 'occurrence_missing_start';
    end if;

    v_meta := jsonb_build_object(
      'invitees', case when v_i = 0 then to_jsonb(coalesce(p_invitees, '{}'::text[])) else '[]'::jsonb end,
      'note', p_note
    ) || coalesce(p_extra, '{}'::jsonb);
    -- Per-invitee tokens live on the anchor only (the RSVP row).
    if v_i = 0 and p_invitee_tokens is not null and p_rsvp_token is not null then
      v_meta := v_meta || jsonb_build_object('invitee_tokens', p_invitee_tokens);
    end if;

    insert into public.cal_events
      (dsp_id, applicant_id, kind, status, provider, starts_at, ends_at, timezone,
       title, meeting_url, calendar_id, series_id, rsvp, rsvp_token, metadata)
    values
      (v_dsp, null, 'event', 'scheduled', 'routeready',
       (v_occ->>'s')::timestamptz, (v_occ->>'e')::timestamptz, p_timezone,
       btrim(p_title), p_meeting_url, p_calendar_id, v_series,
       case when v_i = 0 and v_has_inv then 'pending' else 'accepted' end,
       case when v_i = 0 then p_rsvp_token else null end,
       v_meta)
    returning id into v_id;

    if v_i = 0 then v_anchor := v_id; end if;
    v_i := v_i + 1;
  end loop;

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
        v_tok := null;
        if p_invitee_tokens is not null and p_rsvp_token is not null then
          select key into v_tok
            from jsonb_each_text(p_invitee_tokens)
           where value = v_email
           limit 1;
        end if;
        insert into public.email_messages
          (dsp_id, cal_event_id, calendar_method, direction, status, to_email, subject, body_text, body_html)
        values
          (v_dsp, v_anchor, 'request', 'outbound', 'queued', v_email, v_subject,
           case when v_tok is not null then replace(v_text, p_rsvp_token, v_tok) else v_text end,
           case when v_tok is not null then replace(v_html, p_rsvp_token, v_tok) else v_html end);
      end if;
    end loop;
  end if;

  return jsonb_build_object('series_id', v_series, 'anchor_id', v_anchor, 'count', v_n);
end;
$$;

grant execute on function public.create_calendar_series(text, jsonb, jsonb, text[], text, text, text, text, text, text, uuid, jsonb, jsonb) to authenticated;

-- ── 3 · meeting lock ─────────────────────────────────────────────────────

alter table public.meetings add column if not exists locked boolean not null default false;

create or replace function public.meet_set_locked(p_code text, p_locked boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_norm text := regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9]', '', 'g');
  v_row  public.meetings;
begin
  select * into v_row
    from public.meetings m
   where replace(m.code, '-', '') = v_norm
   limit 1;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if not (v_row.host_id = auth.uid()
          or private.is_staff(v_row.dsp_id, 'dispatcher')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.meetings
     set locked = coalesce(p_locked, false)
   where id = v_row.id
   returning * into v_row;

  return jsonb_build_object('ok', true, 'code', v_row.code, 'locked', v_row.locked);
end; $$;

grant execute on function public.meet_set_locked(text, boolean) to authenticated;

-- meet_lookup reports the lock so the meeting page can hold guests out.
create or replace function public.meet_lookup(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_norm text := regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9]', '', 'g');
  v_row  public.meetings;
begin
  if v_norm = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_code');
  end if;

  select * into v_row
    from public.meetings m
   where replace(m.code, '-', '') = v_norm
   limit 1;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', v_row.code,
    'title', v_row.title,
    'host_name', v_row.host_name,
    'created_at', v_row.created_at,
    'ended', v_row.ended_at is not null,
    'locked', coalesce(v_row.locked, false),
    'is_host', coalesce(v_row.host_id = auth.uid(), false));
end; $$;

grant execute on function public.meet_lookup(text) to anon, authenticated;

notify pgrst, 'reload schema';
