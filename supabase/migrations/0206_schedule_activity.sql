-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0206 · Schedule activity feed
--
-- One chronological merge of every audit event on the schedule:
--   • shift_changes      (created / driver moves / time edits / status flips)
--   • shift_offers_audit (Cover offers + accept / decline / expire)
--   • shift_swaps_audit  (peer swap requests + outcomes)
--
-- Built on the audit tables shipped in #834 / #830 / #838. Dispatcher
-- can see exactly what happened, when, by whom, across the schedule —
-- HR replay, post-mortems, "who moved Bob on Tuesday?", all answered
-- from one feed.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.schedule_activity(
  p_since timestamptz default null,
  p_limit int default 200
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_since timestamptz := coalesce(p_since, now() - interval '24 hours');
  v_lim   int := greatest(least(coalesce(p_limit, 200), 500), 10);
  v_rows  jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with shift_evt as (
    select
      'shift'::text      as source,
      c.event            as event,
      c.at               as at,
      c.shift_id,
      c.before,
      c.after,
      c.actor_user_id    as actor_user_id,
      null::uuid         as actor_driver_id,
      s.date             as shift_date,
      s.route_code,
      s.driver_id        as current_driver_id
    from public.shift_changes c
    join public.shifts s on s.id = c.shift_id
    where c.dsp_id = v_dsp
      and c.at    >= v_since
  ),
  offer_evt as (
    select
      'offer'::text      as source,
      a.event            as event,
      a.at               as at,
      o.shift_id,
      a.metadata         as before,
      null::jsonb        as after,
      a.actor_user_id    as actor_user_id,
      coalesce(a.actor_driver_id, o.driver_id) as actor_driver_id,
      s.date             as shift_date,
      s.route_code,
      s.driver_id        as current_driver_id
    from public.shift_offers_audit a
    join public.shift_offers       o on o.id = a.offer_id
    join public.shifts             s on s.id = o.shift_id
    where o.dsp_id = v_dsp
      and a.at    >= v_since
  ),
  swap_evt as (
    select
      'swap'::text       as source,
      a.event            as event,
      a.at               as at,
      r.requester_shift_id as shift_id,
      a.metadata         as before,
      null::jsonb        as after,
      null::uuid         as actor_user_id,
      coalesce(a.actor_driver_id, r.requester_driver_id) as actor_driver_id,
      s.date             as shift_date,
      s.route_code,
      s.driver_id        as current_driver_id
    from public.shift_swaps_audit  a
    join public.shift_swap_requests r on r.id = a.swap_id
    join public.shifts              s on s.id = r.requester_shift_id
    where r.dsp_id = v_dsp
      and a.at    >= v_since
  ),
  merged as (
    select * from shift_evt
    union all
    select * from offer_evt
    union all
    select * from swap_evt
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source',          m.source,
    'event',           m.event,
    'at',              m.at,
    'shift_id',        m.shift_id,
    'shift_date',      m.shift_date,
    'route_code',      m.route_code,
    'before',          m.before,
    'after',           m.after,
    'actor_name',      coalesce(
                         nullif(trim(au.full_name), ''),
                         au.email,
                         nullif(trim(dr.preferred_name), ''),
                         nullif(trim(dr.full_name), '')
                       )
  ) order by m.at desc), '[]'::jsonb) into v_rows
  from (
    select * from merged order by at desc limit v_lim
  ) m
  left join public.app_users au on au.id = m.actor_user_id
  left join public.drivers   dr on dr.id = m.actor_driver_id;

  return jsonb_build_object(
    'since',  v_since,
    'limit',  v_lim,
    'events', v_rows
  );
end;
$$;
grant execute on function public.schedule_activity(timestamptz, int) to authenticated;

notify pgrst, 'reload schema';
