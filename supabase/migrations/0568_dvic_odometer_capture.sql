-- Migration 0568 · DVIC odometer capture → mileage ledger
--
-- Product-audit #90 / fleet-inventory follow-up (docs/FLEET-SYSTEM.md §5).
-- The PM engine (0539) runs on mileage and calendar axes, but the only
-- mileage sources were manual dashboard readings, PM completions, and
-- repair returns-to-service. The richest daily signal — the driver's
-- morning DVIC — captured nothing.
--
-- Fix, WITHOUT re-issuing driver_submit_form (its 0223 body has been
-- hardened by 0436/0439/0445 — re-issuing it is the vehicles_roster-0345
-- hazard class): two triggers on vehicle_inspections.
--
--   1. BEFORE INSERT · when the row arrives with no mileage but links a
--      form submission (the DVIC path), find a numeric answer whose
--      field id or label names the odometer ("Odometer", "mileage", …)
--      and stamp it onto the inspection. Best-effort — any surprise in
--      the answers shape leaves the row exactly as submitted.
--   2. AFTER INSERT · any inspection that carries mileage (driver DVIC
--      or the dashboard's Log-inspection modal) writes a
--      vehicle_mileage_log row (source 'inspection') and ratchets
--      vehicles.mileage upward — same only-up rule as
--      vehicle_mileage_log_save. The RPC itself isn't callable here:
--      it resolves the tenant via private.current_dsp_id(), which is
--      null in the driver-token context this trigger fires under, so
--      the trigger writes the ledger directly with NEW.dsp_id.
--
-- Operator setup: add a numeric question named/labelled "Odometer" (or
-- "Mileage") to the DVIC form. No question → triggers no-op, exactly as
-- before. Standard triggers skip under session_replication_role =
-- 'replica' (seeds/tests), as usual. Idempotent — safe to re-run.

-- ── 1 · BEFORE INSERT: pull the odometer out of the DVIC answers ────
create or replace function private.vehicle_inspections_capture_odometer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ans    jsonb;
  v_fields jsonb;
  v_key    text;
  v_raw    text;
  v_mi     bigint;
begin
  if new.mileage is not null or new.form_submission_id is null then
    return new;
  end if;

  select fs.answers, f.fields
    into v_ans, v_fields
    from public.form_submissions fs
    left join public.forms f on f.id = fs.form_id
   where fs.id = new.form_submission_id;
  if v_ans is null or jsonb_typeof(v_ans) <> 'object' then
    return new;
  end if;

  -- Prefer a form field whose id or label names the odometer; fall back
  -- to any answer key that matches (covers hand-edited forms whose
  -- field defs drifted from the stored answers).
  select coalesce(
    (select fld->>'id'
       from jsonb_array_elements(coalesce(v_fields, '[]'::jsonb)) fld
      where (coalesce(fld->>'id', '')    ~* '(odometer|mileage)'
          or coalesce(fld->>'label', '') ~* '(odometer|mileage)')
        and v_ans ? (fld->>'id')
      limit 1),
    (select k from jsonb_object_keys(v_ans) k
      where k ~* '(odometer|mileage)'
      limit 1)
  ) into v_key;
  if v_key is null then return new; end if;

  v_raw := case jsonb_typeof(v_ans -> v_key)
             when 'number' then v_ans ->> v_key
             when 'string' then v_ans ->> v_key
             else null
           end;
  -- Strip ONLY thousands separators/whitespace, then require a plain
  -- positive integer. Deleting every non-digit would corrupt instead of
  -- reject: "12345.5" → 123455 (inflated, and the only-up ratchet locks
  -- it in) and "-123" → 123. Fractional/negative/exponent → no capture.
  v_raw := regexp_replace(btrim(coalesce(v_raw, '')), '[, ]', '', 'g');
  if v_raw !~ '^[0-9]{1,7}$' then return new; end if;
  v_mi := v_raw::bigint;
  if v_mi >= 1 and v_mi <= 2000000 then
    new.mileage := v_mi::int;
  end if;
  return new;
exception when others then
  -- Capture is best-effort — never block the inspection itself.
  return new;
end;
$$;

drop trigger if exists vehicle_inspections_capture_odometer on public.vehicle_inspections;
create trigger vehicle_inspections_capture_odometer
  before insert on public.vehicle_inspections
  for each row execute function private.vehicle_inspections_capture_odometer();


-- ── 2 · AFTER INSERT: feed the mileage ledger + ratchet the van ─────
create or replace function private.vehicle_inspections_log_mileage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.mileage is null or new.vehicle_id is null or new.dsp_id is null then
    return null;
  end if;

  insert into public.vehicle_mileage_log (dsp_id, vehicle_id, reading_at, mileage, source)
  values (new.dsp_id, new.vehicle_id, coalesce(new.inspected_at, now()), new.mileage, 'inspection');

  -- Only-up ratchet, mirroring vehicle_mileage_log_save: a stale or
  -- fat-fingered low reading never rolls the van's odometer back.
  update public.vehicles
     set mileage            = new.mileage,
         mileage_updated_at = now()
   where id = new.vehicle_id and dsp_id = new.dsp_id
     and (mileage is null or mileage < new.mileage);

  return null;
exception when others then
  return null;  -- ledger write is best-effort; the inspection stands
end;
$$;

drop trigger if exists vehicle_inspections_log_mileage on public.vehicle_inspections;
create trigger vehicle_inspections_log_mileage
  after insert on public.vehicle_inspections
  for each row execute function private.vehicle_inspections_log_mileage();


notify pgrst, 'reload schema';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0568_dvic_odometer_capture.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
