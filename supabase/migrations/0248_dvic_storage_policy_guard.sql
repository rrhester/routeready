-- Migration 0248 · Revert the 0247 rename + guard storage RLS casts.
--
-- 0247 renamed storage.objects.name from `dvic/...` → `<dsp_id>/dvic/...`
-- but did NOT move the underlying file blobs (Supabase Storage keys the
-- S3 path off `name`).  Result: the new metadata pointed at a path with
-- no file, so signed URLs returned 404.
--
-- Root cause for the original symptom was a strict driver-documents
-- SELECT policy that does `(storage.foldername(name))[1]::uuid =
-- private.current_dsp_id()` with no guard.  When RLS evaluated the
-- policy against a `dvic/...` row, casting "dvic" to uuid threw and
-- the whole query errored — even though the permissive
-- `driver_docs_inspection_select` policy would have granted access.
--
-- Fix:
--   1. Revert the rename.
--   2. Add a regex guard so the strict policies no-op (rather than
--      throw) on rows whose first folder isn't a UUID.
--
-- Idempotent.

-- ── 1. Revert the rename so blobs match metadata again ──────────────
do $$
declare
  r record;
  v_old_name text;
  v_moved int := 0;
begin
  for r in
    select o.id as obj_id, o.name as full_name,
           regexp_replace(o.name,
             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/(dvic/.+)$',
             '\1') as legacy_name
      from storage.objects o
     where o.bucket_id = 'driver-documents'
       and o.name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/dvic/'
  loop
    v_old_name := r.legacy_name;
    update storage.objects set name = v_old_name where id = r.obj_id;
    update public.vehicle_inspections
       set photos = (
         select jsonb_agg(case when p = r.full_name then v_old_name else p end)
           from jsonb_array_elements_text(photos) p)
     where photos @> to_jsonb(r.full_name);
    v_moved := v_moved + 1;
  end loop;
  raise notice 'Reverted % path(s) to legacy dvic/* form', v_moved;
end $$;

-- ── 2. Guard the strict driver-documents policies ──────────────────
drop policy if exists "driver_docs_tenant_select" on storage.objects;
create policy "driver_docs_tenant_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'driver-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and ((storage.foldername(name))[1])::uuid = private.current_dsp_id()
  );

drop policy if exists "driver_docs_tenant_delete" on storage.objects;
create policy "driver_docs_tenant_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'driver-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and ((storage.foldername(name))[1])::uuid = private.current_dsp_id()
  );

drop policy if exists "driver_docs_dvic_select" on storage.objects;
create policy "driver_docs_dvic_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'driver-documents'
    and name like '%/dvic/%'
    and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and ((storage.foldername(name))[1])::uuid = private.current_dsp_id()
  );

notify pgrst, 'reload schema';
