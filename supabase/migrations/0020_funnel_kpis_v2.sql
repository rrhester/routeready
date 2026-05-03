-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0020 · Funnel KPIs v2 — window + contacted + end-to-end
--
-- Pipeline KPI strip now lets the operator switch the lookback window
-- (this week / 4 weeks / all time). The funnel-conversion RPC adds:
--   • Window filter (created_at > now - p_window_days).
--   • "Contacted" as a positive metric (replaces "not_contacted").
--   • End-to-end conversion rate (hired ÷ total applicants in window).
--   • Active drivers stays in the response but the UI hides it now.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.pipeline_funnel_kpis(p_window_days int default 36500)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_cutoff timestamptz := now() - (greatest(p_window_days, 1) || ' days')::interval;
  v_total int;
  v_contacted int;
  v_passed int;
  v_failed int;
  v_invited int;
  v_booked  int;
  v_hired   int;
  v_active_drivers int;
begin
  select count(*) into v_total
  from public.applicants
  where dsp_id = v_dsp and created_at >= v_cutoff;

  -- "Contacted" = anyone we've reached out to (status moved past 'applied').
  select count(*) into v_contacted
  from public.applicants
  where dsp_id = v_dsp
    and created_at >= v_cutoff
    and status <> 'applied';

  select count(*) into v_passed
  from public.applicants
  where dsp_id = v_dsp
    and created_at >= v_cutoff
    and status in (
      'screening_completed','qualified','review_needed',
      'interview_invited','interview_booked','interview_completed',
      'orientation_invited','orientation_booked','hired'
    );

  select count(*) into v_failed
  from public.applicants
  where dsp_id = v_dsp
    and created_at >= v_cutoff
    and status = 'auto_declined';

  select
    count(*) filter (where status in (
      'interview_invited','orientation_invited',
      'interview_booked','orientation_booked','interview_completed',
      'hired','not_hired','no_show'
    )),
    count(*) filter (where status in (
      'interview_booked','orientation_booked','interview_completed',
      'hired','not_hired','no_show'
    )),
    count(*) filter (where status = 'hired')
  into v_invited, v_booked, v_hired
  from public.applicants
  where dsp_id = v_dsp and created_at >= v_cutoff;

  select count(*) into v_active_drivers
  from public.drivers
  where dsp_id = v_dsp and status in ('active','onboarding');

  return jsonb_build_object(
    'window_days',       p_window_days,
    'total',             v_total,
    'contacted',         v_contacted,
    'contacted_pct',     case when v_total = 0 then 0 else round(100.0 * v_contacted / v_total) end,
    'passed',            v_passed,
    'passed_pct',        case when v_total = 0 then 0 else round(100.0 * v_passed / v_total) end,
    'failed',            v_failed,
    'failed_pct',        case when v_total = 0 then 0 else round(100.0 * v_failed / v_total) end,
    'invited',           v_invited,
    'booked',            v_booked,
    'booked_rate',       case when v_invited = 0 then 0 else round(100.0 * v_booked / v_invited) end,
    'hired',             v_hired,
    'e2e_pct',           case when v_total = 0 then 0 else round(100.0 * v_hired / v_total) end,
    'active_drivers',    v_active_drivers
  );
end;
$$;
grant execute on function public.pipeline_funnel_kpis(int) to authenticated;
