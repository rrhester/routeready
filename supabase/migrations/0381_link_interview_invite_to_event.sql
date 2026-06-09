-- ───────────────────────────────────────────────────────────────────────
-- 0381 · Link the interview invite to the event it produced
--
-- The booking-link email/SMS (template key applicant.invite_interview /
-- applicant.invite_orientation) is queued BEFORE the applicant books, so it
-- has no cal_event_id and never showed up in the calendar event's "Messages
-- sent" trail. When the booking finally creates the cal_event, link the
-- applicant's most recent unlinked invite to it — via an AFTER INSERT
-- trigger, so it works for every booking path (native book_interview_slot,
-- Cal.com book_event, and anything future).
--
-- Idempotent. Safe to re-run.
-- ───────────────────────────────────────────────────────────────────────

create or replace function private.link_invite_to_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.applicant_id is null or new.kind not in ('interview', 'orientation') then
    return new;
  end if;

  -- Most recent outbound interview/orientation invite for this applicant that
  -- isn't already tied to an event. One per channel.
  update public.email_messages em
  set cal_event_id = new.id
  where em.id = (
    select e2.id from public.email_messages e2
    join public.message_templates t on t.id = e2.template_id
    where e2.applicant_id = new.applicant_id
      and e2.cal_event_id is null
      and e2.direction = 'outbound'
      and t.key in ('applicant.invite_interview', 'applicant.invite_orientation')
    order by e2.created_at desc
    limit 1
  );

  update public.sms_messages sm
  set cal_event_id = new.id
  where sm.id = (
    select s2.id from public.sms_messages s2
    join public.message_templates t on t.id = s2.template_id
    where s2.applicant_id = new.applicant_id
      and s2.cal_event_id is null
      and s2.direction = 'outbound'
      and t.key in ('applicant.invite_interview', 'applicant.invite_orientation')
    order by s2.created_at desc
    limit 1
  );

  return new;
end;
$$;

drop trigger if exists trg_cal_events_link_invite on public.cal_events;
create trigger trg_cal_events_link_invite
  after insert on public.cal_events
  for each row execute function private.link_invite_to_event();


-- ─── Backfill: link past invites to the event each one produced ────────
-- For every existing interview/orientation event, attach the applicant's most
-- recent unlinked invite sent at/before the event was created.
update public.email_messages em
set cal_event_id = ce.id
from public.cal_events ce
where ce.applicant_id = em.applicant_id
  and ce.kind in ('interview', 'orientation')
  and em.cal_event_id is null
  and em.direction = 'outbound'
  and em.created_at <= ce.created_at
  and em.template_id is not null
  and em.id = (
    select e2.id from public.email_messages e2
    join public.message_templates t2 on t2.id = e2.template_id
    where e2.applicant_id = ce.applicant_id
      and e2.cal_event_id is null
      and e2.direction = 'outbound'
      and e2.created_at <= ce.created_at
      and t2.key in ('applicant.invite_interview', 'applicant.invite_orientation')
    order by e2.created_at desc
    limit 1
  );

update public.sms_messages sm
set cal_event_id = ce.id
from public.cal_events ce
where ce.applicant_id = sm.applicant_id
  and ce.kind in ('interview', 'orientation')
  and sm.cal_event_id is null
  and sm.direction = 'outbound'
  and sm.created_at <= ce.created_at
  and sm.template_id is not null
  and sm.id = (
    select s2.id from public.sms_messages s2
    join public.message_templates t2 on t2.id = s2.template_id
    where s2.applicant_id = ce.applicant_id
      and s2.cal_event_id is null
      and s2.direction = 'outbound'
      and s2.created_at <= ce.created_at
      and t2.key in ('applicant.invite_interview', 'applicant.invite_orientation')
    order by s2.created_at desc
    limit 1
  );
