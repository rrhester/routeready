-- ─────────────────────────────────────────────────────────────────────────
-- 0493 · Booking page v2 (calendar 100-list #19, #22, #23, #24, #25, #29, #30)
--
--  • interview_schedules gains candidate-facing fields: branding (accent /
--    welcome message), arrival_notes (directions / parking / what to bring),
--    intake_questions (asked at confirm; answers land on the booked event's
--    metadata.intake_answers), require_phone_verify (SMS code before booking),
--    and offer_public (list this schedule as a pickable appointment type on
--    the booking page alongside the active one).
--  • booking_load returns all of the above + the offered schedule options.
--  • interview_open_slots / book_interview_slot accept p_schedule_id so a
--    candidate can book any OFFERED schedule — config + weekly windows come
--    from that schedule directly; every existing guard (lead time, grid
--    alignment, overrides, busy-block, capacity, advisory lock) is unchanged
--    and capacity still counts ALL interviews in the time range, so two
--    schedules can never oversell the same hour.
--  • booking_verify_start + booking_phone_codes: 6-digit SMS code (10-min
--    expiry, 5 attempts, 60s resend cool-down) enforced by book_interview_slot
--    when the governing schedule requires it.
--  • cancel_interview_booking gains p_reason (stored on the event).
--  • booking_running_late: candidate one-tap "running late" — lands on the
--    event's metadata for the operator's calendar to badge.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1 · schedule columns ────────────────────────────────────────────────

alter table public.interview_schedules add column if not exists branding jsonb not null default '{}'::jsonb;
alter table public.interview_schedules add column if not exists arrival_notes text;
alter table public.interview_schedules add column if not exists intake_questions jsonb not null default '[]'::jsonb;
alter table public.interview_schedules add column if not exists require_phone_verify boolean not null default false;
alter table public.interview_schedules add column if not exists offer_public boolean not null default false;

-- ── 2 · phone-verification codes (definer-only; RLS with no policies) ───

create table if not exists public.booking_phone_codes (
  applicant_id uuid primary key references public.applicants(id) on delete cascade,
  code         text not null,
  phone        text,
  expires_at   timestamptz not null,
  attempts     int not null default 0,
  sent_at      timestamptz not null default now()
);
alter table public.booking_phone_codes enable row level security;

create or replace function public.booking_verify_start(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_app   public.applicants;
  v_sched public.interview_schedules;
  v_code  text;
  v_last  timestamptz;
  v_phone text;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then raise exception 'invalid_or_expired_token' using errcode='P0002'; end if;

  select * into v_sched from public.interview_schedules
    where dsp_id = v_app.dsp_id and is_active limit 1;
  -- Verification is only offered when some offered schedule requires it.
  if not exists (select 1 from public.interview_schedules s
                  where s.dsp_id = v_app.dsp_id and (s.is_active or s.offer_public)
                    and coalesce(s.require_phone_verify, false)) then
    return jsonb_build_object('ok', false, 'error', 'not_required');
  end if;

  v_phone := nullif(regexp_replace(coalesce(v_app.phone, ''), '[^0-9+]', '', 'g'), '');
  if v_phone is null then
    return jsonb_build_object('ok', false, 'error', 'no_phone');
  end if;

  select sent_at into v_last from public.booking_phone_codes where applicant_id = v_app.id;
  if v_last is not null and v_last > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'error', 'too_soon');
  end if;

  v_code := lpad((floor(random() * 900000) + 100000)::int::text, 6, '0');
  insert into public.booking_phone_codes (applicant_id, code, phone, expires_at, attempts, sent_at)
  values (v_app.id, v_code, v_phone, now() + interval '10 minutes', 0, now())
  on conflict (applicant_id) do update
    set code = excluded.code, phone = excluded.phone,
        expires_at = excluded.expires_at, attempts = 0, sent_at = now();

  insert into public.sms_messages (dsp_id, applicant_id, direction, status, to_phone, body)
  values (v_app.dsp_id, v_app.id, 'outbound', 'queued', v_phone,
          'Your interview booking code is ' || v_code || '. It expires in 10 minutes.');

  return jsonb_build_object('ok', true,
    'phone_hint', right(regexp_replace(v_phone, '\D', '', 'g'), 2));
end; $$;
grant execute on function public.booking_verify_start(text) to anon, authenticated;

-- ── 3 · booking_load v2 ─────────────────────────────────────────────────

create or replace function public.booking_load(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_app    public.applicants;
  v_dsp    public.dsps;
  v_cfg    public.interview_config;
  v_sched  public.interview_schedules;
  v_booked public.cal_events;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;
  select * into v_dsp from public.dsps where id = v_app.dsp_id;
  select * into v_cfg from public.interview_config where dsp_id = v_app.dsp_id;
  select * into v_sched from public.interview_schedules
    where dsp_id = v_app.dsp_id and is_active limit 1;
  select * into v_booked from public.cal_events ce
    where ce.applicant_id = v_app.id and ce.kind = 'interview'
      and ce.status in ('scheduled','rescheduled')
    order by ce.starts_at asc limit 1;
  return jsonb_build_object(
    'dsp', jsonb_build_object('name', v_dsp.name, 'short_code', v_dsp.short_code),
    'applicant', jsonb_build_object('first_name', v_app.first_name, 'full_name', v_app.full_name),
    'timezone', coalesce(v_cfg.timezone, v_dsp.timezone, 'America/Chicago'),
    'slot_minutes', coalesce(v_cfg.slot_minutes, 30),
    'schedule_name', v_sched.name,
    'branding', coalesce(v_sched.branding, '{}'::jsonb),
    'arrival_notes', v_sched.arrival_notes,
    'intake_questions', coalesce(v_sched.intake_questions, '[]'::jsonb),
    'require_phone_verify', coalesce(v_sched.require_phone_verify, false),
    'phone_hint', case when v_app.phone is not null
                       then right(regexp_replace(v_app.phone, '\D', '', 'g'), 2) end,
    -- Appointment-type options: the active schedule + any offered publicly.
    'options', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', s2.id, 'name', s2.name, 'slot_minutes', s2.slot_minutes,
                    'is_active', s2.is_active,
                    'arrival_notes', s2.arrival_notes,
                    'intake_questions', coalesce(s2.intake_questions, '[]'::jsonb),
                    'require_phone_verify', coalesce(s2.require_phone_verify, false)
                  ) order by s2.is_active desc, s2.sort_order), '[]'::jsonb)
                 from public.interview_schedules s2
                 where s2.dsp_id = v_app.dsp_id and (s2.is_active or s2.offer_public)),
    'already_booked', v_booked.id is not null,
    'booking', case when v_booked.id is null then null else jsonb_build_object(
      'starts_at', v_booked.starts_at,
      'ends_at', v_booked.ends_at,
      'meeting_url', v_booked.meeting_url,
      'location', v_booked.location,
      'running_late', v_booked.metadata->'running_late'
    ) end
  );
