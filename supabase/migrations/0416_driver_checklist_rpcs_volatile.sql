-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0416 · Driver checklist read RPCs must be VOLATILE
--
-- driver_list_checklists / driver_get_checklist were declared STABLE in
-- 0415. PostgREST executes STABLE/IMMUTABLE RPCs inside a READ ONLY
-- transaction — but private.driver_validate_token() writes a last-used
-- timestamp, so every call from the driver app failed with SQLSTATE
-- 25006 ("cannot execute UPDATE in a read-only transaction"). The SQL
-- editor and staff dashboard never hit this because they don't run in
-- PostgREST's read-only mode.
--
-- Same lesson as driver_list_forms: 0081 created it STABLE, 0142
-- re-created it without the marker. Re-issue both functions VOLATILE
-- (the default); bodies are identical to 0415.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.driver_list_checklists(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
  return coalesce((
    select jsonb_agg(row_to_json(t)::jsonb order by
             case t.status when 'overdue' then 0 when 'in_progress' then 1
                           when 'not_started' then 2 else 3 end,
             t.due_at nulls last, t.name)
    from (
      select
        a.id  as assignment_id,
        f.id  as template_id,
        f.name, f.description,
        a.required,
        coalesce(a.repeat_rule->>'type', 'once') as repeat_type,
        (select count(*)::int from public.checklist_items i where i.template_id = f.id) as item_count,
        private.clf_due_for(a, v_drv.id, current_date) as due_at,
        s.submitted_at,
        case
          when s.status = 'submitted' then 'completed'
          when coalesce(s.status,'') in ('in_progress','reopened')
            or coalesce(s.status,'') = '' then
            case
              when private.clf_due_for(a, v_drv.id, current_date) is not null
               and private.clf_due_for(a, v_drv.id, current_date) < now() then 'overdue'
              when s.id is null then 'not_started'
              else 'in_progress'
            end
        end as status
      from public.checklist_assignments a
      join public.checklist_forms f on f.id = a.template_id and f.status = 'active'
      left join public.checklist_submissions s
        on s.assignment_id = a.id and s.driver_id = v_drv.id
       and coalesce(s.period_key, '0001-01-01'::date)
           = coalesce(private.clf_period_key(a, current_date), '0001-01-01'::date)
      where a.dsp_id = v_drv.dsp_id
        and a.status = 'active'
        and private.clf_assignment_applies(a, v_drv, current_date)
        and private.clf_in_window(a, current_date)
        -- keep completed one-time checklists around for 3 days, then drop
        and not coalesce(
              s.status = 'submitted'
              and coalesce(a.repeat_rule->>'type','once') in ('once','date')
              and s.submitted_at < now() - interval '3 days', false)
    ) t
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.driver_list_checklists(text) to anon, authenticated;


create or replace function public.driver_get_checklist(p_token text, p_assignment_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_a   public.checklist_assignments;
  v_tpl public.checklist_forms;
  v_sub public.checklist_submissions;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_a from public.checklist_assignments
   where id = p_assignment_id and dsp_id = v_drv.dsp_id and status = 'active';
  if v_a.id is null then raise exception 'checklist_not_found' using errcode = 'P0001'; end if;
  select * into v_tpl from public.checklist_forms where id = v_a.template_id and status = 'active';
  if v_tpl.id is null then raise exception 'checklist_not_found' using errcode = 'P0001'; end if;
  if not private.clf_assignment_applies(v_a, v_drv, current_date) then
    raise exception 'checklist_not_found' using errcode = 'P0001';
  end if;

  select * into v_sub from public.checklist_submissions
   where assignment_id = v_a.id and driver_id = v_drv.id
     and coalesce(period_key, '0001-01-01'::date)
         = coalesce(private.clf_period_key(v_a, current_date), '0001-01-01'::date);

  return jsonb_build_object(
    'assignment_id', v_a.id,
    'template_id',   v_tpl.id,
    'name',          v_tpl.name,
    'description',   v_tpl.description,
    'required',      v_a.required,
    'due_at',        private.clf_due_for(v_a, v_drv.id, current_date),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',          i.id,
        'label',       i.label,
        'helper_text', i.helper_text,
        'item_type',   i.item_type,
        'required',    i.required,
        'options',     i.options_json
      ) order by i.sort_order, i.created_at)
      from public.checklist_items i where i.template_id = v_tpl.id
    ), '[]'::jsonb),
    'submission', case when v_sub.id is null then null else jsonb_build_object(
      'id', v_sub.id, 'status', v_sub.status, 'submitted_at', v_sub.submitted_at,
      'reopened_at', v_sub.reopened_at
    ) end,
    'answers', coalesce((
      select jsonb_object_agg(a.item_id::text, jsonb_build_object(
        'v', case
               when a.value_bool is not null then to_jsonb(a.value_bool)
               when a.value_number is not null then to_jsonb(a.value_number)
               else to_jsonb(coalesce(a.value_text, ''))
             end,
        'photos', coalesce(a.photo_urls, '[]'::jsonb),
        'note', a.note,
        'failed', a.failed_flag
      ))
      from public.checklist_answers a where a.submission_id = v_sub.id
    ), '{}'::jsonb)
  );
end;
$$;
grant execute on function public.driver_get_checklist(text, uuid) to anon, authenticated;


notify pgrst, 'reload schema';
