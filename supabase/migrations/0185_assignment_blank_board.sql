-- Migration 0185 · Operational Assignments — blank "spreadsheet" board
--
-- assignment_board_create_blank() spins up a board that opens like a
-- fresh Excel sheet: a wide run of plain text columns named with the
-- A, B, C … Z, AA, AB … spreadsheet letters, plus a tall stack of empty
-- rows.  The operator renames a column and gives it a "function"
-- (Status, Date, Assigned-to, …) from the column-settings panel — the
-- column metadata and the rows are all the existing shapes, so every
-- other RPC (row upsert, reorder, board update, the driver loop) keeps
-- working unchanged.

create or replace function public.assignment_board_create_blank(p_name text, p_n_cols int default 40, p_n_rows int default 100)
returns public.assignment_boards
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_ncol int  := greatest(1, least(coalesce(p_n_cols, 40), 256));
  v_nrow int  := greatest(0, least(coalesce(p_n_rows, 100), 2000));
  v_cols jsonb;
  v_pos  int;
  v_b    public.assignment_boards;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required' using errcode = '22023'; end if;

  -- Build [{id:'c0', name:'A', type:'text', width:132}, …] for v_ncol columns.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',    'c' || i,
             'name',  case when i < 26 then chr(65 + i)
                           else chr(65 + (i / 26) - 1) || chr(65 + (i % 26)) end,
             'type',  'text',
             'width', 132
           ) order by i), '[]'::jsonb)
    into v_cols
    from generate_series(0, v_ncol - 1) as g(i);

  select coalesce(max(position), -1) + 1 into v_pos from public.assignment_boards where dsp_id = v_dsp;

  insert into public.assignment_boards (dsp_id, name, icon, columns, position)
  values (v_dsp, trim(p_name), 'generic', v_cols, v_pos)
  returning * into v_b;

  if v_nrow > 0 then
    insert into public.assignment_rows (board_id, dsp_id, data, position)
    select v_b.id, v_dsp, '{}'::jsonb, g from generate_series(0, v_nrow - 1) as g;
  end if;

  perform private.assignment_log(v_b.id, v_dsp, 'board_created', null,
    jsonb_build_object('name', v_b.name, 'blank', true, 'cols', v_ncol, 'rows', v_nrow));
  return v_b;
end;
$$;
grant execute on function public.assignment_board_create_blank(text, int, int) to authenticated;

notify pgrst, 'reload schema';
