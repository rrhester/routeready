-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0023 · Message-template attachments (MMS / email)
--
-- Operators can attach files from their desktop to any hiring message
-- template. When that template fires:
--   • SMS path → Twilio receives one MediaUrl per attachment (becomes
--     MMS automatically). Attachment files must be publicly readable
--     so Twilio can fetch them, hence the bucket is `public = true`.
--   • Email path → Resend receives the attachment URLs in the
--     `attachments` array.
--
-- Schema:
--   message_templates.attachments  jsonb [{name, url, content_type, size}]
--   sms_messages.attachments       jsonb (copied from template at queue time)
--   email_messages.attachments     jsonb (same)
--
-- Storage: `message-attachments` bucket, files keyed by
--   "<dsp_id>/<template_id>/<filename>". Tenant staff can write/delete;
--   public can read (so Twilio can pull MediaUrl).
--
-- Each send_*_link RPC is updated to copy template.attachments onto the
-- queued message row so the edge functions don't have to re-join.
-- ─────────────────────────────────────────────────────────────────────────


-- ─── Schema additions ──────────────────────────────────────────────────

alter table public.message_templates
  add column if not exists attachments jsonb not null default '[]'::jsonb;

alter table public.sms_messages
  add column if not exists attachments jsonb not null default '[]'::jsonb;

alter table public.email_messages
  add column if not exists attachments jsonb not null default '[]'::jsonb;


-- ─── Storage bucket ────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('message-attachments', 'message-attachments', true)
on conflict (id) do nothing;

-- Tenant staff can write/delete in their DSP path.
create policy "msg_attach_tenant_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'message-attachments'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );

create policy "msg_attach_tenant_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'message-attachments'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );

-- Reads are public for the bucket (no policy needed when bucket is public).


-- ─── Replace sender RPCs to carry attachments through ──────────────────

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
  v_tpl     public.message_templates;
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
    select * into v_tpl from public.message_templates
      where dsp_id = v_dsp and channel = 'sms' and key = 'applicant.invite_screening' and active = true;
    select * into v_msg from private.render_template(
      v_dsp, 'sms', 'applicant.invite_screening',
      jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name), 'link', v_link)
    );
    insert into public.sms_messages
      (dsp_id, applicant_id, template_id, direction, status, to_phone, body, attachments)
    values
      (v_dsp, p_id, v_tpl.id, 'outbound', 'queued', v_app.phone, v_msg.body, coalesce(v_tpl.attachments, '[]'::jsonb))
    returning id into v_sms_id;
    v_channel := 'sms'; v_message_id := v_sms_id;
  else
    select * into v_tpl from public.message_templates
      where dsp_id = v_dsp and channel = 'email' and key = 'applicant.invite_screening' and active = true;
    select * into v_msg from private.render_template(
      v_dsp, 'email', 'applicant.invite_screening',
      jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name), 'link', v_link)
    );
    insert into public.email_messages
      (dsp_id, applicant_id, template_id, direction, status, to_email, subject, body_text, attachments)
    values
      (v_dsp, p_id, v_tpl.id, 'outbound', 'queued', v_app.email, v_msg.subject, v_msg.body, coalesce(v_tpl.attachments, '[]'::jsonb))
    returning id into v_email_id;
    v_channel := 'email'; v_message_id := v_email_id;
  end if;

  if v_app.status = 'applied' then
    update public.applicants set status = 'contacted' where id = p_id;
  end if;

  return jsonb_build_object('channel', v_channel, 'message_id', v_message_id);
end;
$$;
grant execute on function public.send_screening_link(uuid) to authenticated;


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
    v_channel := 'sms'; v_message_id := v_sms_id;
  else
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
    v_channel := 'email'; v_message_id := v_email_id;
  end if;

  update public.applicants
     set status = case
       when p_kind = 'interview'   then 'interview_invited'::public.applicant_status
       when p_kind = 'orientation' then 'orientation_invited'::public.applicant_status
     end
   where id = p_id
     and status not in ('hired','rejected','no_show','not_hired');

  return jsonb_build_object('channel', v_channel, 'message_id', v_message_id, 'kind', p_kind);
end;
$$;
grant execute on function public.send_booking_link(uuid, public.cal_event_kind) to authenticated;


-- Outcome-message helper now copies attachments too.
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
  v_tpl  public.message_templates;
begin
  select * into v_app from public.applicants where id = p_applicant_id;
  if v_app.id is null then return; end if;

  select * into v_dsp from public.dsps where id = v_app.dsp_id;

  if p_outcome = 'no_show'
     and not coalesce((v_dsp.metadata->'outcomes'->>'send_no_show')::boolean, false) then
    return;
  end if;

  v_key := 'applicant.outcome_' || p_outcome;

  if v_app.phone is not null then
    select * into v_tpl from public.message_templates
      where dsp_id = v_app.dsp_id and channel = 'sms' and key = v_key and active = true;
    select * into v_msg from private.render_template(
      v_app.dsp_id, 'sms', v_key,
      jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name))
    );
    insert into public.sms_messages
      (dsp_id, applicant_id, template_id, direction, status, to_phone, body, attachments)
    values
      (v_app.dsp_id, v_app.id, v_tpl.id, 'outbound', 'queued', v_app.phone, v_msg.body, coalesce(v_tpl.attachments, '[]'::jsonb));
  elsif v_app.email is not null then
    select * into v_tpl from public.message_templates
      where dsp_id = v_app.dsp_id and channel = 'email' and key = v_key and active = true;
    select * into v_msg from private.render_template(
      v_app.dsp_id, 'email', v_key,
      jsonb_build_object('first_name', coalesce(v_app.first_name, v_app.full_name))
    );
    insert into public.email_messages
      (dsp_id, applicant_id, template_id, direction, status, to_email, subject, body_text, attachments)
    values
      (v_app.dsp_id, v_app.id, v_tpl.id, 'outbound', 'queued', v_app.email, v_msg.subject, v_msg.body, coalesce(v_tpl.attachments, '[]'::jsonb));
  end if;
end;
$$;
