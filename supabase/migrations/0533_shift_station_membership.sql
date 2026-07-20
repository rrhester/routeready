-- 0533_shift_station_membership.sql
--
-- Scheduled work creates station membership.
--
-- Follow-up to 0532 (operator, 2026-07-20: schedule/roster still mismatched
-- after the home-station union — "these are not lent drivers"). A driver can
-- have a BLANK home station (drivers.station_id null — e.g. graduated from
-- the hiring pipeline with no target station) and no driver_stations row,
-- yet be scheduled at a station every day. The schedule lens shows them via
-- shift.station_id; the roster's membership/home lens can't see them at all.
--
-- Under the "each station is its own DSP" model, anyone scheduled at a
-- station belongs to that station: assigning a shift now upserts a
-- driver_stations membership row (is_primary = false — never touches the
-- home flag), and a backfill grants membership from the last 90 days of
-- assigned shifts plus everything upcoming.
--
-- Idempotent — safe to re-run. Companion client change ships in live.js
-- (_rrDriverIdsAtStation unions a scheduled-drivers source), so the roster
-- is correct even before this is applied.

create or replace function private.sync_shift_station_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Seat rows generated unassigned (driver_id null) are filtered by the
  -- trigger's WHEN clause; station_id is NOT NULL by schema, but guard
  -- anyway so a malformed row can never abort the assignment write. The
  -- EXISTS checks matter: shifts can carry driver ids that no longer
  -- exist in public.drivers (drivers hard-deleted, their shifts kept —
  -- seen in production during the 0533 backfill), and an FK violation
  -- here would abort the operator's shift write.
  if new.driver_id is not null and new.station_id is not null
     and exists (select 1 from public.drivers  d  where d.id  = new.driver_id)
     and exists (select 1 from public.stations st where st.id = new.station_id) then
    insert into public.driver_stations (dsp_id, driver_id, station_id, is_primary)
    values (new.dsp_id, new.driver_id, new.station_id, false)
    on conflict (driver_id, station_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_shift_station_membership on public.shifts;
create trigger trg_sync_shift_station_membership
  after insert or update of driver_id on public.shifts
  for each row
  when (new.driver_id is not null)
  execute function private.sync_shift_station_membership();

-- Backfill: membership from actual scheduled work — last 90 days plus all
-- future assigned shifts. JOINs (not just NOT NULL) because shifts can
-- reference drivers/stations that were since deleted — inserting those
-- ids violates driver_stations' FKs and aborts the whole migration.
-- DO NOTHING keeps existing rows' is_primary intact.
insert into public.driver_stations (dsp_id, driver_id, station_id, is_primary)
select distinct s.dsp_id, s.driver_id, s.station_id, false
from public.shifts s
join public.drivers  d  on d.id  = s.driver_id
join public.stations st on st.id = s.station_id
where s.date >= current_date - 90
on conflict (driver_id, station_id) do nothing;
