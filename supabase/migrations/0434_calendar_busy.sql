-- ───────────────────────────────────────────────────────────────────────
-- 0434 · Attendee free/busy for the composer's "Find a time"
--
-- calendar_busy(emails, from, to) returns the busy intervals of the given
-- attendees inside a window so the event composer can flag conflicts and
-- suggest open slots (Google's "Suggested times" / Outlook's Scheduling
-- Assistant). A person is BUSY during a non-cancelled, non-task cal_event
-- of this DSP when either:
--   • their email is on the event's invitee list (metadata.invitees), or
--   • they created it (created_by = the app_user with that email).
-- Emails are matched case-insensitively. p_exclude_event_id drops the
-- event currently being edited so it never conflicts with itself.
-- Idempotent.
-- ───────────────────────────────────────────────────────────────────────

create or replace function public.calendar_busy(
  p_emails            text[],
  p_from              timestamptz,
  p_to                timestamptz,
  p_exclude_event_id  uuid default null
)
returns table(email text, starts_at timestamptz, ends_at timestamptz, title text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    return;
  end if;

  return query
  with em as (
    select distinct lower(btrim(e)) as email
    from unnest(coalesce(p_emails, '{}'::text[])) as e
    where position('@' in e) > 0
  ),
  staff as (
    select lower(u.email::text) as email, u.id
    from public.app_users u
    where u.dsp_id = v_dsp and u.active
      and lower(u.email::text) in (select em.email from em)
  )
  select em.email,
         ce.starts_at,
         coalesce(ce.ends_at, ce.starts_at + interval '30 minutes') as ends_at,
         ce.title
  from em
  join public.cal_events ce
    on ce.dsp_id = v_dsp
   and ce.status in ('scheduled', 'rescheduled')
   and coalesce((ce.metadata->>'is_task')::boolean, false) = false
   and (p_exclude_event_id is null or ce.id <> p_exclude_event_id)
   and ce.starts_at < p_to
   and coalesce(ce.ends_at, ce.starts_at + interval '30 minutes') > p_from
   and (
     exists (
       select 1
       from jsonb_array_elements_text(
         case when jsonb_typeof(ce.metadata->'invitees') = 'array'
              then ce.metadata->'invitees' else '[]'::jsonb end) as inv
       where lower(inv) = em.email
     )
     or ce.created_by in (select s.id from staff s where s.email = em.email)
   );
end;
$$;

grant execute on function public.calendar_busy(text[], timestamptz, timestamptz, uuid) to authenticated;
