-- Migration 0233 · Lock van name (the "van number") on the Van
-- assignments board.  vehicle_upsert no longer updates name on an
-- existing van — name is owned by the Fleet record drawer.  Inserts
-- still set name (a name is required to create a van).
--
-- Status was already locked on UPDATE in migration 0232; this PR
-- finishes the job for the name field so the Workspaces board is
-- truly chains-and-notes only.
--
-- Idempotent.

create or replace function public.vehicle_upsert(
  p_id     uuid default null,
  p_name   text default null,
  p_kind   text default 'van',
  p_status text default 'active',
  p_notes  text default null
) returns public.vehicles
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_v public.vehicles;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_id is null and coalesce(trim(p_name), '') = '' then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if coalesce(p_status, 'active') not in ('active','spare','out_of_service','retired') then
    raise exception 'bad_status' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.vehicles (dsp_id, name, kind, status, notes, created_by)
    values (
      v_dsp, trim(p_name),
      coalesce(nullif(trim(p_kind), ''), 'van'),
      coalesce(p_status, 'active'),
      nullif(trim(p_notes), ''),
      auth.uid()
    )
    returning * into v_v;
  else
    -- Name + status intentionally NOT updated here.  Renames go through
    -- the Fleet record drawer (vehicle_record_save); status changes go
    -- through the Fleet roster pill (vehicle_set_operational_status).
    update public.vehicles set
      kind       = coalesce(nullif(trim(p_kind), ''), 'van'),
      notes      = nullif(trim(p_notes), ''),
      updated_at = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_v;
    if v_v.id is null then
      raise exception 'vehicle_not_found' using errcode = 'P0002';
    end if;
  end if;

  return v_v;
end;
$$;
grant execute on function public.vehicle_upsert(uuid, text, text, text, text) to authenticated;
