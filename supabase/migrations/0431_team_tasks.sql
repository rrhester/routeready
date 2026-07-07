-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0431 · Team tasks — server-backed My Tasks with assignment
--
-- Promotes the schedule rail's "My Tasks" list from device-local
-- localStorage to a Supabase table so a DSP can assign tasks to the
-- leadership team (dashboard users, role >= dispatcher). Drivers and the
-- driver app are not involved anywhere in this feature.
--
--   * Personal task: assignee = creator (the default). Only the creator
--     sees it (visibility 'private').
--   * Delegated task: the creator assigns another leader. Creator and
--     assignee both see the row — the creator tracks it in the panel's
--     "Delegated" view. visibility 'team' is reserved for a future
--     all-leadership view; nothing writes it yet.
--   * Repeats keep the existing client model: one row per occurrence,
--     all sharing a series_key ("delete whole series" uses it);
--     repeat_label ('daily'|'weekly'|'monthly') is display-only.
--   * meta carries small client hints (e.g. {"kind":"ftpt_convert",
--     "driver_id":"…"}) so contextual creators can dedupe.
--   * Delivery is realtime-only (no email, per operator): the table is
--     in the supabase_realtime publication; the dashboard subscribes
--     per-DSP and pops an in-app notice when an INSERT arrives assigned
--     to the viewer. The RLS select policy is what realtime uses to
--     decide who receives each row's events, so private tasks only ever
--     reach their creator + assignee. (DELETE events carry only the PK
--     and don't pass the dsp filter — the dashboard refetches on panel
--     open instead, so no replica-identity change is needed.)
--   * All writes go through the RPCs below; clients get SELECT only
--     (required for realtime).
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.team_tasks (
  id               uuid primary key default gen_random_uuid(),
  dsp_id           uuid not null references public.dsps(id) on delete cascade,
  title            text not null,
  due_date         date,
  status           text not null default 'open'
                   check (status in ('open','done')),
  visibility       text not null default 'private'
                   check (visibility in ('private','team')),
  assignee_user_id uuid references auth.users(id) on delete set null,
  created_by       uuid references auth.users(id) on delete set null,
  series_key       text,
  repeat_label     text,
  meta             jsonb not null default '{}'::jsonb,
  completed_at     timestamptz,
  completed_by     uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists team_tasks_dsp_idx
  on public.team_tasks (dsp_id, status, due_date);
create index if not exists team_tasks_assignee_idx
  on public.team_tasks (assignee_user_id) where status = 'open';
create index if not exists team_tasks_series_idx
  on public.team_tasks (dsp_id, series_key) where series_key is not null;

alter table public.team_tasks enable row level security;

-- Visible to same-DSP leadership who created the task or are assigned it
-- (or, later, rows marked team-visible). Realtime evaluates this per
-- subscriber, so it is also the event-delivery gate.
drop policy if exists team_tasks_select on public.team_tasks;
create policy team_tasks_select on public.team_tasks
  for select to authenticated
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
    and (created_by = auth.uid()
         or assignee_user_id = auth.uid()
         or visibility = 'team')
  );
grant select on public.team_tasks to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.team_tasks;
exception when duplicate_object then null; end $$;


-- ── Row → JSON shape shared by every RPC ──────────────────────────────
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
    'created_at',       t.created_at
  );
$$;


-- ── RPC · list my tasks ────────────────────────────────────────────────
-- Everything I created or am assigned (done tasks age out after 30 days
-- so the panel stays light).
create or replace function public.team_tasks_list()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(private.team_task_json(t) order by t.created_at), '[]'::jsonb)
    into v_out
  from public.team_tasks t
  where t.dsp_id = v_dsp
    and (t.created_by = auth.uid() or t.assignee_user_id = auth.uid() or t.visibility = 'team')
    and (t.status = 'open' or coalesce(t.completed_at, t.updated_at) > now() - interval '30 days');
  return v_out;
end;
$$;
grant execute on function public.team_tasks_list() to authenticated;


-- ── RPC · leadership picker for "Assign to" ────────────────────────────
create or replace function public.team_task_members()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id,
           'name', coalesce(nullif(u.full_name, ''), u.email),
           'email', u.email,
           'role', u.role)
           order by coalesce(nullif(u.full_name, ''), u.email)), '[]'::jsonb)
    into v_out
  from public.app_users u
  where u.dsp_id = v_dsp and u.active = true
    and u.role >= 'dispatcher'::public.app_role;
  return v_out;
end;
$$;
grant execute on function public.team_task_members() to authenticated;


