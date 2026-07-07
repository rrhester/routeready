-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0437 · Checklist flag alerts for dispatch
--
-- Flagged answers (checklist_answers.failed_flag — e.g. "brakes OK? No",
-- a number out of range) were computed and stored but never surfaced:
-- dispatch only saw them by opening a specific checklist's Responses tab.
-- This wires them into the staff alerting substrate.
--
-- Staff have no Web Push; the dashboard is notified via Supabase Realtime
-- postgres_changes on tables in the supabase_realtime publication (see
-- 0024). So "alert dispatch" = make checklist_submissions a realtime table
-- and carry the flag count on the row the dashboard already receives.
--
--   1. Denormalize failed_count onto checklist_submissions so the realtime
--      payload (and staff lists) have it without a follow-up query.
--   2. Re-emit private.clf_write_submission (authoritative body from 0436)
--      to stamp failed_count in the same UPDATE that flips 'submitted'.
--   3. Add checklist_submissions to the supabase_realtime publication.
--
-- The dashboard side (a postgres_changes handler on the rr-dashboard
-- channel that toasts on failed_count > 0 and refreshes the open Responses
-- view) ships in dashboard/live.js.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Denormalized flag count ────────────────────────────────────────
alter table public.checklist_submissions
  add column if not exists failed_count int not null default 0;

-- Backfill existing rows from their answers.
update public.checklist_submissions s
   set failed_count = coalesce((
     select count(*) from public.checklist_answers a
      where a.submission_id = s.id and a.failed_flag), 0)
 where s.failed_count is distinct from coalesce((
     select count(*) from public.checklist_answers a
      where a.submission_id = s.id and a.failed_flag), 0);


-- ── 2. Writer stamps failed_count (0436 body + one SET line) ──────────
create or replace function private.clf_write_submission(
  p_drv public.drivers,
  p_assignment_id uuid,
  p_answers jsonb,
  p_submit boolean
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_a    public.checklist_assignments;
  v_tpl  public.checklist_forms;
  v_day  date := private.dsp_today(p_drv.dsp_id);
  v_pk   date;
  v_due  timestamptz;
  v_sub  public.checklist_submissions;
  v_item public.checklist_items;
  v_ans  jsonb;
  v_val  text;
  v_empty boolean;
  v_shift uuid;
begin
  select * into v_a from public.checklist_assignments
   where id = p_assignment_id and dsp_id = p_drv.dsp_id and status = 'active';
  if v_a.id is null then raise exception 'assignment_not_found' using errcode = 'P0001'; end if;

  select * into v_tpl from public.checklist_forms
   where id = v_a.template_id and status = 'active';
  if v_tpl.id is null then raise exception 'checklist_not_active' using errcode = 'P0001'; end if;

  if not private.clf_assignment_applies(v_a, p_drv, v_day) then
    raise exception 'not_assigned' using errcode = 'P0001';
  end if;

  v_pk  := private.clf_period_key(v_a, v_day);
  v_due := private.clf_due_for(v_a, p_drv.id, v_day);

  select * into v_sub from public.checklist_submissions
   where assignment_id = v_a.id and driver_id = p_drv.id
     and coalesce(period_key, '0001-01-01'::date) = coalesce(v_pk, '0001-01-01'::date)
   for update;

  if v_sub.id is not null and v_sub.status = 'submitted' then
    raise exception 'already_submitted' using errcode = 'P0001';
  end if;

  select s.id into v_shift from public.shifts s
   where s.driver_id = p_drv.id and s.date = v_day
     and s.status in ('scheduled','completed')
   order by s.starts_at nulls last limit 1;

  if v_sub.id is null then
    insert into public.checklist_submissions
      (assignment_id, template_id, dsp_id, driver_id, schedule_shift_id, period_key, due_at, status)
    values
      (v_a.id, v_tpl.id, v_a.dsp_id, p_drv.id, v_shift, v_pk, v_due,
       case when p_submit then 'submitted' else 'in_progress' end)
    on conflict (assignment_id, driver_id, coalesce(period_key, '0001-01-01'::date)) do nothing
    returning * into v_sub;

    if v_sub.id is null then
      select * into v_sub from public.checklist_submissions
       where assignment_id = v_a.id and driver_id = p_drv.id
         and coalesce(period_key, '0001-01-01'::date) = coalesce(v_pk, '0001-01-01'::date)
       for update;
      if v_sub.id is not null and v_sub.status = 'submitted' then
        raise exception 'already_submitted' using errcode = 'P0001';
      end if;
    end if;
  end if;

  if p_submit then
    for v_item in
      select * from public.checklist_items
       where template_id = v_tpl.id and required
    loop
      v_ans := p_answers->(v_item.id::text);
      v_val := coalesce(v_ans->>'v', '');
      v_empty := v_ans is null or v_val = '' or lower(v_val) = 'false';
      if v_item.item_type = 'photo' then
        v_empty := v_ans is null or jsonb_array_length(coalesce(v_ans->'photos', '[]'::jsonb)) = 0;
      elsif v_item.item_type = 'note' or v_item.item_type in ('short_text','signature') then
        v_empty := v_ans is null or v_val = '';
      elsif v_item.item_type = 'number' then
        v_empty := v_ans is null or v_val = '';
      elsif v_item.item_type = 'yes_no' then
        v_empty := v_ans is null or lower(v_val) not in ('yes','no');
      end if;
      if v_empty then
        raise exception 'missing_required:%', coalesce(nullif(v_item.label,''), 'Untitled item') using errcode = 'P0001';
      end if;
    end loop;
  end if;

  delete from public.checklist_answers where submission_id = v_sub.id;
  for v_item in
    select * from public.checklist_items where template_id = v_tpl.id
  loop
    v_ans := p_answers->(v_item.id::text);
    if v_ans is null then continue; end if;
    v_val := v_ans->>'v';
    insert into public.checklist_answers
      (submission_id, item_id, dsp_id, value_text, value_bool, value_number, value_json, photo_urls, note, failed_flag)
    values (
      v_sub.id, v_item.id, v_a.dsp_id,
      case when v_item.item_type in ('short_text','note','signature','yes_no') then v_val end,
      case when v_item.item_type = 'checkbox' then lower(coalesce(v_val,'')) in ('true','1','yes') end,
      case when v_item.item_type = 'number' then
        (case when v_val ~ '^-?[0-9]+(\.[0-9]+)?$' then v_val::numeric end) end,
      case when v_ans ? 'json' then v_ans->'json' end,
      case when v_item.item_type = 'photo' then coalesce(v_ans->'photos', '[]'::jsonb) end,
      nullif(v_ans->>'note', ''),
      private.clf_answer_failed(v_item, v_ans)
    );
  end loop;

  update public.checklist_submissions
     set status       = case when p_submit then 'submitted' else
                          case when status = 'reopened' then 'reopened' else 'in_progress' end
                        end,
         submitted_at = case when p_submit then now() else submitted_at end,
         due_at       = coalesce(v_due, due_at),
         failed_count = (select count(*)::int from public.checklist_answers
                          where submission_id = v_sub.id and failed_flag)
   where id = v_sub.id
   returning * into v_sub;

  return jsonb_build_object(
    'id',           v_sub.id,
    'status',       v_sub.status,
    'submitted_at', v_sub.submitted_at,
    'failed_count', v_sub.failed_count
  );
end;
$$;


-- ── 3. Make checklist_submissions a realtime table for the dashboard ──
do $$ begin
  alter publication supabase_realtime add table public.checklist_submissions;
exception when duplicate_object then null; end $$;


notify pgrst, 'reload schema';
