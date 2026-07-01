-- ───────────────────────────────────────────────────────────────────────
-- 0402 · booking_preview(schedule) — token-free preview of the booking page
--
-- Lets the operator preview exactly what an applicant sees for a given named
-- schedule, without a candidate token and without booking anything. Mirrors
-- interview_open_slots, but sources its config + weekly windows from the
-- interview_schedules / interview_schedule_windows rows for p_schedule_id
-- (so you can preview ANY schedule, not just the active/mirrored one).
--
-- The random schedule UUID is the capability (same bearer model as the
-- booking token), so this is granted to anon for the read-only preview page.
--
-- Idempotent — safe to re-run.
-- ───────────────────────────────────────────────────────────────────────

create or replace function public.booking_preview(p_schedule_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_s     public.interview_schedules;
  v_dsp   public.dsps;
  v_slots jsonb;
begin
  select * into v_s from public.interview_schedules where id = p_schedule_id;
  if v_s.id is null then
    raise exception 'schedule_not_found' using errcode = 'P0002';
  end if;
  select * into v_dsp from public.dsps where id = v_s.dsp_id;

  with days as (
    select d::date as local_date from generate_series(
      (now() at time zone v_s.timezone)::date,
      (now() at time zone v_s.timezone)::date + v_s.window_days, interval '1 day') d
  ),
  windows as (
    select dy.local_date, w.start_min, w.end_min, w.capacity
    from days dy
    join public.interview_schedule_windows w
      on w.schedule_id = v_s.id and w.weekday = extract(dow from dy.local_date)::int
  ),
  rec as (
    select ((w.local_date::timestamp + make_interval(mins => s)) at time zone v_s.timezone) as ss,
           ((w.local_date::timestamp + make_interval(mins => s + v_s.slot_minutes)) at time zone v_s.timezone) as se,
           w.capacity
    from windows w cross join lateral
      generate_series(w.start_min, w.end_min - v_s.slot_minutes, v_s.slot_minutes + v_s.buffer_minutes) s
  ),
  rec_open as (
    select r.ss, r.se, r.capacity,
      r.capacity - (select count(*)::int from public.cal_events ce
        where ce.dsp_id = v_s.dsp_id and ce.kind in ('interview','orientation') and ce.status in ('scheduled','rescheduled')
          and ce.interview_session_id is null
          and tstzrange(ce.starts_at, coalesce(ce.ends_at, ce.starts_at + make_interval(mins => v_s.slot_minutes)))
              && tstzrange(r.ss, r.se)) as remaining
    from rec r
    where r.ss >= now() + make_interval(hours => v_s.min_lead_hours)
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('slot_start', ss, 'slot_end', se, 'capacity', capacity, 'remaining', remaining)
              order by ss) filter (where remaining > 0),
    '[]'::jsonb)
    into v_slots
  from rec_open;

  return jsonb_build_object(
    'dsp', jsonb_build_object('name', v_dsp.name, 'short_code', v_dsp.short_code),
    'timezone', v_s.timezone,
    'slot_minutes', v_s.slot_minutes,
    'schedule_name', v_s.name,
    'preview', true,
    'slots', v_slots
  );
end;
$$;
grant execute on function public.booking_preview(uuid) to anon, authenticated;
