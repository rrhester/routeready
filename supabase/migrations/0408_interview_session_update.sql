-- ───────────────────────────────────────────────────────────────────────
-- 0408 · Edit a group interview session
--
-- The availability editor could add and remove group sessions but not edit
-- them — yet clicking a session on the calendar toasts "Edit group sessions
-- from the Availability tab", promising an edit that didn't exist. Fixing a
-- typo or moving a 20-person session meant delete + recreate, which orphaned
-- anyone already booked into it.
--
-- Idempotent.
-- ───────────────────────────────────────────────────────────────────────

create or replace function public.interview_session_update(
  p_id uuid, p_starts_at timestamptz, p_ends_at timestamptz,
  p_capacity int, p_label text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_booked int;
begin
  if v_dsp is null then raise exception 'forbidden' using errcode='42501'; end if;
  if p_ends_at <= p_starts_at then raise exception 'end_before_start'; end if;
  -- Don't let capacity drop below the number already booked into the session.
  select count(*)::int into v_booked from public.cal_events
    where interview_session_id = p_id and status in ('scheduled','rescheduled');
  if p_capacity < greatest(v_booked, 1) then
    raise exception 'capacity_below_booked';
  end if;
  update public.interview_sessions
    set starts_at = p_starts_at, ends_at = p_ends_at,
        capacity = greatest(p_capacity, 1), label = p_label
    where id = p_id and dsp_id = v_dsp;
end; $$;
grant execute on function public.interview_session_update(uuid, timestamptz, timestamptz, int, text) to authenticated;
