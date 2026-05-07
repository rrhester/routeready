-- 0078_service_type_certs.sql
--
-- Service-type certification gating for Smart Fill.
--
-- Adds:
--   1. drivers.xl_certified — second cert flag alongside dot_certified.
--   2. service_types.requires_dot / requires_xl — per-type gates.
--   3. A new "STEP" service type per DSP (Step Vans), seeded as
--      requires_dot=true and inactive by default.
--   4. Existing XL service-type rows updated to requires_xl=true.
--   5. update_driver_record accepts xl_certified from the payload.
--
-- Smart Fill (autoAssignDriversForWeek in live.js) reads these gates
-- when assigning drivers — only drivers holding the required cert(s)
-- become eligible for shifts whose service_type carries the
-- corresponding requires_* flag.

-- 1. drivers.xl_certified
alter table public.drivers
  add column if not exists xl_certified boolean not null default false;


-- 2. service_types cert columns
alter table public.service_types
  add column if not exists requires_dot boolean not null default false,
  add column if not exists requires_xl  boolean not null default false;


-- 3. Flag XL service types as requires_xl=true
update public.service_types
   set requires_xl = true
 where code = 'XL';


-- 4. Insert STEP service type per DSP
insert into public.service_types (dsp_id, code, label, color, sort_order, active, requires_dot)
select d.id, 'STEP', 'Step Vans', '#0EA5E9', 4, false, true
from public.dsps d
on conflict (dsp_id, code) do update
  set requires_dot = excluded.requires_dot;


-- 5. Auto-seed for newly created DSPs
create or replace function private.tg_dsp_seed_service_types()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.service_types (dsp_id, code, label, color, sort_order, active, requires_dot, requires_xl) values
    (NEW.id, 'SP',   'Standard Parcel', '#3b82f6', 0, true,  false, false),
    (NEW.id, 'XL',   'Extra Large',     '#f97316', 1, false, false, true),
    (NEW.id, 'HUB',  'Hub',             '#10b981', 2, false, false, false),
    (NEW.id, 'ASU',  'ASU',             '#a855f7', 3, false, false, false),
    (NEW.id, 'STEP', 'Step Vans',       '#0EA5E9', 4, false, true,  false)
  on conflict (dsp_id, code) do nothing;
  return NEW;
end;
$$;

drop trigger if exists trg_dsp_seed_service_types on public.dsps;
create trigger trg_dsp_seed_service_types
  after insert on public.dsps
  for each row execute function private.tg_dsp_seed_service_types();


-- 6. update_driver_record — accept xl_certified.  The existing function
-- returns public.drivers; CREATE OR REPLACE can't change the return type
-- so we drop it first.  Everything else mirrors the prior body
-- (migration 0051) plus the xl_certified line.
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
