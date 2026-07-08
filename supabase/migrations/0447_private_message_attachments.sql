-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0447 · Make the message-attachments bucket PRIVATE
--
-- message-attachments was created public (0023) so Twilio (MMS MediaUrl) and
-- Resend (email attachment URLs) — both unauthenticated external fetchers —
-- could pull the files. Public buckets serve every object with NO row-level
-- security, so applicant-facing attachments were readable by anyone who knew
-- (or guessed) the "<dsp_id>/<template_id>/<file>" path, across tenants.
--
-- The fix isn't a plain flip: external senders still need to fetch the files.
-- The trick is that a SIGNED url from a private bucket is self-contained — it
-- works for any fetcher, no login, until it expires. So:
--   • send-sms / send-email now sign each attachment fresh at send time
--     (service role, 24h TTL) and hand Twilio/Resend the signed URL.
--   • The dashboard signs on demand for its "Open" preview.
-- Nothing needs a public URL anymore.
--
-- Writes are unchanged (msg_attach_tenant_insert / _delete, 0023). The service
-- role used by the senders bypasses RLS, so signing needs no read policy; the
-- only new grant is a tenant-scoped SELECT so dashboard staff can sign their
-- own DSP's attachments for preview.
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Flip the bucket private.
update storage.buckets set public = false where id = 'message-attachments';

-- 2. Tenant staff may read (sign for preview) attachments under their DSP
--    path — mirrors the existing insert/delete policies (0023).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'msg_attach_tenant_read'
  ) then
    create policy "msg_attach_tenant_read" on storage.objects
      for select to authenticated
      using (
        bucket_id = 'message-attachments'
        and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
      );
  end if;
end $$;
