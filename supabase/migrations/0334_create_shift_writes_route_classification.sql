-- Migration 0334 · create_shift writes route_classification
--
-- 0332 added the column. 0333 made it visible on the schedule grid.
-- This makes the create path persist it too — without this, the
-- "Add shift" modal could pick a Route type but the value would
-- silently drop on insert because the RPC didn't read it.
--
-- Verbatim copy of 0261's create_shift, plus route_classification
-- in the insert columns + values.

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
     route_classification, created_by)
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
     auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.create_shift(jsonb) to authenticated;
