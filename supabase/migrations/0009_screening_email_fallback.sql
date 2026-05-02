-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0009 · Screening invite falls back to email when no phone
--
-- Until 0008, send_screening_link required a phone and raised
-- 'applicant_has_no_phone' otherwise. Operators ingesting from sources
-- that supply only an email (or where SMS is blocked by carrier
-- restrictions, like a not-yet-approved Twilio account) had no way to
-- contact the applicant.
--
-- New behavior: dispatch by what contact info is on file.
--   • phone present → SMS via applicant.invite_screening (sms channel)
--   • no phone, email present → email via applicant.invite_screening (email channel)
--   • neither → raise applicant_has_no_contact
--
-- Returns jsonb describing what was queued: { channel, message_id }.
-- Front-end can read .channel to choose its toast text.
-- ─────────────────────────────────────────────────────────────────────────

drop function if exists public.send_screening_link(uuid);

create or replace function public.send_screening_link(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_app     public.applicants;
  v_token   text;
  v_link    text;
  v_base    text;
  v_msg     record;
  v_sms_id  uuid;
  v_email_id uuid;
  v_channel text;
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

  v_token := private.upsert_token(p_id, 'screening');

  select coalesce(metadata->>'public_base_url', 'https://gorouteready.com')
    into v_base
  from public.dsps where id = v_dsp;

  v_link := v_base || '/dashboard/screening.html?t=' || v_token;

  if v_app.phone is not null then
    -- SMS path
    select * into v_msg from private.render_template(
      v_dsp, 'sms', 'applicant.invite_screening',
      jsonb_build_object(
        'first_name', coalesce(v_app.first_name, v_app.full_name),
        'link', v_link
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
    -- Email path (phone is null, email guaranteed present by check above)
    select * into v_msg from private.render_template(
      v_dsp, 'email', 'applicant.invite_screening',
      jsonb_build_object(
        'first_name', coalesce(v_app.first_name, v_app.full_name),
        'link', v_link
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

  -- Promote 'applied' → 'contacted' on first send.
  if v_app.status = 'applied' then
    update public.applicants set status = 'contacted' where id = p_id;
  end if;

  return jsonb_build_object(
    'channel',    v_channel,
    'message_id', v_message_id
  );
end;
$$;

grant execute on function public.send_screening_link(uuid) to authenticated;
