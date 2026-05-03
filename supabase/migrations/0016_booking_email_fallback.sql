-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0016 · send_booking_link falls back to email when no phone
--
-- Same parity fix we applied to send_screening_link in 0009. Operators
-- pulling email-only applicants from Indeed (or anyone whose Twilio
-- account is still pending approval) need a way to get the booking
-- link out the door. Dispatch:
--
--   phone present                 → SMS via applicant.invite_<kind> (sms)
--   no phone, email present       → email via applicant.invite_<kind> (email)
--   neither                       → applicant_has_no_contact
--
-- Returns jsonb { channel, message_id, kind } so callers can render
-- channel-aware feedback.
-- ─────────────────────────────────────────────────────────────────────────

drop function if exists public.send_booking_link(uuid, public.cal_event_kind);

create or replace function public.send_booking_link(
  p_id   uuid,
  p_kind public.cal_event_kind default 'interview'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_app        public.applicants;
  v_token      text;
  v_slug       text;
  v_cal_user   text;
  v_link       text;
  v_msg        record;
  v_template_key text;
  v_sms_id     uuid;
  v_email_id   uuid;
  v_channel    text;
  v_message_id uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_app from public.applicants where id = p_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;
  if v_app.phone is null and v_app.email is null then
    raise exception 'applicant_has_no_contact';
  end if;

  v_token := private.upsert_token(p_id, 'booking');

  select metadata->'cal'->>(case when p_kind = 'interview' then 'interview_slug' else 'orientation_slug' end),
         metadata->'cal'->>'username'
    into v_slug, v_cal_user
  from public.dsps where id = v_dsp;

  v_slug     := coalesce(v_slug, case when p_kind = 'interview' then 'interview' else 'orientation-day' end);
  v_cal_user := coalesce(v_cal_user, 'Routeready');

  v_link := 'https://cal.com/' || v_cal_user || '/' || v_slug
            || '?metadata[applicant_id]=' || p_id::text
            || '&metadata[token]=' || v_token
            || '&name=' || replace(coalesce(v_app.full_name, ''), ' ', '%20')
            || (case when v_app.email is not null then '&email=' || v_app.email else '' end);

  v_template_key := case when p_kind = 'interview'
                         then 'applicant.invite_interview'
                         else 'applicant.invite_orientation' end;

  if v_app.phone is not null then
    select * into v_msg from private.render_template(
      v_dsp, 'sms', v_template_key,
      jsonb_build_object(
        'first_name', coalesce(v_app.first_name, v_app.full_name),
        'link',       v_link
      )
    );

    insert into public.sms_messages
      (dsp_id, applicant_id, direction, status, to_phone, body)
    values
      (v_dsp, p_id, 'outbound', 'queued', v_app.phone, v_msg.body)
    returning id into v_sms_id;

    v_channel    := 'sms';
    v_message_id := v_sms_id;

  else
    select * into v_msg from private.render_template(
      v_dsp, 'email', v_template_key,
      jsonb_build_object(
        'first_name', coalesce(v_app.first_name, v_app.full_name),
        'link',       v_link
      )
    );

    insert into public.email_messages
      (dsp_id, applicant_id, direction, status, to_email, subject, body_text)
    values
      (v_dsp, p_id, 'outbound', 'queued', v_app.email, v_msg.subject, v_msg.body)
    returning id into v_email_id;

    v_channel    := 'email';
    v_message_id := v_email_id;
  end if;

  -- Status promotion regardless of channel.
  update public.applicants
     set status = case
       when p_kind = 'interview'   then 'interview_invited'::public.applicant_status
       when p_kind = 'orientation' then 'orientation_invited'::public.applicant_status
     end
   where id = p_id
     and status not in ('hired','rejected','no_show','not_hired');

  return jsonb_build_object(
    'channel',    v_channel,
    'message_id', v_message_id,
    'kind',       p_kind
  );
end;
$$;

grant execute on function public.send_booking_link(uuid, public.cal_event_kind) to authenticated;


-- Seed the email templates for orientation invites if missing (interview
-- email template was already seeded in 0005).
insert into public.message_templates (dsp_id, channel, key, name, subject, body)
values
  ('00000000-0000-0000-0000-00000000d000', 'email', 'applicant.invite_orientation',
   'Orientation invite (email)',
   'You''re cleared for orientation',
   E'Hi {{first_name}},\n\nCongrats — you passed your interview! Pick a paid orientation day:\n\n{{link}}\n\n— The RouteReady team')
on conflict (dsp_id, channel, key) do update
  set body = excluded.body, subject = excluded.subject, updated_at = now();
