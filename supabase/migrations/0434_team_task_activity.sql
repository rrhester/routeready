-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0434 · Team tasks — accountability layer (acknowledge,
-- comments, activity trail)
--
-- Phase 2 of team tasks (0432 data + assignment, 0433 calendar
-- reschedule). Adds the pieces that make delegation trustworthy for the
-- owner:
--
--   * Acknowledge — the assignee taps "Got it" on a delegated task so
--     the creator knows the hand-off landed. Two columns on team_tasks
--     (acknowledged_at / acknowledged_by).
--   * Activity trail — an append-only public.team_task_events log:
--     created, assigned, due_changed, completed, reopened, acknowledged
--     are written AUTOMATICALLY by a trigger on team_tasks (so the
--     0432/0433 RPCs need no edits), and comments are written by the
--     RPC below.
--   * Comments — a per-task discussion thread ("what's the status on
--     this?") without leaving the app.
--
-- Delivery stays realtime-only, no email: team_task_events joins the
-- supabase_realtime publication so the creator's dashboard can toast on
-- a fresh acknowledge / comment. RLS mirrors team_tasks — an event is
-- visible to whoever can see its parent task. Idempotent throughout.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.team_tasks add column if not exists acknowledged_at timestamptz;
alter table public.team_tasks add column if not exists acknowledged_by uuid references auth.users(id) on delete set null;


-- ── Activity / comment log ─────────────────────────────────────────────
create table if not exists public.team_task_events (
  id            bigint generated always as identity primary key,
  task_id       uuid not null references public.team_tasks(id) on delete cascade,
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  kind          text not null
                check (kind in ('created','assigned','due_changed','completed',
                                'reopened','acknowledged','comment')),
  actor_user_id uuid references auth.users(id) on delete set null,
  body          text,
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists team_task_events_task_idx
  on public.team_task_events (task_id, created_at);

alter table public.team_task_events enable row level security;

-- Visible to whoever can see the parent task (creator or assignee, same
-- DSP + leadership). Realtime evaluates this per subscriber, so the log
-- only ever reaches a task's participants.
drop policy if exists team_task_events_select on public.team_task_events;
create policy team_task_events_select on public.team_task_events
  for select to authenticated
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
    and exists (
      select 1 from public.team_tasks t
      where t.id = team_task_events.task_id
        and (t.created_by = auth.uid()
             or t.assignee_user_id = auth.uid()
             or t.visibility = 'team')
    )
  );
grant select on public.team_task_events to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.team_task_events;
exception when duplicate_object then null; end $$;


-- ── Trigger · auto-log lifecycle events ────────────────────────────────
-- auth.uid() is the calling user even inside SECURITY DEFINER RPCs
-- (definer changes privileges, not the JWT), so the actor is always the
-- person who took the action.
create or replace function private.team_task_activity()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.team_task_events (task_id, dsp_id, kind, actor_user_id)
      values (new.id, new.dsp_id, 'created', v_actor);
    if new.assignee_user_id is not null and new.assignee_user_id <> new.created_by then
      insert into public.team_task_events (task_id, dsp_id, kind, actor_user_id, meta)
        values (new.id, new.dsp_id, 'assigned', v_actor,
                jsonb_build_object('to', new.assignee_user_id));
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      insert into public.team_task_events (task_id, dsp_id, kind, actor_user_id)
        values (new.id, new.dsp_id,
                case when new.status = 'done' then 'completed' else 'reopened' end, v_actor);
    end if;
    if new.due_date is distinct from old.due_date then
      insert into public.team_task_events (task_id, dsp_id, kind, actor_user_id, meta)
        values (new.id, new.dsp_id, 'due_changed', v_actor,
                jsonb_build_object('from', old.due_date, 'to', new.due_date));
    end if;
    if new.acknowledged_at is distinct from old.acknowledged_at and new.acknowledged_at is not null then
      insert into public.team_task_events (task_id, dsp_id, kind, actor_user_id)
        values (new.id, new.dsp_id, 'acknowledged', v_actor);
    end if;
    if new.assignee_user_id is distinct from old.assignee_user_id
       and new.assignee_user_id is not null
       and new.assignee_user_id <> new.created_by then
      insert into public.team_task_events (task_id, dsp_id, kind, actor_user_id, meta)
        values (new.id, new.dsp_id, 'assigned', v_actor,
                jsonb_build_object('to', new.assignee_user_id));
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists team_task_activity_trg on public.team_tasks;
create trigger team_task_activity_trg
  after insert or update on public.team_tasks
  for each row execute function private.team_task_activity();


-- ── team_task_json gains the acknowledge fields ────────────────────────
create or replace function private.team_task_json(t public.team_tasks)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id',               t.id,
    'title',            t.title,
    'due_date',          t.due_date,
    'status',           t.status,
    'visibility',       t.visibility,
    'assignee_user_id', t.assignee_user_id,
    'assignee_name',    (select coalesce(nullif(u.full_name, ''), u.email)
                           from public.app_users u where u.id = t.assignee_user_id),
    'created_by',       t.created_by,
    'creator_name',     (select coalesce(nullif(u.full_name, ''), u.email)
                           from public.app_users u where u.id = t.created_by),
    'series_key',       t.series_key,
    'repeat_label',     t.repeat_label,
    'meta',             t.meta,
    'completed_at',     t.completed_at,
    'acknowledged_at',  t.acknowledged_at,
    'acknowledged_by',  t.acknowledged_by,
    'acknowledged_name',(select coalesce(nullif(u.full_name, ''), u.email)
                           from public.app_users u where u.id = t.acknowledged_by),
    'created_at',       t.created_at
  );
