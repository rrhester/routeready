-- 0323_edv_cert.sql
--
-- Electric Delivery Vehicle (EDV) certification gating for Smart Fill.
--
-- Mirrors the DOT/XL pattern from migration 0078:
--   1. drivers.edv_certified — third cert flag alongside dot_certified
--      and xl_certified.
--   2. service_types.requires_edv — per-type gate.
--   3. A new "EDV" service type per DSP (Electric Vans), seeded as
--      requires_edv=true and inactive by default — the operator turns
--      it on under Targets rules when they're ready to dispatch EDV.
--   4. tg_dsp_seed_service_types updated so new DSPs get EDV too.
--   5. update_driver_record accepts edv_certified from the payload.
--
-- Smart Fill (autoAssignDriversForWeek in live.js) honors the new gate
-- the same way it already does for DOT/XL — a driver is only eligible
-- for a requires_edv shift when their edv_certified=true.
--
-- Idempotent.

-- 1. drivers.edv_certified
alter table public.drivers
  add column if not exists edv_certified boolean not null default false;


-- 2. service_types.requires_edv
alter table public.service_types
  add column if not exists requires_edv boolean not null default false;


-- 3. Insert EDV service type per existing DSP
insert into public.service_types (dsp_id, code, label, color, sort_order, active, requires_edv)
select d.id, 'EDV', 'Electric Vans', '#22C55E', 5, false, true
from public.dsps d
on conflict (dsp_id, code) do update
  set requires_edv = excluded.requires_edv;


-- 4. Auto-seed for newly created DSPs — include the EDV row alongside
--    the existing five.
create or replace function private.tg_dsp_seed_service_types()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.service_types (dsp_id, code, label, color, sort_order, active, requires_dot, requires_xl, requires_edv) values
    (NEW.id, 'SP',   'Standard Parcel', '#3b82f6', 0, true,  false, false, false),
    (NEW.id, 'XL',   'Extra Large',     '#f97316', 1, false, false, true,  false),
    (NEW.id, 'HUB',  'Hub',             '#10b981', 2, false, false, false, false),
    (NEW.id, 'ASU',  'ASU',             '#a855f7', 3, false, false, false, false),
    (NEW.id, 'STEP', 'Step Vans',       '#0EA5E9', 4, false, true,  false, false),
    (NEW.id, 'EDV',  'Electric Vans',   '#22C55E', 5, false, false, false, true)
  on conflict (dsp_id, code) do nothing;
  return NEW;
end;
$$;

drop trigger if exists trg_dsp_seed_service_types on public.dsps;
create trigger trg_dsp_seed_service_types
  after insert on public.dsps
  for each row execute function private.tg_dsp_seed_service_types();


-- 5. update_driver_record — accept edv_certified.  CREATE OR REPLACE
-- can't change the return type, so drop + re-create.  Body mirrors the
-- prior version (migration 0078) plus the edv_certified line.
drop function if exists public.update_driver_record(uuid, jsonb);

create function public.update_driver_record(p_id uuid, p_payload jsonb)
returns public.drivers
language plpgsql security definer set search_path = ''
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
         xl_certified            = coalesce((p_payload->>'xl_certified')::boolean, xl_certified),
         edv_certified           = coalesce((p_payload->>'edv_certified')::boolean, edv_certified),
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

notify pgrst, 'reload schema';
