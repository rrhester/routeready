-- Migration 0344 · create_shift accepts service_type_id
--
-- create_shift (0025 → 0261 → 0334) never read service_type_id from its
-- payload, so any shift created through it defaulted to no service type
-- (which renders as Standard Parcel). That dropped the service type on
-- the Add-shift card and on materialized shifts. Add service_type_id to
-- the payload + INSERT so every create path is typed at the source.
--
-- Verbatim copy of 0334's create_shift, plus service_type_id.
-- Idempotent.

create or replace function public.create_shift(p_payload jsonb)
returns public.shifts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.shifts;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.shifts
    (dsp_id, station_id, driver_id, date, starts_at, ends_at,
     route_code, status, notes, source, shift_kind,
     route_classification, service_type_id, created_by)
  values
    (v_dsp,
     (p_payload->>'station_id')::uuid,
     nullif(p_payload->>'driver_id','')::uuid,
     (p_payload->>'date')::date,
     nullif(p_payload->>'starts_at','')::timestamptz,
     nullif(p_payload->>'ends_at','')::timestamptz,
     p_payload->>'route_code',
     coalesce((p_payload->>'status')::public.shift_status, 'scheduled'),
     p_payload->>'notes',
     coalesce((p_payload->>'source')::public.shift_source, 'manual'),
     coalesce((p_payload->>'shift_kind')::public.shift_kind, 'regular'),
     nullif(p_payload->>'route_classification',''),
     nullif(p_payload->>'service_type_id','')::uuid,
     auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.create_shift(jsonb) to authenticated;

notify pgrst, 'reload schema';
