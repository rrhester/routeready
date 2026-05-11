-- Migration 0148 · applicant_email_thread — also surface inbound mail by
-- sender address, not only by applicant_id.
--
-- webhook-email-inbound attaches a reply to one applicant. When several
-- applicants share an email address (a re-apply, a referrer who also
-- applied, reused test data), the reply can land on a different applicant
-- row than the one whose thread the operator has open — so it looks
-- "lost." Show inbound mail whose sender matches this applicant's email
-- regardless of which applicant row it was filed under. Outbound is
-- still strictly by applicant_id (those are unambiguous).

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
  v_dsp   uuid := private.current_dsp_id();
  v_email text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select email::text into v_email
    from public.applicants where id = p_applicant_id and dsp_id = v_dsp;

  return query
  select e.id, e.direction, e.status, e.to_email, e.from_email,
         e.subject, e.body_text, e.body_html,
         e.created_at, e.sent_at, e.delivered_at
    from public.email_messages e
   where e.dsp_id = v_dsp
     and (
       e.applicant_id = p_applicant_id
       or (
         e.direction = 'inbound'
         and v_email is not null
         and e.from_email is not null
         and lower(e.from_email) = lower(v_email)
       )
     )
   order by e.created_at asc;
end;
$$;

grant execute on function public.applicant_email_thread(uuid) to authenticated;

notify pgrst, 'reload schema';
