-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0022 · Fix record_outcome day binding + onboarding milestones
--
-- Bug: record_outcome was opening today's interview_day every time, so
-- when the operator viewed a future booking (e.g. May 15), hit Hired,
-- and later closed the May 15 day, the day's `totals_*` were computed
-- against an empty cohort (no outcome rows on May 15) — close marked
-- the booked applicant as no_show, dropping show/hire rates to 0%.
--
-- Fix: derive the right interview_day from the applicant's interview
-- cal_event date. Open/reuse a day for that local date.
--
-- Also adds onboarding-milestone columns to drivers so the Onboarding
-- tab can swap its columns:
--   background_check_completed_at, drug_test_completed_at,
--   training_scheduled_at, training_date.
-- ─────────────────────────────────────────────────────────────────────────

-- Onboarding milestone columns.
alter table public.drivers
  add column if not exists background_check_completed_at  timestamptz,
  add column if not exists drug_test_completed_at         timestamptz,
  add column if not exists training_scheduled_at          timestamptz,
  add column if not exists training_date                  date;


-- Replace record_outcome to bind the outcome to the day that
-- corresponds to the applicant's interview slot, not "today".

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
  v_event_date date;
  v_tz text;
  v_driver_id uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_app from public.applicants where id = p_applicant_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;

  -- Find the interview cal_event for this applicant + the local date it
  -- falls on in the DSP's tz. We pick the most recent matching event;
  -- if none, fall back to today (rare — applicant marked outcome with
  -- no booking record, e.g. operator marked them via a manual flow).
  select timezone into v_tz from public.dsps where id = v_dsp;

  select (ce.starts_at at time zone coalesce(v_tz, 'UTC'))::date
    into v_event_date
  from public.cal_events ce
  where ce.dsp_id = v_dsp
    and ce.applicant_id = p_applicant_id
    and ce.kind = 'interview'
  order by ce.starts_at desc
  limit 1;

  if v_event_date is null then
    v_event_date := (now() at time zone coalesce(v_tz, 'UTC'))::date;
  end if;

  -- Open or reuse the day for that date.
  v_day := public.open_interview_day(v_event_date, null);

  insert into public.interview_outcomes
    (dsp_id, interview_day_id, applicant_id, outcome, decided_by, notes)
  values
    (v_dsp, v_day.id, p_applicant_id, p_outcome, v_uid, p_notes)
  on conflict (interview_day_id, applicant_id) do update
    set outcome = excluded.outcome,
        decided_by = excluded.decided_by,
        notes = excluded.notes,
        decided_at = now();

  update public.applicants
     set status = case
       when p_outcome = 'hired' then 'hired'::public.applicant_status
       else 'not_hired'::public.applicant_status
     end
   where id = p_applicant_id;

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

  perform private.queue_outcome_message(p_applicant_id, p_outcome::text);

  return jsonb_build_object(
    'applicant_id',     p_applicant_id,
    'outcome',          p_outcome,
    'driver_id',        v_driver_id,
    'interview_day_id', v_day.id,
    'event_date',       v_event_date
  );
end;
$$;
grant execute on function public.record_outcome(uuid, public.interview_outcome, text) to authenticated;


-- Operator RPC for per-driver field edits. Returns the updated row.
create or replace function public.update_driver_record(p_id uuid, p_payload jsonb)
returns public.drivers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.drivers;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.drivers
     set first_name              = coalesce(p_payload->>'first_name', first_name),
         last_name               = coalesce(p_payload->>'last_name', last_name),
         full_name               = coalesce(p_payload->>'full_name', full_name),
         preferred_name          = coalesce(p_payload->>'preferred_name', preferred_name),
         pronouns                = coalesce(p_payload->>'pronouns', pronouns),
         phone                   = coalesce(p_payload->>'phone', phone),
         email                   = coalesce(p_payload->>'email', email),
         address                 = coalesce(p_payload->>'address', address),
         birthday                = coalesce(nullif(p_payload->>'birthday','')::date, birthday),
         emergency_contact_name  = coalesce(p_payload->>'emergency_contact_name', emergency_contact_name),
         emergency_contact_phone = coalesce(p_payload->>'emergency_contact_phone', emergency_contact_phone),
         hire_date               = coalesce(nullif(p_payload->>'hire_date','')::date, hire_date),
         status                  = coalesce((p_payload->>'status')::public.driver_status, status),
         tier                    = coalesce(p_payload->>'tier', tier),
         dl_number               = coalesce(p_payload->>'dl_number', dl_number),
         dl_expires_on           = coalesce(nullif(p_payload->>'dl_expires_on','')::date, dl_expires_on),
         background_check_completed_at = coalesce(nullif(p_payload->>'background_check_completed_at','')::timestamptz, background_check_completed_at),
         drug_test_completed_at        = coalesce(nullif(p_payload->>'drug_test_completed_at','')::timestamptz, drug_test_completed_at),
         training_scheduled_at         = coalesce(nullif(p_payload->>'training_scheduled_at','')::timestamptz, training_scheduled_at),
         training_date                 = coalesce(nullif(p_payload->>'training_date','')::date, training_date)
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;

  if v_row.id is null then raise exception 'driver_not_found'; end if;
  return v_row;
end;
$$;
grant execute on function public.update_driver_record(uuid, jsonb) to authenticated;


-- Backfill: any applicant who is currently 'hired' but has interview_outcomes
-- on the wrong day's no_show should be re-stamped. (Idempotent cleanup for
-- existing rows that hit the bug.)
update public.applicants
   set status = 'hired'
 where status = 'not_hired'
   and id in (
     select io.applicant_id
     from public.interview_outcomes io
     where io.outcome = 'hired'
   );

-- Recompute interview_days totals for any closed days so existing rows
-- reflect the corrected outcome bindings.
update public.interview_days d
   set totals_booked  = (select count(*) from public.cal_events ce
                          join public.applicants a on a.id = ce.applicant_id
                          where ce.dsp_id = d.dsp_id and ce.kind = 'interview'
                            and (ce.starts_at at time zone coalesce(
                                   (select timezone from public.dsps where id = d.dsp_id),
                                   'UTC'))::date = d.date
                            and ce.status in ('scheduled','rescheduled','completed','no_show')),
       totals_hired   = (select count(*) from public.interview_outcomes o
                          where o.interview_day_id = d.id and o.outcome = 'hired'),
       totals_no_hire = (select count(*) from public.interview_outcomes o
                          where o.interview_day_id = d.id and o.outcome = 'no_hire'),
       totals_no_show = (select count(*) from public.interview_outcomes o
                          where o.interview_day_id = d.id and o.outcome = 'no_show')
 where closed_at is not null;
