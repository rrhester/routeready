-- 0320_email_messages_backfill_folder_id.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · all inbound mail also lands in the DSP's Inbox folder
--
-- Until now the webhook routed applicant-matched replies straight to
-- the applicant thread (folder_id NULL) and only routed vendor mail
-- (no applicant match) to Fleet Bridge. The product decision is now
-- "show me ALL inbound conversation in Fleet Bridge regardless of
-- whether it came from a known applicant" — applicant threads still
-- render the same rows via applicant_id, so nothing is lost.
--
-- This migration backfills folder_id on every historical inbound row
-- that currently has folder_id NULL, pointing at that DSP's Inbox
-- folder (kind='inbox'). Idempotent: a row that already has a folder
-- is skipped.
-- ════════════════════════════════════════════════════════════════════

update public.email_messages m
   set folder_id = f.id
  from public.fb_folders f
 where m.dsp_id = f.dsp_id
   and f.kind = 'inbox'
   and m.direction = 'inbound'
   and m.folder_id is null;
