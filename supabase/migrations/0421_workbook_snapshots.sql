-- 0421_workbook_snapshots.sql
-- Version history for workbooks: point-in-time snapshots you can restore to.
-- Each row stores the full serialized state of every sheet (cells + structure
-- + meta) as JSON. Idempotent.

create table if not exists public.workbook_snapshots (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  workbook_id  uuid not null references public.workbooks(id) on delete cascade,
  label        text not null default '',
  auto         boolean not null default false,   -- true for automatic (pre-restore / periodic) snapshots
  payload      jsonb not null,                   -- [{ name, position, row_count, …, meta, cells:[…] }]
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_workbook_snapshots_wb on public.workbook_snapshots (workbook_id, created_at desc);

alter table public.workbook_snapshots enable row level security;

-- view: anyone who can view the workbook; insert: any editor; delete: admins.
drop policy if exists "workbook_snapshots_select" on public.workbook_snapshots;
create policy "workbook_snapshots_select" on public.workbook_snapshots for select
  using (private.can_view_workbook(workbook_id));

drop policy if exists "workbook_snapshots_insert" on public.workbook_snapshots;
create policy "workbook_snapshots_insert" on public.workbook_snapshots for insert
  with check (dsp_id = private.current_dsp_id() and private.can_edit_workbook(workbook_id));

drop policy if exists "workbook_snapshots_delete" on public.workbook_snapshots;
create policy "workbook_snapshots_delete" on public.workbook_snapshots for delete
  using (private.can_admin_workbook(workbook_id));
