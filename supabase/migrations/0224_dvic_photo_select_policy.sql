-- Migration 0224 · DVIC — let dispatchers read driver-documents DVIC photos
--
-- The driver-documents bucket already has a tenant-scoped SELECT
-- policy (0021) that requires the first path segment to be the DSP id.
-- The first cut of the DVIC photo path (0223) put `dvic/` first, so
-- dispatchers got a 403 on createSignedUrls and the Inspections-tab
-- thumbnails came back broken.
--
-- This migration:
--   1. Moves any already-uploaded `dvic/...` objects to
--      `<dsp_id>/dvic/...` so the existing policy approves them.
--   2. Adds a belt-and-suspenders SELECT policy for any object whose
--      path matches `<uuid>/dvic/%` so the read works regardless of
--      what the per-tenant policy resolves to.
--
-- The driver-app change in the same PR uses the new <dsp>/dvic/...
-- shape on every future upload, so this migration is one-and-done.

-- ── 1. Re-home any existing dvic/* objects under their DSP folder ──
-- We look up which DSP owns a path by joining vehicle_inspections
-- (photos column) → vehicles → dsp_id, matching the legacy path.
do $$
declare r record; v_new_name text;
begin
  for r in
    select o.id, o.bucket_id, o.name as old_name, v.dsp_id
      from storage.objects o
      join public.vehicle_inspections vi on o.name = any (
        select jsonb_array_elements_text(vi.photos)
      )
      join public.vehicles v on v.id = vi.vehicle_id
     where o.bucket_id = 'driver-documents'
       and o.name like 'dvic/%'
  loop
    v_new_name := r.dsp_id::text || '/' || r.old_name;
    begin
      update storage.objects
         set name = v_new_name
       where id = r.id and bucket_id = 'driver-documents';
      -- Update the inspection's photos array to point at the new path.
      update public.vehicle_inspections
         set photos = (
           select jsonb_agg(case when p = r.old_name then v_new_name else p end)
             from jsonb_array_elements_text(photos) p
         )
       where photos @> to_jsonb(r.old_name);
    exception when others then
      raise notice 'skip move %: %', r.old_name, sqlerrm;
    end;
  end loop;
end $$;


-- ── 2. Belt-and-suspenders SELECT policy for DVIC paths ─────────────
-- Authenticated DSP staff can read any object under <dsp_id>/dvic/* in
-- driver-documents.  This duplicates the existing tenant policy for
-- the DVIC sub-tree so a future path tweak doesn't silently break
-- thumbnail rendering.
drop policy if exists "driver_docs_dvic_select" on storage.objects;
create policy "driver_docs_dvic_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'driver-documents'
    and name like '%/dvic/%'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );


notify pgrst, 'reload schema';
