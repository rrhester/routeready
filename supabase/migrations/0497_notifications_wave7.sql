-- ─────────────────────────────────────────────────────────────────────────
-- 0497 · Notifications & reminders (calendar 100-list #71–#77)
--
--  • #71 Web Push reminders: event reminders also ping the operator's
--    browser (staff_push_subscriptions → send-staff-push, 0470 pipeline).
--  • #72 Event reminders now reach every INTERNAL attendee (staff whose
--    email is on the event's invitee list), not just the creator.
--  • #73 Morning digest: opt-in daily email of today's calendar to all
--    dispatcher+ staff, at a DSP-local hour (notify_prefs.digest_hour).
--  • #74 Slack / Teams: booking lifecycle events post to incoming-webhook
--    URLs (notify_prefs.slack_url / teams_url) — extends fire_cal_webhooks.
--  • #75 Custom reminder step: a third candidate reminder at N hours
--    before (reminder_config.custom_hours + steps[label=rcustom]), plus a
--    {{manage}} placeholder (candidate's booking-manage link).
--  • #76 Unconfirmed escalation: booking_confirm(p_token) lets candidates
--    one-tap "I'll be there"; a cron scan emails + pushes staff when an
--    interview inside notify_prefs.escalate_hours is still unconfirmed.
--  • #77 SMS quiet hours: notify_prefs.quiet_start/quiet_end suppress the
--    SMS channel of automated interview reminders during DSP-local nights.
--
-- All prefs live in interview_config.notify_prefs (jsonb) via
-- calendar_notify_get/set. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.interview_config
  add column if not exists notify_prefs jsonb;

-- ── 1 · notify-prefs RPCs ────────────────────────────────────────────────

create or replace function public.calendar_notify_get()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select notify_prefs from public.interview_config
      where dsp_id = private.current_dsp_id()),
    '{}'::jsonb);
$$;
grant execute on function public.calendar_notify_get() to authenticated;

