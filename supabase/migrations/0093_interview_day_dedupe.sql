-- Interview Day page was rendering an applicant twice when they had
-- more than one active cal_events row for the same day (most often a
-- rebook where the original wasn't cancelled). The roster query joined
-- cal_events directly with no per-applicant dedup, so each event row
-- produced its own card.
--
-- Pick the latest event per applicant for the day. DISTINCT ON over
-- (a.id) with ORDER BY ce.starts_at DESC keeps the most recent
-- timeslot, which is what the operator actually expects to see.

create or replace function public.interview_day_roster(p_day_id uuid default null)
returns table (
  applicant_id    uuid,
  full_name       text,
  email           text,
  phone           text,
  source          text,
  score           int,
  video_url       text,
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
      ce.applicant_id, ce.starts_at, ce.status
    from public.cal_events ce
    where ce.dsp_id = v_dsp
      and ce.kind = 'interview'
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
