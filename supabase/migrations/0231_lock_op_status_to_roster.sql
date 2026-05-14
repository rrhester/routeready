-- Migration 0231 · Lock operational_status to the Fleet roster.
--
-- The Fleet roster's pill menu is the only operator-facing surface
-- that should change a van's operational status.  Two prior surfaces
-- in the per-van drawer (a quick-toggle in the head + a select in the
-- Overview tab) are gone from the UI as of this PR.
--
-- This migration tightens the server side so even an API client can't
-- update operational_status through vehicle_record_save once a van
-- already exists.  Setting it on INSERT (creating a new van) still
-- works — but on UPDATE the field is ignored.  The single supported
-- path for flipping status is vehicle_set_operational_status (added
-- in migration 0229), which writes a paired grounding event +
-- compliance_audit_events row.
--
-- Idempotent: safe to re-run.

create or replace function public.vehicle_record_save(
  p_id                     uuid    default null,
  p_name                   text    default null,
  p_nickname               text    default null,
  p_kind                   text    default 'van',
  p_status                 text    default 'active',
  p_ownership              text    default 'dsp_owned',
  p_operational_status     text    default 'operational',
  p_year                   int     default null,
  p_make                   text    default null,
  p_model                  text    default null,
  p_trim                   text    default null,
  p_color                  text    default null,
  p_vin                    text    default null,
  p_plate                  text    default null,
  p_plate_state            text    default null,
  p_mileage                int     default null,
  p_station_id             uuid    default null,
  p_in_service_on          date    default null,
  p_last_service_at        date    default null,
  p_last_service_note      text    default null,
  p_next_service_due_at    date    default null,
  p_dot_inspection_at      date    default null,
  p_registration_expires_on date   default null,
  p_insurance_expires_on   date    default null,
  p_notes                  text    default null
) returns public.vehicles
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_v public.vehicles;
  v_mileage_updated timestamptz;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if coalesce(p_status, 'active') not in ('active','spare','out_of_service','retired') then
    raise exception 'bad_status' using errcode = '22023';
  end if;
  if coalesce(p_ownership, 'dsp_owned') not in ('amazon_owned','dsp_owned','rental','leased') then
    raise exception 'bad_ownership' using errcode = '22023';
  end if;
  if p_operational_status is not null
     and coalesce(p_operational_status, 'operational') not in ('operational','grounded') then
    raise exception 'bad_op_status' using errcode = '22023';
  end if;

  if p_id is null then
    -- Create path · operational_status defaults to 'operational' on a
    -- new van.  This is the only path that may set it through this
    -- function; updates ignore the field below.
    insert into public.vehicles (
      dsp_id, name, nickname, kind, status, ownership, operational_status,
      year, make, model, trim_level, color, vin, plate, plate_state,
      mileage, mileage_updated_at, station_id, in_service_on,
      last_service_at, last_service_note, next_service_due_at,
      dot_inspection_at, registration_expires_on, insurance_expires_on,
      notes, created_by
    ) values (
      v_dsp,
      trim(p_name),
      nullif(trim(p_nickname), ''),
      coalesce(nullif(trim(p_kind), ''), 'van'),
      coalesce(p_status, 'active'),
      coalesce(p_ownership, 'dsp_owned'),
      coalesce(p_operational_status, 'operational'),
      p_year, nullif(trim(p_make), ''), nullif(trim(p_model), ''),
      nullif(trim(p_trim), ''), nullif(trim(p_color), ''),
      nullif(upper(trim(p_vin)), ''), nullif(upper(trim(p_plate)), ''), nullif(upper(trim(p_plate_state)), ''),
      p_mileage,
      case when p_mileage is not null then now() else null end,
      p_station_id,
      p_in_service_on,
      p_last_service_at, nullif(trim(p_last_service_note), ''), p_next_service_due_at,
      p_dot_inspection_at, p_registration_expires_on, p_insurance_expires_on,
      nullif(trim(p_notes), ''), auth.uid()
    )
    returning * into v_v;
  else
    -- mileage_updated_at bumps only when the mileage actually changed.
    select case when p_mileage is distinct from mileage and p_mileage is not null then now() else mileage_updated_at end
      into v_mileage_updated
      from public.vehicles where id = p_id and dsp_id = v_dsp;

    -- Update path · operational_status is intentionally NOT touched
    -- here.  Use vehicle_set_operational_status (migration 0229) for
    -- that — it writes the paired grounding event + audit row.
    update public.vehicles set
      name                   = trim(p_name),
      nickname               = nullif(trim(p_nickname), ''),
      kind                   = coalesce(nullif(trim(p_kind), ''), 'van'),
      status                 = coalesce(p_status, 'active'),
      ownership              = coalesce(p_ownership, 'dsp_owned'),
      year                   = p_year,
      make                   = nullif(trim(p_make), ''),
      model                  = nullif(trim(p_model), ''),
      trim_level             = nullif(trim(p_trim), ''),
      color                  = nullif(trim(p_color), ''),
      vin                    = nullif(upper(trim(p_vin)), ''),
      plate                  = nullif(upper(trim(p_plate)), ''),
      plate_state            = nullif(upper(trim(p_plate_state)), ''),
      mileage                = p_mileage,
      mileage_updated_at     = v_mileage_updated,
      station_id             = p_station_id,
      in_service_on          = p_in_service_on,
      last_service_at        = p_last_service_at,
      last_service_note      = nullif(trim(p_last_service_note), ''),
      next_service_due_at    = p_next_service_due_at,
      dot_inspection_at      = p_dot_inspection_at,
      registration_expires_on= p_registration_expires_on,
      insurance_expires_on   = p_insurance_expires_on,
      notes                  = nullif(trim(p_notes), ''),
      updated_at             = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_v;
    if v_v.id is null then raise exception 'vehicle_not_found' using errcode = 'P0002'; end if;
  end if;

  return v_v;
end;
$$;
grant execute on function public.vehicle_record_save(
  uuid, text, text, text, text, text, text,
  int, text, text, text, text, text, text, text,
  int, uuid, date, date, text, date, date, date, date, text
) to authenticated;
