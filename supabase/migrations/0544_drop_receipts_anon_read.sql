-- 0544_drop_receipts_anon_read.sql
--
-- Closes the same class of cross-tenant PII leak as Blocker B-1, on the
-- `receipts` bucket.
--
-- Migration 0435 opened the private `receipts` bucket with a **bucket-wide anon
-- SELECT** policy:
--
--     create policy "receipts_anon_read" on storage.objects
--       for select to anon using (bucket_id = 'receipts');
--
-- The driver PWA authenticates as the identity-less `anon` Postgres role, so
-- the anon key (which ships in every browser + the app) can sign/enumerate
-- EVERY tenant's uploaded receipts — expense images that routinely carry names,
-- card tails, addresses. That is a cross-tenant data exposure.
--
-- Unlike the three driver buckets in B-1 (0538/0539), the `receipts` bucket has
-- NO legitimate anon reader to preserve, so no ownership RPC / signing edge
-- function is needed — the policy is simply dropped:
--   • the driver app only UPLOADS receipts (anon INSERT via `receipts_anon_write`,
--     path verified server-side by `driver_receipt_submit`, 0437) — it never
--     reads a receipt image back;
--   • the dashboard reads receipts as the AUTHENTICATED operator, served by
--     `receipts_tenant_read` (0435), which is DSP-scoped by the first path
--     segment and is unaffected by this change.
--
-- Therefore dropping `receipts_anon_read` is safe to apply ANY time — it breaks
-- no legitimate flow and requires no app/edge-function coordination. The anon
-- INSERT policy (`receipts_anon_write`) is intentionally left in place so driver
-- receipt uploads keep working.
--
-- Idempotent: `drop policy if exists`.

drop policy if exists "receipts_anon_read" on storage.objects;

notify pgrst, 'reload schema';
