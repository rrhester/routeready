-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510090000 · routes + shifts
-- The schedule layer. Routes are the static catalog of route codes you run
-- (KMO1-14B, KMO2-08C, etc.). Shifts are the actual assignments — one row
-- per (driver, date) when scheduled, plus 'open' rows for unfilled
-- positions and 'timeoff'/'vto'/'off' rows for non-working states.
--
-- Phase 2's suspension cascade hooks into this in migration 130000 to
-- flip future shifts to 'open' when a driver is suspended.
-- ─────────────────────────────────────────────────────────────────────────

create type public.shift_status as enum (
  'scheduled',     -- driver assigned, normal expected shift
  'open',          -- no driver assigned; needs backfill
  'swap_pending',  -- driver has a pending swap request on this shift
  'vto',           -- voluntary time off accepted (was scheduled, now opted out)
  'timeoff',       -- approved PTO / sick / FMLA — driver-blocked
  'off'            -- driver's regular off-day (informational)
);

-- ─── Routes ──────────────────────────────────────────────────────────────

create table public.routes (
  id           uuid        primary key default gen_random_uuid(),
  dsp_id       uuid        not null references public.dsps(id) on delete cascade,
  station_id   uuid        references public.stations(id) on delete set null,
  code         text        not null,                 -- 'KMO1-14B'
  description  text,
  start_time   time,
  end_time     time,
  active       boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint routes_code_unique_per_dsp unique (dsp_id, code)
);

create index routes_dsp_active_idx
  on public.routes (dsp_id) where active = true;
create index routes_dsp_station_idx
  on public.routes (dsp_id, station_id);

create trigger trg_routes_updated_at
  before update on public.routes
  for each row execute function moddatetime(updated_at);

comment on table public.routes is
  'Static catalog of route codes the DSP runs. Shifts FK to a route. ' ||
  'Routes are typically per-station, with start/end times for the day.';

alter table public.routes enable row level security;

create policy "routes_tenant_select"
  on public.routes for select
  using (dsp_id = private.current_dsp_id());

create policy "routes_dispatcher_write"
  on public.routes for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

grant select, insert, update, delete on public.routes to authenticated;

-- ─── Shifts ──────────────────────────────────────────────────────────────

create table public.shifts (
  id              uuid                 primary key default gen_random_uuid(),
  dsp_id          uuid                 not null references public.dsps(id) on delete cascade,
  station_id      uuid                 references public.stations(id) on delete set null,
  driver_id       uuid                 references public.drivers(id) on delete set null,
  route_id        uuid                 references public.routes(id) on delete set null,
  shift_date      date                 not null,
  start_at        timestamptz,
  end_at          timestamptz,
  status          public.shift_status  not null default 'scheduled',
  swap_request_id uuid,                                            -- FK added in migration 100000
  notes           text,
  published       boolean              not null default false,
  created_at      timestamptz          not null default now(),
  updated_at      timestamptz          not null default now(),
  created_by      uuid                 references public.app_users(id),

  -- A driver can't be double-booked on the same date. NULL driver_id (open
  -- shifts) is excluded from this constraint via partial index.
  constraint shifts_one_per_driver_per_date
    exclude (driver_id with =, shift_date with =)
    where (driver_id is not null and status in ('scheduled','swap_pending','vto'))
);

create index shifts_dsp_date_idx
  on public.shifts (dsp_id, shift_date);
create index shifts_dsp_driver_date_idx
  on public.shifts (dsp_id, driver_id, shift_date);
create index shifts_open_idx
  on public.shifts (dsp_id, station_id, shift_date)
  where status = 'open';
create index shifts_published_idx
  on public.shifts (dsp_id, shift_date)
  where published = true;
create index shifts_unpublished_idx
  on public.shifts (dsp_id, shift_date)
  where published = false;

create trigger trg_shifts_updated_at
  before update on public.shifts
  for each row execute function moddatetime(updated_at);

comment on table public.shifts is
  'One row per (driver, date) when scheduled, plus rows with NULL driver_id ' ||
  'for open positions. status drives all downstream UX: scheduled/open/' ||
  'swap_pending/vto/timeoff/off.';

-- ─── RLS on shifts ───────────────────────────────────────────────────────

alter table public.shifts enable row level security;

-- Read: staff in DSP, OR the assigned driver themselves
create policy "shifts_tenant_select"
  on public.shifts for select
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or driver_id = private.current_driver_id()
    )
  );

-- Insert / update / delete: dispatcher+
create policy "shifts_dispatcher_insert"
  on public.shifts for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
  );

create policy "shifts_dispatcher_update"
  on public.shifts for update
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

create policy "shifts_ops_delete"
  on public.shifts for delete
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'ops')
  );

grant select, insert, update, delete on public.shifts to authenticated;

-- ─── Cross-table integrity ──────────────────────────────────────────────
-- driver_id and route_id must belong to the same DSP as the shift.
-- Postgres can't enforce this with FK alone (cross-column), so trigger.

create or replace function private.shifts_validate_refs()
returns trigger language plpgsql as $$
declare
  v_driver_dsp uuid;
  v_route_dsp  uuid;
begin
  if new.driver_id is not null then
    select dsp_id into v_driver_dsp from public.drivers where id = new.driver_id;
    if v_driver_dsp is null then
      raise exception 'shifts: driver_id % not found', new.driver_id;
    end if;
    if v_driver_dsp <> new.dsp_id then
      raise exception 'shifts: driver % belongs to a different DSP', new.driver_id;
    end if;
  end if;

  if new.route_id is not null then
    select dsp_id into v_route_dsp from public.routes where id = new.route_id;
    if v_route_dsp is null then
      raise exception 'shifts: route_id % not found', new.route_id;
    end if;
    if v_route_dsp <> new.dsp_id then
      raise exception 'shifts: route % belongs to a different DSP', new.route_id;
    end if;
  end if;

  -- Open shifts must have NULL driver_id
  if new.status = 'open' and new.driver_id is not null then
    raise exception 'shifts: status=open requires driver_id is null';
  end if;

  return new;
end $$;

create trigger trg_shifts_validate_refs
  before insert or update on public.shifts
  for each row execute function private.shifts_validate_refs();
