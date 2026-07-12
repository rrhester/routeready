-- ───────────────────────────────────────────────────────────────────────
-- 0462 · Stable booking links — stop rotating the 'booking' token on resend
--
-- private.upsert_token() ALWAYS mints a fresh UUID and overwrites
-- metadata.tokens.booking. Two operator actions ran it every time:
--   • send_booking_link()      — every (re)send
--   • preview_applicant_email() — every time the "Resend booking link"
--                                 composer is opened to review the email
-- So resending — or merely previewing — an interview invite silently
-- invalidated the /b/<token> link already sitting in the applicant's inbox.
-- The applicant then hit `invalid_or_expired_token` ("This scheduling link is
-- no longer valid") on a link that worked minutes earlier.
--
-- Fix: acquire the booking token via a get-or-create helper. If the applicant
-- already has one, reuse it (the existing link keeps working); mint only when
-- absent. Behavior is otherwise identical to 0372 / 0379.
--
-- Scope: only the 'booking' token. Screening tokens are unchanged.
-- Idempotent — safe to re-run.
-- ───────────────────────────────────────────────────────────────────────

-- ── Get-or-create token: reuse an existing token, mint one only if missing ──
create or replace function private.ensure_token(p_applicant uuid, p_kind text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tok text;
begin
  select metadata #>> array['tokens', p_kind]
    into v_tok
  from public.applicants
  where id = p_applicant;

  if v_tok is null or v_tok = '' then
    v_tok := private.upsert_token(p_applicant, p_kind);
  end if;
  return v_tok;
end;
$$;

-- ── send_booking_link: reuse the existing booking token (was 0372) ──────────
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
  v_tpl        public.message_templates;
  v_template_key text;
  v_sms_id     uuid;
  v_email_id   uuid;
  v_channels   text[] := '{}';
  v_native     boolean;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_app from public.applicants where id = p_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;
  if v_app.phone is null and v_app.email is null then
    raise exception 'applicant_has_no_contact';
  end if;

  -- Reuse the applicant's existing booking token so a resend does not break the
  -- link already in their inbox; mint one only if they don't have one yet.
  v_token := private.ensure_token(p_id, 'booking');

  -- Native booking page for interview invites once this DSP has set up
  -- native availability (or a group session); else the Cal.com link.
  v_native := (p_kind = 'interview') and (
       exists (select 1 from public.interview_availability where dsp_id = v_dsp)
    or exists (select 1 from public.interview_sessions where dsp_id = v_dsp and active)
  );

  if v_native then
    v_link := 'https://gorouteready.com/b/' || v_token;
  else
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
  end if;

  v_template_key := case when p_kind = 'interview' then 'applicant.invite_interview' else 'applicant.invite_orientation' end;

  if v_app.phone is not null then
    select * into v_tpl from public.message_templates
      where dsp_id = v_dsp and channel = 'sms' and key = v_template_key and active = true;
    select * into v_msg from private.render_template(
      v_dsp, 'sms', v_template_key,
      jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name), 'link', v_link)
    );
    insert into public.sms_messages
      (dsp_id, applicant_id, template_id, direction, status, to_phone, body, attachments)
    values
      (v_dsp, p_id, v_tpl.id, 'outbound', 'queued', v_app.phone, v_msg.body, coalesce(v_tpl.attachments, '[]'::jsonb))
    returning id into v_sms_id;
    v_channels := array_append(v_channels, 'sms');
  end if;

  if v_app.email is not null then
    select * into v_tpl from public.message_templates
      where dsp_id = v_dsp and channel = 'email' and key = v_template_key and active = true;
    select * into v_msg from private.render_template(
      v_dsp, 'email', v_template_key,
      jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name), 'link', v_link)
    );
    insert into public.email_messages
      (dsp_id, applicant_id, template_id, direction, status, to_email, subject, body_text, attachments)
    values
      (v_dsp, p_id, v_tpl.id, 'outbound', 'queued', v_app.email, v_msg.subject, v_msg.body, coalesce(v_tpl.attachments, '[]'::jsonb))
    returning id into v_email_id;
    v_channels := array_append(v_channels, 'email');
  end if;

  update public.applicants
     set status = case
       when p_kind = 'interview'   then 'interview_invited'::public.applicant_status
       when p_kind = 'orientation' then 'orientation_invited'::public.applicant_status
     end
   where id = p_id
     and status not in ('hired','rejected','no_show','not_hired');

  return jsonb_build_object(
    'channels', v_channels, 'sms_id', v_sms_id, 'email_id', v_email_id,
    'channel', v_channels[1], 'message_id', coalesce(v_sms_id, v_email_id),
    'kind', p_kind, 'native', v_native
  );