-- ── RPC · create a task (or a batch of recurring occurrences) ──────────
-- p_dues, when provided, creates one row per date, all sharing a series
-- key (capped at 60 like the client's occurrence cap). Assigning to
-- someone else requires them to be active same-DSP leadership.
create or replace function public.team_task_create(
  p_title text,
  p_due date default null,
  p_assignee_user_id uuid default null,
  p_series text default null,
  p_repeat text default null,
  p_meta jsonb default null,
  p_dues date[] default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp      uuid := private.current_dsp_id();
  v_me       uuid := auth.uid();
  v_title    text := left(nullif(trim(coalesce(p_title, '')), ''), 200);
  v_assignee uuid := coalesce(p_assignee_user_id, auth.uid());
  v_series   text;
  v_ids      uuid[];
  v_row      public.team_tasks;
  v_out      jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_title is null then raise exception 'title_required' using errcode = '22023'; end if;
  if v_assignee <> v_me and not exists (
      select 1 from public.app_users u
      where u.id = v_assignee and u.dsp_id = v_dsp and u.active = true
        and u.role >= 'dispatcher'::public.app_role) then
    raise exception 'bad_assignee' using errcode = '22023';
  end if;

  if p_dues is not null and coalesce(array_length(p_dues, 1), 0) > 0 then
    v_series := coalesce(nullif(trim(coalesce(p_series, '')), ''), 's' || replace(gen_random_uuid()::text, '-', ''));
    with ins as (
      insert into public.team_tasks
          (dsp_id, title, due_date, assignee_user_id, created_by, series_key, repeat_label, meta)
      select v_dsp, v_title, d, v_assignee, v_me, v_series,
             nullif(trim(coalesce(p_repeat, '')), ''), coalesce(p_meta, '{}'::jsonb)
      from unnest(p_dues[1:60]) as d
      returning id
    )
    select array_agg(id) into v_ids from ins;
    select jsonb_agg(private.team_task_json(t) order by t.due_date, t.created_at) into v_out
      from public.team_tasks t where t.id = any(v_ids);
  else
    insert into public.team_tasks
        (dsp_id, title, due_date, assignee_user_id, created_by, series_key, repeat_label, meta)
      values
        (v_dsp, v_title, p_due, v_assignee, v_me,
         nullif(trim(coalesce(p_series, '')), ''),
         nullif(trim(coalesce(p_repeat, '')), ''),
         coalesce(p_meta, '{}'::jsonb))
      returning * into v_row;
    v_out := jsonb_build_array(private.team_task_json(v_row));
  end if;

  return coalesce(v_out, '[]'::jsonb);
end;
$$;
grant execute on function public.team_task_create(text, date, uuid, text, text, jsonb, date[]) to authenticated;


-- ── RPC · toggle open/done ─────────────────────────────────────────────
-- Creator or assignee only.
create or replace function public.team_task_toggle(p_id uuid)
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
      status       = case when status = 'open' then 'done' else 'open' end,
      completed_at = case when status = 'open' then now() else null end,
      completed_by = case when status = 'open' then auth.uid() else null end,
      updated_at   = now()
    where id = v_row.id
    returning * into v_row;
  return private.team_task_json(v_row);
end;
$$;
grant execute on function public.team_task_toggle(uuid) to authenticated;


-- ── RPC · delete a task (optionally its whole repeat series) ───────────
-- Creator only — an assignee completes a delegated task, they don't
-- delete it.
create or replace function public.team_task_delete(p_id uuid, p_series boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_row   public.team_tasks;
  v_count int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from public.team_tasks where id = p_id and dsp_id = v_dsp;
  if v_row.id is null then return jsonb_build_object('deleted', 0); end if;
  if v_row.created_by is distinct from auth.uid() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_series and v_row.series_key is not null then
    delete from public.team_tasks
      where dsp_id = v_dsp and series_key = v_row.series_key and created_by = auth.uid();
  else
    delete from public.team_tasks where id = v_row.id;
  end if;
  get diagnostics v_count = row_count;
  return jsonb_build_object('deleted', v_count);
end;
$$;
grant execute on function public.team_task_delete(uuid, boolean) to authenticated;


-- ── RPC · one-time import of the device-local list ─────────────────────
-- The dashboard calls this once per browser (flagged in localStorage)
-- with the old localStorage array, then clears it. Everything imports as
-- a private self-task, preserving done state, series, and creation time.
create or replace function public.team_tasks_import(p_tasks jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_me  uuid := auth.uid();
  v_ids uuid[];
  v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_tasks is null or jsonb_typeof(p_tasks) <> 'array' then return '[]'::jsonb; end if;

  with src as (
    select x.*
    from jsonb_to_recordset(p_tasks)
         as x(title text, due text, done boolean, ts bigint,
              series text, "repeat" text, kind text, driver_id text)
    where nullif(trim(coalesce(x.title, '')), '') is not null
    limit 200
  ), ins as (
    insert into public.team_tasks
        (dsp_id, title, due_date, status, assignee_user_id, created_by,
         series_key, repeat_label, meta, completed_at, created_at)
    select v_dsp,
           left(trim(src.title), 200),
           case when src.due ~ '^\d{4}-\d{2}-\d{2}$' then src.due::date end,
           case when coalesce(src.done, false) then 'done' else 'open' end,
           v_me, v_me,
           nullif(trim(coalesce(src.series, '')), ''),
           nullif(trim(coalesce(src."repeat", '')), ''),
           jsonb_strip_nulls(jsonb_build_object('kind', src.kind, 'driver_id', src.driver_id)),
           case when coalesce(src.done, false) then now() end,
           coalesce(to_timestamp(src.ts / 1000.0), now())
    from src
    returning id
  )
  select array_agg(id) into v_ids from ins;
  select coalesce(jsonb_agg(private.team_task_json(t) order by t.created_at), '[]'::jsonb)
    into v_out
  from public.team_tasks t where t.id = any(v_ids);
  return v_out;
end;
$$;
grant execute on function public.team_tasks_import(jsonb) to authenticated;


notify pgrst, 'reload schema';
