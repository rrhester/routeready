-- ───────────────────────────────────────────────────────────────────────
-- 0461 · Fix "column reference capacity is ambiguous" in interview_open_slots
--
-- interview_open_slots is declared `returns table (... capacity int,
-- remaining int, session_id uuid)`, so those names are OUT variables in
-- scope inside the function body. The final UNION ALL selected them
-- UNQUALIFIED (`select ss, se, capacity, remaining, session_id from rec_open`),
-- so PL/pgSQL couldn't tell whether `capacity` meant the CTE column or the
-- OUT variable and raised `column reference "capacity" is ambiguous` — which
-- surfaced to applicants as "Couldn't load times".
--
-- Fix: table-qualify every column in the two final SELECTs (r.* / s.*).
-- Body is otherwise identical to 0407 (date-override-aware slot generation).
-- Idempotent — safe to re-run.
-- ───────────────────────────────────────────────────────────────────────

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
  select r.ss, r.se, r.capacity, r.remaining, r.session_id from rec_open  r where r.remaining > 0
  union all
  select s.ss, s.se, s.capacity, s.remaining, s.session_id from sess_open s where s.remaining > 0
  order by 1;
end; $$;
grant execute on function public.interview_open_slots(text) to anon, authenticated;
