-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0018 · Funnel-conversion KPIs for the Pipeline banner
--
-- Adds a single RPC that returns the four left-to-right funnel metrics
-- the Pipeline KPI strip now shows alongside show / hire / headcount:
--
--   not_contacted   applicants in 'applied' state (no SMS/email queued yet)
--   passed          completed screening, didn't fail
--   failed          auto_declined (hard-filter)
--   booked_rate     booked / sent-a-booking-link
--   active_drivers  drivers in 'active' or 'onboarding' status
--
-- Each count is paired with a percentage relative to the right denom:
--   not_contacted_pct, passed_pct, failed_pct → % of total applicants
--   booked_rate                               → % of those sent a link
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.pipeline_funnel_kpis()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_total int;
  v_not_contacted int;
  v_passed int;
  v_failed int;
  v_invited int;  -- sent any kind of booking link (or beyond)
  v_booked  int;  -- actually clicked through and booked a slot
  v_active_drivers int;
  v_pct numeric;
begin
  select count(*) into v_total
  from public.applicants where dsp_id = v_dsp;

  select count(*) into v_not_contacted
  from public.applicants
  where dsp_id = v_dsp and status = 'applied';

  -- "Passed screening" = anyone past screening that isn't hard-filter-declined.
  select count(*) into v_passed
  from public.applicants
  where dsp_id = v_dsp
    and status in (
      'screening_completed','qualified','review_needed',
      'interview_invited','interview_booked','interview_completed',
      'orientation_invited','orientation_booked','hired'
    );

  select count(*) into v_failed
  from public.applicants
  where dsp_id = v_dsp and status = 'auto_declined';

  -- Booked rate denominator: anyone we ever sent a booking link to (and beyond).
  -- Numerator: anyone who actually has a booked slot or progressed past it.
  select
    count(*) filter (where status in (
      'interview_invited','orientation_invited',
      'interview_booked','orientation_booked','interview_completed',
      'hired','not_hired','no_show'
    )),
    count(*) filter (where status in (
      'interview_booked','orientation_booked','interview_completed',
      'hired','not_hired','no_show'
    ))
  into v_invited, v_booked
  from public.applicants where dsp_id = v_dsp;

  select count(*) into v_active_drivers
  from public.drivers
  where dsp_id = v_dsp and status in ('active','onboarding');

  return jsonb_build_object(
    'total',              v_total,
    'not_contacted',      v_not_contacted,
    'not_contacted_pct',  case when v_total = 0 then 0 else round(100.0 * v_not_contacted / v_total) end,
    'passed',             v_passed,
    'passed_pct',         case when v_total = 0 then 0 else round(100.0 * v_passed / v_total) end,
    'failed',             v_failed,
    'failed_pct',         case when v_total = 0 then 0 else round(100.0 * v_failed / v_total) end,
    'invited',            v_invited,
    'booked',             v_booked,
    'booked_rate',        case when v_invited = 0 then 0 else round(100.0 * v_booked / v_invited) end,
    'active_drivers',     v_active_drivers
  );
end;
$$;
grant execute on function public.pipeline_funnel_kpis() to authenticated;
