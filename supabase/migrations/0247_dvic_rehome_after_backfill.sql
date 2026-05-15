-- Migration 0247 · Re-run the DVIC photo re-home after our backfill.
--
-- Migration 0226 moved any storage.objects under `dvic/*` to
-- `<dsp_id>/dvic/*` so the strict driver-documents RLS policy (which
-- expects a DSP-UUID first segment) can read them without throwing
-- "invalid input syntax for type uuid: dvic".  But 0226 was a
-- one-time pass.  Subsequent backfills of vehicle_inspections (from
-- the DVIC AI rollout) re-introduced photo paths under the legacy
-- prefix, so the dashboard's signed-URL call started failing again
-- with the same UUID cast error.
--
-- Re-run the rename idempotently so it covers anything that's landed
-- since 0226.  Also re-issue the permissive SELECT policy as a
-- safety net in case it got dropped somewhere along the way.

do $$
declare
  r record;
  v_new_name text;
  v_moved int := 0;
begin
  for r in
    select distinct o.id    as obj_id,
           o.name           as old_name,
           v.dsp_id         as dsp_id
      from storage.objects o
      join public.vehicle_inspections vi on vi.photos @> to_jsonb(o.name)
      join public.vehicles v on v.id = vi.vehicle_id
     where o.bucket_id = 'driver-documents'
       and o.name like 'dvic/%'
  loop
    v_new_name := r.dsp_id::text || '/' || r.old_name;
    begin
      update storage.objects
         set name = v_new_name
       where id = r.obj_id and bucket_id = 'driver-documents';
      update public.vehicle_inspections
         set photos = (
           select jsonb_agg(case when p = r.old_name then v_new_name else p end)
             from jsonb_array_elements_text(photos) p
         )
       where photos @> to_jsonb(r.old_name);
      v_moved := v_moved + 1;
    exception when others then
      raise notice 'rehome skip % : %', r.old_name, sqlerrm;
    end;
  end loop;
  raise notice 'rehome complete · % object(s) moved', v_moved;
end $$;

-- Permissive safety-net policy (mirror of 0226, re-issued).
drop policy if exists "driver_docs_inspection_select" on storage.objects;
create policy "driver_docs_inspection_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'driver-documents'
    and exists (
      select 1
        from public.vehicle_inspections vi
        join public.vehicles v on v.id = vi.vehicle_id
       where v.dsp_id = private.current_dsp_id()
         and private.is_staff(v.dsp_id, 'dispatcher')
         and vi.photos @> to_jsonb(storage.objects.name)
    )
  );

notify pgrst, 'reload schema';
