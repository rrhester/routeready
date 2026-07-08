-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0445 · Make the vehicle-photos bucket PRIVATE
--
-- vehicle-photos was created public (0213) so an <img> against the public
-- URL "just worked". Public buckets serve every object with NO row-level
-- security — anyone who knows (or guesses) the object path can read it,
-- across tenants. Van photos aren't the crown jewels, but a public bucket
-- is a standing cross-tenant read hole and there's no reason to keep it.
--
-- This flips the bucket to private and adds a proper SELECT policy scoped to
-- the caller's DSP. Reads now go through short-lived signed URLs
-- (createSignedUrl) — the exact pattern the dashboard already uses for
-- driver-documents / vehicle-documents. Uploads are unaffected: the existing
-- `vehicle_photos_write` policy (0213, FOR ALL to authenticated dispatcher)
-- still governs writes.
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Flip the bucket private.
update storage.buckets set public = false where id = 'vehicle-photos';

-- 2. Read policy: any authenticated staff member of the DSP that owns the
--    vehicle can read (sign) its photos. Path convention is
--    "<vehicle_id>/<filename>", so the first path segment identifies the van.
--    (The pre-existing FOR ALL write policy only grants read to dispatchers;
--    this widens *read* to every staff role that can already see the van,
--    so lower roles don't lose the thumbnail.)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'vehicle_photos_read'
  ) then
    create policy "vehicle_photos_read" on storage.objects
      for select to authenticated
      using (
        bucket_id = 'vehicle-photos'
        and exists (
          select 1 from public.vehicles v
          where v.id::text = split_part(storage.objects.name, '/', 1)
            and v.dsp_id = private.current_dsp_id()
        )
      );
  end if;
end $$;
