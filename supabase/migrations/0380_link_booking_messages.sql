-- ───────────────────────────────────────────────────────────────────────
-- 0380 · Link booking-confirmation messages to their cal_event
--
-- email_messages already carries cal_event_id (0377, for .ics invites), but
-- booking-confirmation emails/SMS sent by send_booking_confirmation() never
-- set it, so the calendar event detail couldn't show "what we sent this
-- attendee." This:
--
--   • adds cal_event_id to sms_messages (mirrors email_messages)
--   • rewrites send_booking_confirmation() to accept + stamp p_cal_event_id
--     on both the SMS and email rows it queues. Because send-email attaches
--     the real .ics whenever cal_event_id is set, confirmation emails now
--     also carry the calendar invite.
--   • backfills existing confirmation messages by matching each to the
--     applicant's interview/orientation event created closest in time.
--
-- Idempotent. Safe to re-run.
-- ───────────────────────────────────────────────────────────────────────

-- ─── sms_messages.cal_event_id ─────────────────────────────────────────
alter table public.sms_messages
  add column if not exists cal_event_id uuid references public.cal_events(id) on delete set null;

create index if not exists sms_messages_cal_event_idx
  on public.sms_messages (cal_event_id) where cal_event_id is not null;


-- ─── send_booking_confirmation (now stamps cal_event_id) ───────────────
-- Drop the old 4-arg signature so callers resolve to the new one. The new
-- p_cal_event_id defaults to null, so a webhook still on the old call shape
-- (4 named args) keeps working — it just won't link the message, same as
-- before. Update the webhook (webhook-cal) to pass the freshly-booked event
-- id and the link gets set going forward.
drop function if exists public.send_booking_confirmation(uuid, timestamptz, text, text);

create or replace function public.send_booking_confirmation(
  p_applicant_id uuid,
  p_starts_at    timestamptz,
  p_meeting_url  text default null,
  p_location     text default null,
  p_cal_event_id uuid default null
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
        (dsp_id, applicant_id, cal_event_id, template_id, direction, status, to_phone, body, attachments)
      values
        (v_app.dsp_id, v_app.id, p_cal_event_id, v_tpl.id, 'outbound', 'queued', v_app.phone, v_msg.body, coalesce(v_tpl.attachments, '[]'::jsonb))
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
        (dsp_id, applicant_id, cal_event_id, template_id, direction, status, to_email, subject, body_text, attachments)
      values
        (v_app.dsp_id, v_app.id, p_cal_event_id, v_tpl.id, 'outbound', 'queued', v_app.email, v_msg.subject, v_msg.body, coalesce(v_tpl.attachments, '[]'::jsonb))
      returning id into v_email_id;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'sms_id', v_sms_id, 'email_id', v_email_id);
end;
$$;

grant execute on function public.send_booking_confirmation(uuid, timestamptz, text, text, uuid) to anon, authenticated, service_role;


-- ─── Backfill: link existing confirmation messages to their event ──────
-- Match each unlinked outbound message that has an applicant to that
-- applicant's interview/orientation event whose created_at is nearest the
-- message's (a confirmation is queued in the same transaction as book_event,
-- so the gap is sub-second; cap at 10 min to stay safe for reschedules).
update public.email_messages em
set cal_event_id = (
  select ce.id from public.cal_events ce
  where ce.applicant_id = em.applicant_id
    and ce.kind in ('interview', 'orientation')
    and abs(extract(epoch from (ce.created_at - em.created_at))) < 600
  order by abs(extract(epoch from (ce.created_at - em.created_at)))
  limit 1
)
where em.cal_event_id is null
  and em.applicant_id is not null
  and exists (
    select 1 from public.cal_events ce
    where ce.applicant_id = em.applicant_id
      and ce.kind in ('interview', 'orientation')
      and abs(extract(epoch from (ce.created_at - em.created_at))) < 600
  );

update public.sms_messages sm
set cal_event_id = (
  select ce.id from public.cal_events ce
  where ce.applicant_id = sm.applicant_id
    and ce.kind in ('interview', 'orientation')
    and abs(extract(epoch from (ce.created_at - sm.created_at))) < 600
  order by abs(extract(epoch from (ce.created_at - sm.created_at)))
  limit 1
)
where sm.cal_event_id is null
  and sm.applicant_id is not null
  and exists (
    select 1 from public.cal_events ce
    where ce.applicant_id = sm.applicant_id
      and ce.kind in ('interview', 'orientation')
      and abs(extract(epoch from (ce.created_at - sm.created_at))) < 600
  );
