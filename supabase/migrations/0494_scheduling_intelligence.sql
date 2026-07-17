-- ─────────────────────────────────────────────────────────────────────────
-- 0494 · Scheduling intelligence (calendar 100-list #12, #13, #16, #17)
--
--  • max_per_day: hard daily cap on booked interviews (grid slots), separate
--    from per-slot capacity — open_slots hides slots on a full day and
--    book_interview_slot enforces it ('day_full').
--  • interviewer_pool: round-robin assignment at booking time — the pool
--    member with the fewest interviews that week gets the new one
--    (ties broken randomly); lands in metadata.interviewer, the same shape
--    the operator's manual assignment writes.
--  • min_cancel_hours: candidates can't self-cancel/reschedule inside the
--    window ('too_late_to_cancel').
--  • max_self_reschedules: after N candidate-initiated cancels, rebooking
--    requires contacting the operator ('reschedule_limit'). 0 = off.
--
-- Pooled capacity across schedules (#18) needs no change here: capacity
-- counting has always been over ALL interviews in the time range, so
-- multiple offered schedules cannot oversell the same hour (see 0493).
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.interview_schedules add column if not exists max_per_day int;
alter table public.interview_schedules add column if not exists interviewer_pool jsonb not null default '[]'::jsonb;
alter table public.interview_schedules add column if not exists min_cancel_hours int not null default 0;
alter table public.interview_schedules add column if not exists max_self_reschedules int not null default 0;

-- ── open_slots: day-cap aware ────────────────────────────────────────────

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
        -- Daily cap (0494): a full day offers nothing more, whatever the
        -- per-slot capacity says.
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

-- ── book: day cap + reschedule limit + round-robin interviewer ──────────

drop function if exists public.book_interview_slot(text, timestamptz, uuid, uuid, jsonb, text);
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
  v_maxday int; v_daycount int;
  v_pick jsonb; v_meta_add jsonb := '{}'::jsonb;
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

  -- Governing schedule: explicit choice, else the active one.
  select * into v_gov from public.interview_schedules s
    where s.dsp_id = v_dsp
      and ((p_schedule_id is not null and s.id = p_schedule_id)
        or (p_schedule_id is null and s.is_active))
    limit 1;

  -- Self-reschedule limit (0494): after N candidate cancels, rebooking goes
  -- through a human.
  if v_gov.id is not null and coalesce(v_gov.max_self_reschedules, 0) > 0
     and coalesce((v_app.metadata->>'self_cancel_count')::int, 0) >= v_gov.max_self_reschedules then
    raise exception 'reschedule_limit';
  end if;

  -- SMS verification (0493).
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
      select w.capacity, w.start_min into v_cap, v_start_min from (
        select av.weekday, av.start_min, av.end_min, av.capacity
          from public.interview_availability av
         where p_schedule_id is null and av.dsp_id = v_dsp
        union all
        select sw.weekday, sw.start_min, sw.end_min, sw.capacity
          from public.interview_schedule_windows sw
         where p_schedule_id is not null and sw.schedule_id = p_schedule_id
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

    -- Daily cap (0494): counted under the same advisory lock as capacity.
    v_maxday := nullif(coalesce(v_gov.max_per_day, 0), 0);
    if v_maxday is not null then
      select count(*)::int into v_daycount from public.cal_events ce
        where ce.dsp_id=v_dsp and ce.kind in('interview','orientation')
          and ce.status in('scheduled','rescheduled')
          and ((ce.starts_at at time zone v_cfg.timezone))::date = v_ldate;
      if v_daycount >= v_maxday then raise exception 'day_full'; end if;
    end if;

    insert into public.cal_events
      (dsp_id, applicant_id, kind, status, starts_at, ends_at, timezone, location, provider)
    values
      (v_dsp, v_app.id, 'interview', 'scheduled', p_slot_start, v_end, v_cfg.timezone, v_cfg.location, 'routeready')
    returning id into v_event_id;
  end if;

  -- Round-robin interviewer (0494): least-loaded pool member this week; the
  -- shape matches the operator's manual "Assign interviewer".
  if v_gov.id is not null and jsonb_typeof(coalesce(v_gov.interviewer_pool, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(v_gov.interviewer_pool, '[]'::jsonb)) > 0 then
    select elem into v_pick
    from jsonb_array_elements(v_gov.interviewer_pool) elem
    where coalesce(elem->>'id', '') <> ''
    order by (select count(*) from public.cal_events ce
              where ce.dsp_id = v_dsp and ce.kind = 'interview'
                and ce.status in ('scheduled','rescheduled')
                and ce.metadata->'interviewer'->>'id' = elem->>'id'
                and ce.starts_at >= date_trunc('week', coalesce(p_slot_start, now()))
                and ce.starts_at <  date_trunc('week', coalesce(p_slot_start, now())) + interval '7 days') asc,
             random()
    limit 1;
    if v_pick is not null then
      v_meta_add := v_meta_add || jsonb_build_object('interviewer',
        jsonb_build_object('id', v_pick->>'id', 'name', coalesce(v_pick->>'name', 'Interviewer')));
    end if;
  end if;

  if p_answers is not null and jsonb_typeof(p_answers) = 'object' and pg_column_size(p_answers) <= 8192 then
    v_meta_add := v_meta_add || jsonb_build_object('intake_answers', p_answers);
  end if;
  if v_sched.id is not null then
    v_meta_add := v_meta_add || jsonb_build_object('schedule_id', v_sched.id, 'schedule_name', v_sched.name);
  end if;
  if v_event_id is not null and v_meta_add <> '{}'::jsonb then
    update public.cal_events
       set metadata = coalesce(metadata, '{}'::jsonb) || v_meta_add
     where id = v_event_id;
  end if;

  update public.applicants set status='interview_booked', updated_at=now()
    where id=v_app.id and status not in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed');
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end; $$;
grant execute on function public.book_interview_slot(text, timestamptz, uuid, uuid, jsonb, text) to anon, authenticated;

-- ── cancel: minimum notice + self-cancel counter ─────────────────────────

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

  -- Minimum notice (0494): inside the window, changes go through a human.
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

  return jsonb_build_object('ok', true, 'cancelled_event_id', v_ev.id);
end; $$;
grant execute on function public.cancel_interview_booking(text, text) to anon, authenticated;

-- ── schedule editor: p_extra learns the 0494 keys ────────────────────────

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
      max_self_reschedules = case when p_extra ? 'max_self_reschedules' then greatest(coalesce((p_extra->>'max_self_reschedules')::int, 0), 0) else max_self_reschedules end
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
