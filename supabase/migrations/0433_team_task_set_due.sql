-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0433 · Team tasks — reschedule from the calendar
--
-- The operations calendar now renders open team tasks as all-day chips
-- on their due date, draggable to another day. This RPC is the drop
-- handler's write path: change a task's due date. Creator or assignee
-- only (same rule as team_task_toggle). Passing null clears the date.
-- Idempotent (create or replace); companion to 0432_team_tasks.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.team_task_set_due(p_id uuid, p_due date)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.team_tasks;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from public.team_tasks where id = p_id and dsp_id = v_dsp;
  if v_row.id is null then raise exception 'not_found' using errcode = '22023'; end if;
  if (v_row.created_by = auth.uid() or v_row.assignee_user_id = auth.uid()) is not true then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.team_tasks set
      due_date   = p_due,
      updated_at = now()
    where id = v_row.id
    returning * into v_row;
  return private.team_task_json(v_row);
end;
$$;
grant execute on function public.team_task_set_due(uuid, date) to authenticated;

notify pgrst, 'reload schema';
