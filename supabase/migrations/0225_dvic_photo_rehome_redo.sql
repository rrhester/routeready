-- Migration 0225 · DVIC — re-home legacy photos (correlated-join fix)
--
-- Migration 0224 tried to re-home pre-fix DVIC photo objects from
-- `dvic/...` to `<dsp_id>/dvic/...` but used a correlated subquery
-- inside a JOIN ON, which in Postgres silently matches zero rows when
-- the inner subquery can't see the outer alias.  The result: the
-- migration ran without error but moved nothing, so existing
-- dispatchers still get 403 on the thumbnails.
--
-- This redo uses jsonb containment (`@>`) so the join is a real
-- equality check between storage.objects.name and a member of
-- vehicle_inspections.photos.  Also adds NOTICE logging so the user
-- can see what actually moved.

do $$
declare r record; v_new_name text; v_moved int := 0;
begin
  for r in
    select o.id          as obj_id,
           o.name        as old_name,
           vi.id         as inspection_id,
           v.dsp_id      as dsp_id
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
      raise notice 'DVIC re-home: % → %', r.old_name, v_new_name;
    exception when others then
      raise notice 'DVIC re-home skip % : %', r.old_name, sqlerrm;
    end;
  end loop;

  raise notice 'DVIC re-home complete · % object(s) moved', v_moved;
end $$;


notify pgrst, 'reload schema';
