-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0015 · not_hired pipeline_stage mapping + daily availability
--
-- Two updates:
--   1. applicant_pipeline_stage() — fold the new 'not_hired' status into
--      the 'closed' visual bucket so it disappears from the funnel view
--      automatically (same as the other terminals).
--   2. Seed the "Which days can you work?" availability question on the
--      DEMO DSP. Multi-select over the 7 days of the week, no scoring or
--      hard filter — just data capture for downstream scheduling tools.
--      Operators can disable it from Settings > Screening Questions if
--      they don't want it.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.applicant_pipeline_stage(s public.applicant_status)
returns text
language sql
immutable
as $$
  select case s
    when 'applied'              then 'applied'
    when 'contacted'            then 'applied'
    when 'screening_started'    then 'applied'
    when 'screening_completed'  then 'screened'
    when 'qualified'            then 'screened'
    when 'review_needed'        then 'screened'
    when 'interview_invited'    then 'booking_pending'
    when 'orientation_invited'  then 'booking_pending'
    when 'interview_booked'     then 'booking_scheduled'
    when 'orientation_booked'   then 'booking_scheduled'
    when 'interview_completed'  then 'booking_scheduled'
    when 'auto_declined'        then 'closed'
    when 'rejected'             then 'closed'
    when 'no_show'              then 'closed'
    when 'not_hired'            then 'closed'
    when 'hired'                then 'closed'
  end;
$$;


-- ─── Daily availability seed (idempotent) ───────────────────────────────

insert into public.screening_questions
  (dsp_id, prompt, field_type, options, required, hard_filter, scoring, display_order, active)
values
  ('00000000-0000-0000-0000-00000000d000',
   'Which days are you available to work?',
   'multi',
   '["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]'::jsonb,
   true,
   null,
   null,
   9,
   true)
on conflict do nothing;
