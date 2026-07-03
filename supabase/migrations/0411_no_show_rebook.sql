-- ───────────────────────────────────────────────────────────────────────
-- 0411 · No-show recovery
--
-- Marking a candidate No Show (record_outcome) set their status to 'not_hired'
-- and did nothing else — they silently dropped out of the funnel. This adds a
-- small RPC the dashboard calls right after a no-show to give them another
-- chance: resend the interview booking link and return them to the "Awaiting
-- scheduling" rail (status = interview_invited).
--
-- It reuses the existing send_booking_link machinery (token mint + templated
-- email/SMS). send_booking_link's own status guard intentionally skips
-- not_hired/no_show applicants, so we flip the status back here explicitly.
--
-- Idempotent.
-- ───────────────────────────────────────────────────────────────────────

create or replace function public.no_show_rebook(p_applicant_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_res jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Resend the interview booking link (queues email/SMS; mints a fresh token).
  v_res := public.send_booking_link(p_applicant_id, 'interview');

  -- Return them to Awaiting. send_booking_link won't do this for a
  -- not_hired/no_show applicant (its guard excludes those), so set it here.
  update public.applicants
     set status = 'interview_invited'::public.applicant_status
   where id = p_applicant_id
     and dsp_id = v_dsp
     and status in ('not_hired'::public.applicant_status, 'no_show'::public.applicant_status);

  return v_res;
end; $$;
grant execute on function public.no_show_rebook(uuid) to authenticated;

notify pgrst, 'reload schema';
