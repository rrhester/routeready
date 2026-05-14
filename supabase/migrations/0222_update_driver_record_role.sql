-- Migration 0222 · update_driver_record accepts role
--
-- Operators need to change a person's role from the driver record
-- drawer without dropping into SQL.  This extends update_driver_record
-- (last touched in 0051) to read `role` from the payload, validate it,
-- and persist.  The role determines which schedule the person appears
-- on (driver vs. staff) and which surfaces they show up in — that's
-- already enforced in 0221's filters; this migration just lets the
-- value be edited from the drawer.

create or replace function public.update_driver_record(p_id uuid, p_payload jsonb)
returns public.drivers
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_row  public.drivers;
  v_role text := nullif(p_payload->>'role', '');
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_role is not null and v_role not in ('driver','dispatcher','fleet_manager','hr','ops_manager','other') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  update public.drivers
     set first_name              = coalesce(p_payload->>'first_name', first_name),
         last_name               = coalesce(p_payload->>'last_name', last_name),
         full_name               = coalesce(p_payload->>'full_name', full_name),
         preferred_name          = coalesce(p_payload->>'preferred_name', preferred_name),
         pronouns                = coalesce(p_payload->>'pronouns', pronouns),
         phone                   = coalesce(p_payload->>'phone', phone),
         email                   = coalesce(p_payload->>'email', email),
         address                 = coalesce(p_payload->>'address', address),
         birthday                = coalesce(nullif(p_payload->>'birthday','')::date, birthday),
         emergency_contact_name  = coalesce(p_payload->>'emergency_contact_name', emergency_contact_name),
         emergency_contact_phone = coalesce(p_payload->>'emergency_contact_phone', emergency_contact_phone),
         hire_date               = coalesce(nullif(p_payload->>'hire_date','')::date, hire_date),
         status                  = coalesce((p_payload->>'status')::public.driver_status, status),
         tier                    = coalesce(p_payload->>'tier', tier),
         role                    = coalesce(v_role, role),
         dl_number               = coalesce(p_payload->>'dl_number', dl_number),
         dl_expires_on           = coalesce(nullif(p_payload->>'dl_expires_on','')::date, dl_expires_on),
         dot_certified           = coalesce((p_payload->>'dot_certified')::boolean, dot_certified),
         background_check_completed_at = coalesce(nullif(p_payload->>'background_check_completed_at','')::timestamptz, background_check_completed_at),
         drug_test_completed_at        = coalesce(nullif(p_payload->>'drug_test_completed_at','')::timestamptz, drug_test_completed_at),
         training_scheduled_at         = coalesce(nullif(p_payload->>'training_scheduled_at','')::timestamptz, training_scheduled_at),
         training_date                 = coalesce(nullif(p_payload->>'training_date','')::date, training_date),
         updated_at                    = now()
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;

  if v_row.id is null then raise exception 'driver_not_found'; end if;
  return v_row;
end;
$$;
grant execute on function public.update_driver_record(uuid, jsonb) to authenticated;


notify pgrst, 'reload schema';
