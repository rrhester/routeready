-- ───────────────────────────────────────────────────────────────────────
-- 0371 · Native interview scheduling — group capacity + one-off sessions
--
--   • interview_availability.capacity      · per recurring block (default 1)
--   • interview_sessions                   · one-off dated group sessions
--   • cal_events.interview_session_id      · links a booking to a session
--   • capacity-aware engine: a slot/session stays OPEN until it's full, and
--     interview_open_slots returns capacity + remaining (+ session_id).
--   • book_interview_slot(token, ts, session_id) handles both paths.
--
-- Idempotent. Parallel to Cal.com.
-- ───────────────────────────────────────────────────────────────────────

alter table public.interview_availability add column if not exists capacity int not null default 1;
alter table public.cal_events            add column if not exists interview_session_id uuid;

create table if not exists public.interview_sessions (
  id         uuid primary key default gen_random_uuid(),
  dsp_id     uuid not null references public.dsps(id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  capacity   int not null default 20 check (capacity >= 1),
  location   text,
  label      text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  constraint interview_sessions_order check (ends_at > starts_at)
);
create index if not exists interview_sessions_dsp_idx on public.interview_sessions (dsp_id, starts_at);

do $$ begin
  alter table public.cal_events
    add constraint cal_events_interview_session_fk
    foreign key (interview_session_id) references public.interview_sessions(id) on delete set null;
exception when duplicate_object then null; end $$;

alter table public.interview_sessions enable row level security;
drop policy if exists interview_sessions_rw on public.interview_sessions;
create policy interview_sessions_rw on public.interview_sessions for all
  using (dsp_id = private.current_dsp_id()) with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.interview_sessions to authenticated;

-- ── Operator: availability now carries per-block capacity ──
create or replace function public.interview_availability_set(
  p_timezone text, p_slot_minutes int, p_buffer_minutes int,
  p_min_lead_hours int, p_window_days int, p_location text, p_windows jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); w jsonb;
begin
  if v_dsp is null then raise exception 'no_dsp'; end if;
  insert into public.interview_config
    (dsp_id, timezone, slot_minutes, buffer_minutes, min_lead_hours, window_days, location, updated_at)
  values (v_dsp, p_timezone, greatest(p_slot_minutes,5), greatest(p_buffer_minutes,0),
          greatest(p_min_lead_hours,0), greatest(p_window_days,1), p_location, now())
  on conflict (dsp_id) do update set
    timezone=excluded.timezone, slot_minutes=excluded.slot_minutes, buffer_minutes=excluded.buffer_minutes,
    min_lead_hours=excluded.min_lead_hours, window_days=excluded.window_days, location=excluded.location, updated_at=now();
  delete from public.interview_availability where dsp_id = v_dsp;
  for w in select * from jsonb_array_elements(coalesce(p_windows,'[]'::jsonb)) loop
    insert into public.interview_availability (dsp_id, weekday, start_min, end_min, capacity)
    values (v_dsp, (w->>'weekday')::int, (w->>'start_min')::int, (w->>'end_min')::int,
            greatest(coalesce((w->>'capacity')::int, 1), 1));
  end loop;
end; $$;
grant execute on function public.interview_availability_set(text,int,int,int,int,text,jsonb) to authenticated;

create or replace function public.interview_availability_get()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'config',  (select to_jsonb(c) from public.interview_config c where c.dsp_id = private.current_dsp_id()),
    'windows', coalesce((select jsonb_agg(jsonb_build_object('weekday',weekday,'start_min',start_min,'end_min',end_min,'capacity',capacity)
                                order by weekday, start_min)
                          from public.interview_availability where dsp_id = private.current_dsp_id()), '[]'::jsonb)
  );
$$;
grant execute on function public.interview_availability_get() to authenticated;

-- ── Operator: one-off session CRUD ──
create or replace function public.interview_sessions_list()
returns setof public.interview_sessions language sql stable security definer set search_path = '' as $$
  select * from public.interview_sessions
  where dsp_id = private.current_dsp_id() and starts_at >= now() - interval '1 day'
  order by starts_at;
$$;
grant execute on function public.interview_sessions_list() to authenticated;

create or replace function public.interview_session_add(
  p_starts_at timestamptz, p_ends_at timestamptz, p_capacity int, p_location text, p_label text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_id uuid;
begin
  if v_dsp is null then raise exception 'no_dsp'; end if;
  insert into public.interview_sessions (dsp_id, starts_at, ends_at, capacity, location, label)
  values (v_dsp, p_starts_at, p_ends_at, greatest(coalesce(p_capacity,20),1), p_location, p_label)
  returning id into v_id;
  return v_id;
end; $$;
grant execute on function public.interview_session_add(timestamptz,timestamptz,int,text,text) to authenticated;

create or replace function public.interview_session_remove(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  delete from public.interview_sessions where id = p_id and dsp_id = private.current_dsp_id();
$$;
grant execute on function public.interview_session_remove(uuid) to authenticated;

-- ── Booking engine (capacity-aware; recurring slots + sessions) ──
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

-- ── Book (recurring slot when p_session_id is null, else into a session) ──
drop function if exists public.book_interview_slot(text, timestamptz);
create or replace function public.book_interview_slot(p_token text, p_slot_start timestamptz, p_session_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_app public.applicants; v_dsp uuid; v_cfg public.interview_config;
  v_end timestamptz; v_dow int; v_min int; v_event_id uuid;
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
    select av.capacity into v_cap from public.interview_availability av
      where av.dsp_id=v_dsp and av.weekday=v_dow and v_min>=av.start_min and v_min+v_cfg.slot_minutes<=av.end_min
      order by av.capacity desc limit 1;
    if v_cap is null then raise exception 'slot_unavailable'; end if;
    perform pg_advisory_xact_lock(hashtext(v_dsp::text), hashtext(p_slot_start::text));
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
