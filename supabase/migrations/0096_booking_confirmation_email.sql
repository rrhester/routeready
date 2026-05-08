-- Replace cal.com's "interview between RouteReady and Ryan Hester"
-- confirmation email with one RouteReady sends itself, branded with
-- the DSP name. The operator disables cal.com's outgoing
-- confirmation in the event-type settings (a one-time manual change)
-- and from then on, every BOOKING_CREATED / BOOKING_RESCHEDULED event
-- produces a templated message from us.

-- ─── Templates ─────────────────────────────────────────────────────────
-- Seeded for every existing DSP. Operators can edit per-DSP via
-- Settings → Hiring messages once it's there.

insert into public.message_templates (dsp_id, channel, key, name, body)
select id, 'sms', 'applicant.booking_confirmed', 'Booking confirmed (SMS)',
  'Hi {{first_name}}, your interview with {{dsp_name}} is confirmed for {{when}}{{location_line}}. Reply if you need to reschedule.'
from public.dsps
on conflict (dsp_id, channel, key) do update
  set body = excluded.body, name = excluded.name, updated_at = now();

insert into public.message_templates (dsp_id, channel, key, name, subject, body)
select id, 'email', 'applicant.booking_confirmed', 'Booking confirmed (email)',
  'Your interview with {{dsp_name}} is confirmed',
  E'Hi {{first_name}},\n\nYour interview with {{dsp_name}} is confirmed for {{when}}.{{location_line}}\n\nReply to this email if you need to reschedule.\n\n— {{dsp_name}}'
from public.dsps
on conflict (dsp_id, channel, key) do update
  set subject = excluded.subject, body = excluded.body, name = excluded.name, updated_at = now();


-- ─── send_booking_confirmation ─────────────────────────────────────────
-- Called from webhook-cal after book_event succeeds. Queues the right
-- channel (SMS preferred) using the booking-confirmed template. dsp_name
-- is auto-injected by render_template (migration 0090); we pass the
-- formatted local-time string and an optional location line so the
-- template can include them.
--
-- Service-role only — there's no current_dsp_id in webhook context, so
-- we trust the caller's p_dsp_id. The webhook handler passes
-- applicant.dsp_id which it just fetched, so the surface is tight.

create or replace function public.send_booking_confirmation(
  p_applicant_id uuid,
  p_starts_at    timestamptz,
  p_meeting_url  text default null,
  p_location     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app   public.applicants;
  v_dsp   public.dsps;
  v_when  text;
  v_loc_line text := '';
  v_msg   record;
  v_tpl   public.message_templates;
  v_sms_id uuid;
  v_email_id uuid;
begin
  select * into v_app from public.applicants where id = p_applicant_id;
  if v_app.id is null then return jsonb_build_object('ok', false, 'error', 'applicant_not_found'); end if;

  select * into v_dsp from public.dsps where id = v_app.dsp_id;

  -- Format start time in the DSP's timezone, e.g. "Fri May 8 at 2:00 PM CDT".
  v_when := to_char(
    p_starts_at at time zone coalesce(v_dsp.timezone, 'UTC'),
    'FMDay FMMonth FMDD "at" FMHH12:MI AM'
  ) || ' ' || coalesce(
    upper(to_char(p_starts_at at time zone coalesce(v_dsp.timezone, 'UTC'), 'TZ')),
    ''
  );

  if p_meeting_url is not null and trim(p_meeting_url) <> '' then
    v_loc_line := ' Join here: ' || p_meeting_url;
  elsif p_location is not null and trim(p_location) <> '' then
    v_loc_line := ' Address: ' || p_location;
  end if;

  if v_app.phone is not null then
    select * into v_tpl from public.message_templates
      where dsp_id = v_app.dsp_id and channel = 'sms' and key = 'applicant.booking_confirmed' and active = true;
    if v_tpl.id is not null then
      select * into v_msg from private.render_template(
        v_app.dsp_id, 'sms', 'applicant.booking_confirmed',
        jsonb_build_object(
          'first_name',    coalesce(v_app.first_name, v_app.full_name),
          'when',          v_when,
          'location_line', v_loc_line
        )
      );
      insert into public.sms_messages
        (dsp_id, applicant_id, template_id, direction, status, to_phone, body, attachments)
      values
        (v_app.dsp_id, v_app.id, v_tpl.id, 'outbound', 'queued', v_app.phone, v_msg.body, coalesce(v_tpl.attachments, '[]'::jsonb))
      returning id into v_sms_id;
    end if;
  elsif v_app.email is not null then
    select * into v_tpl from public.message_templates
      where dsp_id = v_app.dsp_id and channel = 'email' and key = 'applicant.booking_confirmed' and active = true;
    if v_tpl.id is not null then
      select * into v_msg from private.render_template(
        v_app.dsp_id, 'email', 'applicant.booking_confirmed',
        jsonb_build_object(
          'first_name',    coalesce(v_app.first_name, v_app.full_name),
          'when',          v_when,
          'location_line', v_loc_line
        )
      );
      insert into public.email_messages
        (dsp_id, applicant_id, template_id, direction, status, to_email, subject, body_text, attachments)
      values
        (v_app.dsp_id, v_app.id, v_tpl.id, 'outbound', 'queued', v_app.email, v_msg.subject, v_msg.body, coalesce(v_tpl.attachments, '[]'::jsonb))
      returning id into v_email_id;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'sms_id', v_sms_id, 'email_id', v_email_id);
end;
$$;

grant execute on function public.send_booking_confirmation(uuid, timestamptz, text, text) to anon, authenticated, service_role;
