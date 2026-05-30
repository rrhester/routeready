-- Migration 0339 · record_outcome — re-hire moves an existing driver back
-- into Onboarding.
--
-- Bug (operator report): an applicant was marked Hired on Interview Day but
-- never showed up in the Onboarding pipeline. Cause: a driver row already
-- existed for that applicant (e.g. a prior 'inactive'/'terminated' stint).
-- record_outcome's hired branch only CREATES a driver when none exists
-- (`if v_driver_id is null`); when one already existed it left that row's
-- status untouched, so a re-hire stayed 'inactive' and the Onboarding list
-- (status = 'onboarding') never showed them.
--
-- Fix: on 'hired', if a driver row already exists for the applicant, move it
-- back into onboarding (status = 'onboarding', fresh hire_date) so the hire
-- surfaces in the pipeline like a brand-new one. New-applicant inserts are
-- unchanged. Everything else is identical to 0146 (best-effort notification).
--
-- Idempotent: plain create or replace, same 4-arg signature.

create or replace function public.record_outcome(
  p_applicant_id     uuid,
  p_outcome          public.interview_outcome,
  p_notes            text default null,
  p_interview_day_id uuid default null
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
  v_msg_error text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_app from public.applicants where id = p_applicant_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;

  -- Prefer the day the caller is showing.
  if p_interview_day_id is not null then
    select * into v_day from public.interview_days where id = p_interview_day_id and dsp_id = v_dsp;
  end if;

  -- Fallback: derive the day from the applicant's most recent active
  -- cal_event of any kind (matches interview_day_roster's filter).  If
  -- there's no booking on file at all, use today.
  if v_day.id is null then
    select timezone into v_tz from public.dsps where id = v_dsp;

    select (ce.starts_at at time zone coalesce(v_tz, 'UTC'))::date
      into v_event_date
    from public.cal_events ce
    where ce.dsp_id = v_dsp
      and ce.applicant_id = p_applicant_id
      and ce.status in ('scheduled','rescheduled','completed','no_show')
    order by ce.starts_at desc
    limit 1;

    if v_event_date is null then
      v_event_date := (now() at time zone coalesce(v_tz, 'UTC'))::date;
    end if;

    v_day := public.open_interview_day(v_event_date, null);
  end if;

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
    else
      -- A driver row already exists for this applicant (e.g. a prior
      -- inactive/terminated stint). Re-hiring must move them back into
      -- Onboarding so they surface in the pipeline, instead of leaving
      -- them in their old status.
      update public.drivers
         set status    = 'onboarding',
             hire_date = current_date
       where id = v_driver_id;
    end if;
  end if;

  -- Best-effort applicant notification.  A missing/broken outcome template
  -- (or any other failure here) must not unwind the outcome we just
  -- recorded, so run it in its own sub-block.
  begin
    perform private.queue_outcome_message(p_applicant_id, p_outcome::text);
  exception when others then
    v_msg_error := sqlerrm;
    raise notice 'record_outcome: queue_outcome_message failed for applicant % (%): %',
      p_applicant_id, p_outcome, v_msg_error;
  end;

  return jsonb_build_object(
    'applicant_id',     p_applicant_id,
    'outcome',          p_outcome,
    'driver_id',        v_driver_id,
    'interview_day_id', v_day.id,
    'message_error',    v_msg_error
  );
end;
$$;
grant execute on function public.record_outcome(uuid, public.interview_outcome, text, uuid) to authenticated;

notify pgrst, 'reload schema';
