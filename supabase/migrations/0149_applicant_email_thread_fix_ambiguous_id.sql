-- Migration 0149 · applicant_email_thread — fix "column reference id is
-- ambiguous".
--
-- 0148 added `select email into v_email from public.applicants where
-- id = p_applicant_id`. Because the function RETURNS TABLE(id uuid, …),
-- `id` is also an OUT-parameter name in scope, so the unqualified `id`
-- in that WHERE clause is ambiguous and the function errors at call
-- time. Alias the table and qualify the reference.

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

  select a.email::text into v_email
    from public.applicants a
   where a.id = p_applicant_id and a.dsp_id = v_dsp;

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
