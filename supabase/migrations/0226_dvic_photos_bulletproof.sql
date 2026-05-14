-- Migration 0226 · DVIC — bulletproof photo rendering
--
-- Combines everything the photo pipeline needs into one idempotent
-- migration that's safe to run on any state of the previous DVIC
-- migrations (0223 / 0224 / 0225).  Three things:
--
--   1. Backfill missing inspections.  Any DVIC form_submissions that
--      didn't land an inspection (because 0223 wasn't applied at the
--      time, or no van resolved, etc.) get one created now if a
--      vehicle still resolves.
--   2. Re-home legacy `dvic/*` storage paths to `<dsp_id>/dvic/*` and
--      update the matching vehicle_inspections.photos entries.
--   3. Add a permissive SELECT policy on driver-documents that allows
--      a dispatcher to read ANY object referenced in their DSP's
--      vehicle_inspections.photos — independent of path prefix.
--      This is the safety net for legacy paths the re-home block
--      couldn't move (e.g. the object was deleted but the inspection
--      row still references it).


-- ── 1. Backfill missing DVIC inspections ────────────────────────────
do $$
declare s record; v_form public.forms; v_drv public.drivers;
        v_van_id uuid; v_photo_paths jsonb; v_today date;
        v_made int := 0;
begin
  for s in
    select fs.id, fs.form_id, fs.driver_id, fs.dsp_id, fs.answers, fs.submitted_at
      from public.form_submissions fs
      join public.forms f on f.id = fs.form_id
     where coalesce((f.settings->>'is_dvic')::boolean, false) = true
       and not exists (
         select 1 from public.vehicle_inspections vi
          where vi.form_submission_id = fs.id
       )
     order by fs.submitted_at asc
  loop
    v_form := (select row(forms.*)::public.forms from public.forms forms where forms.id = s.form_id);
    v_drv  := (select row(drivers.*)::public.drivers from public.drivers drivers where drivers.id = s.driver_id);
    v_today := s.submitted_at::date;
    if v_drv.role is distinct from 'driver' then
      continue;
    end if;

    -- Same resolver order as driver_submit_form (override → primary → backup)
    select coalesce(
      (select v.id from public.vehicles v
         join public.vehicle_day_assignments oa
           on oa.vehicle_id = v.id and oa.driver_id = v_drv.id and oa.date = v_today
        where v.dsp_id = v_drv.dsp_id and v.archived_at is null limit 1),
      (select v.id from public.vehicles v
         join public.vehicle_driver_assignments a
           on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank = 0
        where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
          and not exists (select 1 from public.vehicle_day_assignments oa
                          where oa.vehicle_id = v.id and oa.date = v_today)
        order by v.name limit 1),
      (select v.id from public.vehicles v
         join public.vehicle_driver_assignments a
           on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank > 0
         left join public.vehicle_driver_assignments pri_a
           on pri_a.vehicle_id = v.id and pri_a.rank = 0
        where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
          and not exists (select 1 from public.vehicle_day_assignments oa
                          where oa.vehicle_id = v.id and oa.date = v_today)
          and (pri_a.driver_id is null
            or not exists (
              select 1 from public.shifts ps
              where ps.driver_id = pri_a.driver_id
                and ps.date = v_today and ps.dsp_id = v_drv.dsp_id
                and ps.status in ('scheduled','completed','late')
            ))
        order by a.rank, v.name limit 1)
    ) into v_van_id;

    -- If the driver doesn't have a chain at all, fall back to the
    -- first active van in the DSP so the backfill isn't blocked by a
    -- missing chain.  Operators can reassign on the drawer.
    if v_van_id is null then
      select id into v_van_id from public.vehicles
       where dsp_id = v_drv.dsp_id and status = 'active' and archived_at is null
       order by name limit 1;
    end if;

    if v_van_id is null then continue; end if;

    -- Extract photo paths.  Iterate every field on the form whose
    -- type is 'photo' or 'file' (some operators built the form with
    -- the wrong type — accept both for backfill).
    select coalesce(jsonb_agg(p), '[]'::jsonb) into v_photo_paths
      from (
        select s.answers -> (f->>'id') ->> 'path' as p
        from jsonb_array_elements(coalesce(v_form.fields, '[]'::jsonb)) f
        where (f->>'type' in ('photo','file'))
          and (s.answers -> (f->>'id') ->> 'path') is not null
      ) sub
      where p is not null;

    insert into public.vehicle_inspections (
      dsp_id, vehicle_id, inspector_driver_id, inspector_name,
      inspected_at, kind, result, defects, photos, form_submission_id
    ) values (
      s.dsp_id, v_van_id, v_drv.id,
      coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
      s.submitted_at, 'dvic', 'passed',
      coalesce(s.answers, '{}'::jsonb),
      v_photo_paths,
      s.id
    );
    v_made := v_made + 1;
    raise notice 'DVIC backfill: submission % → inspection on vehicle %', s.id, v_van_id;
  end loop;
  raise notice 'DVIC backfill complete · % inspection(s) created', v_made;
end $$;


-- ── 2. Re-home legacy dvic/* storage paths (idempotent) ─────────────
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


-- ── 3. Permissive SELECT policy: dispatchers read any photo their
--      DSP's inspections reference, no matter the path prefix.
--      This is the safety net.  Reads only — no insert/delete grant.
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
