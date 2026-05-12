-- Migration 0182 · Operational Assignments — data layer
--
-- Lightweight, spreadsheet-*like* operational boards for DSP ops:
-- devices, batteries, chargers, uniforms, fuel cards, keys, van issues,
-- recovery actions, safety follow-ups, etc.  A board has a freeform
-- column schema (the operator adds/renames/removes columns); each row
-- is one operational item.  Rows carry a freeform `data` jsonb keyed by
-- column id, plus first-class mirror columns (assigned driver, status,
-- due date, completion) that later slices use to (a) link the item to
-- the driver profile, (b) push it into the driver app, (c) record the
-- acknowledgement + completion history.  An append-only audit trail
-- (`assignment_audit`) captures every board / row change and assignment
-- — the accountability record.
--
-- This migration is the data layer only:
--   • assignment_boards / assignment_rows / assignment_audit + RLS
--   • staff-side RPCs: board CRUD, row upsert/delete/reorder, templates
-- The board UI (dashboard), the driver-app task surface, and the
-- assign→task→push→acknowledge loop land in later slices.  The schema
-- already carries the columns those slices need so they need no further
-- migration.

-- ─────────────────────────────────────────────────────────────────────
--  Tables
-- ─────────────────────────────────────────────────────────────────────

-- A board.  `columns` is the freeform schema:
--   [ { "id":"c1", "name":"Item", "type":"text", "width":220 },
--     { "id":"c2", "name":"Status", "type":"status", "width":140,
--       "options":["Open","Assigned","In progress","Done"], "role":"status" },
--     { "id":"c3", "name":"Assigned to", "type":"driver", "width":170, "role":"assignee" },
--     { "id":"c4", "name":"Due", "type":"date", "width":120, "role":"due" },
--     { "id":"c5", "name":"Note", "type":"note", "width":280 } ]
-- column.type ∈ text | status | driver | date | number | note | tag | attachment
-- column.role ∈ status | due | assignee  (optional hint → the first-class mirror columns)
create table if not exists public.assignment_boards (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  name        text not null,
  icon        text,                                   -- icon/color key: devices | equipment | safety | recovery | uniforms | vehicle | compliance | generic
  columns     jsonb not null default '[]'::jsonb,
  position    int not null default 0,                 -- order in the board picker
  archived_at timestamptz,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists assignment_boards_dsp_idx on public.assignment_boards (dsp_id, archived_at, position);

-- A row = one operational item.  `data` holds every freeform cell value
-- keyed by column id; the mirror columns below are derived from the
-- columns flagged role=assignee|status|due so the row stays query-able
-- (and so the driver-loop slice can FK to the driver + push the task).
create table if not exists public.assignment_rows (
  id                    uuid primary key default gen_random_uuid(),
  board_id              uuid not null references public.assignment_boards(id) on delete cascade,
  dsp_id                uuid not null references public.dsps(id) on delete cascade,   -- denormalized for RLS
  data                  jsonb not null default '{}'::jsonb,
  position              int not null default 0,
  -- first-class mirrors (derived from `data` + the board's column roles)
  assigned_driver_id    uuid references public.drivers(id) on delete set null,
  status                text,
  due_date              date,
  -- completion (set by a later slice when the driver — or staff — marks it done)
  completed_at          timestamptz,
  completion_note       text,
  completion_photo_path text,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists assignment_rows_board_idx  on public.assignment_rows (board_id, position);
create index if not exists assignment_rows_driver_idx on public.assignment_rows (assigned_driver_id) where assigned_driver_id is not null;

-- Append-only accountability trail: board created/updated/archived, row
-- added/updated/deleted, and — the moments that matter — assigned /
-- unassigned / completed / reopened.  Written only by the RPCs (and the
-- driver-loop RPCs in a later slice); never edited by clients.
create table if not exists public.assignment_audit (
  id              bigint generated always as identity primary key,
  board_id        uuid not null references public.assignment_boards(id) on delete cascade,
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  row_id          uuid references public.assignment_rows(id) on delete set null,   -- null for board-level events
  event           text not null,             -- board_created | board_updated | board_archived | board_unarchived | row_added | row_updated | row_deleted | assigned | unassigned | completed | reopened
  actor_kind      text not null default 'user',   -- user | driver | system
  actor_user_id   uuid references auth.users(id) on delete set null,
  actor_driver_id uuid references public.drivers(id) on delete set null,
  actor_name      text,
  event_data      jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists assignment_audit_board_idx on public.assignment_audit (board_id, id);
create index if not exists assignment_audit_row_idx   on public.assignment_audit (row_id, id) where row_id is not null;

-- ─────────────────────────────────────────────────────────────────────
--  RLS — dispatchers (and up) of the owning DSP
-- ─────────────────────────────────────────────────────────────────────
alter table public.assignment_boards enable row level security;
alter table public.assignment_rows   enable row level security;
alter table public.assignment_audit  enable row level security;

create policy "assignment_boards_rw" on public.assignment_boards
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

create policy "assignment_rows_rw" on public.assignment_rows
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

-- Audit is read-only to clients (an audit log); the RPCs (security
-- definer) do the inserts.  No insert/update/delete policy.
create policy "assignment_audit_select" on public.assignment_audit
  for select using (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

grant select, insert, update, delete on public.assignment_boards to authenticated;
grant select, insert, update, delete on public.assignment_rows   to authenticated;
grant select                          on public.assignment_audit  to authenticated;

-- ─────────────────────────────────────────────────────────────────────
--  Helpers (private)
-- ─────────────────────────────────────────────────────────────────────

-- Append an audit event.  Staff actor by default; the driver-loop slice
-- passes p_actor_kind => 'driver' with p_actor_driver_id.
create or replace function private.assignment_log(
  p_board uuid, p_dsp uuid, p_event text,
  p_row uuid default null, p_data jsonb default '{}'::jsonb,
  p_actor_kind text default 'user', p_actor_driver_id uuid default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_name text; v_uid uuid := auth.uid();
begin
  if p_actor_kind = 'user' and v_uid is not null then
    begin select coalesce(nullif(trim(full_name), ''), email) into v_name from public.app_users where id = v_uid; exception when others then v_name := null; end;
  elsif p_actor_kind = 'driver' and p_actor_driver_id is not null then
    begin select coalesce(nullif(trim(full_name), ''), nullif(trim(preferred_name), '')) into v_name from public.drivers where id = p_actor_driver_id; exception when others then v_name := null; end;
  end if;
  insert into public.assignment_audit (board_id, dsp_id, row_id, event, actor_kind, actor_user_id, actor_driver_id, actor_name, event_data)
  values (p_board, p_dsp, p_row, p_event, p_actor_kind,
          case when p_actor_kind = 'user' then v_uid end,
          case when p_actor_kind = 'driver' then p_actor_driver_id end,
          v_name, coalesce(p_data, '{}'::jsonb));
end;
$$;

-- The id of the column carrying a given role (role= hint first, then the
-- first column of the matching type as a fallback).
create or replace function private.assignment_role_col(p_columns jsonb, p_role text, p_fallback_type text)
returns text
language sql immutable set search_path = ''
as $$
  select coalesce(
    (select c->>'id' from jsonb_array_elements(coalesce(p_columns, '[]'::jsonb)) c where c->>'role' = p_role limit 1),
    (select c->>'id' from jsonb_array_elements(coalesce(p_columns, '[]'::jsonb)) c where c->>'type' = p_fallback_type limit 1)
  );
$$;

-- Seed board templates — one-click starting points.  Columns only; the
-- operator adds rows.  Keys are stable; names/columns can evolve.
create or replace function private.assignment_templates()
returns jsonb
language sql immutable set search_path = ''
as $$
  select $j$[
    { "key":"device_tracking", "name":"Device Tracking", "icon":"devices",
      "columns":[
        {"id":"item","name":"Device","type":"text","width":220},
        {"id":"kind","name":"Type","type":"status","width":150,"options":["Phone","Rabbit","Charger","Battery","Key","Fuel card"]},
        {"id":"assignee","name":"Assigned to","type":"driver","width":170,"role":"assignee"},
        {"id":"issued","name":"Issued","type":"date","width":120},
        {"id":"status","name":"Status","type":"status","width":150,"options":["Issued","In use","Returned","Lost","Damaged"],"role":"status"},
        {"id":"note","name":"Note","type":"note","width":280}
      ] },
    { "key":"missing_equipment", "name":"Missing Equipment Tracker", "icon":"equipment",
      "columns":[
        {"id":"item","name":"Item","type":"text","width":220},
        {"id":"status","name":"Status","type":"status","width":160,"options":["Reported missing","Searching","Located","Recovered","Written off"],"role":"status"},
        {"id":"assignee","name":"Owner / last had it","type":"driver","width":190,"role":"assignee"},
        {"id":"due","name":"Resolve by","type":"date","width":120,"role":"due"},
        {"id":"note","name":"Details","type":"note","width":300}
      ] },
    { "key":"recovery_actions", "name":"Driver Recovery Actions", "icon":"recovery",
      "columns":[
        {"id":"item","name":"Action","type":"text","width":260},
        {"id":"assignee","name":"Driver","type":"driver","width":170,"role":"assignee"},
        {"id":"status","name":"Status","type":"status","width":150,"options":["Open","In progress","Done","Waived"],"role":"status"},
        {"id":"due","name":"Due","type":"date","width":120,"role":"due"},
        {"id":"note","name":"Note","type":"note","width":300}
      ] },
    { "key":"van_damage", "name":"Van Damage Assignments", "icon":"vehicle",
      "columns":[
        {"id":"van","name":"Van","type":"text","width":120},
        {"id":"item","name":"Damage / issue","type":"text","width":260},
        {"id":"assignee","name":"Driver responsible","type":"driver","width":180,"role":"assignee"},
        {"id":"status","name":"Status","type":"status","width":160,"options":["Reported","Reviewing","Repair scheduled","Resolved","No fault"],"role":"status"},
        {"id":"due","name":"Follow up by","type":"date","width":130,"role":"due"},
        {"id":"note","name":"Note","type":"note","width":280}
      ] },
    { "key":"safety_followups", "name":"Safety Follow-Ups", "icon":"safety",
      "columns":[
        {"id":"item","name":"Follow-up","type":"text","width":260},
        {"id":"assignee","name":"Driver","type":"driver","width":170,"role":"assignee"},
        {"id":"status","name":"Status","type":"status","width":150,"options":["Open","In progress","Closed"],"role":"status"},
        {"id":"due","name":"Due","type":"date","width":120,"role":"due"},
        {"id":"note","name":"Note","type":"note","width":300}
      ] }
  ]$j$::jsonb;
$$;

-- ─────────────────────────────────────────────────────────────────────
--  RPCs — staff (dispatcher+) board CRUD
-- ─────────────────────────────────────────────────────────────────────

-- List the DSP's boards (active first, then archived), with row + open
-- counts for the picker.
create or replace function public.assignment_boards_list()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'icon', b.icon, 'columns', b.columns,
      'position', b.position, 'archived_at', b.archived_at, 'updated_at', b.updated_at,
      'row_count',  (select count(*)::int from public.assignment_rows r where r.board_id = b.id),
      'open_count', (select count(*)::int from public.assignment_rows r where r.board_id = b.id and r.completed_at is null)
    ) order by (b.archived_at is not null), b.position, b.created_at)
    from public.assignment_boards b
    where b.dsp_id = v_dsp
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.assignment_boards_list() to authenticated;

-- A board + all its rows (ordered).
create or replace function public.assignment_board_get(p_board_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_b public.assignment_boards;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_b from public.assignment_boards where id = p_board_id and dsp_id = v_dsp;
  if v_b.id is null then raise exception 'board_not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'board', jsonb_build_object('id', v_b.id, 'name', v_b.name, 'icon', v_b.icon, 'columns', v_b.columns, 'position', v_b.position, 'archived_at', v_b.archived_at, 'updated_at', v_b.updated_at),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'data', r.data, 'position', r.position,
        'assigned_driver_id', r.assigned_driver_id, 'status', r.status, 'due_date', r.due_date,
        'completed_at', r.completed_at, 'completion_note', r.completion_note, 'completion_photo_path', r.completion_photo_path,
        'updated_at', r.updated_at
      ) order by r.position, r.created_at)
      from public.assignment_rows r where r.board_id = v_b.id
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.assignment_board_get(uuid) to authenticated;

-- Create a board.  Pass p_columns to define the schema directly, or
-- p_template_key to start from a seed template (p_columns wins if both).
create or replace function public.assignment_board_create(p_name text, p_icon text default null, p_columns jsonb default null, p_template_key text default null)
returns public.assignment_boards
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_cols jsonb := p_columns;
  v_icon text := p_icon;
  v_tpl jsonb;
  v_pos int;
  v_b public.assignment_boards;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required' using errcode = '22023'; end if;

  if v_cols is null and coalesce(trim(p_template_key), '') <> '' then
    select t into v_tpl from jsonb_array_elements(private.assignment_templates()) t where t->>'key' = p_template_key limit 1;
    if v_tpl is not null then
      v_cols := v_tpl->'columns';
      if v_icon is null then v_icon := v_tpl->>'icon'; end if;
    end if;
  end if;
  v_cols := coalesce(v_cols, '[]'::jsonb);
  if jsonb_typeof(v_cols) <> 'array' then raise exception 'columns_must_be_array' using errcode = '22023'; end if;

  select coalesce(max(position), -1) + 1 into v_pos from public.assignment_boards where dsp_id = v_dsp;

  insert into public.assignment_boards (dsp_id, name, icon, columns, position)
  values (v_dsp, trim(p_name), v_icon, v_cols, v_pos)
  returning * into v_b;

  perform private.assignment_log(v_b.id, v_dsp, 'board_created', null, jsonb_build_object('name', v_b.name, 'template', p_template_key));
  return v_b;
end;
$$;
grant execute on function public.assignment_board_create(text, text, jsonb, text) to authenticated;

-- Rename / re-icon / re-schema a board.  Null args leave that field as-is.
create or replace function public.assignment_board_update(p_board_id uuid, p_name text default null, p_icon text default null, p_columns jsonb default null)
returns public.assignment_boards
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_b public.assignment_boards;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_b from public.assignment_boards where id = p_board_id and dsp_id = v_dsp;
  if v_b.id is null then raise exception 'board_not_found' using errcode = 'P0002'; end if;
  if p_columns is not null and jsonb_typeof(p_columns) <> 'array' then raise exception 'columns_must_be_array' using errcode = '22023'; end if;

  update public.assignment_boards
     set name    = case when p_name is not null and trim(p_name) <> '' then trim(p_name) else name end,
         icon    = coalesce(p_icon, icon),
         columns = coalesce(p_columns, columns),
         updated_at = now()
   where id = p_board_id
   returning * into v_b;

  perform private.assignment_log(v_b.id, v_dsp, 'board_updated', null,
    jsonb_strip_nulls(jsonb_build_object('name', p_name, 'columns_changed', (p_columns is not null) or null)));
  return v_b;
end;
$$;
grant execute on function public.assignment_board_update(uuid, text, text, jsonb) to authenticated;

-- Archive (or restore) a board — never hard-deleted (the audit trail
-- references it).
create or replace function public.assignment_board_archive(p_board_id uuid, p_archived boolean default true)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_b public.assignment_boards;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_b from public.assignment_boards where id = p_board_id and dsp_id = v_dsp;
  if v_b.id is null then raise exception 'board_not_found' using errcode = 'P0002'; end if;
  update public.assignment_boards set archived_at = case when p_archived then now() else null end, updated_at = now() where id = p_board_id;
  perform private.assignment_log(p_board_id, v_dsp, case when p_archived then 'board_archived' else 'board_unarchived' end);
end;
$$;
grant execute on function public.assignment_board_archive(uuid, boolean) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
--  RPCs — staff row CRUD
-- ─────────────────────────────────────────────────────────────────────

-- Insert (p_row_id null) or update a row.  Derives the first-class
-- mirrors (assigned driver / status / due) from the board's column
-- roles, validates the driver belongs to the DSP, and logs row_added /
-- row_updated — plus assigned / unassigned when the driver changes.
-- (The assign → driver-task → push → acknowledge loop hangs off the
-- assigned event in a later slice.)
create or replace function public.assignment_row_upsert(p_board_id uuid, p_row_id uuid default null, p_data jsonb default null, p_position int default null)
returns public.assignment_rows
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_b public.assignment_boards;
  v_old public.assignment_rows;
  v_data jsonb := coalesce(p_data, '{}'::jsonb);
  v_col_assignee text; v_col_status text; v_col_due text;
  v_assigned uuid; v_status text; v_due date;
  v_pos int;
  v_r public.assignment_rows;
  v_changed jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(v_data) <> 'object' then raise exception 'data_must_be_object' using errcode = '22023'; end if;
  select * into v_b from public.assignment_boards where id = p_board_id and dsp_id = v_dsp;
  if v_b.id is null then raise exception 'board_not_found' using errcode = 'P0002'; end if;

  -- derive mirrors from the board's column roles
  v_col_assignee := private.assignment_role_col(v_b.columns, 'assignee', 'driver');
  v_col_status   := private.assignment_role_col(v_b.columns, 'status',   'status');
  v_col_due      := private.assignment_role_col(v_b.columns, 'due',      'date');

  if v_col_assignee is not null and coalesce(v_data->>v_col_assignee, '') <> '' then
    begin v_assigned := (v_data->>v_col_assignee)::uuid; exception when others then v_assigned := null; end;
    if v_assigned is not null and not exists (select 1 from public.drivers d where d.id = v_assigned and d.dsp_id = v_dsp) then v_assigned := null; end if;
  end if;
  if v_col_status is not null then v_status := nullif(v_data->>v_col_status, ''); end if;
  if v_col_due is not null and coalesce(v_data->>v_col_due, '') <> '' then
    begin v_due := (v_data->>v_col_due)::date; exception when others then v_due := null; end;
  end if;

  if p_row_id is null then
    select coalesce(max(position), -1) + 1 into v_pos from public.assignment_rows where board_id = p_board_id;
    insert into public.assignment_rows (board_id, dsp_id, data, position, assigned_driver_id, status, due_date)
    values (p_board_id, v_dsp, v_data, coalesce(p_position, v_pos), v_assigned, v_status, v_due)
    returning * into v_r;
    perform private.assignment_log(p_board_id, v_dsp, 'row_added', v_r.id, jsonb_build_object('data', v_data));
    if v_assigned is not null then
      perform private.assignment_log(p_board_id, v_dsp, 'assigned', v_r.id,
        jsonb_build_object('driver_id', v_assigned, 'driver_name', (select coalesce(nullif(trim(full_name),''), preferred_name) from public.drivers where id = v_assigned)));
    end if;
  else
    select * into v_old from public.assignment_rows where id = p_row_id and board_id = p_board_id and dsp_id = v_dsp;
    if v_old.id is null then raise exception 'row_not_found' using errcode = 'P0002'; end if;
    update public.assignment_rows
       set data = v_data, position = coalesce(p_position, position),
           assigned_driver_id = v_assigned, status = v_status, due_date = v_due,
           updated_at = now()
     where id = p_row_id
     returning * into v_r;
    -- log the subset of cells that actually changed
    select jsonb_object_agg(k, v) into v_changed
      from jsonb_each(v_data) e(k, v)
     where v is distinct from (v_old.data -> k);
    perform private.assignment_log(p_board_id, v_dsp, 'row_updated', v_r.id, jsonb_build_object('changed', coalesce(v_changed, '{}'::jsonb)));
    if v_assigned is distinct from v_old.assigned_driver_id then
      if v_assigned is not null then
        perform private.assignment_log(p_board_id, v_dsp, 'assigned', v_r.id,
          jsonb_build_object('driver_id', v_assigned, 'driver_name', (select coalesce(nullif(trim(full_name),''), preferred_name) from public.drivers where id = v_assigned)));
      else
        perform private.assignment_log(p_board_id, v_dsp, 'unassigned', v_r.id,
          jsonb_build_object('was_driver_id', v_old.assigned_driver_id));
      end if;
    end if;
  end if;

  update public.assignment_boards set updated_at = now() where id = p_board_id;
  return v_r;
end;
$$;
grant execute on function public.assignment_row_upsert(uuid, uuid, jsonb, int) to authenticated;

-- Delete a row.
create or replace function public.assignment_row_delete(p_row_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_r public.assignment_rows;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_r from public.assignment_rows where id = p_row_id and dsp_id = v_dsp;
  if v_r.id is null then raise exception 'row_not_found' using errcode = 'P0002'; end if;
  perform private.assignment_log(v_r.board_id, v_dsp, 'row_deleted', null, jsonb_build_object('row_id', p_row_id, 'data', v_r.data));
  delete from public.assignment_rows where id = p_row_id;
  update public.assignment_boards set updated_at = now() where id = v_r.board_id;
end;
$$;
grant execute on function public.assignment_row_delete(uuid) to authenticated;

-- Re-order a board's rows (positions = the order of the id array).
create or replace function public.assignment_rows_reorder(p_board_id uuid, p_row_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.assignment_boards b where b.id = p_board_id and b.dsp_id = v_dsp) then raise exception 'board_not_found' using errcode = 'P0002'; end if;
  update public.assignment_rows r
     set position = ord, updated_at = now()
    from (select id, (ordinality - 1)::int ord from unnest(coalesce(p_row_ids, '{}'::uuid[])) with ordinality as t(id, ordinality)) o
   where r.id = o.id and r.board_id = p_board_id and r.dsp_id = v_dsp;
  update public.assignment_boards set updated_at = now() where id = p_board_id;
end;
$$;
grant execute on function public.assignment_rows_reorder(uuid, uuid[]) to authenticated;

-- The seed templates (for the "new board" picker).
create or replace function public.assignment_board_templates()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case
    when private.is_staff(private.current_dsp_id(), 'dispatcher') then private.assignment_templates()
    else '[]'::jsonb
  end;
$$;
grant execute on function public.assignment_board_templates() to authenticated;

notify pgrst, 'reload schema';
