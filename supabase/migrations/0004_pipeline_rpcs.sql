-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0004 · Pipeline RPCs
--
-- Server-side functions exposed via PostgREST. The dashboard never writes
-- raw rows — it calls these. Each function:
--   • is SECURITY DEFINER so it can write across tables under a single
--     consistent rule set (RLS still applies to the rows they touch via
--     the underlying tables).
--   • either checks tenant via private.is_staff(...) or, for the public
--     applicant-facing entry points, checks an explicit signed token on
--     the applicant row.
--
-- The /pipeline UI calls only:
--   pipeline_counts(), pipeline_list(stage), applicant_detail(id),
--   send_screening_link, send_booking_link, decline_applicant,
--   hire_applicant, mark_no_show, set_applicant_stage.
--
-- The screening + booking pages (anon) call:
--   screening_load(token), screening_submit(token, answers).
--
-- Edge functions (service-role) call book_interview / book_orientation
-- directly from Cal.com webhook payloads.
-- ─────────────────────────────────────────────────────────────────────────


-- ─── helpers ─────────────────────────────────────────────────────────────

-- Resolve token → applicant. Tokens live in applicants.metadata->'tokens'
-- as { "screening": "<uuid>", "booking": "<uuid>" }. Cheap, opaque, and
-- rotateable: a fresh send_*_link RPC just regenerates the token.
create or replace function private.applicant_for_token(p_kind text, p_token text)
returns public.applicants
language sql
stable
security definer
set search_path = ''
as $$
  select a.*
  from public.applicants a
  where a.metadata #>> array['tokens', p_kind] = p_token
  limit 1;
$$;

-- Pull the body of a template, with {{token}} substitution. We keep the
-- substitution logic in SQL so there's one source of truth across SMS
-- and email senders.
create or replace function private.render_template(p_dsp_id uuid, p_channel public.message_channel, p_key text, p_vars jsonb)
returns table (subject text, body text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t_subject text;
  t_body    text;
  k text;
begin
  select subject, body
    into t_subject, t_body
  from public.message_templates
  where dsp_id = p_dsp_id
    and channel = p_channel
    and key = p_key
    and active = true
  limit 1;

  if t_body is null then
    raise exception 'template_not_found: dsp=%, channel=%, key=%', p_dsp_id, p_channel, p_key;
  end if;

  for k in select jsonb_object_keys(coalesce(p_vars, '{}'::jsonb))
  loop
    t_body    := replace(t_body,    '{{' || k || '}}', coalesce(p_vars->>k, ''));
    t_subject := replace(t_subject, '{{' || k || '}}', coalesce(p_vars->>k, ''));
  end loop;

  return query select t_subject, t_body;
end;
$$;


-- ─── pipeline_counts ─────────────────────────────────────────────────────

create or replace function public.pipeline_counts()
returns table (stage text, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select pipeline_stage, count(*)::bigint
  from public.applicants_pipeline
  where dsp_id = private.current_dsp_id()
    and pipeline_stage <> 'closed'
  group by pipeline_stage
  union all
  select 'all', count(*)::bigint
  from public.applicants_pipeline
  where dsp_id = private.current_dsp_id()
    and pipeline_stage <> 'closed';
$$;

grant execute on function public.pipeline_counts() to authenticated;


-- ─── pipeline_list ───────────────────────────────────────────────────────
--
-- Returns one row per applicant in the requested visual stage, with the
-- joined fields the card needs: most recent cal_event, last sms direction
-- + status, total messages count.

create or replace function public.pipeline_list(p_stage text default 'all', p_limit int default 200)
returns table (
  id                uuid,
  full_name         text,
  email             text,
  phone             text,
  source            text,
  status            public.applicant_status,
  pipeline_stage    text,
  score             int,
  station_id        uuid,
  station_code      text,
  created_at        timestamptz,
  screening_completed_at timestamptz,
  next_event_starts_at timestamptz,
  next_event_kind   public.cal_event_kind,
  next_event_status public.cal_event_status,
  last_sms_at       timestamptz,
  last_sms_status   public.message_status,
  message_count     bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select * from public.applicants_pipeline
    where dsp_id = private.current_dsp_id()
      and (p_stage = 'all' or pipeline_stage = p_stage)
      and pipeline_stage <> 'closed'
    order by score desc nulls last, created_at desc
    limit greatest(p_limit, 1)
  ),
  next_event as (
    select distinct on (applicant_id)
      applicant_id, starts_at, kind, status
    from public.cal_events
    where dsp_id = private.current_dsp_id()
      and status in ('scheduled','rescheduled')
    order by applicant_id, starts_at asc
  ),
  last_sms as (
    select distinct on (applicant_id)
      applicant_id, created_at, status
    from public.sms_messages
    where dsp_id = private.current_dsp_id()
      and applicant_id is not null
    order by applicant_id, created_at desc
  ),
  msg_counts as (
    select applicant_id, count(*)::bigint as n
    from public.sms_messages
    where dsp_id = private.current_dsp_id()
      and applicant_id is not null
    group by applicant_id
  )
  select
    b.id, b.full_name, b.email, b.phone, b.source,
    b.status, b.pipeline_stage, b.score,
    b.station_id, s.code,
    b.created_at, b.screening_completed_at,
    ne.starts_at, ne.kind, ne.status,
    ls.created_at, ls.status,
    coalesce(mc.n, 0)
  from base b
  left join public.stations s   on s.id = b.station_id
  left join next_event ne       on ne.applicant_id = b.id
  left join last_sms ls         on ls.applicant_id = b.id
  left join msg_counts mc       on mc.applicant_id = b.id;
$$;

grant execute on function public.pipeline_list(text, int) to authenticated;


-- ─── applicant_detail ────────────────────────────────────────────────────

create or replace function public.applicant_detail(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_applicant jsonb;
  v_responses jsonb;
  v_events    jsonb;
  v_sms       jsonb;
  v_history   jsonb;
begin
  select to_jsonb(a) into v_applicant
  from public.applicants a where a.id = p_id and a.dsp_id = v_dsp;

  if v_applicant is null then
    raise exception 'applicant_not_found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'question_id', q.id, 'prompt', q.prompt, 'field_type', q.field_type,
    'answer_text', r.answer_text, 'answer_json', r.answer_json,
    'score_awarded', r.score_awarded, 'hard_filter_failed', r.hard_filter_failed,
    'answered_at', r.created_at
  ) order by q.display_order), '[]'::jsonb) into v_responses
  from public.screening_questions q
  left join public.screening_responses r
    on r.question_id = q.id and r.applicant_id = p_id
  where q.dsp_id = v_dsp and q.active = true;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.starts_at desc), '[]'::jsonb) into v_events
  from public.cal_events c where c.applicant_id = p_id and c.dsp_id = v_dsp;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at desc), '[]'::jsonb) into v_sms
  from public.sms_messages m where m.applicant_id = p_id and m.dsp_id = v_dsp;

  select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at asc), '[]'::jsonb) into v_history
  from public.applicant_status_changes h where h.applicant_id = p_id and h.dsp_id = v_dsp;

  return jsonb_build_object(
    'applicant', v_applicant,
    'responses', v_responses,
    'events', v_events,
    'sms', v_sms,
    'history', v_history
  );
