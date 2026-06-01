-- 0349_helper_service_type.sql
--
-- Add "Helper" as a selectable service type (route category), alongside
-- SP / XL / HUB / ASU / STEP / EDV. Operator request: "I need to add helper
-- routes as a service type."
--
-- Same pattern as STEP (0078) and EDV (0323):
--   1. Seed a HELPER row for every existing DSP — inactive by default, so it
--      shows up as a toggle row in Scheduling Settings → Service Types but
--      doesn't add demand/shift buckets until the operator turns it on (one
--      click in that panel, exactly like XL/HUB/ASU).
--   2. Extend tg_dsp_seed_service_types so newly created DSPs get it too.
--
-- No cert gate: a helper rides along / supports, so requires_dot / requires_xl
-- / requires_edv all stay false — Smart Fill won't gate eligibility on a cert
-- for helper routes. The Settings panel lists service types dynamically from
-- list_service_types (filtering only EDV/STEP), so this row appears with no JS
-- change. color/label are sensible defaults the operator can rename/recolor
-- in-panel (set_service_type) without a migration.
--
-- Idempotent: on conflict do nothing (won't clobber an operator-renamed row
-- if re-run) + create or replace for the trigger function.

insert into public.service_types
  (dsp_id, code, label, color, sort_order, active, requires_dot, requires_xl, requires_edv)
select d.id, 'HELPER', 'Helper', '#EC4899', 6, false, false, false, false
from public.dsps d
on conflict (dsp_id, code) do nothing;


create or replace function private.tg_dsp_seed_service_types()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.service_types (dsp_id, code, label, color, sort_order, active, requires_dot, requires_xl, requires_edv) values
    (NEW.id, 'SP',     'Standard Parcel', '#3b82f6', 0, true,  false, false, false),
    (NEW.id, 'XL',     'Extra Large',     '#f97316', 1, false, false, true,  false),
    (NEW.id, 'HUB',    'Hub',             '#10b981', 2, false, false, false, false),
    (NEW.id, 'ASU',    'ASU',             '#a855f7', 3, false, false, false, false),
    (NEW.id, 'STEP',   'Step Vans',       '#0EA5E9', 4, false, true,  false, false),
    (NEW.id, 'EDV',    'Electric Vans',   '#22C55E', 5, false, false, false, true),
    (NEW.id, 'HELPER', 'Helper',          '#EC4899', 6, false, false, false, false)
  on conflict (dsp_id, code) do nothing;
  return NEW;
end;
$$;

drop trigger if exists trg_dsp_seed_service_types on public.dsps;
create trigger trg_dsp_seed_service_types
  after insert on public.dsps
  for each row execute function private.tg_dsp_seed_service_types();

notify pgrst, 'reload schema';
