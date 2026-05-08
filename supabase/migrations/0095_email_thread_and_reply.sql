-- Two-way email on the applicant card. Operators want to see applicant
-- replies (currently sent to a personal inbox via Reply-To) inside the
-- dashboard, and reply back without leaving it.
--
-- Backend pieces:
--   1. applicant_email_thread(p_applicant_id) — returns the chronological
--      email_messages rows for the applicant (DSP-scoped).
--   2. send_applicant_email(p_applicant_id, p_subject, p_body) — queues
--      a free-text outbound email row. The send-email edge function
--      already drains the queue.
-- Inbound rows arrive via the webhook-email-inbound edge function (a
-- separate piece of this PR). Either RPC is operator-facing
-- (dispatcher role required); the inbound path uses the service role.

-- ─── applicant_email_thread ────────────────────────────────────────────

create or replace function public.applicant_email_thread(p_applicant_id uuid)
returns table (
  id            uuid,
  direction     public.message_direction,
  status        public.message_status,
  to_email      text,
  from_email    text,
  subject       text,
  body_text     text,
  body_html     text,
  created_at    timestamptz,
  sent_at       timestamptz,
  delivered_at  timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'viewer') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select e.id, e.direction, e.status, e.to_email, e.from_email,
         e.subject, e.body_text, e.body_html,
         e.created_at, e.sent_at, e.delivered_at
    from public.email_messages e
   where e.dsp_id = v_dsp
     and e.applicant_id = p_applicant_id
   order by e.created_at asc;
end;
$$;

grant execute on function public.applicant_email_thread(uuid) to authenticated;


-- ─── send_applicant_email ──────────────────────────────────────────────
-- Free-text outbound email queued for the existing send-email function
-- to drain. Subject defaults to "Re: <last subject>" so the applicant's
-- mail client threads the reply naturally.

create or replace function public.send_applicant_email(
  p_applicant_id uuid,
  p_body         text,
  p_subject      text default null
)
returns public.email_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_app public.applicants;
  v_subject text;
  v_last_subject text;
  v_row public.email_messages;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(trim(p_body), '') = '' then
    raise exception 'body_required';
  end if;

  select * into v_app from public.applicants where id = p_applicant_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;
  if v_app.email is null or trim(v_app.email) = '' then
    raise exception 'applicant_has_no_email';
  end if;

  -- If the caller didn't supply a subject, derive one from the most
  -- recent message in the thread so reply clients keep them grouped.
  if coalesce(trim(p_subject), '') = '' then
    select subject into v_last_subject
      from public.email_messages
     where dsp_id = v_dsp and applicant_id = p_applicant_id
     order by created_at desc
     limit 1;
    if v_last_subject is null then
      v_subject := 'Message from ' || coalesce((select name from public.dsps where id = v_dsp), 'us');
    elsif v_last_subject ilike 'Re:%' then
      v_subject := v_last_subject;
    else
      v_subject := 'Re: ' || v_last_subject;
    end if;
  else
    v_subject := trim(p_subject);
  end if;

  insert into public.email_messages
    (dsp_id, applicant_id, direction, status, to_email, subject, body_text)
  values
    (v_dsp, p_applicant_id, 'outbound', 'queued', v_app.email, v_subject, p_body)
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.send_applicant_email(uuid, text, text) to authenticated;
