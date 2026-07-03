-- ───────────────────────────────────────────────────────────────────────
-- 0407 · Date-specific availability overrides (holidays / one-off hours)
--
-- Availability was a strict weekly pattern — no way to close July 4th, block a
-- vacation day, or open special hours for one date without editing (and later
-- reverting) the weekly grid. This adds per-DSP date overrides and teaches the
-- booking engine to honor them.
--
-- An override for a date either CLOSES it (no bookable slots) or REPLACES that
-- day's windows with a custom set. Days without an override keep the weekly
-- pattern. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

create table if not exists public.interview_date_overrides (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  override_date date not null,
  is_closed     boolean not null default true,
  -- when not closed: [{ "start_min": 540, "end_min": 1020, "capacity": 1 }, ...]
  windows       jsonb not null default '[]'::jsonb,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (dsp_id, override_date)
);

alter table public.interview_date_overrides enable row level security;

do $$ begin
  create policy interview_date_overrides_rw on public.interview_date_overrides
    for all using (dsp_id = private.current_dsp_id())
    with check (dsp_id = private.current_dsp_id());
exception when duplicate_object then null; end $$;

-- ── Management RPCs (operator, RLS-scoped) ──────────────────────────────────
create or replace function public.interview_overrides_list()
returns setof public.interview_date_overrides
language sql stable security definer set search_path = '' as $$
  select * from public.interview_date_overrides
  where dsp_id = private.current_dsp_id() and override_date >= (current_date - 1)
  order by override_date asc;
$$;
grant execute on function public.interview_overrides_list() to authenticated;

create or replace function public.interview_override_set(
  p_date date, p_is_closed boolean, p_windows jsonb default '[]'::jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_id uuid;
begin
  if v_dsp is null then raise exception 'forbidden' using errcode='42501'; end if;
  if p_date is null then raise exception 'date_required'; end if;
  insert into public.interview_date_overrides (dsp_id, override_date, is_closed, windows, note)
  values (v_dsp, p_date, coalesce(p_is_closed, true), coalesce(p_windows, '[]'::jsonb), p_note)
  on conflict (dsp_id, override_date) do update
    set is_closed = excluded.is_closed, windows = excluded.windows,
        note = excluded.note, updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;
grant execute on function public.interview_override_set(date, boolean, jsonb, text) to authenticated;

create or replace function public.interview_override_remove(p_date date)
returns void language sql security definer set search_path = '' as $$
  delete from public.interview_date_overrides
  where dsp_id = private.current_dsp_id() and override_date = p_date;
$$;
grant execute on function public.interview_override_remove(date) to authenticated;

-- ── Slot generation: layer overrides over the weekly windows ────────────────
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
  ovr as (
    select od.override_date, od.is_closed, od.windows
    from public.interview_date_overrides od where od.dsp_id = v_dsp
  ),
  windows as (
    -- Custom windows for override days (not closed).
    select dy.local_date,
           (win->>'start_min')::int as start_min,
           (win->>'end_min')::int   as end_min,
           coalesce((win->>'capacity')::int, 1) as capacity
    from days dy
    join ovr o on o.override_date = dy.local_date and not o.is_closed
    cross join lateral jsonb_array_elements(coalesce(o.windows, '[]'::jsonb)) win
    union all
    -- Weekly windows for days with NO override at all.
    select dy.local_date, av.start_min, av.end_min, av.capacity
    from days dy
    join public.interview_availability av on av.dsp_id=v_dsp and av.weekday=extract(dow from dy.local_date)::int
    where not exists (select 1 from ovr o where o.override_date = dy.local_date)
    -- (Closed override days match neither branch → no windows → no slots.)
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
grant execute on function public.interview_open_slots(text) to anon, authenticated;

-- ── Booking: enforce overrides server-side ──────────────────────────────────
drop function if exists public.book_interview_slot(text, timestamptz, uuid);
create or replace function public.book_interview_slot(p_token text, p_slot_start timestamptz, p_session_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_app public.applicants; v_dsp uuid; v_cfg public.interview_config;
  v_end timestamptz; v_dow int; v_min int; v_start_min int; v_event_id uuid;
  v_sess public.interview_sessions; v_cap int; v_booked int;
  v_ldate date; v_ovr public.interview_date_overrides; v_win jsonb;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then raise exception 'invalid_or_expired_token' using errcode='P0002'; end if;
  v_dsp := v_app.dsp_id;
  select * into v_cfg from public.interview_config where dsp_id=v_dsp;
  if v_cfg.dsp_id is null then
    v_cfg.timezone:='America/Chicago'; v_cfg.slot_minutes:=30; v_cfg.buffer_minutes:=0;
    v_cfg.min_lead_hours:=12; v_cfg.window_days:=21;
  end if;

  if v_app.status in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed') then
    raise exception 'not_eligible';
  end if;
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
    v_ldate := (p_slot_start at time zone v_cfg.timezone)::date;

    select * into v_ovr from public.interview_date_overrides
      where dsp_id=v_dsp and override_date=v_ldate;
    if v_ovr.id is not null then
      -- A closed date has no bookable time.
      if v_ovr.is_closed then raise exception 'slot_unavailable'; end if;
      -- Custom windows for the date: the slot must fall inside one.
      v_cap := null; v_start_min := null;
      for v_win in select * from jsonb_array_elements(coalesce(v_ovr.windows,'[]'::jsonb)) loop
        if v_min >= (v_win->>'start_min')::int and v_min + v_cfg.slot_minutes <= (v_win->>'end_min')::int then
          v_cap := coalesce((v_win->>'capacity')::int, 1);
          v_start_min := (v_win->>'start_min')::int;
          exit;
        end if;
      end loop;
    else
      -- No override → weekly windows.
      select av.capacity, av.start_min into v_cap, v_start_min from public.interview_availability av
        where av.dsp_id=v_dsp and av.weekday=v_dow and v_min>=av.start_min and v_min+v_cfg.slot_minutes<=av.end_min
        order by av.capacity desc limit 1;
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

  update public.applicants set status='interview_booked', updated_at=now()
    where id=v_app.id and status not in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed');
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end; $$;
grant execute on function public.book_interview_slot(text, timestamptz, uuid) to anon, authenticated;
