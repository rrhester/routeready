-- 0083_coaching_v2.sql
--
-- Phase 1 of the coaching system overhaul.  Coaching becomes a
-- driver-facing primitive that fires from many trigger surfaces
-- (Attendance Event log, Attendance Report, future safety + quality
-- scorecards, ad-hoc from the driver record drawer).  Drivers get a
-- unified /tasks/coaching feed in the app where they read,
-- acknowledge, and sign coachings — backed by one canonical RPC.
--
-- This migration is additive: it extends the existing public.coachings
-- table, doesn't fork it.  Existing data keeps working; new fields
-- power the new flows.
--
-- Schema changes:
--   1. coaching_severity enum gains 'note', 'verbal', 'written',
--      'termination'.  The existing 'final' value stays.  Older
--      values (info / concern / warning) remain readable so historic
--      coachings still load, but the new UI only writes the new
--      values.
--   2. coaching_topic enum gains 'quality'.
--   3. coaching_delivery enum is new — 'none' / 'ack' / 'sign' /
--      'ack_and_sign'.  Says what the driver must do to clear the
--      coaching from their feed.
--   4. coachings.delivery_required + coachings.signed_at +
--      coachings.triggering_shift_id columns.
--
-- RPCs:
--   1. send_coaching(p_payload) — every trigger surface uses this.
--      Always sets driver_visible = true so the driver app sees the
--      coaching immediately.  Gated to dispatcher staff.
--   2. driver_list_coachings(p_token) — feed for the driver app.
--   3. driver_ack_coaching(p_token, p_id, p_signature_b64) —
--      driver completes the coaching's required action.


-- 1. coaching_severity additions
alter type public.coaching_severity add value if not exists 'note';
alter type public.coaching_severity add value if not exists 'verbal';
alter type public.coaching_severity add value if not exists 'written';
alter type public.coaching_severity add value if not exists 'termination';


-- 2. coaching_topic additions
alter type public.coaching_topic add value if not exists 'quality';


-- 3. coaching_delivery enum
do $$ begin
  if not exists (select 1 from pg_type where typname = 'coaching_delivery') then
    create type public.coaching_delivery as enum ('none','ack','sign','ack_and_sign');
  end if;
end $$;


-- 4. coachings columns
alter table public.coachings
  add column if not exists delivery_required   public.coaching_delivery not null default 'none',
  add column if not exists triggering_shift_id uuid references public.shifts(id) on delete set null,
  add column if not exists signed_at           timestamptz;

create index if not exists coachings_driver_open_idx
  on public.coachings (driver_id, occurred_at desc)
  where archived_at is null and driver_visible = true;


-- 5. send_coaching — canonical insert path
create or replace function public.send_coaching(p_payload jsonb)
returns public.coachings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_app_user_id uuid;
  v_row public.coachings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if (p_payload->>'driver_id') is null then
    raise exception 'driver_id_required' using errcode = '22023';
  end if;

  -- coach_user_id references public.app_users.  app_users.id is the
  -- auth.users.id, so auth.uid() resolves directly.
  select id into v_app_user_id from public.app_users where id = v_uid limit 1;

  insert into public.coachings (
    dsp_id, driver_id, coach_user_id, occurred_at,
    topic, type, severity,
    summary, notes,
    driver_visible, delivery_required, triggering_shift_id,
    incident_date
  )
  values (
    v_dsp,
    (p_payload->>'driver_id')::uuid,
    v_app_user_id,
    coalesce(nullif(p_payload->>'occurred_at','')::timestamptz, now()),
    coalesce(nullif(p_payload->>'topic','')::public.coaching_topic, 'other'),
    'documented_warning'::public.coaching_type,
    coalesce(nullif(p_payload->>'severity','')::public.coaching_severity, 'verbal'),
    nullif(p_payload->>'summary',''),
    nullif(p_payload->>'notes',''),
    true,  -- new flow: every send_coaching surfaces in the driver app
    coalesce(nullif(p_payload->>'delivery_required','')::public.coaching_delivery, 'ack'),
    nullif(p_payload->>'triggering_shift_id','')::uuid,
    nullif(p_payload->>'incident_date','')::date
  )
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.send_coaching(jsonb) to authenticated;


-- 6. driver_list_coachings — unified feed for the driver app
create or replace function public.driver_list_coachings(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_rows jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',                c.id,
    'occurred_at',       c.occurred_at,
    'topic',             c.topic,
    'severity',          c.severity,
    'summary',           c.summary,
    'notes',             c.notes,
    'coached_by_name',   c.coached_by_name,
    'delivery_required', c.delivery_required,
    'acknowledged_at',   c.acknowledged_at,
    'signed_at',         c.signed_at
  ) order by c.occurred_at desc), '[]'::jsonb)
    into v_rows
  from public.coachings c
  where c.driver_id    = v_drv.id
    and c.driver_visible = true
    and c.archived_at  is null;

  return v_rows;
end;
$$;
grant execute on function public.driver_list_coachings(text) to anon, authenticated;


-- 7. driver_ack_coaching — driver completes their required action
create or replace function public.driver_ack_coaching(
  p_token         text,
  p_coaching_id   uuid,
  p_signature_b64 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_row public.coachings;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_row from public.coachings
   where id = p_coaching_id and driver_id = v_drv.id;
  if v_row.id is null then raise exception 'coaching_not_found' using errcode = 'P0001'; end if;

  -- Acknowledgment timestamp lands when the required action is met.
  -- Signature gets stored when delivery_required wants one and the
  -- driver provided it.
  if v_row.delivery_required in ('ack','ack_and_sign') then
    update public.coachings
       set acknowledged_at = coalesce(acknowledged_at, now())
     where id = p_coaching_id;
  end if;
  if v_row.delivery_required in ('sign','ack_and_sign') then
    if p_signature_b64 is null or p_signature_b64 = '' then
      raise exception 'signature_required' using errcode = '22023';
    end if;
    update public.coachings
       set ack_signature_b64 = p_signature_b64,
           signed_at         = coalesce(signed_at, now()),
           acknowledged_at   = coalesce(acknowledged_at, now())
     where id = p_coaching_id;
  end if;

  select * into v_row from public.coachings where id = p_coaching_id;
  return jsonb_build_object(
    'id',              v_row.id,
    'acknowledged_at', v_row.acknowledged_at,
    'signed_at',       v_row.signed_at
  );
end;
$$;
grant execute on function public.driver_ack_coaching(text, uuid, text) to anon, authenticated;


notify pgrst, 'reload schema';
