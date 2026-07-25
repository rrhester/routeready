-- Migration 0525 · driver_stations (floating-driver membership)
--
-- Drivers can float between stations (operator, 2026-07-19): a driver is
-- not fixed to one home station. `drivers.station_id` stays the PRIMARY /
-- home station; this join table lets a driver be a MEMBER of more than one
-- station so roster / bans / etc. scope by membership, not just home. The
-- SCHEDULE already scopes correctly by shift.station_id and is unaffected.
--
-- Backfills one membership row (is_primary = true) from each driver's
-- existing station_id, so the roster's station lens works the moment this
-- lands. Idempotent — safe to re-run.

create table if not exists public.driver_stations (
  id          uuid        primary key default gen_random_uuid(),
  dsp_id      uuid        not null references public.dsps(id)     on delete cascade,
  driver_id   uuid        not null references public.drivers(id)  on delete cascade,
  station_id  uuid        not null references public.stations(id) on delete cascade,
  is_primary  boolean     not null default false,
  created_at  timestamptz not null default now(),

  constraint driver_stations_unique unique (driver_id, station_id)
);

create index if not exists driver_stations_dsp_station_idx
  on public.driver_stations (dsp_id, station_id);
create index if not exists driver_stations_driver_idx
  on public.driver_stations (driver_id);

-- Backfill: one membership row per driver that already has a home station.
-- ON CONFLICT keeps re-runs clean; doesn't touch rows added by hand later.
insert into public.driver_stations (dsp_id, driver_id, station_id, is_primary)
select d.dsp_id, d.id, d.station_id, true
from public.drivers d
where d.station_id is not null
on conflict (driver_id, station_id) do nothing;

alter table public.driver_stations enable row level security;

-- Tenant-scoped read; dispatcher-and-up write (mirrors the roster's own
-- write surface — dispatchers manage station membership).
drop policy if exists driver_stations_tenant_select on public.driver_stations;
create policy driver_stations_tenant_select
  on public.driver_stations for select
  using (dsp_id = private.current_dsp_id());

drop policy if exists driver_stations_staff_write on public.driver_stations;
create policy driver_stations_staff_write
  on public.driver_stations for all
  using      (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

grant select, insert, update, delete on public.driver_stations to authenticated;

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0525_driver_stations.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
