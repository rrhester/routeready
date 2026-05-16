-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0259 · Applicant form prefill + silent booking removal
--
-- 1. screening_load: also return email, phone, last_name so the
--    applicant-facing form can prefill every contact field we already
--    have on file, not just first_name.
--
-- 2. interview_day_roster: also return event_id (the cal_events row that
--    put the applicant on this day). Lets the dashboard target the exact
--    booking for the silent-remove action below.
--
-- 3. cancel_cal_event_silent(event_id): operator-driven hard remove for
--    a booking. Cancels the cal_event without sending the applicant any
--    SMS/email or generating a re-booking link. If the applicant has no
--    other active interview events left, their status is reverted from
--    interview_booked → interview_invited so they stop sitting in the
--    Interview Day list. Solves the "I keep removing them and they keep
--    coming back" loop caused by cancel_interview's auto re-invite.
-- ─────────────────────────────────────────────────────────────────────────


-- ─── screening_load · return contact fields for prefill ────────────────

create or replace function public.screening_load(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_app public.applicants;
  v_dsp public.dsps;
  v_questions jsonb;
  v_video jsonb;
begin
  v_app := private.applicant_for_token('screening', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;
  if v_app.status in ('rejected','auto_declined','hired','no_show','not_hired') then
    raise exception 'screening_closed';
  end if;

  select * into v_dsp from public.dsps where id = v_app.dsp_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', q.id, 'prompt', q.prompt, 'field_type', q.field_type,
    'options', q.options, 'required', q.required, 'display_order', q.display_order
  ) order by q.display_order), '[]'::jsonb)
  into v_questions
  from public.screening_questions q
  where q.dsp_id = v_app.dsp_id and q.active = true;

  v_video := coalesce(v_dsp.metadata->'video', '{}'::jsonb);

  return jsonb_build_object(
    'dsp', jsonb_build_object(
      'name', v_dsp.name,
      'short_code', v_dsp.short_code
    ),
    'applicant', jsonb_build_object(
      'id',         v_app.id,
      'first_name', v_app.first_name,
      'last_name',  v_app.last_name,
      'full_name',  v_app.full_name,
      'email',      v_app.email,
      'phone',      v_app.phone,
      'status',     v_app.status
    ),
    'questions', v_questions,
    'video', jsonb_build_object(
      'enabled', coalesce((v_video->>'enabled')::boolean, true),
      'prompt',  coalesce(v_video->>'prompt',
                          'Tell us about yourself and why you''d be a great fit for our team.'),
      'max_seconds', coalesce((v_video->>'max_seconds')::int, 60)
    )
  );
end;
$$;

grant execute on function public.screening_load(text) to anon, authenticated;


-- ─── interview_day_roster · include event_id for targeted actions ──────
-- CREATE OR REPLACE can't change the RETURNS TABLE shape, so drop first.

drop function if exists public.interview_day_roster(uuid);

create or replace function public.interview_day_roster(p_day_id uuid default null)
returns table (
  applicant_id    uuid,
  full_name       text,
  email           text,
  phone           text,
  source          text,
  score           int,
  video_url       text,
  event_id        uuid,
  starts_at       timestamptz,
  cal_status      public.cal_event_status,
  outcome         public.interview_outcome,
  outcome_notes   text,
  decided_at      timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_day public.interview_days;
  v_tz  text;
begin
  if p_day_id is not null then
    select * into v_day from public.interview_days where id = p_day_id and dsp_id = v_dsp;
  else
    select * into v_day from public.interview_days where dsp_id = v_dsp and closed_at is null
      order by date desc, opened_at desc limit 1;
  end if;
  if v_day.id is null then return; end if;

  select timezone into v_tz from public.dsps where id = v_dsp;

  return query
  with latest_event as (
    select distinct on (ce.applicant_id)
      ce.id as event_id, ce.applicant_id, ce.starts_at, ce.status
    from public.cal_events ce
    where ce.dsp_id = v_dsp
      and ce.status in ('scheduled','rescheduled','completed','no_show')
      and (ce.starts_at at time zone coalesce(v_tz, 'UTC'))::date = v_day.date
    order by ce.applicant_id, ce.starts_at desc
  )
  select
    a.id,
    a.full_name,
    a.email,
    a.phone,
    a.source,
    a.score,
    a.video_url,
    le.event_id,
    le.starts_at,
    le.status,
    o.outcome,
    o.notes,
    o.decided_at
  from latest_event le
  join public.applicants a on a.id = le.applicant_id
  left join public.interview_outcomes o
         on o.interview_day_id = v_day.id and o.applicant_id = a.id
  order by le.starts_at asc;
end;
$$;

grant execute on function public.interview_day_roster(uuid) to authenticated;


-- ─── cancel_cal_event_silent · hard remove without messaging ───────────

create or replace function public.cancel_cal_event_silent(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_event public.cal_events;
  v_remaining int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_event from public.cal_events
   where id = p_event_id and dsp_id = v_dsp;
  if v_event.id is null then
    raise exception 'event_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent: cancelling an already-cancelled event is a no-op.
  if v_event.status in ('scheduled','rescheduled') then
    update public.cal_events
       set status = 'cancelled',
           cancelled_at = now(),
           cancellation_reason = 'Removed by operator (silent)'
     where id = v_event.id;
  end if;

  -- If the applicant has no other live interview events, drop them out of
  -- interview_booked so they aren't stuck in the booked column with no
  -- actual booking. interview_invited is the closest pre-booking state.
  if v_event.applicant_id is not null then
    select count(*) into v_remaining
    from public.cal_events
    where dsp_id = v_dsp
      and applicant_id = v_event.applicant_id
      and kind = v_event.kind
      and status in ('scheduled','rescheduled')
      and id <> v_event.id;

    if v_remaining = 0 then
      update public.applicants
         set status = 'interview_invited'::public.applicant_status
       where id = v_event.applicant_id
         and dsp_id = v_dsp
         and status = 'interview_booked'::public.applicant_status;
    end if;
  end if;

  return jsonb_build_object(
    'event_id', v_event.id,
    'applicant_id', v_event.applicant_id,
    'remaining_events', v_remaining
  );
end;
$$;

grant execute on function public.cancel_cal_event_silent(uuid) to authenticated;
