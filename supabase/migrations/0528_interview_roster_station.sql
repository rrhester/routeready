-- Migration 0528 · interview_day_roster · surface the applicant's station
--
-- Multi-station lens: the Onboarding → Interview tab lists everyone booked for
-- a given day, but the roster didn't carry each applicant's target station, so
-- the client couldn't scope it. This re-issues interview_day_roster (0259)
-- verbatim plus two columns — station_id + station_code (from the applicant's
-- station) — appended at the END so the existing positional consumers are
-- undisturbed. The client filters the roster (and its KPIs) by the selected
-- station; "All stations" shows everyone as before.
--
-- Adding columns changes the function's return type, which `create or replace`
-- can't do — drop it first. Safe: interview_day_roster is only ever called as a
-- PostgREST RPC from the client; nothing in the DB depends on it.

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
  decided_at      timestamptz,
  station_id      uuid,
  station_code    text
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
    o.decided_at,
    a.station_id,
    st.code
  from latest_event le
  join public.applicants a on a.id = le.applicant_id
  left join public.stations st on st.id = a.station_id
  left join public.interview_outcomes o
         on o.interview_day_id = v_day.id and o.applicant_id = a.id
  order by le.starts_at asc;
end;
$$;

grant execute on function public.interview_day_roster(uuid) to authenticated;

notify pgrst, 'reload schema';
