-- ───────────────────────────────────────────────────────────────────────
-- 0430 · Per-event reminders (Google/Outlook-style "10 minutes before")
--
-- The composer gains a reminder field (metadata.reminders = array of
-- minutes-before-start, e.g. [10, 1440]). Two delivery paths:
--
--   • In-app: the dashboard fires a popup when an offset crosses (client
--     only, no schema needed).
--   • Email: this cron scan emails the event's CREATOR — reminders are
--     operator-facing, matching Google's "reminders notify you, not your
--     guests" model. Candidate-facing interview reminders (0406/0410)
--     are untouched and continue to run separately.
--
-- cal_events.created_by records who to email. Plain uuid (no FK) so no
-- existing insert path — anon booking, service-role webhooks — can ever
-- trip a constraint; default auth.uid() stamps operator-created events
-- automatically. Events created before this migration have no creator
-- and simply never email (in-app popups still work for them).
--
-- Reuses the 0406 cal_event_reminders exactly-once log with 'm<minutes>'
-- labels. Reminder emails carry cal_event_id but NO calendar_method, so
-- the 0429 .ics attach never fires on them. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

alter table public.cal_events
  add column if not exists created_by uuid default auth.uid();

create index if not exists cal_events_reminders_idx
  on public.cal_events (starts_at)
  where (metadata ? 'reminders');

create or replace function public.event_reminders_run()
returns int language plpgsql security definer set search_path = '' as $fn$
declare
  r record;
  v_when text;
  v_title_html text;
  v_join text;
  v_count int := 0;
begin
  for r in
    select ce.id, ce.dsp_id, ce.starts_at, ce.meeting_url, ce.location,
           coalesce(nullif(btrim(ce.title), ''), 'Untitled event') as title,
           (rem.val)::int as mins,
           u.email as to_email,
           coalesce(ce.timezone, cfg.timezone, d.timezone, 'America/Chicago') as tz
    from public.cal_events ce
    join public.app_users u on u.id = ce.created_by and u.active
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
    -- Claim first; overlapping runs lose on the PK and skip (0406 pattern).
    begin
      insert into public.cal_event_reminders (cal_event_id, label)
      values (r.id, 'm' || r.mins);
    exception when unique_violation then
      continue;
    end;

    if r.to_email is null or position('@' in r.to_email) = 0 then
      continue;
    end if;

    v_when := to_char(r.starts_at at time zone r.tz, 'FMDay, FMMon FMDD at FMHH12:MI AM');
    -- Title is operator-typed free text — escape it for the HTML body.
    v_title_html := replace(replace(replace(r.title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
    v_join := case when r.meeting_url ~* '^https://'
                   then '<p>Join: <a href="' || r.meeting_url || '">' || r.meeting_url || '</a></p>'
                   else '' end;

    insert into public.email_messages
      (dsp_id, cal_event_id, direction, status, to_email, subject, body_text, body_html)
    values
      (r.dsp_id, r.id, 'outbound', 'queued', r.to_email,
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

  return v_count;
end;
$fn$;

grant execute on function public.event_reminders_run() to service_role;

-- ── Schedule · every 5 minutes (finer than the 15-min interview cron so a
-- 10-minute reminder can't fire after the meeting started) ────────────────
do $$ begin
  perform cron.unschedule('event-reminders');
exception when others then null; end $$;

select cron.schedule(
  'event-reminders',
  '*/5 * * * *',
  $cron$ select public.event_reminders_run(); $cron$
);
