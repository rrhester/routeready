-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0014 · Interview-day RPCs + KPI calc + driver auto-creation
--
-- Operator surface for the Interview Day subtab:
--   open_interview_day(date?)          → opens or returns an existing
--                                         open day for that date.
--   current_interview_day()            → returns the latest open day
--                                         (today's, by default).
--   interview_day_roster(day_id?)      → list of applicants booked for
--                                         that day with current outcome
--                                         (if any).
--   record_outcome(applicant_id,
--                  outcome, notes?)    → upserts the per-applicant
--                                         decision, updates applicants.
--                                         status, and on 'hired' creates
--                                         a public.drivers row.
--   close_interview_day(id?)           → marks remaining-but-undecided
--                                         booked applicants as no_show,
--                                         freezes day totals, sets
--                                         closed_at.
--   pipeline_kpis(window_days?)        → returns show_rate / hire_rate
--                                         from the rolling window of
--                                         closed days; falls back to
--                                         0.75 / 0.75 industry standard
--                                         when no closed days yet.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── open_interview_day ─────────────────────────────────────────────────

create or replace function public.open_interview_day(p_date date default null, p_station_id uuid default null)
returns public.interview_days
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_tz  text;
  v_date date;
  v_row public.interview_days;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Resolve "today" in the DSP's local timezone if no date passed.
  select timezone into v_tz from public.dsps where id = v_dsp;
  v_date := coalesce(p_date, (now() at time zone coalesce(v_tz, 'UTC'))::date);

  -- Reuse an open day if it exists.
  select * into v_row
  from public.interview_days
  where dsp_id = v_dsp and date = v_date and closed_at is null
  limit 1;
  if v_row.id is not null then return v_row; end if;

  insert into public.interview_days (dsp_id, station_id, date)
  values (v_dsp, p_station_id, v_date)
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.open_interview_day(date, uuid) to authenticated;


-- ─── current_interview_day ──────────────────────────────────────────────

create or replace function public.current_interview_day()
returns public.interview_days
language sql
stable
security definer
set search_path = ''
as $$
  select *
  from public.interview_days
  where dsp_id = private.current_dsp_id()
    and closed_at is null
  order by date desc, opened_at desc
  limit 1;
$$;
grant execute on function public.current_interview_day() to authenticated;


-- ─── interview_day_roster ───────────────────────────────────────────────
--
-- Returns applicants whose interview event falls on the day's date.
-- We join cal_events to find the booked timeslot. Outcomes (if recorded)
-- come back too so the UI can render the row state.

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
  select
    a.id,
    a.full_name,
    a.email,
    a.phone,
    a.source,
    a.score,
    a.video_url,
    ce.starts_at,
    ce.status,
    o.outcome,
    o.notes,
    o.decided_at
  from public.cal_events ce
  join public.applicants a on a.id = ce.applicant_id
  left join public.interview_outcomes o
         on o.interview_day_id = v_day.id and o.applicant_id = a.id
  where ce.dsp_id = v_dsp
    and ce.kind = 'interview'
    and ce.status in ('scheduled','rescheduled','completed','no_show')
    and (ce.starts_at at time zone coalesce(v_tz, 'UTC'))::date = v_day.date
  order by ce.starts_at asc;
end;
$$;
grant execute on function public.interview_day_roster(uuid) to authenticated;


-- ─── record_outcome ─────────────────────────────────────────────────────

create or replace function public.record_outcome(
  p_applicant_id uuid,
  p_outcome      public.interview_outcome,
  p_notes        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_app public.applicants;
  v_day public.interview_days;
  v_driver_id uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Open a day for today if none exists; idempotent if already open.
  v_day := public.open_interview_day(null, null);

  select * into v_app from public.applicants where id = p_applicant_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;

  -- Upsert the outcome.
  insert into public.interview_outcomes
    (dsp_id, interview_day_id, applicant_id, outcome, decided_by, notes)
  values
    (v_dsp, v_day.id, p_applicant_id, p_outcome, v_uid, p_notes)
  on conflict (interview_day_id, applicant_id) do update
    set outcome = excluded.outcome,
        decided_by = excluded.decided_by,
        notes = excluded.notes,
        decided_at = now();

  -- Update the master applicant status. Per requirements: both no_hire
  -- and no_show roll up to 'not_hired' on the master row; granular
  -- distinction stays on interview_outcomes.
  update public.applicants
     set status = case
       when p_outcome = 'hired'  then 'hired'::public.applicant_status
       else 'not_hired'::public.applicant_status
     end
   where id = p_applicant_id;

  -- On hire, create a driver row (or return the existing one if this is
  -- a re-click). Compute initials for tier badge fallback.
  if p_outcome = 'hired' then
    select id into v_driver_id from public.drivers
     where applicant_id = p_applicant_id and dsp_id = v_dsp
     limit 1;

    if v_driver_id is null then
      insert into public.drivers
        (dsp_id, station_id, applicant_id,
         first_name, last_name, full_name, email, phone,
         status, hire_date)
      values
        (v_dsp, v_app.station_id, v_app.id,
         v_app.first_name, v_app.last_name, v_app.full_name, v_app.email, v_app.phone,
         'onboarding', current_date)
      returning id into v_driver_id;
    end if;
  end if;

  return jsonb_build_object(
    'applicant_id',     p_applicant_id,
    'outcome',          p_outcome,
    'driver_id',        v_driver_id,
    'interview_day_id', v_day.id
  );
end;
$$;
grant execute on function public.record_outcome(uuid, public.interview_outcome, text) to authenticated;


-- ─── close_interview_day ────────────────────────────────────────────────

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
  insert into public.interview_outcomes
    (dsp_id, interview_day_id, applicant_id, outcome, decided_by, notes)
  select v_dsp, v_day.id, a.id, 'no_show'::public.interview_outcome, v_uid,
         'Auto-marked no_show on day close'
  from public.cal_events ce
  join public.applicants a on a.id = ce.applicant_id
  left join public.interview_outcomes o
         on o.interview_day_id = v_day.id and o.applicant_id = a.id
  where ce.dsp_id = v_dsp
    and ce.kind = 'interview'
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
    count(*) filter (where ce.id is not null),
    count(*) filter (where o.outcome = 'hired'),
    count(*) filter (where o.outcome = 'no_hire'),
    count(*) filter (where o.outcome = 'no_show')
  into v_booked, v_hired, v_no_hire, v_no_show
  from public.cal_events ce
  join public.applicants a on a.id = ce.applicant_id
  left join public.interview_outcomes o
         on o.interview_day_id = v_day.id and o.applicant_id = a.id
  where ce.dsp_id = v_dsp
    and ce.kind = 'interview'
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


-- ─── pipeline_kpis ──────────────────────────────────────────────────────
--
-- Returns the rolling show / hire rate for the DSP. When zero closed days
-- exist, returns the industry-standard 0.75 / 0.75 fallback so the
-- dashboard isn't empty on day one.

create or replace function public.pipeline_kpis(p_window_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_booked int;
  v_hired  int;
  v_no_hire int;
  v_no_show int;
  v_show_rate numeric;
  v_hire_rate numeric;
  v_closed_count int;
begin
  select
    coalesce(sum(totals_booked),  0),
    coalesce(sum(totals_hired),   0),
    coalesce(sum(totals_no_hire), 0),
    coalesce(sum(totals_no_show), 0),
    count(*)
  into v_booked, v_hired, v_no_hire, v_no_show, v_closed_count
  from public.interview_days
  where dsp_id = v_dsp
    and closed_at is not null
    and date >= current_date - greatest(p_window_days, 1);

  if v_closed_count = 0 or v_booked = 0 then
    v_show_rate := 0.75;
    v_hire_rate := 0.75;
  else
    -- Show rate: of those booked, who actually showed up
    v_show_rate := round((v_booked - v_no_show)::numeric / v_booked, 2);
    -- Hire rate: of those who showed up (hired + no_hire), who got hired
    if (v_hired + v_no_hire) = 0 then
      v_hire_rate := 0;
    else
      v_hire_rate := round(v_hired::numeric / (v_hired + v_no_hire), 2);
    end if;
  end if;

  return jsonb_build_object(
    'show_rate',     v_show_rate,
    'hire_rate',     v_hire_rate,
    'is_default',    (v_closed_count = 0 or v_booked = 0),
    'window_days',   p_window_days,
    'closed_days',   v_closed_count,
    'booked',        v_booked,
    'hired',         v_hired,
    'no_hire',       v_no_hire,
    'no_show',       v_no_show
  );
end;
$$;
grant execute on function public.pipeline_kpis(int) to authenticated;
