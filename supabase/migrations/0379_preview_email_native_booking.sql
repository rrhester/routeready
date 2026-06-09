-- 0379 · preview_applicant_email — use the native booking page, not Cal.com.
--
-- preview_applicant_email (0378) feeds the "Resend booking link" composer.
-- It was still building a cal.com URL for interview/orientation invites. Mirror
-- send_booking_link's native logic: when the DSP has native interview
-- availability (or an active group session), point at /b/<token>; otherwise
-- fall back to the legacy Cal.com link.

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
    v_token := private.upsert_token(p_id, 'booking');
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