end;
$$;

grant execute on function public.applicant_detail(uuid) to authenticated;


-- ─── set_applicant_stage / decline / hire / mark_no_show ─────────────────

create or replace function public.set_applicant_status(
  p_id uuid,
  p_to public.applicant_status,
  p_reason text default null
)
returns public.applicants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.applicants;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.applicants
     set status = p_to,
         auto_declined_reason = case when p_to = 'auto_declined' then p_reason else auto_declined_reason end,
         notes = case when p_reason is not null and p_to in ('rejected','no_show')
                      then coalesce(notes, '') || E'\n[' || now()::date || '] ' || p_reason
                      else notes end
   where id = p_id and dsp_id = v_dsp
  returning * into v_row;

  if v_row.id is null then
    raise exception 'applicant_not_found' using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

grant execute on function public.set_applicant_status(uuid, public.applicant_status, text) to authenticated;

create or replace function public.decline_applicant(p_id uuid, p_reason text)
returns public.applicants
language sql
security definer
set search_path = ''
as $$
  select public.set_applicant_status(p_id, 'rejected', p_reason);
$$;
grant execute on function public.decline_applicant(uuid, text) to authenticated;

create or replace function public.hire_applicant(p_id uuid)
returns public.applicants
language sql
security definer
set search_path = ''
as $$
  select public.set_applicant_status(p_id, 'hired', null);
$$;
grant execute on function public.hire_applicant(uuid) to authenticated;

create or replace function public.mark_no_show(p_id uuid)
returns public.applicants
language sql
security definer
set search_path = ''
as $$
  select public.set_applicant_status(p_id, 'no_show', 'Marked no-show by operator');
