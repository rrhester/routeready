-- 0278_dvic_compare_surface_form_answers.sql
--
-- Surface completed DVIC form answers in the Fleet photo-review payload.
-- The dashboard uses these optional fields to show operators the driver's
-- submitted checklist alongside the before/after photo comparison.
--
-- Net change vs migration 0242:
--   • Current and previous inspection blocks gain `defects` and
--     `form_submission_id` so the modal can link back to the
--     driver-submitted DVIC form (and surface the defect map inline).
--   • No new columns; `vehicle_inspections.defects` (jsonb) and
--     `vehicle_inspections.form_submission_id` (uuid) already exist
--     since migrations 0080-era inspections + 0223.
--
-- Idempotent: `create or replace function` re-runs cleanly.


create or replace function public.vehicle_dvic_compare_pair(
  p_vehicle_id   uuid,
  p_inspection_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_cur public.vehicle_inspections;
  v_prev public.vehicle_inspections;
  v_veh record;
begin
  if v_dsp is null then return jsonb_build_object('error', 'no_dsp'); end if;

  select id, coalesce(nickname, name) as label, vin
    into v_veh
    from public.vehicles
   where id = p_vehicle_id and dsp_id = v_dsp;
  if not found then return jsonb_build_object('error', 'vehicle_not_found'); end if;

  if p_inspection_id is not null then
    select * into v_cur from public.vehicle_inspections
     where id = p_inspection_id and dsp_id = v_dsp and vehicle_id = p_vehicle_id;
  else
    select * into v_cur from public.vehicle_inspections
     where vehicle_id = p_vehicle_id and dsp_id = v_dsp
       and photos is not null and jsonb_array_length(coalesce(photos, '[]'::jsonb)) > 0
     order by inspected_at desc
     limit 1;
  end if;

  if v_cur.id is not null then
    v_prev := public._dvic_prev_inspection(p_vehicle_id, v_cur.inspected_at);
  end if;

  return jsonb_build_object(
    'vehicle', jsonb_build_object('id', v_veh.id, 'label', v_veh.label, 'vin', v_veh.vin),
    'current', case when v_cur.id is null then null else jsonb_build_object(
        'id',                v_cur.id,
        'inspected_at',      v_cur.inspected_at,
        'inspector_name',    v_cur.inspector_name,
        'kind',              v_cur.kind,
        'result',            v_cur.result,
        'mileage',           v_cur.mileage,
        'notes',             v_cur.notes,
        'defects',           coalesce(v_cur.defects, '{}'::jsonb),
        'form_submission_id', v_cur.form_submission_id,
        'photos',            coalesce(v_cur.photos, '[]'::jsonb),
        'ai_review_status',  v_cur.ai_review_status,
        'ai_review_at',      v_cur.ai_review_at,
        'ai_review_summary', v_cur.ai_review_summary,
        'ai_review_findings',coalesce(v_cur.ai_review_findings, '[]'::jsonb),
        'ai_review_model',   v_cur.ai_review_model,
        'ai_review_confidence', v_cur.ai_review_confidence,
        'reviewer_id',       v_cur.reviewer_id,
        'reviewed_at',       v_cur.reviewed_at,
        'reviewer_disposition', v_cur.reviewer_disposition,
        'reviewer_notes',    v_cur.reviewer_notes
      ) end,
    'previous', case when v_prev.id is null then null else jsonb_build_object(
        'id',             v_prev.id,
        'inspected_at',   v_prev.inspected_at,
        'inspector_name', v_prev.inspector_name,
        'kind',           v_prev.kind,
        'result',         v_prev.result,
        'mileage',        v_prev.mileage,
        'notes',          v_prev.notes,
        'defects',        coalesce(v_prev.defects, '{}'::jsonb),
        'form_submission_id', v_prev.form_submission_id,
        'photos',         coalesce(v_prev.photos, '[]'::jsonb)
      ) end,
    'storage_bucket', 'driver-documents'
  );
end $$;

grant execute on function public.vehicle_dvic_compare_pair(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
