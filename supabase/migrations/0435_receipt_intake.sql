-- 0435_receipt_intake.sql
--
-- Receipt Intake — Phase 1 foundation.
--
-- A driver scans a receipt in the phone app, RouteReady stores the image in a
-- private, DSP-scoped storage bucket, captures/extracts the details, and files
-- one durable receipt record. A companion migration (0436) projects each
-- record into a "Receipt Ledger" workbook sheet the DSP reconciles against a
-- statement; the RPCs the phone + dashboard call live in 0437.
--
-- Conventions mirrored from the rest of the schema:
--   • every row carries a denormalized dsp_id for one-hop RLS
--   • timestamps + a private.set_updated_at() trigger
--   • idempotent DDL throughout (safe to re-run after a partial apply)
--
-- The phone app authenticates with an opaque driver session token (no auth
-- JWT), so driver writes come through a security-definer RPC (0437) — this
-- table's RLS is written for the *staff* (dispatcher+) dashboard side.

-- ─── Category + status vocabularies ─────────────────────────────────────────
-- Kept as text + check (not enums) so a DSP-specific category can be added
-- later without a type migration; the check lists the Phase-1 controlled set.

-- ─── Table ──────────────────────────────────────────────────────────────────
create table if not exists public.receipt_uploads (
  id                        uuid primary key default gen_random_uuid(),
  dsp_id                    uuid not null references public.dsps(id) on delete cascade,

  -- Who submitted it (phone app = a driver; dashboard = a staff auth user).
  uploaded_by_employee_id   uuid references public.drivers(id) on delete set null,
  uploaded_by_user_id       uuid references auth.users(id)    on delete set null,
  uploaded_by_name          text,
  upload_timestamp          timestamptz not null default now(),

  -- Receipt facts (captured or extracted; all optional at rest so a
  -- partially-filled receipt is never lost — validated in the RPC/UI).
  receipt_date              date,
  vendor_name               text,
  total_amount              numeric(12,2),
  tax_amount                numeric(12,2),
  payment_type              text,
  category                  text check (category in (
                              'Fuel','Maintenance','Tires','Tolls / Parking',
                              'Supplies','Uniforms / Equipment','Reimbursement',
                              'Cleaning','Other')),

  -- Optional operational attachment points.
  driver_id                 uuid references public.drivers(id)  on delete set null,
  driver_name               text,
  van_id                    uuid references public.vehicles(id) on delete set null,
  van_number                text,
  route_date                date,
  shift_id                  uuid references public.shifts(id)   on delete set null,
  notes                     text,

  -- Image lives in the private 'receipts' storage bucket; we persist the
  -- object key (path) and mint short-lived signed URLs on demand. The
  -- *_url columns are reserved for a future public/CDN variant.
  file_storage_key          text,
  file_name                 text,
  file_size_bytes           bigint,
  mime_type                 text,
  receipt_image_url         text,
  receipt_thumbnail_url     text,

  -- Extraction (on-device OCR today; server AI later). Non-blocking.
  ocr_raw_text              text,
  ocr_confidence            numeric(4,3),

  -- Reconciliation lifecycle. Default Unreconciled; the ledger Status
  -- column is bound to exactly this controlled set.
  reconciliation_status     text not null default 'Unreconciled'
                              check (reconciliation_status in (
                                'Unreconciled','Matched','Needs Review',
                                'Duplicate Possible','Rejected','Reimbursable')),
  duplicate_flag            boolean not null default false,
  reviewed_by               uuid references auth.users(id) on delete set null,
  reviewed_at               timestamptz,

  -- Link to the projected Receipt Ledger row (one durable receipt ↔ one row).
  -- Populated by private.sync_receipt_to_ledger() in 0436; a non-null
  -- ledger_sync_error means the projection failed and the row needs a retry
  -- (the receipt itself is never lost).
  ledger_workbook_id        uuid,
  ledger_sheet_id           uuid,
  ledger_row_index          integer,
  ledger_synced_at          timestamptz,
  ledger_sync_error         text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- Admin-view + dedup indexes.
create index if not exists idx_receipt_uploads_dsp_status
  on public.receipt_uploads (dsp_id, reconciliation_status, receipt_date desc);
create index if not exists idx_receipt_uploads_dsp_date
  on public.receipt_uploads (dsp_id, receipt_date desc);
create index if not exists idx_receipt_uploads_dsp_category
  on public.receipt_uploads (dsp_id, category);
create index if not exists idx_receipt_uploads_dsp_driver
  on public.receipt_uploads (dsp_id, driver_id);
create index if not exists idx_receipt_uploads_dsp_van
  on public.receipt_uploads (dsp_id, van_id);
create index if not exists idx_receipt_uploads_dup
  on public.receipt_uploads (dsp_id, total_amount, receipt_date, lower(vendor_name));
-- Fast reverse lookup: a ledger cell edit → its receipt.
create index if not exists idx_receipt_uploads_ledger_cell
  on public.receipt_uploads (ledger_sheet_id, ledger_row_index)
  where ledger_sheet_id is not null;

-- ─── updated_at trigger ─────────────────────────────────────────────────────
drop trigger if exists trg_receipt_uploads_updated_at on public.receipt_uploads;
create trigger trg_receipt_uploads_updated_at
  before update on public.receipt_uploads
  for each row execute function private.set_updated_at();

-- ─── RLS — dispatcher+ of the owning DSP ────────────────────────────────────
-- Employees only ever reach this table through the security-definer driver
-- RPC (0437); the direct-table policy governs the dashboard (staff) side.
alter table public.receipt_uploads enable row level security;

drop policy if exists "receipt_uploads_tenant_rw" on public.receipt_uploads;
create policy "receipt_uploads_tenant_rw" on public.receipt_uploads
  for all
  using      (dsp_id = private.current_dsp_id()
              and private.is_staff(private.current_dsp_id(), 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(private.current_dsp_id(), 'dispatcher'));

grant select, insert, update, delete on public.receipt_uploads to authenticated;

-- ─── Storage bucket (private; DSP-scoped) ───────────────────────────────────
-- Path layout enforced by the driver RPC:  <dsp_id>/<driver_id>/<ts>-<name>
-- 25 MB ceiling covers a multi-page PDF or a high-res phone JPEG.
insert into storage.buckets (id, name, public, file_size_limit)
values ('receipts', 'receipts', false, 26214400)
on conflict (id) do nothing;

-- Staff (dashboard) read/write/delete, scoped to their DSP by the first
-- path segment — mirrors document-intake (0330) and vehicle-documents (0297).
drop policy if exists "receipts_tenant_read"  on storage.objects;
drop policy if exists "receipts_tenant_write" on storage.objects;
drop policy if exists "receipts_tenant_del"   on storage.objects;

create policy "receipts_tenant_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );

create policy "receipts_tenant_write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );

create policy "receipts_tenant_del" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );

-- Driver-side uploads come from the anon role with a session token, which a
-- storage policy can't read — so we accept any well-formed object in the
-- bucket and let driver_receipt_submit (0437) verify the <dsp_id>/<driver_id>
-- prefix before it records the key. Untracked uploads are orphans a later
-- cron can sweep — same contract as driver-chat-attachments (0072).
drop policy if exists "receipts_anon_write" on storage.objects;
create policy "receipts_anon_write" on storage.objects
  for insert to anon
  with check (bucket_id = 'receipts');

drop policy if exists "receipts_anon_read" on storage.objects;
create policy "receipts_anon_read" on storage.objects
  for select to anon
  using (bucket_id = 'receipts');

notify pgrst, 'reload schema';