$$;
grant execute on function public.mark_no_show(uuid) to authenticated;


-- ─── send_screening_link / send_booking_link ─────────────────────────────
--
-- These just queue an sms_messages row (status='queued') and stamp the
-- token on the applicant. The send-sms edge function picks queued rows
-- and actually dispatches via Twilio. Keeps the DB transaction synchronous
-- and side-effect-free if Twilio is down.

create or replace function private.upsert_token(p_applicant uuid, p_kind text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t text := replace(gen_random_uuid()::text, '-', '');
begin
  update public.applicants
     set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), array['tokens', p_kind], to_jsonb(t))
   where id = p_applicant;
  return t;
end;
$$;

create or replace function public.send_screening_link(p_id uuid)
returns public.sms_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_app public.applicants;
  v_token text;
  v_link  text;
  v_msg   record;
  v_row   public.sms_messages;
  v_base  text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_app from public.applicants where id = p_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;
  if v_app.phone is null then raise exception 'applicant_has_no_phone'; end if;

  v_token := private.upsert_token(p_id, 'screening');

  select coalesce(metadata->>'public_base_url', 'https://gorouteready.com')
    into v_base
  from public.dsps where id = v_dsp;

  v_link := v_base || '/dashboard/screening.html?t=' || v_token;

  select * into v_msg from private.render_template(
    v_dsp, 'sms', 'applicant.invite_screening',
    jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name), 'link', v_link)
  );

  insert into public.sms_messages
    (dsp_id, applicant_id, direction, status, to_phone, body)
  values
    (v_dsp, p_id, 'outbound', 'queued', v_app.phone, v_msg.body)
  returning * into v_row;

  -- Promote 'applied' → 'contacted' on first send.
  if v_app.status = 'applied' then
    update public.applicants set status = 'contacted' where id = p_id;
  end if;

  return v_row;
end;
$$;
grant execute on function public.send_screening_link(uuid) to authenticated;

create or replace function public.send_booking_link(p_id uuid, p_kind public.cal_event_kind default 'interview')
returns public.sms_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_app public.applicants;
  v_token text;
  v_slug  text;
  v_cal_user text;
  v_link  text;
  v_msg   record;
  v_row   public.sms_messages;
  v_template_key text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_app from public.applicants where id = p_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;
  if v_app.phone is null then raise exception 'applicant_has_no_phone'; end if;

  v_token := private.upsert_token(p_id, 'booking');

  select metadata->'cal'->>(case when p_kind = 'interview' then 'interview_slug' else 'orientation_slug' end),
         metadata->'cal'->>'username'
    into v_slug, v_cal_user
  from public.dsps where id = v_dsp;

  v_slug := coalesce(v_slug, case when p_kind = 'interview' then 'interview' else 'orientation-day' end);
  v_cal_user := coalesce(v_cal_user, 'routeready');

  v_link := 'https://cal.com/' || v_cal_user || '/' || v_slug
            || '?metadata[applicant_id]=' || p_id::text
            || '&metadata[token]=' || v_token
            || '&name=' || replace(coalesce(v_app.full_name,''), ' ', '%20')
            || (case when v_app.email is not null then '&email=' || v_app.email else '' end);

  v_template_key := case when p_kind = 'interview'
                         then 'applicant.invite_interview'
                         else 'applicant.invite_orientation' end;

  select * into v_msg from private.render_template(
    v_dsp, 'sms', v_template_key,
    jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name), 'link', v_link)
  );

  insert into public.sms_messages
    (dsp_id, applicant_id, direction, status, to_phone, body)
  values
    (v_dsp, p_id, 'outbound', 'queued', v_app.phone, v_msg.body)
  returning * into v_row;

  update public.applicants
     set status = case
       when p_kind = 'interview'  then 'interview_invited'::public.applicant_status
       when p_kind = 'orientation' then 'orientation_invited'::public.applicant_status
     end
   where id = p_id
     and status not in ('hired','rejected','no_show');

  return v_row;
end;
$$;
grant execute on function public.send_booking_link(uuid, public.cal_event_kind) to authenticated;


-- ─── Public, anon-callable: screening flow ───────────────────────────────
--
-- The applicant clicks the screening link → screening.html loads with the
-- token → calls screening_load(token) to fetch the form → submits answers
-- via screening_submit(token, answers).

