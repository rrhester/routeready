-- 0392_attendance_reason_in_summary.sql
-- Adjusts the attendance-reason work from 0391: the specific infraction
-- (No Call/No Show, Call-Out, Late) now rides in the coaching SUMMARY text,
-- and the severity label stays the generic "-Attendance" tag. So the push
-- should NOT also fold the reason into the severity wording (that would
-- double it against the summary).
--
-- Net change vs 0391: fire_coaching_push drops the reason wording and goes
-- back to the generic "attendance <severity>" flavor. The reason is still
-- stored on coachings.metadata.attendance_reason (stamping trigger +
-- send_coaching metadata passthrough + backfill are kept) so it's on the
-- record, and the driver RPCs still return it — but display now reads it
-- from the summary, so those fields are harmless if unused.
--
-- Self-contained + idempotent: run THIS instead of 0391 (it create-or-
-- replaces everything 0391 touched). Safe to re-run.

-- ── 1. Reason-stamping trigger (BEFORE INSERT) ────────────────────────
create or replace function private.coaching_stamp_attendance_reason()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if new.topic = 'attendance'::public.coaching_topic
     and coalesce(new.metadata->>'attendance_reason', '') = ''
     and new.triggering_shift_id is not null then
    select s.status::text into v_status
      from public.shifts s
     where s.id = new.triggering_shift_id;
    if v_status in ('no_show', 'called_off', 'late') then
      new.metadata := jsonb_set(
        coalesce(new.metadata, '{}'::jsonb),
        '{attendance_reason}',
        to_jsonb(v_status)
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_coaching_stamp_attendance_reason on public.coachings;
create trigger trg_coaching_stamp_attendance_reason
  before insert on public.coachings
  for each row execute function private.coaching_stamp_attendance_reason();

-- ── 2. Backfill existing attendance coachings ─────────────────────────
update public.coachings c
   set metadata = jsonb_set(
         coalesce(c.metadata, '{}'::jsonb),
         '{attendance_reason}',
         to_jsonb(s.status::text)
       )
  from public.shifts s
 where c.triggering_shift_id = s.id
   and c.topic = 'attendance'::public.coaching_topic
   and s.status in ('no_show', 'called_off', 'late')
   and coalesce(c.metadata->>'attendance_reason', '') = '';

-- ── 3. send_coaching — pass metadata (incl. a hand-picked reason) ─────
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

  select id into v_app_user_id from public.app_users where id = v_uid limit 1;

  insert into public.coachings (
    dsp_id, driver_id, coach_user_id, occurred_at,
    topic, type, severity,
    summary, notes,
    driver_visible, delivery_required, triggering_shift_id,
    incident_date, metadata
  )
  values (
    v_dsp,
    (p_payload->>'driver_id')::uuid,
    v_app_user_id,
    coalesce(nullif(p_payload->>'occurred_at', '')::timestamptz, now()),
    coalesce(nullif(p_payload->>'topic', '')::public.coaching_topic, 'other'),
    'documented_warning'::public.coaching_type,
    coalesce(nullif(p_payload->>'severity', '')::public.coaching_severity, 'verbal'),
    nullif(p_payload->>'summary', ''),
    nullif(p_payload->>'notes', ''),
    true,  -- new flow: every send_coaching surfaces in the driver app
    coalesce(nullif(p_payload->>'delivery_required', '')::public.coaching_delivery, 'ack'),
    nullif(p_payload->>'triggering_shift_id', '')::uuid,
    nullif(p_payload->>'incident_date', '')::date,
    coalesce(p_payload->'metadata', '{}'::jsonb)
  )
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.send_coaching(jsonb) to authenticated;

-- ── 4. fire_coaching_push — generic "attendance <severity>" wording ───
-- The reason lives in the summary (v_headline), so the push reads it from
-- there. No reason in the severity wording (would double it).
create or replace function private.fire_coaching_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_level    text;
  v_sevword  text;
  v_headline text;
  v_dspname  text;
  v_base     text;
  v_token    text;
  v_link     text;
  v_body     text;
begin
  if coalesce(new.driver_visible, false) is not true then
    return new;
  end if;

  begin
    v_level := lower(coalesce(new.metadata->>'level', new.severity::text, ''));
    v_sevword := case
      when v_level in ('verbal', 'verbal_attendance')  then 'coaching note'
      when v_level in ('written', 'written_attendance') then 'written warning'
      when v_level in ('final', 'final_attendance')     then 'final written warning'
      when v_level = 'termination'                      then 'termination notice'
      else 'coaching'
    end;

    select coalesce(nullif(d.name, ''), 'Dispatch'),
           coalesce(nullif(d.metadata->>'public_base_url', ''), 'https://gorouteready.com')
      into v_dspname, v_base
    from public.dsps d
    where d.id = new.dsp_id;
    v_dspname := coalesce(v_dspname, 'Dispatch');
    v_base    := coalesce(v_base, 'https://gorouteready.com');

    v_headline := coalesce(
      nullif(trim(new.summary), ''),
      -- new.topic is the coaching_topic enum — cast to text before
      -- concatenating, or COALESCE coerces '' into the enum and errors.
      nullif(trim(coalesce(new.topic::text, '') || ' ' || v_sevword), ''),
      'New coaching'
    );

    -- Attendance coachings read "attendance <severity>" to match the
    -- "-Attendance" label; the specific reason is in the summary above.
    -- Applied after the headline fallback so the topic word isn't doubled.
    if new.topic::text = 'attendance' then
      v_sevword := 'attendance ' || v_sevword;
    end if;

    select nullif(dr.coaching_view_token::text, '')
      into v_token
    from public.drivers dr
    where dr.id = new.driver_id;
    if v_token is not null then
      v_link := rtrim(v_base, '/') || '/c/' || v_token;
    end if;

    v_body := 'New ' || v_sevword || ' from ' || v_dspname || ': ' || v_headline || '.'
      || case
           when v_link is not null then E'\n\nReview and sign here: ' || v_link
           else '  Reach out to dispatch to review and sign.'
         end;

    insert into public.driver_messages (driver_id, dsp_id, sender_kind, sender_user_id, body)
      values (new.driver_id, new.dsp_id, 'dispatch', auth.uid(), v_body);

    insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
      values (new.driver_id, new.dsp_id, now())
      on conflict (driver_id) do update set last_message_at = excluded.last_message_at;
  exception when others then
    null;
  end;

  return new;
end;
$$;

drop trigger if exists trg_coachings_fire_push on public.coachings;
create trigger trg_coachings_fire_push
  after insert on public.coachings
  for each row execute function private.fire_coaching_push();

-- ── 5a. coaching_for_driver_token — keep returning the reason ─────────
drop function if exists public.coaching_for_driver_token(text);
create or replace function public.coaching_for_driver_token(p_token text)
returns table (
  id                uuid,
  occurred_at       timestamptz,
  topic             text,
  type              text,
  severity          text,
  attendance_reason text,
  summary           text,
  notes             text,
  action_taken      jsonb,
  coached_by_name   text,
  acknowledgment    text,
  acknowledged_at   timestamptz,
  driver_full_name  text,
  dsp_name          text
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_dsp public.dsps;
begin
  select * into v_drv from public.drivers where coaching_view_token = p_token;
  if not found then raise exception 'invalid token' using errcode = '42501'; end if;

  select * into v_dsp from public.dsps where id = v_drv.dsp_id;

  return query
  select c.id, c.occurred_at,
         c.topic::text, c.type::text, c.severity::text,
         c.metadata->>'attendance_reason',
         c.summary, c.notes, c.action_taken,
         c.coached_by_name,
         c.acknowledgment::text, c.acknowledged_at,
         v_drv.full_name,
         v_dsp.name
    from public.coachings c
   where c.driver_id = v_drv.id
     and c.driver_visible = true
     and c.archived_at is null
     and c.privacy_tier = 'standard'
   order by c.occurred_at desc;
end $$;

grant execute on function public.coaching_for_driver_token(text) to anon, authenticated;

-- ── 5b. driver_list_coachings — keep returning the reason ─────────────
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
    'attendance_reason', c.metadata->>'attendance_reason',
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
    and c.archived_at  is null
    and c.acknowledged_at is null;  -- pending only (unchanged from 0088)

  return v_rows;
end;
$$;
grant execute on function public.driver_list_coachings(text) to anon, authenticated;

notify pgrst, 'reload schema';
