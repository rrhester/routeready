-- 0420_workbook_protected_ranges.sql
-- Server-side enforcement for workbook protected ranges.
--
-- The client already blocks edits to cells inside sheet.meta.protected for
-- non-admins (advisory, stops accidental overwrites). This makes it real: the
-- workbook_cells write policy now also rejects writes to a locked cell unless
-- the caller can administer the workbook. Idempotent — safe to re-run.

-- True when (sheet, row, col) falls inside a protected range AND the caller is
-- not a workbook admin. Robust to malformed meta: a non-array `protected`, or a
-- range whose bounds aren't integers, simply doesn't match (never errors, so it
-- can't fail-closed an entire sheet's edits).
create or replace function private.workbook_cell_locked(p_sheet_id uuid, p_row int, p_col int)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workbook_sheets s
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(s.meta -> 'protected') = 'array' then s.meta -> 'protected' else '[]'::jsonb end
    ) as pr
    where s.id = p_sheet_id
      and (pr ->> 'r0') ~ '^-?\d+$' and (pr ->> 'r1') ~ '^-?\d+$'
      and (pr ->> 'c0') ~ '^-?\d+$' and (pr ->> 'c1') ~ '^-?\d+$'
      and p_row between (pr ->> 'r0')::int and (pr ->> 'r1')::int
      and p_col between (pr ->> 'c0')::int and (pr ->> 'c1')::int
      and not private.can_admin_workbook(s.workbook_id)
  );
$$;

-- Re-create the cells write policy with the lock check on both the existing row
-- (update/delete → using) and the incoming row (insert/update → with check).
drop policy if exists "workbook_cells_write" on public.workbook_cells;
create policy "workbook_cells_write" on public.workbook_cells for all
  using (
    private.can_edit_workbook(workbook_id)
    and not private.workbook_cell_locked(sheet_id, row_index, col_index)
  )
  with check (
    dsp_id = private.current_dsp_id()
    and private.can_edit_workbook(workbook_id)
    and not private.workbook_cell_locked(sheet_id, row_index, col_index)
  );

-- Close the bypass: sheet meta is editor-writable (hidden rows, filters, …), so
-- a non-admin could otherwise strip meta.protected and then edit the cells.
-- This trigger keeps the protected array pinned to its prior value for anyone
-- who can't administer the workbook, while leaving the rest of meta editable.
create or replace function private.preserve_protected_ranges()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.can_admin_workbook(new.workbook_id) then
    if old.meta ? 'protected' then
      new.meta = jsonb_set(coalesce(new.meta, '{}'::jsonb), '{protected}', old.meta -> 'protected', true);
    else
      new.meta = coalesce(new.meta, '{}'::jsonb) - 'protected';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_preserve_protected on public.workbook_sheets;
create trigger trg_preserve_protected
  before update on public.workbook_sheets
  for each row execute function private.preserve_protected_ranges();
