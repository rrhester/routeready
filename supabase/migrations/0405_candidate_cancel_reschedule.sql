-- ───────────────────────────────────────────────────────────────────────
-- 0405 · Candidate self-serve cancel (and reschedule)
--
-- Candidates could book but never cancel or move an interview without emailing
-- a human — a direct no-show driver for hourly-workforce hiring. This adds an
-- anon, token-gated cancel. Reschedule is cancel + re-book on the client: once
-- the active interview is cancelled, book_interview_slot (0403) lets the
-- applicant pick a new time again.
--
-- Idempotent.
-- ───────────────────────────────────────────────────────────────────────

create or replace function public.cancel_interview_booking(p_token text)
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

  update public.cal_events set status = 'cancelled', updated_at = now() where id = v_ev.id;

  -- Return the applicant to the "awaiting scheduling" queue so they can rebook
  -- and the operator sees them as open again (only when they were booked —
  -- don't resurrect a rejected/hired applicant).
  update public.applicants set status = 'interview_invited', updated_at = now()
    where id = v_app.id and status = 'interview_booked';

  return jsonb_build_object('ok', true, 'cancelled_event_id', v_ev.id);
end; $$;
grant execute on function public.cancel_interview_booking(text) to anon, authenticated;
