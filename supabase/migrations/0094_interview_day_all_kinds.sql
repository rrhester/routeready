-- Interview Day page should surface every applicant who's booked for
-- that date, regardless of whether webhook-cal classified the cal_event
-- as kind='interview' or kind='orientation'. Operators think in terms
-- of "who's coming in on May 22?" — the cal.com slug-driven enum split
-- was leaking through and hiding orientation bookings from the day-by-
-- day view (the funnel still showed them, which is how the operator
-- noticed they were missing on Interview Day).
--
-- Two functions to update so the visible list and the auto-no-show on
-- close stay in sync:

-- ─── interview_day_roster · accept any cal_event kind ──────────────────

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


-- ─── close_interview_day · same broadened filter ───────────────────────

create or replace function public.close_interview_day(p_day_id uuid default null)
returns public.interview_days
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_day public.interview_days;
  v_tz  text;
  v_booked int;
  v_hired  int;
  v_no_hire int;
  v_no_show int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_day_id is not null then
    select * into v_day from public.interview_days where id = p_day_id and dsp_id = v_dsp;
  else
    select * into v_day from public.interview_days where dsp_id = v_dsp and closed_at is null
      order by date desc, opened_at desc limit 1;
  end if;
  if v_day.id is null then raise exception 'no_open_interview_day'; end if;

  select timezone into v_tz from public.dsps where id = v_dsp;

  -- Anyone booked for the day with no recorded outcome → no_show.
  -- No kind filter: catches orientation bookings too.
  insert into public.interview_outcomes
    (dsp_id, interview_day_id, applicant_id, outcome, decided_by, notes)
  select v_dsp, v_day.id, a.id, 'no_show'::public.interview_outcome, v_uid,
         'Auto-marked no_show on day close'
  from public.cal_events ce
  join public.applicants a on a.id = ce.applicant_id
  left join public.interview_outcomes o
         on o.interview_day_id = v_day.id and o.applicant_id = a.id
  where ce.dsp_id = v_dsp
    and ce.status in ('scheduled','rescheduled','completed','no_show')
    and (ce.starts_at at time zone coalesce(v_tz, 'UTC'))::date = v_day.date
    and o.id is null
  on conflict (interview_day_id, applicant_id) do nothing;

  -- And update applicant.status for those auto-no_show rows.
  update public.applicants a
     set status = 'not_hired'::public.applicant_status
    from public.interview_outcomes o
   where o.interview_day_id = v_day.id
     and o.applicant_id = a.id
     and o.outcome = 'no_show'
     and a.status not in ('hired'::public.applicant_status);

  -- Compute totals and freeze.
  select
    count(distinct a.id) filter (where ce.id is not null),
    count(*) filter (where o.outcome = 'hired'),
    count(*) filter (where o.outcome = 'no_hire'),
    count(*) filter (where o.outcome = 'no_show')
  into v_booked, v_hired, v_no_hire, v_no_show
  from public.cal_events ce
  join public.applicants a on a.id = ce.applicant_id
  left join public.interview_outcomes o
         on o.interview_day_id = v_day.id and o.applicant_id = a.id
  where ce.dsp_id = v_dsp
    and ce.status in ('scheduled','rescheduled','completed','no_show')
    and (ce.starts_at at time zone coalesce(v_tz, 'UTC'))::date = v_day.date;

  update public.interview_days
     set totals_booked  = coalesce(v_booked, 0),
         totals_hired   = coalesce(v_hired, 0),
         totals_no_hire = coalesce(v_no_hire, 0),
         totals_no_show = coalesce(v_no_show, 0),
         closed_at = now(),
         closed_by = v_uid
   where id = v_day.id
   returning * into v_day;

  return v_day;
end;
$$;

grant execute on function public.close_interview_day(uuid) to authenticated;
