-- 0414_workbook_sheet_meta.sql
--
-- Per-sheet metadata bag for spreadsheet features that are structured
-- but small: hidden rows/columns, data-validation rules, conditional-
-- formatting rules (and future named ranges / print settings). Kept as
-- one jsonb per sheet — each list is bounded (tens of entries) and
-- always loaded with the sheet, so relational rows would add joins
-- without adding queryability we need.

alter table public.workbook_sheets
  add column if not exists meta jsonb not null default '{}'::jsonb;

notify pgrst, 'reload schema';