create or replace function public.calendar_notify_set(p_prefs jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then raise exception 'no_dsp'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_prefs is null or jsonb_typeof(p_prefs) <> 'object' then
    raise exception 'invalid_prefs';
  end if;
  if p_prefs ? 'digest_hour' and jsonb_typeof(p_prefs->'digest_hour') <> 'null'
     and ((p_prefs->>'digest_hour') !~ '^[0-9]{1,2}$' or (p_prefs->>'digest_hour')::int > 23) then
    raise exception 'invalid_digest_hour';
  end if;
  if (p_prefs ? 'quiet_start' and jsonb_typeof(p_prefs->'quiet_start') <> 'null' and (p_prefs->>'quiet_start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     or (p_prefs ? 'quiet_end' and jsonb_typeof(p_prefs->'quiet_end') <> 'null' and (p_prefs->>'quiet_end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception 'invalid_quiet_hours';
  end if;
  if p_prefs ? 'escalate_hours' and jsonb_typeof(p_prefs->'escalate_hours') <> 'null'
     and ((p_prefs->>'escalate_hours') !~ '^[0-9]{1,2}$' or (p_prefs->>'escalate_hours')::int not between 1 and 48) then
    raise exception 'invalid_escalate_hours';
  end if;
  if (p_prefs ? 'slack_url' and jsonb_typeof(p_prefs->'slack_url') <> 'null' and nullif(btrim(p_prefs->>'slack_url'), '') is not null and (p_prefs->>'slack_url') !~* '^https://')
     or (p_prefs ? 'teams_url' and jsonb_typeof(p_prefs->'teams_url') <> 'null' and nullif(btrim(p_prefs->>'teams_url'), '') is not null and (p_prefs->>'teams_url') !~* '^https://') then
    raise exception 'https_url_required';
  end if;
  insert into public.interview_config (dsp_id, notify_prefs, updated_at)
  values (v_dsp, p_prefs, now())
  on conflict (dsp_id) do update set
    notify_prefs = excluded.notify_prefs, updated_at = now();
  return p_prefs;
end; $$;
grant execute on function public.calendar_notify_set(jsonb) to authenticated;

-- ── 2 · quiet-hours helper (#77) ─────────────────────────────────────────
-- True when the DSP's local time is inside [quiet_start, quiet_end), which
-- may wrap midnight (21:00 → 08:00). Unset/malformed prefs ⇒ never quiet.

create or replace function private.sms_quiet_now(p_dsp uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
      when qs is null or qe is null or qs = qe then false
      when qs < qe then lt >= qs and lt < qe
      else lt >= qs or lt < qe
    end
    from (
      select case when (cfg.notify_prefs->>'quiet_start') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                  then (cfg.notify_prefs->>'quiet_start')::time end as qs,
             case when (cfg.notify_prefs->>'quiet_end') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                  then (cfg.notify_prefs->>'quiet_end')::time end as qe,
             (now() at time zone coalesce(cfg.timezone, d.timezone, 'America/Chicago'))::time as lt
      from public.dsps d
      left join public.interview_config cfg on cfg.dsp_id = d.id
      where d.id = p_dsp
    ) x
  ), false);
$$;

-- ── 3 · candidate interview reminders: custom step + quiet hours + {{manage}} ──
-- 0410 base, unchanged except:
--   • a third 'rcustom' step at reminder_config.custom_hours before start
--     (only when a steps[] entry with label 'rcustom' opts in),
--   • SMS suppressed during DSP-local quiet hours (#77),
--   • {{manage}} placeholder → the candidate's booking-manage link.

create or replace function public.interview_reminders_run()
returns int language plpgsql security definer set search_path = '' as $fn$
declare
  r record;
  v_tz text; v_when text; v_word text; v_first text; v_dsp text;
  v_join_html text; v_join_text text; v_manage text;
  v_subject text; v_html text; v_text text; v_count int := 0;
  v_cfg jsonb; v_steps jsonb; v_step jsonb;
  v_want_email boolean; v_want_sms boolean;
  v_subj_tpl text; v_email_tpl text; v_sms_tpl text;
  v_body_text text;
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
    cross join lateral (values ('r24h'), ('r1h'), ('rcustom')) as lbl(label)
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
        or
        (lbl.label = 'rcustom'
          and (cfg.reminder_config->>'custom_hours') ~ '^[0-9]{1,3}$'
          and (cfg.reminder_config->>'custom_hours')::int between 1 and 168
          and ce.starts_at >  now()
          and ce.starts_at <= now() + ((cfg.reminder_config->>'custom_hours')::int * interval '1 hour'))
      )
  loop
    v_cfg   := coalesce(r.rcfg, '{}'::jsonb);
    v_steps := coalesce(v_cfg->'steps', c_default_steps);
    select s into v_step
      from jsonb_array_elements(v_steps) s
      where s->>'label' = r.label
      limit 1;
    if v_step is null then continue; end if;
    v_want_email := coalesce((v_step->>'email')::boolean, true);
    v_want_sms   := coalesce((v_step->>'sms')::boolean, true);
    -- Quiet hours (#77): hold the SMS channel overnight; email still goes.
    v_want_sms   := v_want_sms and not private.sms_quiet_now(r.dsp_id);
    if not v_want_email and not v_want_sms then continue; end if;

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

    -- {{manage}} → the candidate's stable booking link (confirm / reschedule /
    -- cancel / running-late all live there). Minted only when referenced.
    v_manage := null;
    if position('{{manage}}' in v_email_tpl) > 0 or position('{{manage}}' in v_sms_tpl) > 0
       or position('{{manage}}' in v_subj_tpl) > 0 then
      begin
        v_manage := 'https://gorouteready.com/b/' || private.ensure_token(r.applicant_id, 'booking');
      exception when others then
        v_manage := '';
      end;
    end if;

    if v_want_email and r.email is not null and position('@' in r.email) > 0 then
      v_subject := replace(replace(replace(replace(replace(v_subj_tpl,
        '{{first_name}}', v_first), '{{kind}}', v_word), '{{when}}', v_when), '{{dsp}}', v_dsp),
        '{{manage}}', coalesce(v_manage, ''));
      v_body_text := replace(replace(replace(replace(replace(replace(v_email_tpl,
        '{{first_name}}', v_first), '{{kind}}', v_word), '{{when}}', v_when),
        '{{dsp}}', v_dsp), '{{join}}', v_join_text), '{{manage}}', coalesce(v_manage, ''));
      v_html := replace(replace(replace(replace(v_email_tpl,
        '{{first_name}}', v_first), '{{kind}}', v_word), '{{when}}', v_when), '{{dsp}}', v_dsp);
      v_html := replace(replace(replace(replace(v_html,
        '&','&amp;'), '<','&lt;'), '>','&gt;'), '"','&quot;');
      v_html := replace(v_html, E'\n', '<br>');
      v_html := replace(v_html, '{{manage}}',
        case when v_manage ~* '^https://' then '<a href="' || v_manage || '">' || v_manage || '</a>' else coalesce(v_manage, '') end);
      v_html := '<p>' || replace(v_html, '{{join}}', v_join_html) || '</p>';
      insert into public.email_messages
        (dsp_id, applicant_id, cal_event_id, direction, status, to_email, subject, body_text, body_html)
      values
        (r.dsp_id, r.applicant_id, r.id, 'outbound', 'queued', r.email, v_subject, v_body_text, v_html);
      v_count := v_count + 1;
    end if;

    if v_want_sms and r.phone is not null and length(btrim(r.phone)) >= 7 then
      v_text := replace(replace(replace(replace(replace(replace(v_sms_tpl,
        '{{first_name}}', v_first), '{{kind}}', v_word), '{{when}}', v_when),
        '{{dsp}}', v_dsp), '{{join}}', v_join_text), '{{manage}}', coalesce(v_manage, ''));
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

-- ── 4 · staff Web Push helper (#71) ──────────────────────────────────────
-- Fire-and-forget pg_net POST to send-staff-push. Uses the same runtime
-- settings as 0007's immediate-send triggers; silently no-ops when unset.

create or replace function private.notify_staff_push(
  p_dsp uuid, p_title text, p_body text, p_url text, p_emails text[] default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_base text := current_setting('app.functions_base_url', true);
  v_key  text := current_setting('app.service_role_key',   true);
begin
  if v_base is null or v_base = '' or v_key is null or v_key = '' then return; end if;
  perform net.http_post(
    url     := v_base || '/send-staff-push',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key),
    body    := jsonb_build_object('dsp_id', p_dsp, 'notify', jsonb_build_object(
                 'title', p_title, 'body', p_body, 'url', p_url,
                 'emails', case when p_emails is null then null else to_jsonb(p_emails) end)));
exception when others then
  null;   -- push is best-effort; never break the caller
end; $$;

-- ── 5 · operator event reminders: internal attendees + Web Push (#71, #72) ──
-- 0430 base. Recipients become creator ∪ active staff on the invitee list;
-- each also gets a browser push (deep-linking to the event) unless the DSP
-- turned notify_prefs.push_reminders off.

create or replace function public.event_reminders_run()
returns int language plpgsql security definer set search_path = '' as $fn$
declare
  r record;
  v_when text;
  v_title_html text;
  v_join text;
  v_count int := 0;
  v_emails text[];
  v_to text;
  v_push boolean;
begin
  for r in
    select ce.id, ce.dsp_id, ce.starts_at, ce.meeting_url, ce.location,
           ce.created_by, ce.metadata,
           coalesce(nullif(btrim(ce.title), ''), 'Untitled event') as title,
           (rem.val)::int as mins,
           coalesce(ce.timezone, cfg.timezone, d.timezone, 'America/Chicago') as tz,
           coalesce(cfg.notify_prefs->>'push_reminders', 'true') <> 'false' as push_on
    from public.cal_events ce
    join public.dsps d on d.id = ce.dsp_id
    left join public.interview_config cfg on cfg.dsp_id = ce.dsp_id
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(ce.metadata->'reminders') = 'array'
           then ce.metadata->'reminders' else '[]'::jsonb end) as rem(val)
    where ce.kind = 'event'
      and ce.status in ('scheduled','rescheduled')
      and rem.val ~ '^[0-9]{1,5}$'
      and ce.starts_at > now()
      and ce.starts_at <= now() + ((rem.val)::int * interval '1 minute')
      and not exists (
        select 1 from public.cal_event_reminders x
        where x.cal_event_id = ce.id and x.label = 'm' || rem.val)
  loop
    begin
      insert into public.cal_event_reminders (cal_event_id, label)
      values (r.id, 'm' || r.mins);
    exception when unique_violation then
      continue;
    end;

    -- Creator + any active staff member whose email is on the invitee list.
    select array_agg(distinct u.email) into v_emails
    from public.app_users u
    where u.dsp_id = r.dsp_id and u.active
      and u.email is not null and position('@' in u.email) > 0
      and (u.id = r.created_by
           or lower(u.email) in (
                select lower(x.e)
                from jsonb_array_elements_text(
                  case when jsonb_typeof(r.metadata->'invitees') = 'array'
                       then r.metadata->'invitees' else '[]'::jsonb end) as x(e)));
    if v_emails is null then continue; end if;

    v_when := to_char(r.starts_at at time zone r.tz, 'FMDay, FMMon FMDD at FMHH12:MI AM');
    v_title_html := replace(replace(replace(r.title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
    v_join := case when r.meeting_url ~* '^https://'
                   then '<p>Join: <a href="' || r.meeting_url || '">' || r.meeting_url || '</a></p>'
                   else '' end;

    foreach v_to in array v_emails loop
      insert into public.email_messages
        (dsp_id, cal_event_id, direction, status, to_email, subject, body_text, body_html)
      values
        (r.dsp_id, r.id, 'outbound', 'queued', v_to,
         'Reminder: ' || r.title || ' — ' || v_when,
         'Reminder: ' || r.title || ' is scheduled for ' || v_when ||
           case when r.location is not null and btrim(r.location) <> '' then '. Location: ' || r.location else '' end ||
           case when r.meeting_url ~* '^https://' then '. Join: ' || r.meeting_url else '' end,
         '<p>Reminder: <strong>' || v_title_html || '</strong></p>' ||
         '<p><strong>' || v_when || '</strong></p>' ||
         case when r.location is not null and btrim(r.location) <> ''
              then '<p>' || replace(replace(replace(r.location, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p>'
              else '' end ||
         v_join);
      v_count := v_count + 1;
    end loop;

    if r.push_on then
      perform private.notify_staff_push(
        r.dsp_id,
        'Reminder: ' || r.title,
        v_when || case when r.location is not null and btrim(r.location) <> '' then ' · ' || r.location else '' end,
        '/dashboard/index.html#onboarding-ops?ev=' || r.id,
        v_emails);
    end if;
  end loop;

  return v_count;
end;
$fn$;
grant execute on function public.event_reminders_run() to service_role;

-- ── 6 · morning digest (#73) ─────────────────────────────────────────────

create table if not exists public.cal_digest_log (
  dsp_id  uuid not null references public.dsps(id) on delete cascade,
  day     date not null,
  sent_at timestamptz not null default now(),
  primary key (dsp_id, day)
);
alter table public.cal_digest_log enable row level security;
-- No policies: internal exactly-once ledger, definer functions only.

create or replace function public.calendar_digest_run()
returns int language plpgsql security definer set search_path = '' as $fn$
declare
  r record;
  u record;
  v_day date;
  v_n int; v_text text; v_html text;
  v_count int := 0;
begin
  for r in
    select d.id as dsp_id, d.name as dsp_name,
           coalesce(cfg.timezone, d.timezone, 'America/Chicago') as tz
    from public.dsps d
    join public.interview_config cfg on cfg.dsp_id = d.id
    where (cfg.notify_prefs->>'digest_hour') ~ '^[0-9]{1,2}$'
      and (cfg.notify_prefs->>'digest_hour')::int between 0 and 23
      and extract(hour from now() at time zone coalesce(cfg.timezone, d.timezone, 'America/Chicago'))::int
          = (cfg.notify_prefs->>'digest_hour')::int
  loop
    v_day := (now() at time zone r.tz)::date;
    begin
      insert into public.cal_digest_log (dsp_id, day) values (r.dsp_id, v_day);
    exception when unique_violation then
      continue;
    end;

    select count(*),
           string_agg(line, E'\n' order by starts_at),
           string_agg('<li>' || replace(replace(replace(line, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</li>',
                      '' order by starts_at)
      into v_n, v_text, v_html
    from (
      select ce.starts_at,
             to_char(ce.starts_at at time zone r.tz, 'FMHH12:MI AM') || ' · ' ||
             case when ce.kind = 'interview'   then 'Interview · '   || coalesce(a.full_name, 'Applicant')
                  when ce.kind = 'orientation' then 'Orientation · ' || coalesce(a.full_name, 'Applicant')
                  else coalesce(nullif(btrim(ce.title), ''), 'Event') end ||
             case when ce.location is not null and btrim(ce.location) <> '' then ' · ' || ce.location else '' end
             as line
      from public.cal_events ce
      left join public.applicants a on a.id = ce.applicant_id
      where ce.dsp_id = r.dsp_id
        and ce.kind in ('interview','orientation','event')
        and ce.status in ('scheduled','rescheduled')
        and coalesce((ce.metadata->>'is_task')::boolean, false) = false
        and (ce.starts_at at time zone r.tz)::date = v_day
    ) x;
    -- Quiet days send nothing (the claim above still marks the day done).
    if coalesce(v_n, 0) = 0 then continue; end if;

    for u in
      select email from public.app_users
      where dsp_id = r.dsp_id and active and role >= 'dispatcher'
        and email is not null and position('@' in email) > 0
    loop
      insert into public.email_messages
        (dsp_id, direction, status, to_email, subject, body_text, body_html)
      values
        (r.dsp_id, 'outbound', 'queued', u.email,
         'Today at ' || coalesce(r.dsp_name, 'RouteReady') || ': ' || v_n || ' on the calendar',
         'Today''s calendar:' || E'\n\n' || v_text,
         '<p>Today''s calendar for <strong>' ||
           replace(replace(replace(coalesce(r.dsp_name, 'RouteReady'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') ||
           '</strong>:</p><ul>' || v_html || '</ul>');
      v_count := v_count + 1;
    end loop;
  end loop;

  return v_count;
end;
$fn$;
grant execute on function public.calendar_digest_run() to service_role;

do $$ begin
  perform cron.unschedule('calendar-digest');
exception when others then null; end $$;
select cron.schedule(
  'calendar-digest',
  '12 * * * *',
  $cron$ select public.calendar_digest_run(); $cron$
);

-- ── 7 · candidate confirmation + escalation (#76) ────────────────────────

create or replace function public.booking_confirm(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_app public.applicants;
  v_ev  public.cal_events;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then raise exception 'invalid_or_expired_token' using errcode = 'P0002'; end if;

  select * into v_ev from public.cal_events ce
    where ce.applicant_id = v_app.id and ce.kind = 'interview'
      and ce.status in ('scheduled','rescheduled') and ce.starts_at > now()
    order by ce.starts_at asc limit 1;
  if v_ev.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_booking');
  end if;

  update public.cal_events
     set metadata = coalesce(metadata, '{}'::jsonb)
       || jsonb_build_object('confirmed_at', now())
   where id = v_ev.id;

  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.booking_confirm(text) to anon, authenticated;

-- booking_load: surface the confirmation so the page can show its state.
-- Verbatim 0493 body + the booking.confirmed flag.
create or replace function public.booking_load(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_app    public.applicants;
  v_dsp    public.dsps;
  v_cfg    public.interview_config;
  v_sched  public.interview_schedules;
  v_booked public.cal_events;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;
  select * into v_dsp from public.dsps where id = v_app.dsp_id;
  select * into v_cfg from public.interview_config where dsp_id = v_app.dsp_id;
  select * into v_sched from public.interview_schedules
    where dsp_id = v_app.dsp_id and is_active limit 1;
  select * into v_booked from public.cal_events ce
    where ce.applicant_id = v_app.id and ce.kind = 'interview'
      and ce.status in ('scheduled','rescheduled')
    order by ce.starts_at asc limit 1;
  return jsonb_build_object(
    'dsp', jsonb_build_object('name', v_dsp.name, 'short_code', v_dsp.short_code),
    'applicant', jsonb_build_object('first_name', v_app.first_name, 'full_name', v_app.full_name),
    'timezone', coalesce(v_cfg.timezone, v_dsp.timezone, 'America/Chicago'),
    'slot_minutes', coalesce(v_cfg.slot_minutes, 30),
    'schedule_name', v_sched.name,
    'branding', coalesce(v_sched.branding, '{}'::jsonb),
    'arrival_notes', v_sched.arrival_notes,
    'intake_questions', coalesce(v_sched.intake_questions, '[]'::jsonb),
    'require_phone_verify', coalesce(v_sched.require_phone_verify, false),
    'phone_hint', case when v_app.phone is not null
                       then right(regexp_replace(v_app.phone, '\D', '', 'g'), 2) end,
    'options', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', s2.id, 'name', s2.name, 'slot_minutes', s2.slot_minutes,
                    'is_active', s2.is_active,
                    'arrival_notes', s2.arrival_notes,
                    'intake_questions', coalesce(s2.intake_questions, '[]'::jsonb),
                    'require_phone_verify', coalesce(s2.require_phone_verify, false)
                  ) order by s2.is_active desc, s2.sort_order), '[]'::jsonb)
                 from public.interview_schedules s2
                 where s2.dsp_id = v_app.dsp_id and (s2.is_active or s2.offer_public)),
    'already_booked', v_booked.id is not null,
    'booking', case when v_booked.id is null then null else jsonb_build_object(
      'starts_at', v_booked.starts_at,
      'ends_at', v_booked.ends_at,
      'meeting_url', v_booked.meeting_url,
      'location', v_booked.location,
      'running_late', v_booked.metadata->'running_late',
      'confirmed', (v_booked.metadata->>'confirmed_at') is not null
    ) end
  );
end; $$;
grant execute on function public.booking_load(text) to anon, authenticated;

-- Escalation scan: interviews inside the escalation window with no
-- confirmation → email the creator + dispatcher+ staff, plus a Web Push.
-- Exactly-once via the 'esc' label in cal_event_reminders.
create or replace function public.unconfirmed_escalation_run()
returns int language plpgsql security definer set search_path = '' as $fn$
declare
  r record;
  v_when text; v_word text; v_who text; v_who_html text;
  v_emails text[]; v_to text;
  v_count int := 0;
begin
  for r in
    select ce.id, ce.dsp_id, ce.starts_at, ce.created_by, ce.kind,
           a.full_name, a.phone, a.email as app_email,
           coalesce(cfg.timezone, d.timezone, 'America/Chicago') as tz
    from public.cal_events ce
    join public.applicants a on a.id = ce.applicant_id
    join public.dsps d on d.id = ce.dsp_id
    join public.interview_config cfg on cfg.dsp_id = ce.dsp_id
    where ce.kind in ('interview','orientation')
      and ce.status in ('scheduled','rescheduled')
      and (cfg.notify_prefs->>'escalate_hours') ~ '^[0-9]{1,2}$'
      and (cfg.notify_prefs->>'escalate_hours')::int between 1 and 48
      and ce.metadata->>'confirmed_at' is null
      and coalesce((ce.metadata->>'is_task')::boolean, false) = false
      and ce.starts_at > now()
      and ce.starts_at <= now() + ((cfg.notify_prefs->>'escalate_hours')::int * interval '1 hour')
      and not exists (
        select 1 from public.cal_event_reminders x
        where x.cal_event_id = ce.id and x.label = 'esc')
  loop
    begin
      insert into public.cal_event_reminders (cal_event_id, label) values (r.id, 'esc');
    exception when unique_violation then
      continue;
    end;

    v_when := to_char(r.starts_at at time zone r.tz, 'FMDay FMHH12:MI AM');
    v_word := case when r.kind = 'orientation' then 'orientation' else 'interview' end;
    v_who  := coalesce(nullif(btrim(r.full_name), ''), 'The applicant');
    v_who_html := replace(replace(replace(v_who, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');

    select array_agg(distinct u.email) into v_emails
    from public.app_users u
    where u.dsp_id = r.dsp_id and u.active
      and u.email is not null and position('@' in u.email) > 0
      and (u.id = r.created_by or u.role >= 'dispatcher');

    if v_emails is not null then
      foreach v_to in array v_emails loop
        insert into public.email_messages
          (dsp_id, cal_event_id, direction, status, to_email, subject, body_text, body_html)
        values
          (r.dsp_id, r.id, 'outbound', 'queued', v_to,
           'Unconfirmed: ' || v_who || ' — ' || v_word || ' ' || v_when,
           v_who || ' has not confirmed their ' || v_word || ' at ' || v_when || '.' ||
             case when r.phone is not null then ' Consider a quick call: ' || r.phone
                  when r.app_email is not null then ' Their email: ' || r.app_email
                  else '' end,
           '<p><strong>' || v_who_html || '</strong> has not confirmed their ' || v_word ||
             ' at <strong>' || v_when || '</strong>.</p>' ||
             case when r.phone is not null
                  then '<p>Consider a quick call: ' || replace(replace(replace(r.phone, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p>'
                  else '' end);
      end loop;
    end if;

    perform private.notify_staff_push(
      r.dsp_id,
      'Unconfirmed ' || v_word,
      v_who || ' hasn''t confirmed for ' || v_when,
      '/dashboard/index.html#onboarding-ops?ev=' || r.id,
      v_emails);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$fn$;
grant execute on function public.unconfirmed_escalation_run() to service_role;

do $$ begin
  perform cron.unschedule('unconfirmed-escalation');
exception when others then null; end $$;
select cron.schedule(
  'unconfirmed-escalation',
  '*/10 * * * *',
  $cron$ select public.unconfirmed_escalation_run(); $cron$
);

-- ── 8 · Slack / Teams chat notifications (#74) ──────────────────────────
-- Extends 0496's fire_cal_webhooks: after the per-endpoint webhook loop,
-- also post a human-readable line to the DSP's incoming-webhook URLs.

create or replace function private.fire_cal_webhooks()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_event text := null;
  w record;
  v_body jsonb;
  v_slack text; v_teams text; v_tz text; v_dsp_name text;
  v_name text; v_txt text;
begin
  if new.kind not in ('interview', 'orientation') then return new; end if;
  if tg_op = 'INSERT' and new.status in ('scheduled') and new.applicant_id is not null then
    v_event := 'booking_created';
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status then
    v_event := case new.status
      when 'cancelled' then 'booking_cancelled'
      when 'rescheduled' then 'booking_rescheduled'
      when 'no_show' then 'booking_no_show'
      else null end;
  elsif tg_op = 'UPDATE' and old.starts_at is distinct from new.starts_at
        and new.status in ('scheduled', 'rescheduled') then
    v_event := 'booking_rescheduled';
  end if;
  if v_event is null then return new; end if;

  v_body := jsonb_build_object(
    'event', v_event,
    'at', now(),
    'cal_event', jsonb_build_object(
      'id', new.id, 'kind', new.kind, 'status', new.status,
      'starts_at', new.starts_at, 'ends_at', new.ends_at,
      'timezone', new.timezone, 'location', new.location,
      'applicant_id', new.applicant_id));

  for w in select * from public.dsp_webhooks
            where dsp_id = new.dsp_id and active and v_event = any(events)
  loop
    begin
      perform net.http_post(
        url     := w.url,
        headers := jsonb_build_object('content-type', 'application/json',
                                      'x-rr-webhook-secret', w.secret,
                                      'x-rr-event', v_event),
        body    := v_body
      );
    exception when others then null;   -- a broken hook must never block a booking
    end;
  end loop;

  -- Slack / Teams incoming webhooks (#74). Simple {"text": ...} payloads,
  -- accepted by both. Best-effort — never blocks the booking.
  begin
    select cfg.notify_prefs->>'slack_url', cfg.notify_prefs->>'teams_url',
           coalesce(cfg.timezone, d.timezone, 'America/Chicago'), d.name
      into v_slack, v_teams, v_tz, v_dsp_name
    from public.dsps d
    left join public.interview_config cfg on cfg.dsp_id = d.id
    where d.id = new.dsp_id;

    if v_slack ~* '^https://' or v_teams ~* '^https://' then
      select a.full_name into v_name from public.applicants a where a.id = new.applicant_id;
      v_txt := case v_event
          when 'booking_created'     then '📅 New booking'
          when 'booking_cancelled'   then '❌ Booking cancelled'
          when 'booking_rescheduled' then '🔁 Booking rescheduled'
          when 'booking_no_show'     then '🚫 No-show'
          else v_event end
        || case when v_name is not null then ': ' || v_name else '' end
        || ' · ' || to_char(new.starts_at at time zone v_tz, 'FMDy Mon FMDD, FMHH12:MI AM')
        || case when v_dsp_name is not null then ' · ' || v_dsp_name else '' end;

      if v_slack ~* '^https://' then
        perform net.http_post(
          url     := v_slack,
          headers := jsonb_build_object('content-type', 'application/json'),
          body    := jsonb_build_object('text', v_txt));
      end if;
      if v_teams ~* '^https://' then
        perform net.http_post(
          url     := v_teams,
          headers := jsonb_build_object('content-type', 'application/json'),
          body    := jsonb_build_object('text', v_txt));
      end if;
    end if;
  exception when others then
    null;
  end;

  return new;
end;
$$;

drop trigger if exists trg_cal_events_webhooks on public.cal_events;
create trigger trg_cal_events_webhooks
  after insert or update on public.cal_events
  for each row execute function private.fire_cal_webhooks();

notify pgrst, 'reload schema';
