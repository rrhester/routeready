-- Migration 0147 · drop the never-defined 'viewer' role from two RPCs
--
-- applicant_email_thread (0095) and referral_leaderboard (0092) both
-- gate on `private.is_staff(v_dsp, 'viewer')`, but public.app_role only
-- ever had ('driver','dispatcher','ops','owner') — 'viewer' was never
-- added.  So the implicit 'viewer'::app_role cast throws
-- `invalid input value for enum public.app_role: "viewer"` and the RPC
-- fails for everyone — e.g. opening the applicant email thread modal.
--
-- There's no 'viewer' user anywhere (nothing assigns that role), so the
-- intent was simply "any back-office user".  Match the rest of the
-- operator RPCs: gate on 'dispatcher'.

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
  if not private.is_staff(v_dsp, 'dispatcher') then
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
  if not private.is_staff(v_dsp, 'dispatcher') then
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

notify pgrst, 'reload schema';
