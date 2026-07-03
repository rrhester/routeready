-- ───────────────────────────────────────────────────────────────────────
-- 0410 · Customizable interview reminders
--
-- 0406 sends fixed 24h + 1h reminders with hard-coded wording over email AND
-- SMS. This adds a per-DSP `interview_config.reminder_config` (jsonb) so an
-- operator can, per reminder step (24h / 1h): turn it on/off, choose channels
-- (email / SMS), and rewrite the message text. The proven send-timing windows
-- from 0406 are UNCHANGED — only enable/channel/wording are configurable — so a
-- DSP that never customizes behaves exactly as before.
--
-- reminder_config shape (all keys optional; missing ⇒ the 0406 default):
--   {
--     "steps": [
--       { "label": "r24h", "email": true, "sms": true },
--       { "label": "r1h",  "email": true, "sms": true }
--     ],
--     "email_subject": "Reminder: your {{kind}} on {{when}}",
--     "email_body":    "Hi {{first_name}}, ... {{when}} ... {{join}} ...",
--     "sms_body":      "Reminder: your {{kind}} is {{when}}.{{join}} ..."
--   }
-- Placeholders: {{first_name}} {{kind}} {{when}} {{join}} {{dsp}}
-- A step whose label is absent from "steps" (when "steps" is present) is treated
-- as disabled — that's how the UI turns a reminder off.
--
-- Idempotent.
-- ───────────────────────────────────────────────────────────────────────

alter table public.interview_config
  add column if not exists reminder_config jsonb;

create or replace function public.interview_reminders_run()
returns int language plpgsql security definer set search_path = '' as $fn$
declare
  r record;
  v_tz text; v_when text; v_word text; v_first text; v_dsp text;
  v_join_html text; v_join_text text;
  v_subject text; v_html text; v_text text; v_count int := 0;
  v_cfg jsonb; v_steps jsonb; v_step jsonb;
  v_want_email boolean; v_want_sms boolean;
  v_subj_tpl text; v_email_tpl text; v_sms_tpl text;
  v_body_text text;
  -- 0406-equivalent defaults.
  c_default_steps constant jsonb :=
    '[{"label":"r24h","email":true,"sms":true},{"label":"r1h","email":true,"sms":true}]'::jsonb;
  c_default_subject constant text := 'Reminder: your {{kind}} on {{when}}';
  c_default_email constant text :=
    'Hi {{first_name}},'||E'\n\n'||
    'This is a reminder that your {{kind}} is scheduled for {{when}}.'||E'\n'||
    '{{join}}'||E'\n'||
    'Reply to this email if you need to reschedule. See you then!';
  c_default_sms constant text :=
    'Reminder: your {{kind}} is {{when}}.{{join}} Reply here to reschedule.';