end; $$;
grant execute on function public.booking_load(text) to anon, authenticated;

-- ── 4 · interview_open_slots(p_token, p_schedule_id) ───────────────────

drop function if exists public.interview_open_slots(text);
create or replace function public.interview_open_slots(p_token text, p_schedule_id uuid default null)
returns table (slot_start timestamptz, slot_end timestamptz, capacity int, remaining int, session_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_app public.applicants; v_dsp uuid; v_cfg public.interview_config; v_sched public.interview_schedules;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then raise exception 'invalid_or_expired_token' using errcode='P0002'; end if;
  v_dsp := v_app.dsp_id;
  select * into v_cfg from public.interview_config where dsp_id=v_dsp;
  if v_cfg.dsp_id is null then
    v_cfg.timezone:='America/Chicago'; v_cfg.slot_minutes:=30; v_cfg.buffer_minutes:=0;
    v_cfg.min_lead_hours:=12; v_cfg.window_days:=21;
  end if;
  -- A specific OFFERED schedule overrides the mirror config; its own weekly
  -- windows are used below. Anything not offered publicly (and not active)
  -- is not bookable through a candidate token.
  if p_schedule_id is not null then
    select * into v_sched from public.interview_schedules s
      where s.id = p_schedule_id and s.dsp_id = v_dsp and (s.is_active or s.offer_public);
    if v_sched.id is null then raise exception 'slot_unavailable'; end if;
    v_cfg.timezone       := coalesce(v_sched.timezone, v_cfg.timezone);
    v_cfg.slot_minutes   := coalesce(v_sched.slot_minutes, v_cfg.slot_minutes);
    v_cfg.buffer_minutes := coalesce(v_sched.buffer_minutes, v_cfg.buffer_minutes);
    v_cfg.min_lead_hours := coalesce(v_sched.min_lead_hours, v_cfg.min_lead_hours);
    v_cfg.window_days    := coalesce(v_sched.window_days, v_cfg.window_days);
  end if;

  return query
  with days as (
    select d::date as local_date from generate_series(
      (now() at time zone v_cfg.timezone)::date,
      (now() at time zone v_cfg.timezone)::date + v_cfg.window_days, interval '1 day') d
  ),
  ovr as (
    select od.override_date, od.is_closed, od.windows
    from public.interview_date_overrides od where od.dsp_id = v_dsp
  ),
  weekly as (
    -- Mirror tables for the active schedule; the schedule's own windows when
    -- a specific one was asked for.
    select av.weekday, av.start_min, av.end_min, av.capacity
      from public.interview_availability av
     where v_sched.id is null and av.dsp_id = v_dsp
    union all
    select sw.weekday, sw.start_min, sw.end_min, sw.capacity
      from public.interview_schedule_windows sw
     where v_sched.id is not null and sw.schedule_id = v_sched.id
  ),
  windows as (
    select dy.local_date,
           (win->>'start_min')::int as start_min,
           (win->>'end_min')::int   as end_min,
           coalesce((win->>'capacity')::int, 1) as capacity
    from days dy
    join ovr o on o.override_date = dy.local_date and not o.is_closed
    cross join lateral jsonb_array_elements(coalesce(o.windows, '[]'::jsonb)) win
    union all
    select dy.local_date, w.start_min, w.end_min, w.capacity
    from days dy
    join weekly w on w.weekday = extract(dow from dy.local_date)::int
    where not exists (select 1 from ovr o where o.override_date = dy.local_date)
  ),
  rec as (
    select ((w.local_date::timestamp + make_interval(mins=>s)) at time zone v_cfg.timezone) as ss,
           ((w.local_date::timestamp + make_interval(mins=>s+v_cfg.slot_minutes)) at time zone v_cfg.timezone) as se,
           w.capacity
    from windows w cross join lateral
      generate_series(w.start_min, w.end_min - v_cfg.slot_minutes, v_cfg.slot_minutes + v_cfg.buffer_minutes) s
  ),
  rec_open as (
    select r.ss, r.se, r.capacity,
      r.capacity - (select count(*)::int from public.cal_events ce
        where ce.dsp_id=v_dsp and ce.kind in('interview','orientation') and ce.status in('scheduled','rescheduled')
          and ce.interview_session_id is null
          and tstzrange(ce.starts_at, coalesce(ce.ends_at, ce.starts_at + make_interval(mins=>v_cfg.slot_minutes)))
              && tstzrange(r.ss, r.se)) as remaining,
      null::uuid as session_id
    from rec r
    where r.ss >= now() + make_interval(hours=>v_cfg.min_lead_hours)
      and not exists (
        select 1 from public.cal_events busy
        where busy.dsp_id=v_dsp and busy.status in('scheduled','rescheduled')
          and busy.kind not in ('interview','orientation')
          and coalesce((busy.metadata->>'is_task')::boolean, false) = false
          and tstzrange(busy.starts_at, coalesce(busy.ends_at, busy.starts_at + make_interval(mins=>v_cfg.slot_minutes)))
              && tstzrange(r.ss, r.se)
      )
  ),
  sess_open as (
    select s.starts_at as ss, s.ends_at as se, s.capacity,
      s.capacity - (select count(*)::int from public.cal_events ce
        where ce.interview_session_id = s.id and ce.status in('scheduled','rescheduled')) as remaining,
      s.id as session_id
    from public.interview_sessions s
    where s.dsp_id=v_dsp and s.active
      and s.starts_at >= now() + make_interval(hours=>v_cfg.min_lead_hours)
  )
  select ss, se, capacity, remaining, session_id from rec_open  where remaining > 0
  union all
  select ss, se, capacity, remaining, session_id from sess_open where remaining > 0
  order by 1;
end; $$;
grant execute on function public.interview_open_slots(text, uuid) to anon, authenticated;

-- ── 5 · book_interview_slot(+ p_schedule_id, p_answers, p_verify_code) ──

drop function if exists public.book_interview_slot(text, timestamptz, uuid);
create or replace function public.book_interview_slot(
  p_token text, p_slot_start timestamptz, p_session_id uuid default null,
  p_schedule_id uuid default null, p_answers jsonb default null, p_verify_code text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_app public.applicants; v_dsp uuid; v_cfg public.interview_config;
  v_end timestamptz; v_dow int; v_min int; v_start_min int; v_event_id uuid;
  v_sess public.interview_sessions; v_cap int; v_booked int;
  v_ldate date; v_ovr public.interview_date_overrides; v_win jsonb;
  v_sched public.interview_schedules; v_gov public.interview_schedules;
  v_vc public.booking_phone_codes;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then raise exception 'invalid_or_expired_token' using errcode='P0002'; end if;
  v_dsp := v_app.dsp_id;
  select * into v_cfg from public.interview_config where dsp_id=v_dsp;
  if v_cfg.dsp_id is null then
    v_cfg.timezone:='America/Chicago'; v_cfg.slot_minutes:=30; v_cfg.buffer_minutes:=0;
    v_cfg.min_lead_hours:=12; v_cfg.window_days:=21;
  end if;
  if p_schedule_id is not null then
    select * into v_sched from public.interview_schedules s
      where s.id = p_schedule_id and s.dsp_id = v_dsp and (s.is_active or s.offer_public);
    if v_sched.id is null then raise exception 'slot_unavailable'; end if;
    v_cfg.timezone       := coalesce(v_sched.timezone, v_cfg.timezone);
    v_cfg.slot_minutes   := coalesce(v_sched.slot_minutes, v_cfg.slot_minutes);
    v_cfg.buffer_minutes := coalesce(v_sched.buffer_minutes, v_cfg.buffer_minutes);
    v_cfg.min_lead_hours := coalesce(v_sched.min_lead_hours, v_cfg.min_lead_hours);
    v_cfg.location       := coalesce(v_sched.location, v_cfg.location);
  end if;

  if v_app.status in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed') then
    raise exception 'not_eligible';
  end if;
  if exists (select 1 from public.cal_events ce
    where ce.dsp_id=v_dsp and ce.applicant_id=v_app.id and ce.kind='interview'
      and ce.status in('scheduled','rescheduled')) then
    raise exception 'already_booked';
  end if;

  -- SMS verification, when the governing schedule requires it (0493).
  select * into v_gov from public.interview_schedules s
    where s.dsp_id = v_dsp
      and ((p_schedule_id is not null and s.id = p_schedule_id)
        or (p_schedule_id is null and s.is_active))
    limit 1;
  if v_gov.id is not null and coalesce(v_gov.require_phone_verify, false) then
    select * into v_vc from public.booking_phone_codes where applicant_id = v_app.id;
    if p_verify_code is null or v_vc.applicant_id is null
       or v_vc.expires_at < now() or v_vc.attempts >= 5 then
      raise exception 'verify_required';
    end if;
    if v_vc.code <> regexp_replace(p_verify_code, '\D', '', 'g') then
      update public.booking_phone_codes set attempts = attempts + 1 where applicant_id = v_app.id;
      raise exception 'verify_bad_code';
    end if;
    delete from public.booking_phone_codes where applicant_id = v_app.id;
  end if;

  if p_session_id is not null then
    select * into v_sess from public.interview_sessions where id=p_session_id and dsp_id=v_dsp and active;
    if v_sess.id is null then raise exception 'slot_unavailable'; end if;
    if v_sess.starts_at < now() + make_interval(hours=>v_cfg.min_lead_hours) then raise exception 'slot_too_soon'; end if;
    perform pg_advisory_xact_lock(hashtext('gcal_session'), hashtext(v_sess.id::text));
    select count(*)::int into v_booked from public.cal_events ce
      where ce.interview_session_id=v_sess.id and ce.status in('scheduled','rescheduled');
    if v_booked >= v_sess.capacity then raise exception 'slot_taken'; end if;
    insert into public.cal_events
      (dsp_id, applicant_id, kind, status, starts_at, ends_at, timezone, location, provider, interview_session_id)
    values
      (v_dsp, v_app.id, 'interview', 'scheduled', v_sess.starts_at, v_sess.ends_at, v_cfg.timezone,
       coalesce(v_sess.location, v_cfg.location), 'routeready', v_sess.id)
    returning id into v_event_id;
  else
    v_end := p_slot_start + make_interval(mins=>v_cfg.slot_minutes);
    if p_slot_start < now() + make_interval(hours=>v_cfg.min_lead_hours) then raise exception 'slot_too_soon'; end if;
    v_dow := extract(dow  from (p_slot_start at time zone v_cfg.timezone))::int;
    v_min := (extract(hour from (p_slot_start at time zone v_cfg.timezone))*60
            + extract(minute from (p_slot_start at time zone v_cfg.timezone)))::int;
    v_ldate := (p_slot_start at time zone v_cfg.timezone)::date;

    select * into v_ovr from public.interview_date_overrides
      where dsp_id=v_dsp and override_date=v_ldate;
    if v_ovr.id is not null then
      if v_ovr.is_closed then raise exception 'slot_unavailable'; end if;
      v_cap := null; v_start_min := null;
      for v_win in select * from jsonb_array_elements(coalesce(v_ovr.windows,'[]'::jsonb)) loop
        if v_min >= (v_win->>'start_min')::int and v_min + v_cfg.slot_minutes <= (v_win->>'end_min')::int then
          v_cap := coalesce((v_win->>'capacity')::int, 1);
          v_start_min := (v_win->>'start_min')::int;
          exit;
        end if;
      end loop;
    else
      -- Weekly windows: the mirror for the active schedule, the schedule's
      -- own windows when a specific one was asked for.
      select w.capacity, w.start_min into v_cap, v_start_min from (
        select av.weekday, av.start_min, av.end_min, av.capacity
          from public.interview_availability av
         where v_sched.id is null and av.dsp_id = v_dsp
        union all
        select sw.weekday, sw.start_min, sw.end_min, sw.capacity
          from public.interview_schedule_windows sw
         where v_sched.id is not null and sw.schedule_id = v_sched.id
      ) w
      where w.weekday=v_dow and v_min>=w.start_min and v_min+v_cfg.slot_minutes<=w.end_min
      order by w.capacity desc limit 1;
    end if;

    if v_cap is null then raise exception 'slot_unavailable'; end if;
    if ((v_min - v_start_min) % greatest(v_cfg.slot_minutes + coalesce(v_cfg.buffer_minutes, 0), 1)) <> 0 then
      raise exception 'slot_unavailable';
    end if;
    perform pg_advisory_xact_lock(hashtext(v_dsp::text), hashtext(p_slot_start::text));
    if exists (select 1 from public.cal_events busy
      where busy.dsp_id=v_dsp and busy.status in('scheduled','rescheduled')
        and busy.kind not in ('interview','orientation')
        and coalesce((busy.metadata->>'is_task')::boolean, false) = false
        and tstzrange(busy.starts_at, coalesce(busy.ends_at, busy.starts_at + make_interval(mins=>v_cfg.slot_minutes)))
            && tstzrange(p_slot_start, v_end)) then
      raise exception 'slot_taken';
    end if;
    select count(*)::int into v_booked from public.cal_events ce
      where ce.dsp_id=v_dsp and ce.kind in('interview','orientation') and ce.status in('scheduled','rescheduled')
        and ce.interview_session_id is null
        and tstzrange(ce.starts_at, coalesce(ce.ends_at, ce.starts_at+make_interval(mins=>v_cfg.slot_minutes)))
            && tstzrange(p_slot_start, v_end);
    if v_booked >= v_cap then raise exception 'slot_taken'; end if;
    insert into public.cal_events
      (dsp_id, applicant_id, kind, status, starts_at, ends_at, timezone, location, provider)
    values
      (v_dsp, v_app.id, 'interview', 'scheduled', p_slot_start, v_end, v_cfg.timezone, v_cfg.location, 'routeready')
    returning id into v_event_id;
  end if;

  -- Intake answers (bounded) + the booked schedule land on the event.
  if v_event_id is not null then
    update public.cal_events
       set metadata = coalesce(metadata, '{}'::jsonb)
         || case when p_answers is not null and jsonb_typeof(p_answers) = 'object'
                      and pg_column_size(p_answers) <= 8192
                 then jsonb_build_object('intake_answers', p_answers) else '{}'::jsonb end
         || case when v_sched.id is not null
                 then jsonb_build_object('schedule_id', v_sched.id, 'schedule_name', v_sched.name)
                 else '{}'::jsonb end
     where id = v_event_id;
  end if;

  update public.applicants set status='interview_booked', updated_at=now()
    where id=v_app.id and status not in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed');
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end; $$;
grant execute on function public.book_interview_slot(text, timestamptz, uuid, uuid, jsonb, text) to anon, authenticated;

-- ── 6 · cancel with a reason ─────────────────────────────────────────────

drop function if exists public.cancel_interview_booking(text);
create or replace function public.cancel_interview_booking(p_token text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_app public.applicants;
  v_ev  public.cal_events;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then raise exception 'invalid_or_expired_token' using errcode='P0002'; end if;

  select * into v_ev from public.cal_events ce
    where ce.applicant_id = v_app.id and ce.kind = 'interview'
      and ce.status in ('scheduled','rescheduled')
    order by ce.starts_at asc limit 1;
  if v_ev.id is null then
    return jsonb_build_object('ok', true, 'nothing_to_cancel', true);
  end if;

  update public.cal_events
     set status = 'cancelled', updated_at = now(),
         cancelled_at = now(),
         cancellation_reason = coalesce(nullif(left(btrim(p_reason), 300), ''), cancellation_reason)
   where id = v_ev.id;

  update public.applicants set status = 'interview_invited', updated_at = now()
    where id = v_app.id and status = 'interview_booked';

  return jsonb_build_object('ok', true, 'cancelled_event_id', v_ev.id);
end; $$;
grant execute on function public.cancel_interview_booking(text, text) to anon, authenticated;

-- ── 7 · running late ─────────────────────────────────────────────────────

create or replace function public.booking_running_late(p_token text, p_minutes int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_app public.applicants;
  v_ev  public.cal_events;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then raise exception 'invalid_or_expired_token' using errcode='P0002'; end if;

  select * into v_ev from public.cal_events ce
    where ce.applicant_id = v_app.id and ce.kind = 'interview'
      and ce.status in ('scheduled','rescheduled')
    order by ce.starts_at asc limit 1;
  if v_ev.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_booking');
  end if;
  -- Only meaningful around the appointment itself.
  if v_ev.starts_at > now() + interval '12 hours' or v_ev.starts_at < now() - interval '3 hours' then
    return jsonb_build_object('ok', false, 'error', 'not_today');
  end if;

  update public.cal_events
     set metadata = coalesce(metadata, '{}'::jsonb)
       || jsonb_build_object('running_late', jsonb_build_object(
            'at', now(),
            'minutes', case when p_minutes between 1 and 240 then p_minutes end))
   where id = v_ev.id;

  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.booking_running_late(text, int) to anon, authenticated;

-- ── 8 · schedule editor: read/write the new fields ───────────────────────
-- interview_schedule_get already returns to_jsonb(schedule) → new columns
-- flow through automatically. Save gains p_extra so the editor can write
-- them without another signature churn later.

drop function if exists public.interview_schedule_save(uuid,text,text,int,int,int,int,text,jsonb,boolean);
create or replace function public.interview_schedule_save(
  p_id uuid, p_name text, p_timezone text, p_slot_minutes int, p_buffer_minutes int,
  p_min_lead_hours int, p_window_days int, p_location text, p_windows jsonb, p_make_active boolean default false,
  p_extra jsonb default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_dsp uuid := private.current_dsp_id(); v_id uuid := p_id; w jsonb;
begin
  if v_dsp is null then raise exception 'no_dsp'; end if;
  if v_id is null then
    insert into public.interview_schedules
      (dsp_id, name, timezone, slot_minutes, buffer_minutes, min_lead_hours, window_days, location, is_active, sort_order)
    values (v_dsp, coalesce(nullif(btrim(p_name),''),'Interview'), coalesce(p_timezone,'America/Chicago'),
            greatest(p_slot_minutes,5), greatest(p_buffer_minutes,0), greatest(p_min_lead_hours,0), greatest(p_window_days,1), p_location,
            coalesce(p_make_active,false) or not exists (select 1 from public.interview_schedules where dsp_id=v_dsp),
            coalesce((select max(sort_order)+1 from public.interview_schedules where dsp_id=v_dsp), 0))
    returning id into v_id;
  else
    update public.interview_schedules set
      name=coalesce(nullif(btrim(p_name),''),name), timezone=coalesce(p_timezone,timezone),
      slot_minutes=greatest(p_slot_minutes,5), buffer_minutes=greatest(p_buffer_minutes,0),
      min_lead_hours=greatest(p_min_lead_hours,0), window_days=greatest(p_window_days,1), location=p_location, updated_at=now()
    where id=v_id and dsp_id=v_dsp;
    if not found then raise exception 'schedule_not_found'; end if;
  end if;
  -- Candidate-facing extras (0493): only the keys present are written.
  if p_extra is not null then
    update public.interview_schedules set
      branding             = case when p_extra ? 'branding' then coalesce(p_extra->'branding', '{}'::jsonb) else branding end,
      arrival_notes        = case when p_extra ? 'arrival_notes' then nullif(btrim(p_extra->>'arrival_notes'), '') else arrival_notes end,
      intake_questions     = case when p_extra ? 'intake_questions' then coalesce(p_extra->'intake_questions', '[]'::jsonb) else intake_questions end,
      require_phone_verify = case when p_extra ? 'require_phone_verify' then coalesce((p_extra->>'require_phone_verify')::boolean, false) else require_phone_verify end,
      offer_public         = case when p_extra ? 'offer_public' then coalesce((p_extra->>'offer_public')::boolean, false) else offer_public end
    where id=v_id and dsp_id=v_dsp;
  end if;
  delete from public.interview_schedule_windows where schedule_id=v_id;
  for w in select * from jsonb_array_elements(coalesce(p_windows,'[]'::jsonb)) loop
    insert into public.interview_schedule_windows (schedule_id, weekday, start_min, end_min, capacity)
    values (v_id, (w->>'weekday')::int, (w->>'start_min')::int, (w->>'end_min')::int, greatest(coalesce((w->>'capacity')::int,1),1));
  end loop;
  if coalesce(p_make_active,false) then
    update public.interview_schedules set is_active=(id=v_id) where dsp_id=v_dsp;
  end if;
  perform private.iv_mirror_active(v_dsp);
  return v_id;
end; $$;
grant execute on function public.interview_schedule_save(uuid,text,text,int,int,int,int,text,jsonb,boolean,jsonb) to authenticated;

notify pgrst, 'reload schema';
