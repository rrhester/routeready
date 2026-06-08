-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0366 · "Action needed" pipeline filter + count
--
-- Adds a virtual stage `action_needed` to the funnel: applicants where the
-- next move is the DSP's, matching the blue "action needed" CTA on the cards:
--   • screened   → screening done, needs the booking link sent, OR
--   • applied + no screening invite sent yet (no SMS on file)
--
-- Implemented in both pipeline_list (so the "Action needed" tab filters the
-- list) and pipeline_counts (so the tab's count is accurate on every tab).
-- Both are `create or replace`, so this migration is safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── pipeline_list · support p_stage = 'action_needed' ─────────────────────
-- Restructured so the last-SMS lookup is available at filter time (the
-- action-needed predicate needs to know whether an invite has gone out).
-- Return shape is unchanged from 0011.
create or replace function public.pipeline_list(p_stage text default 'all', p_limit int default 200)
returns table (
  id                uuid,
  full_name         text,
  email             text,
  phone             text,
  source            text,
  status            public.applicant_status,
  pipeline_stage    text,
  score             int,
  station_id        uuid,
  station_code      text,
  created_at        timestamptz,
  screening_completed_at timestamptz,
  next_event_starts_at timestamptz,
  next_event_kind   public.cal_event_kind,
  next_event_status public.cal_event_status,
  last_sms_at       timestamptz,
  last_sms_status   public.message_status,
  message_count     bigint,
  video_url         text
)
language sql
stable
security definer
set search_path = ''
as $$
  with last_sms as (
    select distinct on (applicant_id)
      applicant_id, created_at, status
    from public.sms_messages
    where dsp_id = private.current_dsp_id()
      and applicant_id is not null
    order by applicant_id, created_at desc
  ),
  base as (
    select ap.*, ls.created_at as ls_created_at, ls.status as ls_status
    from public.applicants_pipeline ap
    left join last_sms ls on ls.applicant_id = ap.id
    where ap.dsp_id = private.current_dsp_id()
      and ap.pipeline_stage <> 'closed'
      and (
        p_stage = 'all'
        or (p_stage = 'action_needed' and (
              ap.pipeline_stage = 'screened'
              or (ap.status = 'applied' and ls.created_at is null)
           ))
        or (p_stage not in ('all', 'action_needed') and ap.pipeline_stage = p_stage)
      )
    order by ap.score desc nulls last, ap.created_at desc
    limit greatest(p_limit, 1)
  ),
  next_event as (
    select distinct on (applicant_id)
      applicant_id, starts_at, kind, status
    from public.cal_events
    where dsp_id = private.current_dsp_id()
      and status in ('scheduled','rescheduled')
    order by applicant_id, starts_at asc
  ),
  msg_counts as (
    select applicant_id, count(*)::bigint as n
    from public.sms_messages
    where dsp_id = private.current_dsp_id()
      and applicant_id is not null
    group by applicant_id
  )
  select
    b.id, b.full_name, b.email, b.phone, b.source,
    b.status, b.pipeline_stage, b.score,
    b.station_id, s.code,
    b.created_at, b.screening_completed_at,
    ne.starts_at, ne.kind, ne.status,
    b.ls_created_at, b.ls_status,
    coalesce(mc.n, 0),
    b.video_url
  from base b
  left join public.stations s   on s.id = b.station_id
  left join next_event ne       on ne.applicant_id = b.id
  left join msg_counts mc       on mc.applicant_id = b.id;
$$;

grant execute on function public.pipeline_list(text, int) to authenticated;


-- ─── pipeline_counts · add an 'action_needed' bucket ───────────────────────
create or replace function public.pipeline_counts()
returns table (stage text, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with pl as (
    select
      ap.pipeline_stage,
      ap.status,
      exists(
        select 1 from public.sms_messages m
        where m.applicant_id = ap.id
          and m.dsp_id = private.current_dsp_id()
      ) as has_sms
    from public.applicants_pipeline ap
    where ap.dsp_id = private.current_dsp_id()
      and ap.pipeline_stage <> 'closed'
  )
  select pipeline_stage, count(*)::bigint
  from pl
  group by pipeline_stage
  union all
  select 'all', count(*)::bigint
  from pl
  union all
  select 'action_needed', count(*)::bigint
  from pl
  where pipeline_stage = 'screened'
     or (status = 'applied' and not has_sms);
$$;

grant execute on function public.pipeline_counts() to authenticated;
