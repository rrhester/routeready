-- 0500_workbook_macros.sql
--
-- Org macro library (100-list #85). Workbook macros were per-browser
-- (localStorage) with clipboard-only sharing. This table lets a DSP's
-- dispatchers PUBLISH macros so the whole org can load and run them.
-- Idempotent.
--
-- SECURITY NOTE (read before changing): rows store executable macro CODE.
-- Macros run in a Web Worker sandbox with no DOM / session-token access, but
-- they DO have brokered internet access, and every run still requires the
-- existing explicit per-run confirmation (which warns about internet access).
-- This table is only a shared *store* — nothing here ever auto-runs a macro.
-- Publishing is limited to dispatcher+ of the owning DSP; editing/unpublishing
-- to the author or an ops+ admin. RLS scopes every row to the caller's DSP, so
-- one org can never see or run another org's macros.

create table if not exists public.workbook_macros (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  name         text not null default 'Untitled macro',
  description  text,
  code         text not null default '',
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_workbook_macros_dsp on public.workbook_macros (dsp_id, name);

alter table public.workbook_macros enable row level security;

-- view: any dispatcher+ of the DSP sees its shared macros
drop policy if exists "workbook_macros_select" on public.workbook_macros;
create policy "workbook_macros_select" on public.workbook_macros for select
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

-- publish: a dispatcher+ can add a macro to their own DSP, as themselves
drop policy if exists "workbook_macros_insert" on public.workbook_macros;
create policy "workbook_macros_insert" on public.workbook_macros for insert
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher')
              and created_by = auth.uid());

-- edit: the author, or an ops+ admin of the DSP
drop policy if exists "workbook_macros_update" on public.workbook_macros;
create policy "workbook_macros_update" on public.workbook_macros for update
  using (dsp_id = private.current_dsp_id()
         and (created_by = auth.uid() or private.is_staff(dsp_id, 'ops')))
  with check (dsp_id = private.current_dsp_id()
              and (created_by = auth.uid() or private.is_staff(dsp_id, 'ops')));

-- unpublish: same rule as edit
drop policy if exists "workbook_macros_delete" on public.workbook_macros;
create policy "workbook_macros_delete" on public.workbook_macros for delete
  using (dsp_id = private.current_dsp_id()
         and (created_by = auth.uid() or private.is_staff(dsp_id, 'ops')));

-- keep updated_at fresh via the shared trigger fn
drop trigger if exists trg_workbook_macros_updated_at on public.workbook_macros;
create trigger trg_workbook_macros_updated_at
  before update on public.workbook_macros
  for each row execute function private.set_updated_at();

-- live sync: a publish / unpublish shows up on teammates' Macros panels
do $$ begin
  alter publication supabase_realtime add table public.workbook_macros;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
