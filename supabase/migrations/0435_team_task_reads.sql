-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0435 · Team tasks — unread comment tracking
--
-- Comments (0434) only surfaced as a transient realtime toast: miss it
-- and nothing flagged the task afterward. This adds a persistent unread
-- indicator so the Delegated view works like an inbox.
--
--   * team_task_reads — one row per (user, task) recording when that
--     user last viewed the task's thread. Written only by the RPCs
--     below (opening the detail modal, or posting a comment).
--   * team_tasks_list now returns, per task: comment_count,
--     last_comment_at, last_comment_by, and my_read_at. The dashboard
--     marks a task unread when the newest comment is by someone else and
--     is newer than my_read_at — then clears it the moment I open the
--     task.
--
-- Backward compatible: the new list fields are additive (a pre-0435
-- client ignores them), and everything is idempotent.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.team_task_reads (
  user_id      uuid not null references auth.users(id) on delete cascade,
  task_id      uuid not null references public.team_tasks(id) on delete cascade,
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (user_id, task_id)
);
create index if not exists team_task_reads_task_idx on public.team_task_reads (task_id);

alter table public.team_task_reads enable row level security;

-- A user only ever sees their own read markers. Writes go through the
-- SECURITY DEFINER RPCs (no direct client insert/update needed).
drop policy if exists team_task_reads_self on public.team_task_reads;
create policy team_task_reads_self on public.team_task_reads
  for select to authenticated using (user_id = auth.uid());
grant select on public.team_task_reads to authenticated;


-- ── Internal · stamp my read marker for a task ─────────────────────────
create or replace function private.team_task_touch_read(p_task uuid, p_dsp uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.team_task_reads (user_id, task_id, dsp_id, last_read_at)
  values (auth.uid(), p_task, p_dsp, now())
  on conflict (user_id, task_id) do update set last_read_at = now();
$$;


-- ── RPC · mark a task's thread read (detail modal open) ────────────────
create or replace function public.team_task_mark_read(p_id uuid)
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
  if (v_row.created_by = auth.uid() or v_row.assignee_user_id = auth.uid() or v_row.visibility = 'team') is not true then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.team_task_touch_read(v_row.id, v_dsp);
  return jsonb_build_object('task_id', v_row.id, 'read_at', now());
end;
$$;
grant execute on function public.team_task_mark_read(uuid) to authenticated;


-- ── team_tasks_list gains per-task comment + read metadata ─────────────
create or replace function public.team_tasks_list()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(
           private.team_task_json(t) || jsonb_build_object(
             'comment_count',   (select count(*) from public.team_task_events e
                                    where e.task_id = t.id and e.kind = 'comment'),
             'last_comment_at',  (select max(e.created_at) from public.team_task_events e
                                    where e.task_id = t.id and e.kind = 'comment'),
             'last_comment_by',  (select e.actor_user_id from public.team_task_events e
                                    where e.task_id = t.id and e.kind = 'comment'
                                    order by e.created_at desc, e.id desc limit 1),
             'my_read_at',       (select r.last_read_at from public.team_task_reads r
                                    where r.task_id = t.id and r.user_id = auth.uid())
           ) order by t.created_at), '[]'::jsonb)
    into v_out
  from public.team_tasks t
  where t.dsp_id = v_dsp
    and (t.created_by = auth.uid() or t.assignee_user_id = auth.uid() or t.visibility = 'team')
    and (t.status = 'open' or coalesce(t.completed_at, t.updated_at) > now() - interval '30 days');
  return v_out;
end;
$$;
grant execute on function public.team_tasks_list() to authenticated;


-- ── team_task_comment also stamps the commenter's read marker ──────────
-- (posting a comment means you've seen the thread up to now, so your own
-- message never lights up your own unread badge.)
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

  perform private.team_task_touch_read(v_row.id, v_dsp);

  return jsonb_build_object(
    'id', v_ev.id, 'task_id', v_ev.task_id, 'kind', v_ev.kind,
    'actor_user_id', v_ev.actor_user_id,
    'actor_name', (select coalesce(nullif(u.full_name, ''), u.email)
                     from public.app_users u where u.id = v_ev.actor_user_id),
    'body', v_ev.body, 'meta', v_ev.meta, 'created_at', v_ev.created_at);
end;
$$;
grant execute on function public.team_task_comment(uuid, text) to authenticated;


notify pgrst, 'reload schema';
