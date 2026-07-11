-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0458 · Upper-funnel hiring planning RPC
--
-- Powers the "Hiring pulse" intelligence view + the upper-funnel math in
-- the Risk forecast: work BACKWARD from the 13-week plan's driver gap,
-- through the DSP's own measured conversion rates, to "how many
-- applicants do I need in the funnel, and by when".
--
-- One RPC, one round-trip: hiring_pipeline_planning(p_window_days) returns
--   • applied / hired volume in the lookback window + apps-per-week pace
--   • median + p75 applied→hired days (funnel velocity, from the
--     status-history trail that migration 0003 has been recording)
--   • per-stage ladder: how many applicants are IN the funnel at each
--     stage right now, and — from the RESOLVED cohort — how many ever
--     reached that stage vs. how many of those went on to be hired
--     (i.e. P(hire | reached stage), the number backward-planning needs)
--
-- Cohort honesty: conditional rates are computed only over applicants
-- whose outcome is known — terminal status (hired / auto_declined /
-- rejected / no_show) or older than 45 days (a stale, silent applicant is
-- a "no" in practice). Counting mid-funnel applicants as non-hires would
-- understate rates; ignoring stale ones would overstate them. The same
-- 45-day line keeps the "in funnel now" counts fresh: only non-terminal
-- applicants younger than 45 days count as live pipeline.
--
-- The client (dashboard/live.js) decides when the sample is too thin to
-- trust and falls back to labeled industry-default rates.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.hiring_pipeline_planning(p_window_days int default 180)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_cutoff     timestamptz := now() - (greatest(p_window_days, 1) || ' days')::interval;
  v_applied    int;
  v_first      timestamptz;
  v_hired      int;
  v_apps_per_week numeric;
  v_median_tth numeric;
  v_p75_tth    numeric;
  v_stages     jsonb;
begin
  -- Application volume + pace. Pace divides by the ACTIVE span (first
  -- application → now, capped at the window) so a 3-week-old DSP isn't
  -- diluted across 180 days.
  select count(*), min(created_at) into v_applied, v_first
  from public.applicants
  where dsp_id = v_dsp and created_at >= v_cutoff;

  v_apps_per_week := case
    when v_applied = 0 or v_first is null then 0
    else round(
      v_applied::numeric
      / greatest(1.0, least(p_window_days::numeric,
                            extract(epoch from now() - v_first) / 86400.0) / 7.0),
      1)
  end;

  -- Hires in window + funnel velocity (days from application to the FIRST
  -- transition into 'hired', per applicant).
  select count(distinct c.applicant_id) into v_hired
  from public.applicant_status_changes c
  where c.dsp_id = v_dsp and c.to_status = 'hired' and c.created_at >= v_cutoff;

  select percentile_cont(0.5) within group (order by t.d),
         percentile_cont(0.75) within group (order by t.d)
    into v_median_tth, v_p75_tth
  from (
    select extract(epoch from min(c.created_at) - a.created_at) / 86400.0 as d
    from public.applicant_status_changes c
    join public.applicants a on a.id = c.applicant_id
    where c.dsp_id = v_dsp
      and c.to_status = 'hired'
      and c.created_at >= v_cutoff
    group by c.applicant_id, a.created_at
  ) t
  where t.d >= 0;

  -- Stage ladder. rank_map folds the 15 applicant statuses into 8 ordered
  -- progress ranks (terminal failures carry no progress of their own —
  -- an applicant's real progress lives in their status history, except
  -- auto_declined, which by construction means screening completed).
  with rank_map(st, rnk) as (
    values
      ('applied', 1), ('contacted', 2),
      ('screening_started', 3), ('screening_completed', 3), ('auto_declined', 3),
      ('qualified', 4), ('review_needed', 4),
      ('interview_invited', 5),
      ('interview_booked', 6), ('interview_completed', 6),
      ('orientation_invited', 7), ('orientation_booked', 7),
      ('hired', 8),
      ('rejected', 1), ('no_show', 1)
  ),
  events as (
    -- Every status an applicant has ever held: current + full history.
    select a.id as applicant_id, a.status::text as st
    from public.applicants a
    where a.dsp_id = v_dsp and a.created_at >= v_cutoff
    union all
    select c.applicant_id, c.to_status::text
    from public.applicant_status_changes c
    join public.applicants a on a.id = c.applicant_id
    where c.dsp_id = v_dsp and a.created_at >= v_cutoff
  ),
  per_app as (
    select a.id,
           max(coalesce(rm.rnk, 1)) as max_rank,
           bool_or(e.st = 'hired')  as is_hired,
           (a.status::text in ('hired', 'auto_declined', 'rejected', 'no_show')
             or a.created_at <= now() - interval '45 days') as resolved,
           case when a.status::text not in ('hired', 'auto_declined', 'rejected', 'no_show')
                  and a.created_at > now() - interval '45 days'
                then (select rm2.rnk from rank_map rm2 where rm2.st = a.status::text)
                else null end as live_rank
    from public.applicants a
    join events e on e.applicant_id = a.id
    left join rank_map rm on rm.st = e.st
    where a.dsp_id = v_dsp and a.created_at >= v_cutoff
    group by a.id, a.status, a.created_at
  ),
  ladder(rnk, key, label) as (
    values
      (1, 'applied',            'Applied'),
      (2, 'contacted',          'Contacted'),
      (3, 'screening',          'In screening'),
      (4, 'qualified',          'Qualified'),
      (5, 'interview_invited',  'Interview invited'),
      (6, 'interview',          'Interview booked'),
      (7, 'orientation',        'Orientation')
  )
  select jsonb_agg(jsonb_build_object(
           'rank',       l.rnk,
           'key',        l.key,
           'label',      l.label,
           'in_funnel',  coalesce(f.in_funnel, 0),
           'reached',    coalesce(r.reached, 0),
           'hired_from', coalesce(r.hired_from, 0)
         ) order by l.rnk)
    into v_stages
  from ladder l
  left join (
    select live_rank as rnk, count(*) as in_funnel
    from per_app where live_rank is not null
    group by live_rank
  ) f on f.rnk = l.rnk
  left join (
    select l2.rnk,
           count(*) filter (where p.resolved and p.max_rank >= l2.rnk)                 as reached,
           count(*) filter (where p.resolved and p.max_rank >= l2.rnk and p.is_hired)  as hired_from
    from ladder l2
    cross join per_app p
    group by l2.rnk
  ) r on r.rnk = l.rnk;

  return jsonb_build_object(
    'window_days',        p_window_days,
    'applied',            v_applied,
    'hired',              v_hired,
    'apps_per_week',      v_apps_per_week,
    'median_days_to_hire', case when v_median_tth is null then null else round(v_median_tth, 1) end,
    'p75_days_to_hire',    case when v_p75_tth   is null then null else round(v_p75_tth, 1) end,
    'stages',             coalesce(v_stages, '[]'::jsonb)
  );
end;
$$;

grant execute on function public.hiring_pipeline_planning(int) to authenticated;
