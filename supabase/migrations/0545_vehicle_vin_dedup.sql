-- ── 0545 · Prevent duplicate vehicles (VIN) within a DSP ──────────────────────
--
-- Closes launch-audit finding #37 (data quality): vehicle_record_save and the
-- CSV/import paths never checked for a duplicate VIN, so the same van could be
-- added twice — inflating fleet counts, splitting assignment/repair history,
-- and corrupting coverage math.
--
-- A BEFORE INSERT trigger (not a table constraint) is used deliberately:
--   • it catches EVERY insert path, not just one RPC;
--   • it only affects NEW rows, so it can't fail to apply on a DSP that
--     already has duplicates (a UNIQUE index would); existing rows are
--     untouched and still editable;
--   • VIN is compared case-insensitively and trimmed, and blank/null VINs are
--     ignored (a fleet may legitimately have several vans with no VIN on file).
-- Scope is per-DSP: two different DSPs may of course never share a VIN in
-- reality, but the guard is tenant-scoped to match how the data is keyed.
--
-- Not enforced on UPDATE: re-pathing an existing VIN is rare, and enforcing it
-- risks blocking a legitimate edit on a DSP that already has a pre-existing
-- duplicate. New duplicates — the actual reported problem — come in via INSERT.
-- session_replication_role='replica' (seeds/tests) skips the trigger as usual.

create or replace function private.vehicles_no_dup_vin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(upper(trim(new.vin)), '') is not null
     and exists (
       select 1 from public.vehicles v
       where v.dsp_id = new.dsp_id
         and v.id <> new.id
         and upper(trim(v.vin)) = upper(trim(new.vin))
     ) then
    raise exception 'duplicate_vin'
      using errcode = '23505',
            detail  = 'A vehicle with this VIN already exists in this fleet.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_vehicles_no_dup_vin on public.vehicles;
create trigger trg_vehicles_no_dup_vin
  before insert on public.vehicles
  for each row execute function private.vehicles_no_dup_vin();

notify pgrst, 'reload schema';
