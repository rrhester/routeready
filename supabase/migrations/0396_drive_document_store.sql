-- Migration 0396 · RouteReady Drive · generic folder/document store
--
-- Foundation for Drive as a true system of record. A reusable folder +
-- document model that ANY module can file into (drivers, fleet, HR,
-- station, reports) — no driver-specific hardcoding. Documents reference
-- the real storage object (no duplication); folders are generic and
-- nestable, with owner_type/owner_id linking e.g. a driver folder to a
-- driver without a hard FK.
--
-- Additive + safe: the dashboard reads/writes these best-effort and
-- degrades to the legacy document view (driver_documents, envelopes,
-- vehicle_documents, employment_reports) when this migration hasn't been
-- applied. Idempotent — re-running is a no-op.

-- ── Folders ────────────────────────────────────────────────────────────────
create table if not exists public.drive_folders (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  parent_id   uuid references public.drive_folders(id) on delete cascade,
  name        text not null,
  category    text not null default 'custom',   -- drivers|fleet|hr|station|reports|custom|system
  owner_type  text,                             -- driver|vehicle|station|null  (generic, no FK)
  owner_id    uuid,                             -- e.g. drivers.id
  sort_order  int  not null default 0,
  archived_at timestamptz,
  created_by  uuid references public.app_users(id) on delete set null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Documents ──────────────────────────────────────────────────────────────
create table if not exists public.drive_documents (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  folder_id   uuid references public.drive_folders(id) on delete set null,
  name        text not null,
  doc_type    text,                             -- e.g. 'Final Warning'
  category    text,                             -- drivers|fleet|hr|station|reports
  subfolder   text,                             -- Coaching|Warnings|Attendance|Employment|DOT|Licenses|Documents
  bucket      text not null default 'driver-documents',
  file_path   text,                             -- storage object key
  file_size   bigint,
  mime_type   text,
  source      text,                             -- coaching|warning|attendance|separation|upload|envelope|report
  source_id   uuid,                             -- originating record id (generic, no FK)
  driver_id   uuid references public.drivers(id) on delete cascade,   -- denormalized for fast filtering
  station_id  uuid,
  tags        text[] not null default '{}',
  archived_at timestamptz,
  deleted_at  timestamptz,                      -- soft delete → Trash
  created_by  uuid references public.app_users(id) on delete set null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists drive_folders_dsp_idx      on public.drive_folders(dsp_id);
create index if not exists drive_folders_owner_idx    on public.drive_folders(owner_type, owner_id);
create index if not exists drive_documents_dsp_idx    on public.drive_documents(dsp_id);
create index if not exists drive_documents_driver_idx on public.drive_documents(driver_id);
create index if not exists drive_documents_folder_idx on public.drive_documents(folder_id);
create index if not exists drive_documents_path_idx   on public.drive_documents(dsp_id, file_path);

-- ── RLS · tenant-scoped (same proven pattern as driver_documents) ───────────
alter table public.drive_folders   enable row level security;
alter table public.drive_documents enable row level security;

drop policy if exists "drive_folders_tenant_rw" on public.drive_folders;
create policy "drive_folders_tenant_rw"
  on public.drive_folders for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

drop policy if exists "drive_documents_tenant_rw" on public.drive_documents;
create policy "drive_documents_tenant_rw"
  on public.drive_documents for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.drive_folders   to authenticated;
grant select, insert, update, delete on public.drive_documents to authenticated;

-- Drive reuses the existing `driver-documents` storage bucket (already
-- created in 0021 with dsp-scoped policies), so no new bucket is needed.

notify pgrst, 'reload schema';
