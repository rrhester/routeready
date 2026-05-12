-- Migration 0184 · Operational Assignments — push the driver on assign
--
-- Re-defs assignment_row_upsert so that when a row gets a *new*
-- assignee and the board's config doesn't opt out (notify_on_assign
-- defaults to true), a short auto-message is dropped into the driver's
-- dispatch chat — which fires the existing send-driver-push trigger
-- (and shows up in the driver's Messages, the natural place for "from
-- dispatch" notices).  Everything else about the function is unchanged
-- from migration 0182; the assigned / unassigned / row_added /
-- row_updated audit events still fire as before — they're just
-- consolidated through a single `v_prev_assigned` comparison so the
-- insert and update paths handle the assignment change identically.

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
  v_prev_assigned uuid;
  v_notify_label text; v_notify_body text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(v_data) <> 'object' then raise exception 'data_must_be_object' using errcode = '22023'; end if;
  select * into v_b from public.assignment_boards where id = p_board_id and dsp_id = v_dsp;
  if v_b.id is null then raise exception 'board_not_found' using errcode = 'P0002'; end if;

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
    v_prev_assigned := null;
    select coalesce(max(position), -1) + 1 into v_pos from public.assignment_rows where board_id = p_board_id;
    insert into public.assignment_rows (board_id, dsp_id, data, position, assigned_driver_id, status, due_date)
    values (p_board_id, v_dsp, v_data, coalesce(p_position, v_pos), v_assigned, v_status, v_due)
    returning * into v_r;
    perform private.assignment_log(p_board_id, v_dsp, 'row_added', v_r.id, jsonb_build_object('data', v_data));
  else
    select * into v_old from public.assignment_rows where id = p_row_id and board_id = p_board_id and dsp_id = v_dsp;
    if v_old.id is null then raise exception 'row_not_found' using errcode = 'P0002'; end if;
    v_prev_assigned := v_old.assigned_driver_id;
    update public.assignment_rows
       set data = v_data, position = coalesce(p_position, position),
           assigned_driver_id = v_assigned, status = v_status, due_date = v_due,
           updated_at = now()
     where id = p_row_id
     returning * into v_r;
    select jsonb_object_agg(k, v) into v_changed
      from jsonb_each(v_data) e(k, v)
     where v is distinct from (v_old.data -> k);
    perform private.assignment_log(p_board_id, v_dsp, 'row_updated', v_r.id, jsonb_build_object('changed', coalesce(v_changed, '{}'::jsonb)));
  end if;

  -- assignment changed → audit, and (unless the board opts out) a push
  -- to the newly-assigned driver via the dispatch-chat channel.
  if v_assigned is distinct from v_prev_assigned then
    if v_assigned is not null then
      perform private.assignment_log(p_board_id, v_dsp, 'assigned', v_r.id,
        jsonb_build_object('driver_id', v_assigned, 'driver_name', (select coalesce(nullif(trim(full_name), ''), preferred_name) from public.drivers where id = v_assigned)));

      if coalesce(v_b.config->>'notify_on_assign', 'true') <> 'false' then
        select coalesce(
          v_data ->> (select c->>'id' from jsonb_array_elements(coalesce(v_b.columns, '[]'::jsonb)) with ordinality t(c, o) where c->>'type' = 'text' order by o limit 1),
          v_data ->> (select c->>'id' from jsonb_array_elements(coalesce(v_b.columns, '[]'::jsonb)) with ordinality t(c, o) order by o limit 1)
        ) into v_notify_label;
        v_notify_label := nullif(trim(coalesce(v_notify_label, '')), '');
        v_notify_body := left(
          'New task' || coalesce(': ' || v_notify_label, '')
          || ' — ' || coalesce(nullif(trim(v_b.name), ''), 'a board')
          || coalesce(' · due ' || to_char(v_due, 'FMMon FMDD'), ''),
          2000);
        insert into public.driver_messages (driver_id, dsp_id, sender_kind, sender_user_id, body)
          values (v_assigned, v_dsp, 'dispatch', auth.uid(), v_notify_body);
        insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
          values (v_assigned, v_dsp, now())
          on conflict (driver_id) do update set last_message_at = excluded.last_message_at;
      end if;
    else
      perform private.assignment_log(p_board_id, v_dsp, 'unassigned', v_r.id, jsonb_build_object('was_driver_id', v_prev_assigned));
    end if;
  end if;

  update public.assignment_boards set updated_at = now() where id = p_board_id;
  return v_r;
end;
$$;
grant execute on function public.assignment_row_upsert(uuid, uuid, jsonb, int) to authenticated;

notify pgrst, 'reload schema';
