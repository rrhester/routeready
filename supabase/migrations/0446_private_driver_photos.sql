-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0446 · Make the driver-photos bucket PRIVATE
--
-- driver-photos was created public (0064) so an <img> against the public URL
-- "just worked". Public Supabase buckets serve every object with NO row-level
-- security — anyone who knows or guesses the object path (which contains a
-- driver UUID) can read a driver's face photo, across tenants. This closes
-- that hole and moves reads onto short-lived signed URLs, the same model
-- driver-documents already uses (private bucket + anon-signable, 0079).
--
-- Two reader surfaces, two policies:
--   • Dashboard (staff, authenticated Supabase session) → tenant-scoped SELECT:
--     a staff member may sign photos only for drivers in their own DSP.
--   • Driver PWA (authenticates with a custom driver token, i.e. the anon
--     role — no Supabase JWT) → an anon SELECT policy keyed on bucket only,
--     exactly like driver_docs_anon_select (0079). The driver only ever knows
--     their own "<driver_id>/…" path, and this is strictly better than a
--     public bucket (no stable public URL, requires the anon key + the exact
--     path + a signing round-trip, time-limited).
--
-- Uploads are unaffected — they go through the upload-driver-photo edge
-- function with the service role, which bypasses RLS.
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Flip the bucket private.
update storage.buckets set public = false where id = 'driver-photos';

-- 2. Authenticated staff: read (sign) photos for drivers in their own DSP.
--    Path convention "<driver_id>/avatar.<ext>".
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'driver_photos_staff_read'
  ) then
    create policy "driver_photos_staff_read" on storage.objects
      for select to authenticated
      using (
        bucket_id = 'driver-photos'
        and exists (
          select 1 from public.drivers d
          where d.id::text = split_part(storage.objects.name, '/', 1)
            and d.dsp_id = private.current_dsp_id()
        )
      );
  end if;
end $$;

-- 3. Anon (driver PWA): sign driver-photos by path, mirroring the accepted
--    driver-documents pattern (0079). Bucket-scoped only — anon has no DB
--    identity to scope against, and the driver only knows their own path.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'driver_photos_anon_read'
  ) then
    create policy "driver_photos_anon_read" on storage.objects
      for select to anon
      using (bucket_id = 'driver-photos');
  end if;
end $$;
