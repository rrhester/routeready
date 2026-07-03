-- ── Harden the interview booking engine ─────────────────────────────────────
-- Design review (2026-07) surfaced four launch-blocking gaps in the public,
-- anon-callable booking RPCs. This migration closes all four without changing
-- the callable signatures (so the booking page keeps working unchanged):
--
--   1. A valid booking token could book unlimited slots (no server-side
--      "already booked" check — the guard was client-side only). One leaked
--      link could loop the RPC and book every open slot, DoS-ing the pipeline.
--      → book_interview_slot now rejects with `already_booked` when the
--        applicant already has a scheduled/rescheduled interview.
--
--   2. Terminal-status applicants (hired/rejected/no_show/…) could still book
--      with an old link, consuming a slot and spawning a room + email.
--      → book_interview_slot now rejects with `not_eligible`.
--
--   3. Non-interview calendar events (PTO, personal blocks, off-sites created
--      via "New event") did NOT block the public booking page — candidates
--      could book right over a recruiter's time off. The core promise of a
--      calendar ("if it's on my calendar, nobody can book it") was broken.
--      → both interview_open_slots and book_interview_slot now treat ANY
--        overlapping busy cal_event (kind <> interview/orientation, excluding
--        Tasks) as blocking the slot entirely.
--
--   4. The server accepted arbitrary off-grid start times (e.g. 9:07), which
--        the overlap check then used to block two adjacent grid slots.
--      → book_interview_slot now validates that the start lands on the
--        window's slot grid (`(min - start_min) % (slot + buffer) = 0`).
--
-- Idempotent: create-or-replace only; no schema changes.