$$;


-- ── RPC · acknowledge a delegated task ─────────────────────────────────
-- Assignee only, and only when it's actually delegated to them (a
-- self-task has nothing to acknowledge). No-op if already acknowledged.
create or replace function public.team_task_ack(p_id uuid)
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
  if v_row.assignee_user_id is distinct from auth.uid()
     or v_row.assignee_user_id = v_row.created_by then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_row.acknowledged_at is null then
    update public.team_tasks set
        acknowledged_at = now(), acknowledged_by = auth.uid(), updated_at = now()
      where id = v_row.id
      returning * into v_row;
  end if;
  return private.team_task_json(v_row);
end;
$$;
grant execute on function public.team_task_ack(uuid) to authenticated;


-- ── RPC · add a comment ────────────────────────────────────────────────
-- Creator or assignee only. Returns the new event row (with actor name).
create or replace function public.team_task_comment(p_id uuid, p_body text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_row  public.team_tasks;
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_ev   public.team_task_events;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_body is null then raise exception 'empty_comment' using errcode = '22023'; end if;
  select * into v_row from public.team_tasks where id = p_id and dsp_id = v_dsp;
  if v_row.id is null then raise exception 'not_found' using errcode = '22023'; end if;
  if (v_row.created_by = auth.uid() or v_row.assignee_user_id = auth.uid()) is not true then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.team_task_events (task_id, dsp_id, kind, actor_user_id, body)
    values (v_row.id, v_dsp, 'comment', auth.uid(), left(v_body, 2000))
    returning * into v_ev;

  return jsonb_build_object(
    'id', v_ev.id, 'task_id', v_ev.task_id, 'kind', v_ev.kind,
    'actor_user_id', v_ev.actor_user_id,
    'actor_name', (select coalesce(nullif(u.full_name, ''), u.email)
                     from public.app_users u where u.id = v_ev.actor_user_id),
    'body', v_ev.body, 'meta', v_ev.meta, 'created_at', v_ev.created_at);
end;
$$;
grant execute on function public.team_task_comment(uuid, text) to authenticated;


-- ── RPC · the task's thread (activity + comments) ──────────────────────
-- Returns { task, events:[…] }. Events carry the actor name and, for
-- 'assigned', the target's name; ordered oldest → newest for the panel.
create or replace function public.team_task_thread(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_row   public.team_tasks;
  v_events jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from public.team_tasks where id = p_id and dsp_id = v_dsp;
  if v_row.id is null then raise exception 'not_found' using errcode = '22023'; end if;
  if (v_row.created_by = auth.uid() or v_row.assignee_user_id = auth.uid() or v_row.visibility = 'team') is not true then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'kind', e.kind,
           'actor_user_id', e.actor_user_id,
           'actor_name', (select coalesce(nullif(au.full_name, ''), au.email)
                            from public.app_users au where au.id = e.actor_user_id),
           'body', e.body, 'meta', e.meta,
           'to_name', case when e.kind = 'assigned'
                           then (select coalesce(nullif(tu.full_name, ''), tu.email)
                                   from public.app_users tu
                                   where tu.id = nullif(e.meta->>'to', '')::uuid)
                           else null end,
           'created_at', e.created_at)
           order by e.created_at, e.id), '[]'::jsonb)
    into v_events
  from public.team_task_events e
  where e.task_id = v_row.id;

  return jsonb_build_object('task', private.team_task_json(v_row), 'events', v_events);
end;
$$;
grant execute on function public.team_task_thread(uuid) to authenticated;


notify pgrst, 'reload schema';
