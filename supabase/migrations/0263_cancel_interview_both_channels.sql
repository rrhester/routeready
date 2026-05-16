-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0263 · cancel_interview · fan out to email alongside SMS
--
-- Operator: "I requested to reschedule an interview and no email was
-- sent back to the applicant." cancel_interview (which powers both the
-- Reschedule and Cancel interview buttons on the dashboard) was missed
-- by 0258_send_both_channels — it still picks one channel:
--   • phone present → SMS only
--   • no phone      → email only
--
-- For applicants with both phone and email on file, that means SMS
-- delivery failures (Twilio block, A2P, quiet hours, non-mobile line)
-- silently fail with no fallback. The applicant gets nothing.
--
-- New rule, matching 0258:
--   • phone AND email → queue BOTH (SMS + email)
--   • phone only      → queue SMS
--   • email only      → queue email
--   • neither         → no message, but the cal_event is still
--                       cancelled (the operator can follow up manually)
--
-- Return shape is back-compat: sms_id / email_id are still nullable
-- depending on which channels actually ran.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.cancel_interview(p_applicant_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp      uuid := private.current_dsp_id();
  v_app      public.applicants;
  v_event    public.cal_events;
  v_token    text;
  v_link     text;
  v_slug     text;
  v_cal_user text;
  v_msg      record;
  v_vars     jsonb;
  v_sms_id   uuid;
  v_email_id uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_app from public.applicants where id = p_applicant_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;

  select * into v_event
  from public.cal_events
  where dsp_id = v_dsp
    and applicant_id = p_applicant_id
    and kind = 'interview'
    and status in ('scheduled','rescheduled')
  order by starts_at desc
  limit 1;

  if v_event.id is not null then
    update public.cal_events
       set status = 'cancelled',
           cancelled_at = now(),
           cancellation_reason = p_reason
     where id = v_event.id;
  end if;

  v_token := private.upsert_token(p_applicant_id, 'booking');

  select metadata->'cal'->>'interview_slug', metadata->'cal'->>'username'
    into v_slug, v_cal_user
  from public.dsps where id = v_dsp;
  v_slug     := coalesce(v_slug, 'interview');
  v_cal_user := coalesce(v_cal_user, 'Routeready');

  v_link := 'https://cal.com/' || v_cal_user || '/' || v_slug
            || '?metadata[applicant_id]=' || p_applicant_id::text
            || '&metadata[token]=' || v_token
            || '&name=' || replace(coalesce(v_app.full_name,''), ' ', '%20')
            || (case when v_app.email is not null then '&email=' || v_app.email else '' end);

  v_vars := jsonb_build_object(
    'first_name', coalesce(v_app.first_name, v_app.full_name),
    'link',       v_link
  );

  if v_app.phone is not null then
    select * into v_msg from private.render_template(
      v_dsp, 'sms', 'applicant.interview_cancelled', v_vars
    );
    insert into public.sms_messages
      (dsp_id, applicant_id, direction, status, to_phone, body)
    values
      (v_dsp, p_applicant_id, 'outbound', 'queued', v_app.phone, v_msg.body)
    returning id into v_sms_id;
  end if;

  if v_app.email is not null then
    select * into v_msg from private.render_template(
      v_dsp, 'email', 'applicant.interview_cancelled', v_vars
    );
    insert into public.email_messages
      (dsp_id, applicant_id, direction, status, to_email, subject, body_text)
    values
      (v_dsp, p_applicant_id, 'outbound', 'queued', v_app.email, v_msg.subject, v_msg.body)
    returning id into v_email_id;
  end if;

  update public.applicants
     set status = 'interview_invited'::public.applicant_status
   where id = p_applicant_id
     and dsp_id = v_dsp
     and status = 'interview_booked'::public.applicant_status;

  return jsonb_build_object(
    'cancelled_event_id', v_event.id,
    'sms_id',     v_sms_id,
    'email_id',   v_email_id,
    'rebook_link', v_link
  );
end;
$$;
grant execute on function public.cancel_interview(uuid, text) to authenticated;

notify pgrst, 'reload schema';
