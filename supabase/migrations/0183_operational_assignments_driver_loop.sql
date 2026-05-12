-- Migration 0183 · Operational Assignments — per-board config + the driver loop
--
-- Adds a `config` jsonb to assignment_boards (the per-board behaviour
-- knobs the "Board Settings" panel edits), and the driver-side RPCs:
--   • driver_assignments_list(token)        — the rows assigned to this
--     driver, with each row's board name/icon and the board's config so
--     the app knows the completion-button label, whether to demand a
--     photo, etc.
--   • driver_assignment_acknowledge(token, row_id, photo_path?, note?)
--     — the driver completes a row: validates the photo / note
--     requirement from the board config, stamps completed_at + note +
--     photo path, flips the status cell to the board's completion value
--     (or its status column's last option), and logs `completed` to the
--     accountability trail (actor = driver).
-- Plus `assignment_board_set_config(board_id, config)` for the panel,
-- and re-defs of assignment_board_get / assignment_boards_list to carry
-- `config` through to the operator UI.
--
-- Config keys (all optional; defaults applied at read time):
--   notify_on_assign    bool   default true   — push the driver on assign  (delivery wired in a follow-up; the flag is the contract)
--   notify_on_due_soon  bool   default false  — push when their row is due soon  (scheduled job is a later slice)
--   driver_sees         text   default 'own'  — 'own' | 'board'  (board-wide read is a later slice; v1 = 'own')
--   driver_can_edit     bool   default false  — driver edits their rows' cells in the app  (in-app cell-edit is a later slice; v1 = false)
--   completion_label    text   default 'Mark done'
--   completion_status   text   default null   — value the status cell flips to on completion; null ⇒ the status column's last option
--   require_photo       text   default 'optional'  — 'off' | 'optional' | 'required'
--   require_note        text   default 'off'       — 'off' | 'optional' | 'required'
--   allow_driver_undo   bool   default true        — driver may un-complete within 24h  (undo RPC is a later slice; the flag is stored)

alter table public.assignment_boards add column if not exists config jsonb not null default '{}'::jsonb;

-- ── assignment_board_set_config ──────────────────────────────────────
create or replace function public.assignment_board_set_config(p_board_id uuid, p_config jsonb)
returns public.assignment_boards
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_b public.assignment_boards;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_config is not null and jsonb_typeof(p_config) <> 'object' then raise exception 'config_must_be_object' using errcode = '22023'; end if;
  select * into v_b from public.assignment_boards where id = p_board_id and dsp_id = v_dsp;
  if v_b.id is null then raise exception 'board_not_found' using errcode = 'P0002'; end if;
  update public.assignment_boards set config = coalesce(p_config, '{}'::jsonb), updated_at = now() where id = p_board_id returning * into v_b;
  perform private.assignment_log(p_board_id, v_dsp, 'board_updated', null, jsonb_build_object('config_changed', true));
  return v_b;
end;
$$;
grant execute on function public.assignment_board_set_config(uuid, jsonb) to authenticated;

-- ── assignment_board_get (re-def: carry `config`) ───────────────────
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
    'board', jsonb_build_object('id', v_b.id, 'name', v_b.name, 'icon', v_b.icon, 'columns', v_b.columns, 'config', v_b.config, 'position', v_b.position, 'archived_at', v_b.archived_at, 'updated_at', v_b.updated_at),
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

-- ── assignment_boards_list (re-def: carry `config`) ─────────────────
create or replace function public.assignment_boards_list()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'icon', b.icon, 'columns', b.columns, 'config', b.config,
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

-- ── driver_assignments_list ─────────────────────────────────────────
-- The rows assigned to the calling driver, across the DSP's active
-- boards.  Each carries its board's name/icon/config + the column
-- schema so the app can render cells and knows the completion rules.
create or replace function public.driver_assignments_list(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'row_id',                r.id,
      'board_id',              b.id,
      'board_name',            b.name,
      'board_icon',            b.icon,
      'config',                b.config,
      'columns',               b.columns,
      'data',                  r.data,
      'item_label',            coalesce(
                                 r.data ->> (select c->>'id' from jsonb_array_elements(coalesce(b.columns, '[]'::jsonb)) with ordinality t(c, o) where c->>'type' = 'text' order by o limit 1),
                                 r.data ->> (select c->>'id' from jsonb_array_elements(coalesce(b.columns, '[]'::jsonb)) with ordinality t(c, o) order by o limit 1)
                               ),
      'status',                r.status,
      'due_date',              r.due_date,
      'completed_at',          r.completed_at,
      'completion_note',       r.completion_note,
      'completion_photo_path', r.completion_photo_path
    ) order by (r.completed_at is not null), r.due_date nulls last, r.created_at)
    from public.assignment_rows r
    join public.assignment_boards b on b.id = r.board_id
    where r.assigned_driver_id = v_drv.id
      and b.dsp_id = v_drv.dsp_id
      and b.archived_at is null
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.driver_assignments_list(text) to anon, authenticated;