begin
  for r in
    select ce.id, ce.dsp_id, ce.applicant_id, ce.kind, ce.starts_at, ce.meeting_url,
           lbl.label,
           coalesce(cfg.timezone, d.timezone, 'America/Chicago') as tz,
           a.full_name, a.email, a.phone, d.name as dsp_name,
           cfg.reminder_config as rcfg
    from public.cal_events ce
    join public.applicants a on a.id = ce.applicant_id
    join public.dsps d on d.id = ce.dsp_id
    left join public.interview_config cfg on cfg.dsp_id = ce.dsp_id
    cross join lateral (values ('r24h'), ('r1h')) as lbl(label)
    where ce.kind in ('interview','orientation')
      and ce.status in ('scheduled','rescheduled')
      and coalesce(cfg.reminders_enabled, true)
      and coalesce((ce.metadata->>'is_task')::boolean, false) = false
      and not exists (
        select 1 from public.cal_event_reminders x
        where x.cal_event_id = ce.id and x.label = lbl.label)
      and (
        (lbl.label = 'r24h' and ce.starts_at >  now() + interval '2 hours'
                            and ce.starts_at <= now() + interval '24 hours')
        or
        (lbl.label = 'r1h'  and ce.starts_at >  now()
                            and ce.starts_at <= now() + interval '90 minutes')
      )
  loop
    -- Resolve this step's config (enable / channels). Missing config ⇒ defaults.
    v_cfg   := coalesce(r.rcfg, '{}'::jsonb);
    v_steps := coalesce(v_cfg->'steps', c_default_steps);
    select s into v_step
      from jsonb_array_elements(v_steps) s
      where s->>'label' = r.label
      limit 1;
    -- Step removed from the config ⇒ this reminder is turned off.
    if v_step is null then continue; end if;
    v_want_email := coalesce((v_step->>'email')::boolean, true);
    v_want_sms   := coalesce((v_step->>'sms')::boolean, true);
    if not v_want_email and not v_want_sms then continue; end if;

    -- Claim first so overlapping runs never double-message (PK dedupe).
    begin
      insert into public.cal_event_reminders (cal_event_id, label) values (r.id, r.label);
    exception when unique_violation then
      continue;
    end;

    v_tz    := r.tz;
    v_word  := case when r.kind = 'orientation' then 'orientation' else 'interview' end;
    v_first := coalesce(nullif(split_part(btrim(r.full_name), ' ', 1), ''), 'there');
    v_dsp   := coalesce(r.dsp_name, 'RouteReady');
    v_when  := to_char(r.starts_at at time zone v_tz, 'FMDay, FMMon FMDD at FMHH12:MI AM');
    v_join_text := case when r.meeting_url ~* '^https://' then ' Join: ' || r.meeting_url else '' end;
    v_join_html := case when r.meeting_url ~* '^https://'
                        then '<p>Join the video meeting:<br><a href="' || r.meeting_url || '">' || r.meeting_url || '</a></p>'
                        else '' end;

    v_subj_tpl  := coalesce(nullif(btrim(v_cfg->>'email_subject'), ''), c_default_subject);
    v_email_tpl := coalesce(nullif(v_cfg->>'email_body', ''), c_default_email);
    v_sms_tpl   := coalesce(nullif(v_cfg->>'sms_body', ''), c_default_sms);

    -- Email.
    if v_want_email and r.email is not null and position('@' in r.email) > 0 then
      v_subject := replace(replace(replace(replace(v_subj_tpl,
        '{{first_name}}', v_first), '{{kind}}', v_word), '{{when}}', v_when), '{{dsp}}', v_dsp);
      -- Plain text: substitute values (join as plain " Join: url").
      v_body_text := replace(replace(replace(replace(replace(v_email_tpl,
        '{{first_name}}', v_first), '{{kind}}', v_word), '{{when}}', v_when),
        '{{dsp}}', v_dsp), '{{join}}', v_join_text);
      -- HTML: substitute values, escape, newlines→<br>, then inject the join link.
      v_html := replace(replace(replace(replace(v_email_tpl,
        '{{first_name}}', v_first), '{{kind}}', v_word), '{{when}}', v_when), '{{dsp}}', v_dsp);
      v_html := replace(replace(replace(replace(v_html,
        '&','&amp;'), '<','&lt;'), '>','&gt;'), '"','&quot;');
      v_html := replace(v_html, E'\n', '<br>');
      v_html := '<p>' || replace(v_html, '{{join}}', v_join_html) || '</p>';
      insert into public.email_messages
        (dsp_id, applicant_id, cal_event_id, direction, status, to_email, subject, body_text, body_html)
      values
        (r.dsp_id, r.applicant_id, r.id, 'outbound', 'queued', r.email, v_subject, v_body_text, v_html);
      v_count := v_count + 1;
    end if;

    -- SMS.
    if v_want_sms and r.phone is not null and length(btrim(r.phone)) >= 7 then
      v_text := replace(replace(replace(replace(replace(v_sms_tpl,
        '{{first_name}}', v_first), '{{kind}}', v_word), '{{when}}', v_when),
        '{{dsp}}', v_dsp), '{{join}}', v_join_text);
      insert into public.sms_messages
        (dsp_id, applicant_id, cal_event_id, direction, status, to_phone, body)
      values
        (r.dsp_id, r.applicant_id, r.id, 'outbound', 'queued', r.phone, v_text);
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$fn$;

grant execute on function public.interview_reminders_run() to service_role;

-- ── Read/write the reminder config from the dashboard ───────────────────────
-- Getter returns the effective config (stored, merged over the defaults) so the
-- settings dialog always has every field to render.
create or replace function public.interview_reminders_config_get()
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
      (select reminder_config from public.interview_config
        where dsp_id = private.current_dsp_id()),
      '{}'::jsonb)
    || jsonb_build_object(
      'defaults', jsonb_build_object(
        'email_subject', 'Reminder: your {{kind}} on {{when}}',
        'email_body', 'Hi {{first_name}},'||E'\n\n'||'This is a reminder that your {{kind}} is scheduled for {{when}}.'||E'\n'||'{{join}}'||E'\n'||'Reply to this email if you need to reschedule. See you then!',
        'sms_body', 'Reminder: your {{kind}} is {{when}}.{{join}} Reply here to reschedule.'));
$$;
grant execute on function public.interview_reminders_config_get() to authenticated;

create or replace function public.interview_reminders_config_set(p_config jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then raise exception 'no_dsp'; end if;
  insert into public.interview_config (dsp_id, reminder_config, updated_at)
  values (v_dsp, p_config, now())
  on conflict (dsp_id) do update set
    reminder_config = excluded.reminder_config, updated_at = now();
  return p_config;
end; $$;
grant execute on function public.interview_reminders_config_set(jsonb) to authenticated;