end;
$$;
grant execute on function public.send_booking_link(uuid, public.cal_event_kind) to authenticated;

-- ── preview_applicant_email: reuse the existing booking token (was 0379) ────
create or replace function public.preview_applicant_email(p_id uuid, p_purpose text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_app   public.applicants;
  v_token text;
  v_link  text;
  v_base  text;
  v_slug  text;
  v_cal_user text;
  v_key   text;
  v_msg   record;
  v_tpl   public.message_templates;
  v_native boolean;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_purpose not in ('screening','interview','orientation') then
    raise exception 'invalid_purpose';
  end if;

  select * into v_app from public.applicants where id = p_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;
  if v_app.email is null then raise exception 'applicant_has_no_email'; end if;

  if p_purpose = 'screening' then
    v_token := private.upsert_token(p_id, 'screening');
    select coalesce(metadata->>'public_base_url', 'https://gorouteready.com')
      into v_base from public.dsps where id = v_dsp;
    v_link := v_base || '/s/' || v_token;
    v_key  := 'applicant.invite_screening';
  else
    -- Reuse the existing booking token so previewing/resending the invite does
    -- not invalidate a link the applicant already has; mint only if missing.
    v_token := private.ensure_token(p_id, 'booking');
    -- Native booking page for interview invites once this DSP has set up
    -- native availability (or an active group session); else the Cal.com link.
    v_native := (p_purpose = 'interview') and (
         exists (select 1 from public.interview_availability where dsp_id = v_dsp)
      or exists (select 1 from public.interview_sessions where dsp_id = v_dsp and active)
    );
    if v_native then
      v_link := 'https://gorouteready.com/b/' || v_token;
    else
      select metadata->'cal'->>(case when p_purpose = 'interview' then 'interview_slug' else 'orientation_slug' end),
             metadata->'cal'->>'username'
        into v_slug, v_cal_user
      from public.dsps where id = v_dsp;
      v_slug     := coalesce(v_slug, case when p_purpose = 'interview' then 'interview' else 'orientation-day' end);
      v_cal_user := coalesce(v_cal_user, 'Routeready');
      v_link := 'https://cal.com/' || v_cal_user || '/' || v_slug
                || '?metadata[applicant_id]=' || p_id::text
                || '&metadata[token]=' || v_token
                || '&name=' || replace(coalesce(v_app.full_name, ''), ' ', '%20')
                || (case when v_app.email is not null then '&email=' || v_app.email else '' end);
    end if;
    v_key := case when p_purpose = 'interview' then 'applicant.invite_interview' else 'applicant.invite_orientation' end;
  end if;

  select * into v_tpl from public.message_templates
    where dsp_id = v_dsp and channel = 'email' and key = v_key and active = true;
  select * into v_msg from private.render_template(
    v_dsp, 'email', v_key,
    jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name), 'link', v_link)
  );

  return jsonb_build_object(
    'to_email',    v_app.email,
    'subject',     v_msg.subject,
    'body_text',   v_msg.body,
    'link',        v_link,
    'template_id', v_tpl.id,
    'purpose',     p_purpose
  );
end;
$$;
grant execute on function public.preview_applicant_email(uuid, text) to authenticated;