create or replace function public.screening_load(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_app public.applicants;
  v_questions jsonb;
begin
  v_app := private.applicant_for_token('screening', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;

  -- Don't leak status of declined / closed applicants to the public form.
  if v_app.status in ('rejected','auto_declined','hired','no_show') then
    raise exception 'screening_closed';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', q.id, 'prompt', q.prompt, 'field_type', q.field_type,
    'options', q.options, 'required', q.required, 'display_order', q.display_order
  ) order by q.display_order), '[]'::jsonb)
  into v_questions
  from public.screening_questions q
  where q.dsp_id = v_app.dsp_id and q.active = true;

  return jsonb_build_object(
    'applicant', jsonb_build_object(
      'id', v_app.id, 'first_name', v_app.first_name, 'full_name', v_app.full_name,
      'status', v_app.status
    ),
    'questions', v_questions
  );
end;
$$;
grant execute on function public.screening_load(text) to anon, authenticated;


create or replace function public.screening_submit(p_token text, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.applicants;
  a jsonb;
begin
  v_app := private.applicant_for_token('screening', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;
  if v_app.status in ('rejected','auto_declined','hired','no_show','interview_booked','orientation_booked') then
    raise exception 'screening_closed';
  end if;

  -- p_answers is [{question_id, answer_text?, answer_json?}, ...]
  for a in select * from jsonb_array_elements(p_answers)
  loop
    insert into public.screening_responses
      (dsp_id, applicant_id, question_id, answer_text, answer_json)
    values
      (v_app.dsp_id, v_app.id, (a->>'question_id')::uuid, a->>'answer_text', a->'answer_json')
    on conflict (applicant_id, question_id) do update
      set answer_text = excluded.answer_text,
          answer_json = excluded.answer_json;
  end loop;

  -- Triggers handle scoring + status transition. Re-read for the response.
  select to_jsonb(applicants.*) into a from public.applicants where id = v_app.id;
  return a;
end;
$$;
grant execute on function public.screening_submit(text, jsonb) to anon, authenticated;


-- ─── Booking lifecycle (called by webhook-cal edge function) ─────────────
--
-- These are SECURITY DEFINER and not granted to anon — only the service
-- role calls them, after verifying Cal.com's signature in the edge fn.

create or replace function public.book_event(
  p_applicant_id uuid,
  p_kind public.cal_event_kind,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_provider_event_id text,
  p_meeting_url text default null,
  p_location  text default null,
  p_timezone  text default null
)
returns public.cal_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app public.applicants;
  v_row public.cal_events;
begin
  select * into v_app from public.applicants where id = p_applicant_id;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;

  insert into public.cal_events
    (dsp_id, applicant_id, kind, status, provider_event_id, starts_at, ends_at, meeting_url, location, timezone)
  values
    (v_app.dsp_id, p_applicant_id, p_kind, 'scheduled', p_provider_event_id, p_starts_at, p_ends_at, p_meeting_url, p_location, p_timezone)
  on conflict (provider, provider_event_id) where provider_event_id is not null
  do update set
    status = 'rescheduled',
    starts_at = excluded.starts_at,
    ends_at = excluded.ends_at,
    meeting_url = excluded.meeting_url,
    location = excluded.location,
    timezone = excluded.timezone
  returning * into v_row;

  update public.applicants
     set status = case
       when p_kind = 'interview'   then 'interview_booked'::public.applicant_status
       when p_kind = 'orientation' then 'orientation_booked'::public.applicant_status
     end
   where id = p_applicant_id
     and status not in ('hired','rejected','no_show');

  return v_row;
end;
$$;

create or replace function public.cancel_event(p_provider_event_id text, p_reason text default null)
returns public.cal_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.cal_events;
begin
  update public.cal_events
     set status = 'cancelled',
         cancelled_at = now(),
         cancellation_reason = p_reason
   where provider_event_id = p_provider_event_id
   returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.complete_event(p_provider_event_id text, p_no_show boolean default false)
returns public.cal_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.cal_events;
begin
  update public.cal_events
     set status = case when p_no_show then 'no_show' else 'completed' end
   where provider_event_id = p_provider_event_id
  returning * into v_row;

  if v_row.id is null then return null; end if;

  if p_no_show then
    update public.applicants
       set status = 'no_show'
     where id = v_row.applicant_id
       and status not in ('hired','rejected');
  else
    update public.applicants
       set status = case
         when v_row.kind = 'interview' then 'interview_completed'::public.applicant_status
         else status
       end
     where id = v_row.applicant_id
       and status not in ('hired','rejected','no_show');
  end if;

  return v_row;
end;
$$;