-- ── driver_assignment_acknowledge ───────────────────────────────────
-- The driver completes a row.  Honours the board config's photo / note
-- requirement, stamps completed_at + note + photo path, flips the
-- status cell to the board's completion value (or its status column's
-- last option), and logs `completed` to the audit trail.
create or replace function public.driver_assignment_acknowledge(p_token text, p_row_id uuid, p_photo_path text default null, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_row public.assignment_rows;
  v_config jsonb; v_cols jsonb;
  v_status_col text; v_target_status text;
  v_photo text := nullif(trim(coalesce(p_photo_path, '')), '');
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
begin
  v_drv := private.driver_validate_token(p_token);
  if p_row_id is null then raise exception 'row_required' using errcode = '22023'; end if;

  select * into v_row from public.assignment_rows where id = p_row_id and assigned_driver_id = v_drv.id and dsp_id = v_drv.dsp_id;
  if v_row.id is null then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;

  select config, columns into v_config, v_cols from public.assignment_boards where id = v_row.board_id and dsp_id = v_drv.dsp_id and archived_at is null;
  if v_config is null then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;   -- archived / wrong dsp

  if coalesce(v_config->>'require_photo', 'optional') = 'required' and v_photo is null then raise exception 'photo_required' using errcode = '22023'; end if;
  if coalesce(v_config->>'require_note',  'off')      = 'required' and v_note  is null then raise exception 'note_required'  using errcode = '22023'; end if;

  -- where the status flips to: config value, else the status column's last option, else leave it
  v_status_col   := private.assignment_role_col(v_cols, 'status', 'status');
  v_target_status := nullif(trim(coalesce(v_config->>'completion_status', '')), '');
  if v_target_status is null and v_status_col is not null then
    select arr->>(jsonb_array_length(arr) - 1)
      into v_target_status
      from (select c->'options' arr from jsonb_array_elements(coalesce(v_cols, '[]'::jsonb)) c where c->>'id' = v_status_col and jsonb_typeof(c->'options') = 'array' limit 1) t
     where jsonb_array_length(arr) > 0;
  end if;

  update public.assignment_rows
     set completed_at          = now(),
         completion_photo_path = v_photo,
         completion_note       = v_note,
         status                = case when v_target_status is not null then v_target_status else status end,
         data                  = case when v_target_status is not null and v_status_col is not null
                                       then jsonb_set(coalesce(data, '{}'::jsonb), array[v_status_col], to_jsonb(v_target_status), true)
                                       else data end,
         updated_at            = now()
   where id = p_row_id
   returning * into v_row;

  perform private.assignment_log(v_row.board_id, v_drv.dsp_id, 'completed', v_row.id,
    jsonb_build_object('with_photo', v_photo is not null, 'with_note', v_note is not null, 'status', v_row.status),
    'driver', v_drv.id);
  update public.assignment_boards set updated_at = now() where id = v_row.board_id;

  return jsonb_build_object('row_id', v_row.id, 'completed_at', v_row.completed_at, 'status', v_row.status);
end;
$$;
grant execute on function public.driver_assignment_acknowledge(text, uuid, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
