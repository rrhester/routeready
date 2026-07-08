-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0442 · Checklist compliance analytics
--
-- A read-only rollup powering the operator's "Insights" dashboard: how much
-- is getting done, how much is on time, what keeps failing, and per-checklist
-- / per-driver breakdowns. Grounded in what's directly measurable from
-- submissions + answers (no roster replay), so the numbers are honest. Dates
-- bucket in the DSP's timezone via private.dsp_today's tz.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.checklist_analytics(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_tz    text := coalesce((select timezone from public.dsps where id = private.current_dsp_id()), 'UTC');
  v_since timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  v_totals jsonb;
  v_by_day jsonb;
  v_top jsonb;
  v_by_checklist jsonb;
  v_by_driver jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  -- Submission totals over the window.
  select jsonb_build_object(
    'submissions',  count(*),
    'submitted',    count(*) filter (where status = 'submitted'),
    'in_progress',  count(*) filter (where status in ('in_progress','reopened')),
    'overdue',      count(*) filter (where status in ('in_progress','reopened') and due_at is not null and due_at < now()),
    'on_time',      count(*) filter (where status = 'submitted' and due_at is not null and submitted_at <= due_at),
    'due_tracked',  count(*) filter (where status = 'submitted' and due_at is not null)
  ) into v_totals
  from public.checklist_submissions
  where dsp_id = v_dsp and created_at >= v_since;

  -- Flag totals (merged into the same object).
  select v_totals || jsonb_build_object(
    'flagged_answers', count(*),
    'open_flags',      count(*) filter (where a.flag_resolved_at is null),
    'resolved_flags',  count(*) filter (where a.flag_resolved_at is not null)
  ) into v_totals
  from public.checklist_answers a
  join public.checklist_submissions s on s.id = a.submission_id
  where a.dsp_id = v_dsp and a.failed_flag and s.created_at >= v_since;

  -- Submitted-per-day trend (DSP-local calendar days).
  select coalesce(jsonb_agg(jsonb_build_object('day', d, 'submitted', c) order by d), '[]'::jsonb) into v_by_day
  from (
    select (submitted_at at time zone v_tz)::date as d, count(*) c
    from public.checklist_submissions
    where dsp_id = v_dsp and status = 'submitted' and submitted_at >= v_since
    group by 1
  ) t;

  -- Top flagged items by count.
  select coalesce(jsonb_agg(jsonb_build_object('label', label, 'count', c) order by c desc), '[]'::jsonb) into v_top
  from (
    select coalesce(a.item_label, i.label, 'Item') as label, count(*) c
    from public.checklist_answers a
    join public.checklist_submissions s on s.id = a.submission_id
    left join public.checklist_items i on i.id = a.item_id
    where a.dsp_id = v_dsp and a.failed_flag and s.created_at >= v_since
    group by 1
    order by c desc
    limit 10
  ) t;

  -- Per checklist.
  select coalesce(jsonb_agg(jsonb_build_object(
           'template_id', template_id, 'name', name, 'submitted', submitted, 'flagged', flagged
         ) order by submitted desc, name), '[]'::jsonb) into v_by_checklist
  from (
    select s.template_id, f.name,
           count(distinct s.id) filter (where s.status = 'submitted') as submitted,
           count(*) filter (where a.failed_flag) as flagged
    from public.checklist_submissions s
    join public.checklist_forms f on f.id = s.template_id
    left join public.checklist_answers a on a.submission_id = s.id
    where s.dsp_id = v_dsp and s.created_at >= v_since
    group by s.template_id, f.name
  ) t;

  -- Per driver (top 20 by submitted).
  select coalesce(jsonb_agg(jsonb_build_object(
           'driver_id', driver_id, 'name', full_name, 'submitted', submitted, 'flagged', flagged
         ) order by submitted desc, full_name), '[]'::jsonb) into v_by_driver
  from (
    select s.driver_id, d.full_name,
           count(distinct s.id) filter (where s.status = 'submitted') as submitted,
           count(*) filter (where a.failed_flag) as flagged
    from public.checklist_submissions s
    join public.drivers d on d.id = s.driver_id
    left join public.checklist_answers a on a.submission_id = s.id
    where s.dsp_id = v_dsp and s.created_at >= v_since
    group by s.driver_id, d.full_name
    order by submitted desc
    limit 20
  ) t;

  return jsonb_build_object(
    'days', greatest(coalesce(p_days, 30), 1),
    'generated_at', now(),
    'totals', coalesce(v_totals, '{}'::jsonb),
    'by_day', v_by_day,
    'top_flagged', v_top,
    'by_checklist', v_by_checklist,
    'by_driver', v_by_driver
  );
end $$;
grant execute on function public.checklist_analytics(int) to authenticated;

notify pgrst, 'reload schema';
