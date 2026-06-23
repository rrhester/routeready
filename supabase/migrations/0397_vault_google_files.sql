-- Migration 0397 · RouteReady Vault · Google Workspace files
--
-- Google Docs / Sheets / Slides live in Google Drive (the editing engine) but
-- appear inside the Vault as part of the operational record. Rather than a
-- separate table, we extend the canonical drive_documents store (migration
-- 0396) with the Google-owned metadata, so Google files list, move, search,
-- and file into folders right beside PDFs, images, and uploads for free.
--
-- Ownership split (enforced by convention + the sync function, never a hard
-- overwrite): RouteReady owns folder_id, driver_id, subfolder, category,
-- doc_type, tags, related_entity_*; Google owns name's source-of-truth,
-- google_drive_url, google_mime_type, modified_at, permissions_status. The
-- background sync only ever writes the Google-owned columns.
--
-- Additive + idempotent. The dashboard reads these best-effort (select *), so
-- this is safe to apply before or after the Google backend ships.

alter table public.drive_documents
  add column if not exists is_google_file      boolean not null default false,
  add column if not exists google_file_id      text,
  add column if not exists google_drive_url    text,
  add column if not exists google_mime_type    text,
  add column if not exists related_entity_type text,     -- driver|applicant|vehicle|incident|coaching|compliance
  add column if not exists related_entity_id   uuid,
  add column if not exists permissions_status  text,     -- ok|restricted|error|null
  add column if not exists modified_at         timestamptz,   -- Google's modifiedTime
  add column if not exists last_synced_at      timestamptz;

-- A Google file maps 1:1 to a Drive object within a tenant.
create unique index if not exists drive_documents_google_file_uq
  on public.drive_documents(google_file_id) where google_file_id is not null;
create index if not exists drive_documents_google_idx
  on public.drive_documents(dsp_id, is_google_file) where is_google_file;
create index if not exists drive_documents_related_idx
  on public.drive_documents(related_entity_type, related_entity_id) where related_entity_id is not null;

notify pgrst, 'reload schema';
