-- Migration 0150 · driver_app_status() — per-driver "are they on the
-- driver app yet?" status for the operator dashboard.
--
-- Signals (all already collected):
--   • driver_invite_codes.consumed_at — set when a driver redeems their
--     invite code, i.e. the first time they sign in.
--   • driver_sessions.last_seen_at — bumped on every app request.
--   • driver_push_subscriptions — a row means they installed the PWA and
--     allowed notifications.
--
-- Returns one row per driver in the caller's DSP. `invited` = a code was
-- issued (consumed or not); `signed_in_at` = earliest consumed_at (null
-- if never signed in); `last_seen_at` = most recent session activity;
-- `has_push` = has at least one push subscription.

create or replace function public.driver_app_status()
returns table (
  driver_id    uuid,
  invited      boolean,
  signed_in_at timestamptz,
  last_seen_at timestamptz,
  has_push     boolean
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
  select
    d.id,
    exists (select 1 from public.driver_invite_codes ic
             where ic.driver_id = d.id and ic.dsp_id = v_dsp),
    (select min(ic.consumed_at) from public.driver_invite_codes ic
      where ic.driver_id = d.id and ic.dsp_id = v_dsp and ic.consumed_at is not null),
    (select max(s.last_seen_at) from public.driver_sessions s
      where s.driver_id = d.id and s.dsp_id = v_dsp and s.revoked_at is null),
    exists (select 1 from public.driver_push_subscriptions ps
             where ps.driver_id = d.id and ps.dsp_id = v_dsp)
  from public.drivers d
  where d.dsp_id = v_dsp;
end;
$$;

grant execute on function public.driver_app_status() to authenticated;

notify pgrst, 'reload schema';
