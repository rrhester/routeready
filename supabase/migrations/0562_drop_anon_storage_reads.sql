-- ── 0562 · Close B-1 — drop the bucket-wide anon READ policies ────────────────
--
-- ⚠️  DO NOT APPLY THIS UNTIL the driver PWA has been switched to
--     driver-file-sign AND you've QA'd file access on a real device.
--     See docs/B1-STORAGE-SIGNING-RUNBOOK.md for the deploy order and the
--     checklist. Applying it early makes drivers unable to open their own
--     license photos, avatars, and chat attachments.
--
-- This is the second half of the B-1 fix. Migration 0561 + the
-- driver-file-sign edge function give the driver app a token-validated,
-- ownership-checked path to a signed URL. Once the app uses that path, these
-- three bucket-WIDE `anon SELECT` policies — the actual cross-tenant hole,
-- since they let any holder of the public anon key sign/enumerate EVERY
-- tenant's files — are no longer needed and are removed here.
--
-- Only the READ policies are dropped. The anon INSERT policies stay: drivers
-- still upload directly (the upload path is unchanged and low-risk — a driver
-- can only write, not read others' files). Staff/dispatcher authenticated
-- read policies are untouched. Idempotent.
--
-- NOTE: the `receipts` bucket had the same bucket-wide `receipts_anon_read`
-- leak (migration 0435). It is closed in migration 0567 — a simple DROP, since
-- nothing legitimate reads receipts as anon (driver app only uploads; dashboard
-- reads authenticated). That one is safe to apply any time, unlike this file.

drop policy if exists "driver_docs_anon_select"    on storage.objects;  -- 0079 · driver-documents
drop policy if exists "driver_photos_anon_read"    on storage.objects;  -- 0446 · driver-photos
drop policy if exists "chat_attachments_anon_read" on storage.objects;  -- 0072 · driver-chat-attachments
