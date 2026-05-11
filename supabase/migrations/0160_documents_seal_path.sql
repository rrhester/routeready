-- Migration 0160 · Documents · cryptographic seal sidecar
--
-- Slice 4b Phase 1 adds an ECDSA P-256 signature over the sealed
-- PDF, written by the Cloudflare sealing worker as a JSON sidecar at
-- <dsp>/seal/<envelope_id>.json. The sealed PDF stays byte-identical
-- to what a court would receive, so the seal proof lives next to it
-- rather than embedded inside (which would invalidate the very
-- signature we'd just produced).
--
-- This migration:
--   • adds document_envelopes.seal_path so the dashboard can link to
--     the sidecar from the audit modal.
--   • extends document_event_kind with `pdf_signed` so the worker's
--     audit event lands cleanly on the hash chain after pdf_sealed.

alter table public.document_envelopes
  add column if not exists seal_path text;

-- enum values can't be added inside a transaction in Postgres
-- 13/14, but newer (15+) supports it. Supabase is 15+, so this is
-- safe. Guard against re-runs.
do $$
begin
  if not exists (
    select 1 from pg_enum
     where enumlabel = 'pdf_signed'
       and enumtypid = 'public.document_event_kind'::regtype
  ) then
    alter type public.document_event_kind add value 'pdf_signed' after 'pdf_sealed';
  end if;
end $$;

notify pgrst, 'reload schema';
