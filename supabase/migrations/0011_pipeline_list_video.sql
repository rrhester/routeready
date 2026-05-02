-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0011 · Surface video_url through pipeline_list
--
-- 0010 added applicants.video_url. The applicants_pipeline view from
-- 0003 was created with `select a.*`, but Postgres expands * at view-
-- creation time and freezes the column list — it does NOT pick up new
-- columns added to the underlying table later. We have to drop and
-- recreate the view (CREATE OR REPLACE VIEW can append columns but
-- not when the underlying source is `a.*` since the column set has
-- changed). Then we drop and recreate pipeline_list with the new
-- video_url field in its return shape.
-- ─────────────────────────────────────────────────────────────────────────

drop function if exists public.pipeline_list(text, int);
drop view if exists public.applicants_pipeline;

create or replace view public.applicants_pipeline as
  select
    a.*,
    public.applicant_pipeline_stage(a.status) as pipeline_stage
  from public.applicants a;

grant select on public.applicants_pipeline to authenticated;


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
  with base as (
    select * from public.applicants_pipeline
    where dsp_id = private.current_dsp_id()
      and (p_stage = 'all' or pipeline_stage = p_stage)
      and pipeline_stage <> 'closed'
    order by score desc nulls last, created_at desc
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
  last_sms as (
    select distinct on (applicant_id)
      applicant_id, created_at, status
    from public.sms_messages
    where dsp_id = private.current_dsp_id()
      and applicant_id is not null
    order by applicant_id, created_at desc
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
    ls.created_at, ls.status,
    coalesce(mc.n, 0),
    b.video_url
  from base b
  left join public.stations s   on s.id = b.station_id
  left join next_event ne       on ne.applicant_id = b.id
  left join last_sms ls         on ls.applicant_id = b.id
  left join msg_counts mc       on mc.applicant_id = b.id;
$$;

grant execute on function public.pipeline_list(text, int) to authenticated;
