-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0428 · Contextual quick tasks
--
-- Powers the subtle "Add task" links on warning surfaces (compliance
-- exceptions, callout exposure, driver risk, expiring credentials, …).
-- A quick task is an ordinary checklist_instance with no template and a
-- single required item, so it rides the existing Checklists UI end to
-- end: it shows up in "All checklists" and the "Today's status"
-- overdue / due-today buckets, and completes through the normal runner
-- (checking the one required item flips the instance to 'completed' via
-- private.checklist_instance_reconcile).
--
-- New columns on checklist_instances:
--   * source_key   dedupe key for the originating warning
--                  (e.g. 'dl:<driver_id>') — one OPEN task per source.
--   * category     display category ('Driver Coaching', 'Fleet', …).
--   * entity_type / entity_id
--                  optional structured link back to the driver / vehicle /
--                  applicant the task is about (deep links also ride in
--                  the item instructions, so these are for future
--                  filtering, not required for v1 UI).
--   * origin       'manual' (launched from a template) vs 'contextual'
--                  (created from a warning surface).
-- ─────────────────────────────────────────────────────────────────────────

alter table public.checklist_instances add column if not exists source_key  text;
alter table public.checklist_instances add column if not exists category    text;
alter table public.checklist_instances add column if not exists entity_type text;
alter table public.checklist_instances add column if not exists entity_id   uuid;
alter table public.checklist_instances add column if not exists origin      text not null default 'manual';

create index if not exists checklist_instances_source_idx
  on public.checklist_instances (dsp_id, source_key)
  where source_key is not null and status = 'active';


-- ── RPC · create a contextual quick task ──────────────────────────────
-- Returns {existing:false, id, name, due_at} on create, or
-- {existing:true, id, name, due_at} when an open task with the same
-- source_key already exists (the UI shows "Task already open" instead
-- of double-creating).
create or replace function public.checklist_task_create(
  p_title text,
  p_description text default null,
  p_category text default null,
  p_due_at timestamptz default null,
  p_assigned_user_id uuid default null,
  p_source_key text default null,
  p_entity_type text default null,
  p_entity_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_title text := nullif(trim(coalesce(p_title, '')), '');
  v_key   text := nullif(trim(coalesce(p_source_key, '')), '');
  v_existing public.checklist_instances;
  v_inst     public.checklist_instances;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_title is null then raise exception 'title_required' using errcode = '22023'; end if;

  if v_key is not null then
    select * into v_existing
      from public.checklist_instances
     where dsp_id = v_dsp and source_key = v_key and status = 'active'
     order by created_at desc
     limit 1;
    if v_existing.id is not null then
      return jsonb_build_object('existing', true, 'id', v_existing.id,
                                'name', v_existing.name, 'due_at', v_existing.due_at);
    end if;
  end if;

  insert into public.checklist_instances
      (dsp_id, template_id, name, assigned_user_id, due_at, created_by,
       source_key, category, entity_type, entity_id, origin)
    values
      (v_dsp, null, v_title, p_assigned_user_id, p_due_at, auth.uid(),
       v_key,
       nullif(trim(coalesce(p_category, '')), ''),
       nullif(trim(coalesce(p_entity_type, '')), ''),
       p_entity_id,
       'contextual')
    returning * into v_inst;

  -- One required item so the task completes through the normal runner.
  insert into public.checklist_instance_items
      (instance_id, dsp_id, section_label, label, instructions, required, position)
    values
      (v_inst.id, v_dsp, null, v_title,
       nullif(trim(coalesce(p_description, '')), ''), true, 0);

  return jsonb_build_object('existing', false, 'id', v_inst.id,
                            'name', v_inst.name, 'due_at', v_inst.due_at);
end;
$$;
grant execute on function public.checklist_task_create(text, text, text, timestamptz, uuid, text, text, uuid) to authenticated;


-- ── RPC · look up the open task for a source_key ──────────────────────
-- Lets the composer show "Task already open · View" before creating.
-- Returns null (jsonb) when no open task matches.
create or replace function public.checklist_task_open_for_source(p_source_key text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object(
           'id', i.id, 'name', i.name, 'due_at', i.due_at,
           'assigned_email', (select email from auth.users where id = i.assigned_user_id))
    into v_out
  from public.checklist_instances i
  where i.dsp_id = v_dsp
    and i.source_key = nullif(trim(coalesce(p_source_key, '')), '')
    and i.status = 'active'
  order by i.created_at desc
  limit 1;
  return coalesce(v_out, 'null'::jsonb);
end;
$$;
grant execute on function public.checklist_task_open_for_source(text) to authenticated;


notify pgrst, 'reload schema';
