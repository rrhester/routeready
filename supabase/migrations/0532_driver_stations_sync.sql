-- 0532_driver_stations_sync.sql
--
-- Keep driver_stations (0525) in sync with drivers.station_id.
--
-- 0525 backfilled one is_primary membership row per driver ONCE, but nothing
-- wrote the join table afterwards — the Add-driver form, the driver editor's
-- station change, and the CSV import all write only drivers.station_id. Every
-- driver hired or re-homed since 0525 therefore has no membership row, so the
-- station-scoped roster (membership lens) hides them while the schedule
-- (station_id + shifts lens) shows them — "more drivers on my schedule than
-- my roster" (operator, 2026-07-20).
--
-- 1) Trigger on public.drivers: INSERT with a home station, or a station_id
--    change, upserts the is_primary membership row for the new home and
--    removes the machine-written is_primary row for the old home (a true
--    transfer leaves the old roster; hand-added float rows are is_primary =
--    false and are never touched).
-- 2) Repair backfill: re-adds missing home rows for drivers created since
--    0525, and deletes stale is_primary rows whose driver has since moved
--    home (only machine state — 0525/this trigger are the only writers of
--    is_primary = true).
--
-- Idempotent — safe to re-run.

create or replace function private.sync_driver_station_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Re-home: retire the machine-maintained primary row at the OLD home.
  -- Explicit float memberships (is_primary = false) are operator data — keep.
  if tg_op = 'UPDATE'
     and old.station_id is distinct from new.station_id
     and old.station_id is not null then
    delete from public.driver_stations
     where driver_id  = new.id
       and station_id = old.station_id
       and is_primary;
  end if;

  -- New home: ensure a membership row exists and is marked primary (a
  -- pre-existing float row at that station gets promoted, not duplicated).
  if new.station_id is not null then
    insert into public.driver_stations (dsp_id, driver_id, station_id, is_primary)
    values (new.dsp_id, new.id, new.station_id, true)
    on conflict (driver_id, station_id) do update set is_primary = true;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_driver_station_membership on public.drivers;
create trigger trg_sync_driver_station_membership
  after insert or update of station_id on public.drivers
  for each row execute function private.sync_driver_station_membership();

-- Repair: drop stale machine-written primaries (driver moved home since the
-- row was written), then re-add the current homes missed since 0525.
delete from public.driver_stations ds
 using public.drivers d
 where d.id = ds.driver_id
   and ds.is_primary
   and (d.station_id is null or d.station_id <> ds.station_id);

insert into public.driver_stations (dsp_id, driver_id, station_id, is_primary)
select d.dsp_id, d.id, d.station_id, true
from public.drivers d
where d.station_id is not null
on conflict (driver_id, station_id) do update set is_primary = true;

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0532_driver_stations_sync.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
