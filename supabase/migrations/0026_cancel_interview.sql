-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0026 · Cancel interview
--
-- DSPs need a way to cancel a booked interview and let the applicant know.
-- This adds:
--   • SMS + email templates for the cancellation notice (with a fresh
--     re-booking link interpolated)
--   • cancel_interview(applicant_id, reason?) RPC that:
--       - marks the latest active interview cal_event 'cancelled'
--       - queues the SMS (or email if no phone) with a re-booking link
--       - reverts the applicant status from interview_booked back to
--         interview_invited so they show up in the booking-pending stage
-- ─────────────────────────────────────────────────────────────────────────

insert into public.message_templates (dsp_id, channel, key, name, body)
select id, 'sms', 'applicant.interview_cancelled', 'Interview cancelled',
  'Hi {{first_name}}, we need to cancel your interview with RouteReady. We''re sorry for the inconvenience. Please use this link to pick a new time: {{link}}'
from public.dsps
on conflict (dsp_id, channel, key) do update
  set body = excluded.body,
      name = excluded.name,
      updated_at = now();

insert into public.message_templates (dsp_id, channel, key, name, subject, body)
select id, 'email', 'applicant.interview_cancelled', 'Interview cancelled (email)',
  'Your RouteReady interview has been cancelled',
  E'Hi {{first_name}},\n\nWe need to cancel your scheduled interview. We''re sorry for the inconvenience. Please use this link to pick a new time:\n\n{{link}}\n\n— The RouteReady team'
from public.dsps
on conflict (dsp_id, channel, key) do update
  set subject = excluded.subject,
      body    = excluded.body,
      name    = excluded.name,
      updated_at = now();


create or replace function public.cancel_interview(p_applicant_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_app public.applicants;
  v_event public.cal_events;
  v_token text;
  v_link  text;
  v_slug  text;
  v_cal_user text;
  v_msg record;
  v_sms_id uuid;
  v_email_id uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_app from public.applicants where id = p_applicant_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;

  -- Most recent active interview event (if any).
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

  -- Fresh re-booking link.
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

  -- SMS preferred when phone is on file; otherwise email.
  if v_app.phone is not null then
    select * into v_msg from private.render_template(
      v_dsp, 'sms', 'applicant.interview_cancelled',
      jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name), 'link', v_link)
    );
    insert into public.sms_messages
      (dsp_id, applicant_id, direction, status, to_phone, body)
    values
      (v_dsp, p_applicant_id, 'outbound', 'queued', v_app.phone, v_msg.body)
    returning id into v_sms_id;
  elsif v_app.email is not null then
    select * into v_msg from private.render_template(
      v_dsp, 'email', 'applicant.interview_cancelled',
      jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name), 'link', v_link)
    );
    insert into public.email_messages
      (dsp_id, applicant_id, direction, status, to_email, subject, body)
    values
      (v_dsp, p_applicant_id, 'outbound', 'queued', v_app.email, v_msg.subject, v_msg.body)
    returning id into v_email_id;
  end if;

  -- Revert applicant status so they show up in booking-pending.
  update public.applicants
     set status = 'interview_invited'::public.applicant_status
   where id = p_applicant_id
     and dsp_id = v_dsp
     and status = 'interview_booked'::public.applicant_status;

  return jsonb_build_object(
    'cancelled_event_id', v_event.id,
    'sms_id',   v_sms_id,
    'email_id', v_email_id,
    'rebook_link', v_link
  );
end;
$$;
grant execute on function public.cancel_interview(uuid, text) to authenticated;
