-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0019 · Outcome notifications + driver no_show opt-in
--
-- When the operator marks an applicant Hired / No Hire / No Show in the
-- Interview Day view, fire a notification to the applicant. Channel:
-- SMS if a phone is on file, email otherwise.
--
-- Per request, no_show messages are opt-in via dsps.metadata.outcomes
-- .send_no_show. Hired and no_hire are always sent.
-- ─────────────────────────────────────────────────────────────────────────

-- Default the no_show opt-in to false on the demo DSP.
update public.dsps
   set metadata = coalesce(metadata, '{}'::jsonb)
                  || jsonb_build_object('outcomes',
                       coalesce(metadata->'outcomes', '{}'::jsonb)
                       || jsonb_build_object('send_no_show', false))
 where short_code = 'DEMO';


-- SMS templates.
insert into public.message_templates (dsp_id, channel, key, name, body) values
  ('00000000-0000-0000-0000-00000000d000', 'sms', 'applicant.outcome_hired',
   'Outcome · hired',
   'Congrats {{first_name}}! You''ve been hired at RouteReady. We''ll be in touch with onboarding details shortly. Welcome to the team!'),
  ('00000000-0000-0000-0000-00000000d000', 'sms', 'applicant.outcome_no_hire',
   'Outcome · not hired',
   'Hi {{first_name}}, thanks for taking the time to interview with RouteReady. We''ve decided to move forward with other candidates. We wish you the best in your job search.'),
  ('00000000-0000-0000-0000-00000000d000', 'sms', 'applicant.outcome_no_show',
   'Outcome · no show',
   'Hi {{first_name}}, we missed you at your interview today. If you''d still like to be considered, reply to this message and we''ll find another time.')
on conflict (dsp_id, channel, key) do update set body = excluded.body, updated_at = now();


-- Email versions (fallback when the applicant has no phone on file).
insert into public.message_templates (dsp_id, channel, key, name, subject, body) values
  ('00000000-0000-0000-0000-00000000d000', 'email', 'applicant.outcome_hired',
   'Outcome · hired (email)',
   'Welcome to the team',
   E'Congrats {{first_name}}!\n\nYou''ve been hired at RouteReady. We''ll be in touch with onboarding details shortly. Welcome to the team!\n\n— The RouteReady team'),
  ('00000000-0000-0000-0000-00000000d000', 'email', 'applicant.outcome_no_hire',
   'Outcome · not hired (email)',
   'Update on your RouteReady application',
   E'Hi {{first_name}},\n\nThanks for taking the time to interview with us. We''ve decided to move forward with other candidates. We wish you the best in your job search.\n\n— The RouteReady team'),
  ('00000000-0000-0000-0000-00000000d000', 'email', 'applicant.outcome_no_show',
   'Outcome · no show (email)',
   'We missed you',
   E'Hi {{first_name}},\n\nWe missed you at your interview today. If you''d still like to be considered, reply to this email and we''ll find another time.\n\n— The RouteReady team')
on conflict (dsp_id, channel, key) do update set body = excluded.body, subject = excluded.subject, updated_at = now();


-- ─── Helper: dispatch outcome message for an applicant ──────────────────

create or replace function private.queue_outcome_message(p_applicant_id uuid, p_outcome text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app  public.applicants;
  v_dsp  public.dsps;
  v_key  text;
  v_msg  record;
begin
  select * into v_app from public.applicants where id = p_applicant_id;
  if v_app.id is null then return; end if;

  select * into v_dsp from public.dsps where id = v_app.dsp_id;

  -- Honor the no_show opt-in.
  if p_outcome = 'no_show'
     and not coalesce((v_dsp.metadata->'outcomes'->>'send_no_show')::boolean, false) then
    return;
  end if;

  v_key := 'applicant.outcome_' || p_outcome;

  if v_app.phone is not null then
    -- SMS path.
    select * into v_msg from private.render_template(
      v_app.dsp_id, 'sms', v_key,
      jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name))
    );
    insert into public.sms_messages
      (dsp_id, applicant_id, direction, status, to_phone, body)
    values
      (v_app.dsp_id, v_app.id, 'outbound', 'queued', v_app.phone, v_msg.body);

  elsif v_app.email is not null then
    -- Email fallback.
    select * into v_msg from private.render_template(
      v_app.dsp_id, 'email', v_key,
      jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name))
    );
    insert into public.email_messages
      (dsp_id, applicant_id, direction, status, to_email, subject, body_text)
    values
      (v_app.dsp_id, v_app.id, 'outbound', 'queued', v_app.email, v_msg.subject, v_msg.body);
  end if;

  -- If neither phone nor email, nothing to send. Quiet no-op.
end;
$$;


-- Replace record_outcome to also queue the notification at the end.
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

  v_day := public.open_interview_day(null, null);

  select * into v_app from public.applicants where id = p_applicant_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;

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

  -- Fire the outcome notification (SMS preferred, email fallback). Quietly
  -- skips no_show when the DSP hasn't opted in.
  perform private.queue_outcome_message(p_applicant_id, p_outcome::text);

  return jsonb_build_object(
    'applicant_id',     p_applicant_id,
    'outcome',          p_outcome,
    'driver_id',        v_driver_id,
    'interview_day_id', v_day.id
  );
end;
$$;
grant execute on function public.record_outcome(uuid, public.interview_outcome, text) to authenticated;
