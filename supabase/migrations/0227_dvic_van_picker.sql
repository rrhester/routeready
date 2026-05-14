-- Migration 0227 · DVIC — explicit "van picker" field becomes the
-- inspection's authoritative van
--
-- The previous design tied the DVIC's inspection to the driver's
-- system-resolved van (from the standing chain + per-day overrides).
-- Real ops drifts away from the schedule constantly — late swaps,
-- spare grabs, dispatcher edits after the driver started — so the
-- inspection ends up on the wrong van and the compliance trail is
-- bad.
--
-- This migration adds a first-class "van_picker" field type that the
-- form builder can drop into a DVIC.  Driver picks the van they're
-- standing next to from a searchable list; that pick becomes the
-- inspection's vehicle_id (authoritative) and ALSO writes a per-day
-- override so the rest of the system (Today's roster, driver app's
-- "your van today") aligns with reality going forward.
--
-- Three RPCs:
--   1. driver_list_vehicles(token)      — searchable list for the form
--   2. driver_submit_form (rewritten)   — honors the picker answer
--   3. driver_resolve_van_today (existing, 0223) — used for pre-fill


-- ── 1. driver_list_vehicles ─────────────────────────────────────────
-- Returns every van the driver could plausibly be inspecting today
-- (active + spare, not archived) so the form picker can populate.
create or replace function public.driver_list_vehicles(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',          v.id,
      'name',        v.name,
      'plate',       v.plate,
      'plate_state', v.plate_state,
      'vin',         v.vin,
      'year',        v.year,
      'make',        v.make,
      'model',       v.model,
      'color',       v.color,
      'station_id',  v.station_id,
      'status',      v.status
    ) order by v.name)
    from public.vehicles v
    where v.dsp_id = v_drv.dsp_id
      and v.archived_at is null
      and v.status in ('active','spare')
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.driver_list_vehicles(text) to anon, authenticated;


-- ── 2. driver_submit_form — picker answer wins ──────────────────────
-- Behavior:
--   • Walks v_form.fields, finds the first field of type='van_picker'
--   • Reads answers[field_id].vehicle_id
--   • Validates that vehicle is on the DSP and not archived
--   • Uses that vehicle_id as the inspection's vehicle_id
--   • If the picked van differs from the system-resolved van, writes
--     a per-day override (vehicle_day_assignments) for today so the
--     rest of the system reflects the actual van
--   • Falls back to the resolver chain only when no van_picker field
--     exists OR the answer doesn't have a vehicle_id
create or replace function public.driver_submit_form(
  p_token text, p_form_id uuid, p_answers jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv      public.drivers;
  v_form     public.forms;
  v_row      public.form_submissions;
  v_is_dvic  boolean;
  v_van_id   uuid;
  v_resolved_van_id uuid;
  v_picker_field jsonb;
  v_picker_vid   uuid;
  v_photo_paths jsonb := '[]'::jsonb;
  v_inspection_id uuid;
  v_today    date := current_date;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_form from public.forms
   where id = p_form_id and dsp_id = v_drv.dsp_id and status = 'published';
  if v_form.id is null then raise exception 'form_not_found' using errcode = 'P0001'; end if;

  if coalesce((v_form.settings->>'once_per_driver')::boolean, false) then
    if exists (select 1 from public.form_submissions
                where form_id = p_form_id and driver_id = v_drv.id) then
      raise exception 'already_submitted' using errcode = 'P0001';
    end if;
  end if;

  insert into public.form_submissions (dsp_id, form_id, driver_id, answers)
  values (v_drv.dsp_id, p_form_id, v_drv.id, coalesce(p_answers, '{}'::jsonb))
  returning * into v_row;

  v_is_dvic := coalesce((v_form.settings->>'is_dvic')::boolean, false);

  if v_is_dvic and v_drv.role = 'driver' then
    -- Pre-resolve via the standing chain so we can detect a mismatch
    -- when the driver picked a different van.
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
    ) into v_resolved_van_id;

    -- Look for an explicit van_picker answer.  It wins.
    select f, (v_row.answers -> (f->>'id') ->> 'vehicle_id')::uuid
      into v_picker_field, v_picker_vid
      from jsonb_array_elements(coalesce(v_form.fields, '[]'::jsonb)) f
      where f->>'type' = 'van_picker'
      limit 1;

    if v_picker_vid is not null then
      -- Validate the picker answer is a real van on this DSP.
      if exists (
        select 1 from public.vehicles
        where id = v_picker_vid and dsp_id = v_drv.dsp_id and archived_at is null
      ) then
        v_van_id := v_picker_vid;

        -- Self-heal: if the driver picked a different van than the
        -- resolver expected, write a per-day override so the rest of
        -- the system (Today's roster, driver-app schedule) reflects
        -- reality from this submission onward.  No-op when picker
        -- agrees with resolver.
        if v_van_id is distinct from v_resolved_van_id then
          insert into public.vehicle_day_assignments (
            dsp_id, vehicle_id, driver_id, date, source, notes
          ) values (
            v_drv.dsp_id, v_van_id, v_drv.id, v_today,
            'dvic_picker', 'auto-set from DVIC van picker'
          )
          on conflict (driver_id, date) do update
            set vehicle_id = excluded.vehicle_id,
                source     = excluded.source,
                notes      = excluded.notes,
                updated_at = now();
        end if;
      else
        -- Picker answer points at a van that isn't on this DSP — fall
        -- through to the resolver as a defensive measure.
        v_van_id := v_resolved_van_id;
      end if;
    else
      v_van_id := v_resolved_van_id;
    end if;

    if v_van_id is not null then
      -- Extract photo paths (same as 0226 — accept photo and file).
      select coalesce(jsonb_agg(p), '[]'::jsonb) into v_photo_paths
        from (
          select v_row.answers -> (f->>'id') ->> 'path' as p
          from jsonb_array_elements(coalesce(v_form.fields, '[]'::jsonb)) f
          where (f->>'type' in ('photo','file'))
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
        'dvic', 'passed',
        coalesce(v_row.answers, '{}'::jsonb),
        v_photo_paths,
        v_row.id
      ) returning id into v_inspection_id;
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


notify pgrst, 'reload schema';
