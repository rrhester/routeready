-- Migration 0223 · DVIC — form submission auto-creates a vehicle_inspection
--
-- DSPs already build their morning Delivery Vehicle Inspection Checklist
-- (DVIC) as a form in Workspaces → Forms.  Drivers fill it in the
-- driver app.  Today the submission lands in form_submissions and the
-- van's Inspections tab knows nothing about it — operators have to
-- look in two places to know whether the van was inspected.
--
-- This migration ties the two surfaces together:
--   1. forms.settings.is_dvic = true marks a form as a DVIC.
--   2. driver_submit_form, when submitting a DVIC, resolves the
--      driver's van for today and writes a vehicle_inspections row
--      that links back to the submission.  Photo paths from answers
--      land in vehicle_inspections.photos so they appear in the
--      Inspections tab thumbnail strip.
--   3. vehicle_inspections.form_submission_id surfaces the linkage on
--      the Inspections tab so the dispatcher can open the full form
--      submission to see every answer.


-- ── 1. form_submission_id on vehicle_inspections ────────────────────
alter table public.vehicle_inspections
  add column if not exists form_submission_id uuid references public.form_submissions(id) on delete set null;
create index if not exists vehicle_inspections_submission_idx
  on public.vehicle_inspections (form_submission_id);


-- ── 2. driver_submit_form auto-creates DVIC inspection ──────────────
-- Resolution mirrors driver_vehicle_days (0187, 0221):
--   1. per-day override
--   2. standing primary on an active van
--   3. standing backup whose primary isn't on today
-- If no van resolves, the submission still saves but no inspection
-- row is created (operator sees the submission in form_submissions
-- with no matching inspection — that's the gap signal).
create or replace function public.driver_submit_form(
  p_token text,
  p_form_id uuid,
  p_answers jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv      public.drivers;
  v_form     public.forms;
  v_row      public.form_submissions;
  v_is_dvic  boolean;
  v_van_id   uuid;
  v_photo_paths jsonb := '[]'::jsonb;
  v_inspection_id uuid;
  v_today    date := current_date;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_form from public.forms
   where id = p_form_id and dsp_id = v_drv.dsp_id and status = 'published';
  if v_form.id is null then raise exception 'form_not_found' using errcode = 'P0001'; end if;

  if coalesce((v_form.settings->>'once_per_driver')::boolean, false) then
    if exists (
      select 1 from public.form_submissions
       where form_id = p_form_id and driver_id = v_drv.id
    ) then
      raise exception 'already_submitted' using errcode = 'P0001';
    end if;
  end if;

  insert into public.form_submissions (dsp_id, form_id, driver_id, answers)
  values (v_drv.dsp_id, p_form_id, v_drv.id, coalesce(p_answers, '{}'::jsonb))
  returning * into v_row;

  v_is_dvic := coalesce((v_form.settings->>'is_dvic')::boolean, false);

  if v_is_dvic and v_drv.role = 'driver' then
    -- Resolve the driver's van for today (override → primary → backup).
    select coalesce(
      (select v.id from public.vehicles v
         join public.vehicle_day_assignments oa
           on oa.vehicle_id = v.id and oa.driver_id = v_drv.id and oa.date = v_today
        where v.dsp_id = v_drv.dsp_id and v.archived_at is null
        limit 1),
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

    if v_van_id is not null then
      -- Extract photo paths from answers.  Each form field of type
      -- 'photo' has an answer like {"path": "<bucket-path>", ...}.
      select coalesce(jsonb_agg(p), '[]'::jsonb) into v_photo_paths
        from (
          select v_row.answers -> (f->>'id') ->> 'path' as p
          from jsonb_array_elements(coalesce(v_form.fields, '[]'::jsonb)) f
          where f->>'type' = 'photo'
            and (v_row.answers -> (f->>'id') ->> 'path') is not null
        ) sub
        where p is not null;

      insert into public.vehicle_inspections (
        dsp_id, vehicle_id, inspector_driver_id, inspector_name,
        inspected_at, kind, result, defects, photos, form_submission_id
      ) values (
        v_drv.dsp_id, v_van_id, v_drv.id,
        coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
        v_row.submitted_at,
        'dvic', 'passed',                              -- result derivation comes in a follow-up
        coalesce(v_row.answers, '{}'::jsonb),
        v_photo_paths,
        v_row.id
      )
      returning id into v_inspection_id;
    end if;
  end if;

  return jsonb_build_object(
    'id',             v_row.id,
    'submitted_at',   v_row.submitted_at,
    'inspection_id',  v_inspection_id,
    'vehicle_id',     v_van_id,
    'is_dvic',        v_is_dvic
  );
end;
$$;
grant execute on function public.driver_submit_form(text, uuid, jsonb) to anon, authenticated;


-- ── 3. driver_resolve_van_today — used by the app pre-submit ────────
-- The driver app needs the van id BEFORE upload so it can build a
-- storage path like dvic/<vehicle_id>/<filename>.  Returns null when
-- no van resolves (the driver isn't scheduled today, isn't on a chain,
-- or all candidate vans are out of service / archived).
create or replace function public.driver_resolve_van_today(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_van_id uuid;
  v_van_name text;
  v_today date := current_date;
begin
  v_drv := private.driver_validate_token(p_token);
  if v_drv.role is distinct from 'driver' then
    return jsonb_build_object('vehicle_id', null, 'vehicle_name', null);
  end if;

  select id, name into v_van_id, v_van_name from public.vehicles
  where id = coalesce(
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
  );

  return jsonb_build_object('vehicle_id', v_van_id, 'vehicle_name', v_van_name);
end;
$$;
grant execute on function public.driver_resolve_van_today(text) to anon, authenticated;


notify pgrst, 'reload schema';
