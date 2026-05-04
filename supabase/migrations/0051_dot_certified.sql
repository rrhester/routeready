-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0051 · drivers.dot_certified
--
-- Adds a single boolean to the driver record so the DSP can mark drivers
-- that hold a current DOT certification. The driver-record drawer gets
-- a new "DOT" tab with one checkbox; this is the schema + RPC support
-- for that field. Future phases will use this to gate DOT-restricted
-- shifts, expose an expiration date, etc., but for now it's a flag the
-- operator manages by hand.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.drivers
  add column if not exists dot_certified boolean not null default false;


-- update_driver_record: accept dot_certified from the payload. Existing
-- columns kept verbatim — coalesce path so an unspecified field doesn't
-- overwrite the stored value.
create or replace function public.update_driver_record(p_id uuid, p_payload jsonb)
returns public.drivers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.drivers;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
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
         dl_number               = coalesce(p_payload->>'dl_number', dl_number),
         dl_expires_on           = coalesce(nullif(p_payload->>'dl_expires_on','')::date, dl_expires_on),
         dot_certified           = coalesce((p_payload->>'dot_certified')::boolean, dot_certified),
         background_check_completed_at = coalesce(nullif(p_payload->>'background_check_completed_at','')::timestamptz, background_check_completed_at),
         drug_test_completed_at        = coalesce(nullif(p_payload->>'drug_test_completed_at','')::timestamptz, drug_test_completed_at),
         training_scheduled_at         = coalesce(nullif(p_payload->>'training_scheduled_at','')::timestamptz, training_scheduled_at),
         training_date                 = coalesce(nullif(p_payload->>'training_date','')::date, training_date)
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;

  if v_row.id is null then raise exception 'driver_not_found'; end if;
  return v_row;
end;
$$;
grant execute on function public.update_driver_record(uuid, jsonb) to authenticated;
