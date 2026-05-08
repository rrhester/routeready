-- Shorten the URLs we put in applicant SMS / email so they don't
-- dominate the message body. Netlify rewrites in netlify.toml map the
-- short paths back to the existing pages, so previously-sent long
-- links keep working unchanged.
--
--   /dashboard/screening.html?t=<token>  →  /s/<token>
--   /dashboard/coaching.html?t=<token>   →  /c/<token>
--   /dashboard/refer.html?r=<token>      →  /r/<token>

-- ─── send_screening_link · use /s/<token> ──────────────────────────────

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
  v_link := v_base || '/s/' || v_token;

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


-- ─── private.driver_referral_link · /r/<token> ─────────────────────────

create or replace function private.driver_referral_link(p_driver public.drivers)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base text;
begin
  select coalesce(metadata->>'public_base_url', 'https://gorouteready.com')
    into v_base
  from public.dsps where id = p_driver.dsp_id;
  return v_base || '/r/' || coalesce(p_driver.referral_token, '');
end;
$$;


-- ─── public.referral_leaderboard · /r/<token> ──────────────────────────
-- The only place outside driver_referral_link that builds a refer URL.
-- Re-create with the short path so the operator's leaderboard "Copy
-- link" buttons match what the driver actually receives.
--
-- Drop first because CREATE OR REPLACE FUNCTION can't change the
-- RETURNS TABLE column names — the prior signature (0017/0037) had
-- "link text" where this revision has "share_url text".

drop function if exists public.referral_leaderboard();

create or replace function public.referral_leaderboard()
returns table (
  driver_id     uuid,
  full_name     text,
  hired_count   bigint,
  active_count  bigint,
  share_url     text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_base text;
begin
  if not private.is_staff(v_dsp, 'viewer') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(metadata->>'public_base_url', 'https://gorouteready.com')
    into v_base from public.dsps where id = v_dsp;

  return query
  select
    d.id,
    d.full_name,
    count(a.id) filter (where a.status = 'hired')::bigint,
    count(a.id) filter (where a.status not in ('hired','rejected','no_show','not_hired','auto_declined'))::bigint,
    case when d.referral_token is not null
      then v_base || '/r/' || d.referral_token
      else null
    end
  from public.drivers d
  left join public.applicants a
    on a.referrer_driver_id = d.id and a.dsp_id = v_dsp
  where d.dsp_id = v_dsp
  group by d.id, d.full_name, d.referral_token
  having count(a.id) > 0
  order by hired_count desc, active_count desc
  limit 25;
end;
$$;
grant execute on function public.referral_leaderboard() to authenticated;