-- ── Open slots: honor busy (non-interview) events as blockers ────────────────
drop function if exists public.interview_open_slots(text);
create or replace function public.interview_open_slots(p_token text)
returns table (slot_start timestamptz, slot_end timestamptz, capacity int, remaining int, session_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_app public.applicants; v_dsp uuid; v_cfg public.interview_config;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then raise exception 'invalid_or_expired_token' using errcode='P0002'; end if;
  v_dsp := v_app.dsp_id;
  select * into v_cfg from public.interview_config where dsp_id=v_dsp;
  if v_cfg.dsp_id is null then
    v_cfg.timezone:='America/Chicago'; v_cfg.slot_minutes:=30; v_cfg.buffer_minutes:=0;
    v_cfg.min_lead_hours:=12; v_cfg.window_days:=21;
  end if;

  return query
  with days as (
    select d::date as local_date from generate_series(
      (now() at time zone v_cfg.timezone)::date,
      (now() at time zone v_cfg.timezone)::date + v_cfg.window_days, interval '1 day') d
  ),
  windows as (
    select dy.local_date, av.start_min, av.end_min, av.capacity from days dy
    join public.interview_availability av on av.dsp_id=v_dsp and av.weekday=extract(dow from dy.local_date)::int
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
      -- Any overlapping busy event (personal block / PTO / off-site) closes the
      -- slot outright. Tasks are checklist items, not busy time, so they don't.
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
grant execute on function public.interview_open_slots(text) to anon, authenticated;

-- ── Book: already-booked + eligibility + busy-block + grid-alignment guards ──
drop function if exists public.book_interview_slot(text, timestamptz, uuid);
create or replace function public.book_interview_slot(p_token text, p_slot_start timestamptz, p_session_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_app public.applicants; v_dsp uuid; v_cfg public.interview_config;
  v_end timestamptz; v_dow int; v_min int; v_start_min int; v_event_id uuid;
  v_sess public.interview_sessions; v_cap int; v_booked int;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then raise exception 'invalid_or_expired_token' using errcode='P0002'; end if;
  v_dsp := v_app.dsp_id;
  select * into v_cfg from public.interview_config where dsp_id=v_dsp;
  if v_cfg.dsp_id is null then
    v_cfg.timezone:='America/Chicago'; v_cfg.slot_minutes:=30; v_cfg.buffer_minutes:=0;
    v_cfg.min_lead_hours:=12; v_cfg.window_days:=21;
  end if;

  -- Eligibility: applicants past the interview stage can't self-book with an
  -- old link. Mirrors the guard on the status update below.
  if v_app.status in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed') then
    raise exception 'not_eligible';
  end if;
  -- One active interview per applicant. Blocks double-booking via replay /
  -- two open tabs. (Reschedule is a separate, explicit flow.)
  if exists (select 1 from public.cal_events ce
    where ce.dsp_id=v_dsp and ce.applicant_id=v_app.id and ce.kind='interview'
      and ce.status in('scheduled','rescheduled')) then
    raise exception 'already_booked';
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
    select av.capacity, av.start_min into v_cap, v_start_min from public.interview_availability av
      where av.dsp_id=v_dsp and av.weekday=v_dow and v_min>=av.start_min and v_min+v_cfg.slot_minutes<=av.end_min
      order by av.capacity desc limit 1;
    if v_cap is null then raise exception 'slot_unavailable'; end if;
    -- Reject off-grid starts (e.g. 9:07) that would otherwise fragment the day
    -- and block two adjacent grid slots for everyone else.
    if ((v_min - v_start_min) % greatest(v_cfg.slot_minutes + coalesce(v_cfg.buffer_minutes, 0), 1)) <> 0 then
      raise exception 'slot_unavailable';
    end if;
    perform pg_advisory_xact_lock(hashtext(v_dsp::text), hashtext(p_slot_start::text));
    -- Busy (non-interview) event overlapping this slot blocks it entirely.
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

  update public.applicants set status='interview_booked', updated_at=now()
    where id=v_app.id and status not in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed');
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end; $$;
grant execute on function public.book_interview_slot(text, timestamptz, uuid) to anon, authenticated;

-- ── booking_load: also return the existing booking's details so the
--    "already scheduled" screen can show the real date/time/link instead of a
--    dead-end "check your email". ───────────────────────────────────────────
create or replace function public.booking_load(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_app public.applicants;
  v_dsp public.dsps;
  v_cfg public.interview_config;
  v_name text;
  v_booked public.cal_events;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;
  select * into v_dsp from public.dsps where id = v_app.dsp_id;
  select * into v_cfg from public.interview_config where dsp_id = v_app.dsp_id;
  select name into v_name from public.interview_schedules where dsp_id = v_app.dsp_id and is_active limit 1;
  select * into v_booked from public.cal_events ce
    where ce.applicant_id = v_app.id and ce.kind = 'interview'
      and ce.status in ('scheduled','rescheduled')
    order by ce.starts_at asc limit 1;
  return jsonb_build_object(
    'dsp', jsonb_build_object('name', v_dsp.name, 'short_code', v_dsp.short_code),
    'applicant', jsonb_build_object('first_name', v_app.first_name, 'full_name', v_app.full_name),
    'timezone', coalesce(v_cfg.timezone, 'America/Chicago'),
    'slot_minutes', coalesce(v_cfg.slot_minutes, 30),
    'schedule_name', v_name,
    'already_booked', v_booked.id is not null,
    'booking', case when v_booked.id is null then null else jsonb_build_object(
      'starts_at', v_booked.starts_at,
      'ends_at', v_booked.ends_at,
      'meeting_url', v_booked.meeting_url,
      'location', v_booked.location
    ) end
  );
end; $$;
grant execute on function public.booking_load(text) to anon, authenticated;

-- ── rsvp_respond: fall back to the DSP timezone (not a hardcoded Chicago) when
--    the event has no timezone, so candidates never see times in the wrong zone.
create or replace function public.rsvp_respond(p_token text, p_response text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ev  public.cal_events;
  v_new text;
  v_dsp public.dsps;
begin
  if p_token is null or btrim(p_token) = '' then
    return jsonb_build_object('ok', false, 'error', 'token_required');
  end if;
  v_new := case lower(coalesce(p_response, ''))
             when 'accept' then 'accepted' when 'yes' then 'accepted'
             when 'decline' then 'declined' when 'no' then 'declined'
             else null end;

  select * into v_ev from public.cal_events where rsvp_token = p_token;
  if v_ev.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- Only record a response on a live event; cancelled/removed events are
  -- read-only (the page renders an explicit "no longer active" state).
  if v_new is not null and v_ev.status in ('scheduled','rescheduled') then
    update public.cal_events set rsvp = v_new where id = v_ev.id;
    v_ev.rsvp := v_new;
  end if;

  select * into v_dsp from public.dsps where id = v_ev.dsp_id;

  return jsonb_build_object(
    'ok', true,
    'rsvp', v_ev.rsvp,
    'status', v_ev.status,
    'title', v_ev.title,
    'starts_at', v_ev.starts_at,
    'ends_at', v_ev.ends_at,
    'timezone', coalesce(v_ev.timezone, v_dsp.timezone, 'America/Chicago'),
    'meeting_url', v_ev.meeting_url,
    'dsp_name', coalesce(v_dsp.name, 'RouteReady')
  );
end; $$;
grant execute on function public.rsvp_respond(text, text) to anon, authenticated;
