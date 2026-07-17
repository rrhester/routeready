-- ─────────────────────────────────────────────────────────────────────────
-- 0495 · Interview outcomes, session waitlists, auto-nudge
--        (calendar 100-list #3, #5, #6, #7)
--
--  • interview_log_outcome: one-click outcome from the calendar — showed /
--    advance (applicant → interview_completed), no_show (event → no_show,
--    applicant → no_show), reject (applicant → rejected). Staff-gated.
--  • Session waitlists: full group sessions surface on the booking page
--    with a "join the waitlist" action; a candidate cancel that frees a
--    seat auto-promotes the first eligible waitlisted candidate (booked +
--    emailed, riding the normal booking insert path so room-assignment
--    and confirmation automations fire as usual).
--  • booking_nudge_run(): daily cron — candidates sitting in
--    interview_invited with no booking N+ days get their booking link
--    re-sent automatically (max 2 nudges, then it's a human's call).
--    Enabled per-DSP by the active schedule's nudge_after_days (0 = off).
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1 · outcomes ─────────────────────────────────────────────────────────

create or replace function public.interview_log_outcome(p_event_id uuid, p_outcome text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_ev  public.cal_events;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_outcome not in ('showed', 'advance', 'no_show', 'reject') then
    raise exception 'invalid_outcome';
  end if;
  select * into v_ev from public.cal_events
    where id = p_event_id and dsp_id = v_dsp;
  if v_ev.id is null then raise exception 'event_not_found' using errcode = 'P0002'; end if;

  if p_outcome = 'no_show' then
    update public.cal_events set status = 'no_show', updated_at = now() where id = v_ev.id;
  elsif v_ev.status = 'no_show' then
    -- Taking a no-show back (they showed after all).
    update public.cal_events set status = 'scheduled', updated_at = now() where id = v_ev.id;
  end if;

  if v_ev.applicant_id is not null then
    update public.applicants set
      status = case p_outcome
        when 'no_show' then 'no_show'::public.applicant_status
        when 'reject'  then 'rejected'::public.applicant_status
        else 'interview_completed'::public.applicant_status
      end,
      updated_at = now()
    where id = v_ev.applicant_id and dsp_id = v_dsp
      and status not in ('hired','rejected');
  end if;

  return jsonb_build_object('ok', true, 'outcome', p_outcome, 'applicant_id', v_ev.applicant_id);
end; $$;
grant execute on function public.interview_log_outcome(uuid, text) to authenticated;

-- ── 2 · session waitlists ────────────────────────────────────────────────

create table if not exists public.interview_session_waitlist (
  id           uuid        primary key default gen_random_uuid(),
  dsp_id       uuid        not null references public.dsps(id) on delete cascade,
  session_id   uuid        not null references public.interview_sessions(id) on delete cascade,
  applicant_id uuid        not null references public.applicants(id) on delete cascade,
  created_at   timestamptz not null default now(),
  promoted_at  timestamptz,
  constraint isw_unique unique (session_id, applicant_id)
);
create index if not exists isw_session_idx on public.interview_session_waitlist (session_id, created_at);
alter table public.interview_session_waitlist enable row level security;
drop policy if exists isw_staff_read on public.interview_session_waitlist;
create policy isw_staff_read on public.interview_session_waitlist
  for select to authenticated
  using (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));
-- Writes go through the definer RPCs only.

create or replace function public.session_waitlist_join(p_token text, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_app  public.applicants;
  v_sess public.interview_sessions;
  v_n    int;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then raise exception 'invalid_or_expired_token' using errcode='P0002'; end if;
  if v_app.status in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed') then
    raise exception 'not_eligible';
  end if;
  select * into v_sess from public.interview_sessions
    where id = p_session_id and dsp_id = v_app.dsp_id and active;
  if v_sess.id is null then raise exception 'slot_unavailable'; end if;

  select count(*)::int into v_n from public.interview_session_waitlist
    where session_id = p_session_id and promoted_at is null;
  if v_n >= 20 then
    return jsonb_build_object('ok', false, 'error', 'waitlist_full');
  end if;

  insert into public.interview_session_waitlist (dsp_id, session_id, applicant_id)
  values (v_app.dsp_id, p_session_id, v_app.id)
  on conflict (session_id, applicant_id) do nothing;

  return jsonb_build_object('ok', true, 'position',
    (select count(*)::int from public.interview_session_waitlist
      where session_id = p_session_id and promoted_at is null));
end; $$;
grant execute on function public.session_waitlist_join(text, uuid) to anon, authenticated;

-- Promote the first eligible waitlisted candidate for a session (used by the
-- candidate-cancel path when a seat frees up). Definer-internal.
create or replace function private.session_waitlist_promote(p_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_sess   public.interview_sessions;
  v_booked int;
  v_row    public.interview_session_waitlist;
  v_app    public.applicants;
  v_ev     uuid;
  v_when   text;
begin
  select * into v_sess from public.interview_sessions where id = p_session_id and active;
  if v_sess.id is null then return; end if;
  select count(*)::int into v_booked from public.cal_events ce
    where ce.interview_session_id = v_sess.id and ce.status in ('scheduled','rescheduled');
  if v_booked >= v_sess.capacity then return; end if;

  for v_row in
    select * from public.interview_session_waitlist
     where session_id = p_session_id and promoted_at is null
     order by created_at
  loop
    select * into v_app from public.applicants where id = v_row.applicant_id;
    -- Skip candidates who moved on or booked something else meanwhile.
    if v_app.id is null
       or v_app.status in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed')
       or exists (select 1 from public.cal_events ce
                   where ce.applicant_id = v_app.id and ce.kind = 'interview'
                     and ce.status in ('scheduled','rescheduled')) then
      update public.interview_session_waitlist set promoted_at = now() where id = v_row.id;
      continue;
    end if;

    insert into public.cal_events
      (dsp_id, applicant_id, kind, status, starts_at, ends_at, timezone, location, provider, interview_session_id)
    values
      (v_sess.dsp_id, v_app.id, 'interview', 'scheduled', v_sess.starts_at, v_sess.ends_at,
       (select timezone from public.interview_config where dsp_id = v_sess.dsp_id),
       v_sess.location, 'routeready', v_sess.id)
    returning id into v_ev;

    update public.interview_session_waitlist set promoted_at = now() where id = v_row.id;
    update public.applicants set status = 'interview_booked', updated_at = now()
      where id = v_app.id
        and status not in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed');

    if v_app.email is not null then
      v_when := to_char(v_sess.starts_at at time zone coalesce(
        (select timezone from public.interview_config where dsp_id = v_sess.dsp_id), 'America/Chicago'),
        'FMDay, FMMonth FMDD at FMHH12:MI AM');
      insert into public.email_messages
        (dsp_id, applicant_id, cal_event_id, calendar_method, direction, status, to_email, subject, body_text)
      values
        (v_sess.dsp_id, v_app.id, v_ev, 'request', 'outbound', 'queued', v_app.email,
         'A spot opened up — you''re booked!',
         'Good news — a spot opened up in the session you waitlisted for, and it''s yours:'
           || E'\n\n' || v_when
           || E'\n\nIt''s on the calendar. If the time no longer works, use your booking link to cancel so the next person can have the seat.');
    end if;
    return;   -- one seat freed → one promotion
  end loop;
end; $$;

-- Candidate cancel now promotes from the waitlist when a session seat frees.
drop function if exists public.cancel_interview_booking(text, text);
create or replace function public.cancel_interview_booking(p_token text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_app public.applicants;
  v_ev  public.cal_events;
  v_gov public.interview_schedules;
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

  select * into v_gov from public.interview_schedules s
    where s.dsp_id = v_app.dsp_id and s.is_active limit 1;
  if v_gov.id is not null and coalesce(v_gov.min_cancel_hours, 0) > 0
     and v_ev.starts_at < now() + make_interval(hours => v_gov.min_cancel_hours) then
    raise exception 'too_late_to_cancel';
  end if;

  update public.cal_events
     set status = 'cancelled', updated_at = now(),
         cancelled_at = now(),
         cancellation_reason = coalesce(nullif(left(btrim(p_reason), 300), ''), cancellation_reason)
   where id = v_ev.id;

  update public.applicants
     set status = 'interview_invited', updated_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb)
           || jsonb_build_object('self_cancel_count',
                coalesce((metadata->>'self_cancel_count')::int, 0) + 1)
   where id = v_app.id and status = 'interview_booked';

  -- A freed group-session seat goes to the first eligible waitlisted
  -- candidate (0495).
  if v_ev.interview_session_id is not null then
    perform private.session_waitlist_promote(v_ev.interview_session_id);
  end if;

  return jsonb_build_object('ok', true, 'cancelled_event_id', v_ev.id);
end; $$;
grant execute on function public.cancel_interview_booking(text, text) to anon, authenticated;

-- Full sessions stay visible (remaining = 0) so the booking page can offer
-- the waitlist; grid slots still require remaining > 0.
drop function if exists public.interview_open_slots(text, uuid);
create or replace function public.interview_open_slots(p_token text, p_schedule_id uuid default null)
returns table (slot_start timestamptz, slot_end timestamptz, capacity int, remaining int, session_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_app public.applicants; v_dsp uuid; v_cfg public.interview_config; v_sched public.interview_schedules;
        v_maxday int;
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
    v_cfg.window_days    := coalesce(v_sched.window_days, v_cfg.window_days);
  else
    select * into v_sched from public.interview_schedules s
      where s.dsp_id = v_dsp and s.is_active limit 1;
  end if;
  v_maxday := nullif(coalesce(v_sched.max_per_day, 0), 0);

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
    select av.weekday, av.start_min, av.end_min, av.capacity
      from public.interview_availability av
     where p_schedule_id is null and av.dsp_id = v_dsp
    union all
    select sw.weekday, sw.start_min, sw.end_min, sw.capacity
      from public.interview_schedule_windows sw
     where p_schedule_id is not null and sw.schedule_id = p_schedule_id
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
  day_booked as (
    select ((ce.starts_at at time zone v_cfg.timezone))::date as d, count(*)::int as n
    from public.cal_events ce
    where ce.dsp_id=v_dsp and ce.kind in('interview','orientation')
      and ce.status in('scheduled','rescheduled')
    group by 1
  ),
  rec as (
    select w.local_date,
           ((w.local_date::timestamp + make_interval(mins=>s)) at time zone v_cfg.timezone) as ss,
           ((w.local_date::timestamp + make_interval(mins=>s+v_cfg.slot_minutes)) at time zone v_cfg.timezone) as se,
           w.capacity
    from windows w cross join lateral
      generate_series(w.start_min, w.end_min - v_cfg.slot_minutes, v_cfg.slot_minutes + v_cfg.buffer_minutes) s
  ),
  rec_open as (
    select r.ss, r.se, r.capacity,
      least(
        r.capacity - (select count(*)::int from public.cal_events ce
          where ce.dsp_id=v_dsp and ce.kind in('interview','orientation') and ce.status in('scheduled','rescheduled')
            and ce.interview_session_id is null
            and tstzrange(ce.starts_at, coalesce(ce.ends_at, ce.starts_at + make_interval(mins=>v_cfg.slot_minutes)))
                && tstzrange(r.ss, r.se)),
        case when v_maxday is null then 2147483647
             else greatest(v_maxday - coalesce((select db.n from day_booked db where db.d = r.local_date), 0), 0) end
      ) as remaining,
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
      greatest(s.capacity - (select count(*)::int from public.cal_events ce
        where ce.interview_session_id = s.id and ce.status in('scheduled','rescheduled')), 0) as remaining,
      s.id as session_id
    from public.interview_sessions s
    where s.dsp_id=v_dsp and s.active
      and s.starts_at >= now() + make_interval(hours=>v_cfg.min_lead_hours)
  )
  select ss, se, capacity, remaining, session_id from rec_open  where remaining > 0
  union all
  -- Full sessions included at remaining = 0 → booking page offers the waitlist.
  select ss, se, capacity, remaining, session_id from sess_open
  order by 1;
end; $$;
grant execute on function public.interview_open_slots(text, uuid) to anon, authenticated;

-- ── 3 · auto-nudge unbooked candidates ──────────────────────────────────

alter table public.interview_schedules add column if not exists nudge_after_days int not null default 0;

create or replace function public.booking_nudge_run()
returns int language plpgsql security definer set search_path = '' as $$
declare
  r      record;
  v_tok  text;
  v_link text;
  v_msg  record;
  v_tpl  public.message_templates;
  v_sent int := 0;
begin
  for r in
    select a.*, s.nudge_after_days
    from public.applicants a
    join public.interview_schedules s on s.dsp_id = a.dsp_id and s.is_active
    where s.nudge_after_days > 0
      and a.status = 'interview_invited'
      and a.updated_at < now() - make_interval(days => s.nudge_after_days)
      and coalesce((a.metadata->>'booking_nudge_count')::int, 0) < 2
      and coalesce((a.metadata->>'last_booking_nudge_at')::timestamptz, 'epoch'::timestamptz)
            < now() - make_interval(days => s.nudge_after_days)
      and not exists (select 1 from public.cal_events ce
                       where ce.applicant_id = a.id and ce.kind = 'interview'
                         and ce.status in ('scheduled','rescheduled'))
    order by a.updated_at
    limit 50
  loop
    v_tok := private.ensure_token(r.id, 'booking');
    v_link := 'https://gorouteready.com/b/' || v_tok;

    if r.phone is not null then
      select * into v_tpl from public.message_templates
        where dsp_id = r.dsp_id and channel = 'sms' and key = 'applicant.invite_interview' and active = true;
      select * into v_msg from private.render_template(
        r.dsp_id, 'sms', 'applicant.invite_interview',
        jsonb_build_object('first_name', coalesce(r.first_name, r.full_name), 'link', v_link));
      insert into public.sms_messages
        (dsp_id, applicant_id, template_id, direction, status, to_phone, body, attachments)
      values
        (r.dsp_id, r.id, v_tpl.id, 'outbound', 'queued', r.phone,
         'Friendly reminder — pick your interview time here: ' || v_link, coalesce(v_tpl.attachments, '[]'::jsonb));
    elsif r.email is not null then
      select * into v_tpl from public.message_templates
        where dsp_id = r.dsp_id and channel = 'email' and key = 'applicant.invite_interview' and active = true;
      select * into v_msg from private.render_template(
        r.dsp_id, 'email', 'applicant.invite_interview',
        jsonb_build_object('first_name', coalesce(r.first_name, r.full_name), 'link', v_link));
      insert into public.email_messages
        (dsp_id, applicant_id, template_id, direction, status, to_email, subject, body_text, attachments)
      values
        (r.dsp_id, r.id, v_tpl.id, 'outbound', 'queued', r.email,
         coalesce(v_msg.subject, 'Reminder: pick your interview time'),
         coalesce(v_msg.body, 'Friendly reminder — pick your interview time here: ' || v_link),
         coalesce(v_tpl.attachments, '[]'::jsonb));
    else
      continue;
    end if;

    update public.applicants set metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object(
           'booking_nudge_count', coalesce((metadata->>'booking_nudge_count')::int, 0) + 1,
           'last_booking_nudge_at', now())
    where id = r.id;
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end; $$;
-- Cron-only: no grant to authenticated/anon.

-- The editor writes nudge_after_days through interview_schedule_save p_extra.
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
  if p_extra is not null then
    update public.interview_schedules set
      branding             = case when p_extra ? 'branding' then coalesce(p_extra->'branding', '{}'::jsonb) else branding end,
      arrival_notes        = case when p_extra ? 'arrival_notes' then nullif(btrim(p_extra->>'arrival_notes'), '') else arrival_notes end,
      intake_questions     = case when p_extra ? 'intake_questions' then coalesce(p_extra->'intake_questions', '[]'::jsonb) else intake_questions end,
      require_phone_verify = case when p_extra ? 'require_phone_verify' then coalesce((p_extra->>'require_phone_verify')::boolean, false) else require_phone_verify end,
      offer_public         = case when p_extra ? 'offer_public' then coalesce((p_extra->>'offer_public')::boolean, false) else offer_public end,
      max_per_day          = case when p_extra ? 'max_per_day' then nullif(coalesce((p_extra->>'max_per_day')::int, 0), 0) else max_per_day end,
      interviewer_pool     = case when p_extra ? 'interviewer_pool' then coalesce(p_extra->'interviewer_pool', '[]'::jsonb) else interviewer_pool end,
      min_cancel_hours     = case when p_extra ? 'min_cancel_hours' then greatest(coalesce((p_extra->>'min_cancel_hours')::int, 0), 0) else min_cancel_hours end,
      max_self_reschedules = case when p_extra ? 'max_self_reschedules' then greatest(coalesce((p_extra->>'max_self_reschedules')::int, 0), 0) else max_self_reschedules end,
      nudge_after_days     = case when p_extra ? 'nudge_after_days' then greatest(coalesce((p_extra->>'nudge_after_days')::int, 0), 0) else nudge_after_days end
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

do $$ begin
  perform cron.unschedule('booking-nudge-run');
exception when others then null; end $$;
select cron.schedule('booking-nudge-run', '0 16 * * *', $$select public.booking_nudge_run()$$);

notify pgrst, 'reload schema';
