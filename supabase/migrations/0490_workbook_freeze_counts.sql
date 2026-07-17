-- 0490_workbook_freeze_counts.sql
--
-- 100-list #13: freeze any number of rows/columns. The Phase-1 schema
-- capped workbook_sheets.frozen_rows / frozen_cols at 0–1 (single
-- row/column freeze). The client now supports Excel-style "freeze
-- panes up to the current cell", so lift the caps to 0–50 (matches
-- WB_FREEZE_MAX in workbook.js).

alter table public.workbook_sheets
  drop constraint if exists workbook_sheets_frozen_rows_check;
alter table public.workbook_sheets
  add constraint workbook_sheets_frozen_rows_check
  check (frozen_rows between 0 and 50);

alter table public.workbook_sheets
  drop constraint if exists workbook_sheets_frozen_cols_check;
alter table public.workbook_sheets
  add constraint workbook_sheets_frozen_cols_check
  check (frozen_cols between 0 and 50);
