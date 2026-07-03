-- ───────────────────────────────────────────────────────────────────────
-- 0406 · Automatic interview reminders (email + SMS)
--
-- No-shows are the #1 operational pain in high-volume driver recruiting, and
-- the calendar had no reminder machinery at all — a candidate booked days out
-- and never heard from the system again until the meeting.
--
-- This adds a scheduled scan that queues a reminder ~24h before and ~1h before
-- each upcoming interview/orientation. Queued email_messages / sms_messages
-- rows auto-send via the existing 0007 fire-on-insert trigger, so this only has
-- to enqueue. A per-event log makes it exactly-once regardless of cron cadence.
--
-- Idempotent.
-- ───────────────────────────────────────────────────────────────────────

-- Per-DSP off switch (default on). Missing config row ⇒ enabled.
alter table public.interview_config
  add column if not exists reminders_enabled boolean not null default true;

-- Exactly-once log: one row per (event, offset). PK dedupes re-runs.
create table if not exists public.cal_event_reminders (
  cal_event_id uuid not null references public.cal_events(id) on delete cascade,
  label        text not null,                 -- 'r24h' | 'r1h'
  sent_at      timestamptz not null default now(),
  primary key (cal_event_id, label)
);

-- Scan upcoming interviews/orientations and enqueue reminders. Returns the
-- number of reminder messages queued. security definer so cron (and only cron /
-- service_role) can run it across every DSP.
create or replace function public.interview_reminders_run()
returns int language plpgsql security definer set search_path = '' as $fn$
declare
  r record;
  v_tz text;
  v_when text;
  v_word text;
  v_first text;
  v_join text;
  v_subject text;
  v_html text;
  v_text text;
  v_count int := 0;
begin
  for r in
    select ce.id, ce.dsp_id, ce.applicant_id, ce.kind, ce.starts_at, ce.meeting_url,
           lbl.label,
           coalesce(cfg.timezone, d.timezone, 'America/Chicago') as tz,
           a.full_name, a.email, a.phone, d.name as dsp_name
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
    -- Claim the reminder first; if two runs overlap, the PK conflict skips the
    -- loser so nobody is double-messaged.
    begin
      insert into public.cal_event_reminders (cal_event_id, label) values (r.id, r.label);
    exception when unique_violation then
      continue;
    end;

    v_tz := r.tz;
    v_word := case when r.kind = 'orientation' then 'orientation' else 'interview' end;
    v_first := coalesce(nullif(split_part(btrim(r.full_name), ' ', 1), ''), 'there');
    v_when := to_char(r.starts_at at time zone v_tz, 'FMDay, FMMon FMDD at FMHH12:MI AM');
    v_join := case when r.meeting_url ~* '^https://'
                   then '<p>Join the video meeting:<br><a href="' || r.meeting_url || '">' || r.meeting_url || '</a></p>'
                   else '' end;
    v_subject := 'Reminder: your ' || v_word || ' ' ||
                 case when r.label = 'r1h' then 'starts soon' else 'is ' ||
                   case when r.starts_at <= now() + interval '3 hours' then 'coming up' else 'tomorrow' end
                 end;

    -- Email (when we have one).
    if r.email is not null and position('@' in r.email) > 0 then
      v_html := '<p>Hi ' || v_first || ',</p>' ||
                '<p>This is a reminder that your ' || v_word || ' is scheduled for:</p>' ||
                '<p><strong>' || v_when || '</strong></p>' || v_join ||
                '<p>Reply to this email if you need to reschedule. See you then!</p>';
      insert into public.email_messages
        (dsp_id, applicant_id, cal_event_id, direction, status, to_email, subject, body_text, body_html)
      values
        (r.dsp_id, r.applicant_id, r.id, 'outbound', 'queued', r.email, v_subject,
         'Reminder: your ' || v_word || ' is scheduled for ' || v_when ||
           case when r.meeting_url ~* '^https://' then '. Join: ' || r.meeting_url else '' end,
         v_html);
      v_count := v_count + 1;
    end if;

    -- SMS (when we have a phone).
    if r.phone is not null and length(btrim(r.phone)) >= 7 then
      v_text := 'Reminder: your ' || v_word || ' is ' || v_when ||
                case when r.meeting_url ~* '^https://' then '. Join: ' || r.meeting_url else '' end ||
                '. Reply here to reschedule.';
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

-- ── Schedule · every 15 minutes ────────────────────────────────────────────
do $$ begin
  perform cron.unschedule('interview-reminders');
exception when others then null; end $$;

select cron.schedule(
  'interview-reminders',
  '*/15 * * * *',
  $cron$ select public.interview_reminders_run(); $cron$
);
