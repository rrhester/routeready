-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0025 · OKAMI (demand) + Schedule (supply) + Time off
--
-- Architecture:
--   OKAMI = the per-day, per-station route TARGET (the demand side).
--           Cushion is a DSP-wide percent applied at read time.
--   Shifts = one row per (driver, date, station). The supply side that
--           fills demand. Status tracks lifecycle.
--   Time off = driver requests with operator approval.
--
-- Coverage math (computed by RPCs, not stored):
--   needed   = ceil(target * (1 + cushion_pct/100))
--   filled   = count(shifts where status in ('scheduled','completed'))
--   open     = max(0, needed - filled)
--
-- Window: 3 weeks rolling (21 days from today). UI editors expose this
-- range; longer-range planning is layered on top later.
-- ─────────────────────────────────────────────────────────────────────────

-- DSP-wide cushion percent (default 10).
update public.dsps
   set metadata = coalesce(metadata, '{}'::jsonb)
                  || jsonb_build_object('scheduling',
                       coalesce(metadata->'scheduling', '{}'::jsonb)
                       || jsonb_build_object('cushion_pct', 10))
 where short_code = 'DEMO'
   and (metadata->'scheduling'->'cushion_pct') is null;


-- ─── okami_demand ────────────────────────────────────────────────────────

create table public.okami_demand (
  id              uuid           primary key default gen_random_uuid(),
  dsp_id          uuid           not null references public.dsps(id) on delete cascade,
  station_id      uuid           not null references public.stations(id) on delete cascade,
  date            date           not null,
  target_routes   int            not null default 0,
  notes           text,
  created_by      uuid           references public.app_users(id) on delete set null,
  created_at      timestamptz    not null default now(),
  updated_at      timestamptz    not null default now(),
  constraint okami_demand_unique unique (dsp_id, station_id, date)
);

create index okami_demand_dsp_date_idx on public.okami_demand (dsp_id, date);

create trigger trg_okami_demand_updated_at
  before update on public.okami_demand
  for each row execute function private.set_updated_at();

alter table public.okami_demand enable row level security;
create policy "okami_demand_tenant_rw"
  on public.okami_demand for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.okami_demand to authenticated;


-- ─── shifts ─────────────────────────────────────────────────────────────

create type public.shift_status as enum (
  'scheduled',
  'called_off',
  'completed',
  'no_show'
);

create type public.shift_source as enum (
  'manual',
  'template',
  'auto'
);

create table public.shifts (
  id              uuid                     primary key default gen_random_uuid(),
  dsp_id          uuid                     not null references public.dsps(id) on delete cascade,
  station_id      uuid                     not null references public.stations(id) on delete cascade,
  driver_id       uuid                     references public.drivers(id) on delete set null,

  date            date                     not null,
  starts_at       timestamptz,
  ends_at         timestamptz,
  route_code      text,
  status          public.shift_status      not null default 'scheduled',
  source          public.shift_source      not null default 'manual',

  notes           text,
  created_by      uuid                     references public.app_users(id) on delete set null,
  created_at      timestamptz              not null default now(),
  updated_at      timestamptz              not null default now()
);

create index shifts_dsp_date_idx     on public.shifts (dsp_id, date);
create index shifts_driver_date_idx  on public.shifts (driver_id, date) where driver_id is not null;
create index shifts_station_date_idx on public.shifts (station_id, date);
create index shifts_open_idx         on public.shifts (dsp_id, date) where driver_id is null;

create trigger trg_shifts_updated_at
  before update on public.shifts
  for each row execute function private.set_updated_at();

alter table public.shifts enable row level security;
create policy "shifts_tenant_rw"
  on public.shifts for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.shifts to authenticated;


-- ─── time_off_requests ─────────────────────────────────────────────────

create type public.time_off_status as enum (
  'pending',
  'approved',
  'denied',
  'cancelled'
);

create table public.time_off_requests (
  id              uuid                       primary key default gen_random_uuid(),
  dsp_id          uuid                       not null references public.dsps(id) on delete cascade,
  driver_id       uuid                       not null references public.drivers(id) on delete cascade,

  start_date      date                       not null,
  end_date        date                       not null,
  reason          text,

  status          public.time_off_status     not null default 'pending',
  decided_by      uuid                       references public.app_users(id) on delete set null,
  decided_at      timestamptz,
  decision_notes  text,

  created_at      timestamptz                not null default now(),
  updated_at      timestamptz                not null default now(),
  constraint time_off_dates_valid check (end_date >= start_date)
);

create index time_off_dsp_status_idx on public.time_off_requests (dsp_id, status, start_date);
create index time_off_driver_idx     on public.time_off_requests (driver_id, start_date desc);

create trigger trg_time_off_updated_at
  before update on public.time_off_requests
  for each row execute function private.set_updated_at();

alter table public.time_off_requests enable row level security;
create policy "time_off_tenant_rw"
  on public.time_off_requests for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.time_off_requests to authenticated;


-- ─── RPCs · OKAMI ───────────────────────────────────────────────────────

-- Returns one row per (date, station) for the requested window, with
-- the current target, computed needed (target × (1+cushion%)), and
-- filled count from shifts. Missing okami_demand rows show as target=0.
create or replace function public.okami_grid(p_start date, p_weeks int default 3)
returns table (
  date            date,
  station_id      uuid,
  station_code    text,
  target_routes   int,
  cushion_pct     numeric,
  needed          int,
  filled          int,
  open_count      int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_end date  := p_start + (p_weeks * 7 - 1);
  v_cushion numeric;
begin
  select coalesce((metadata->'scheduling'->>'cushion_pct')::numeric, 10)
    into v_cushion
  from public.dsps where id = v_dsp;

  return query
  with dates as (
    select generate_series(p_start, v_end, interval '1 day')::date as date
  ),
  stations as (
    select * from public.stations where dsp_id = v_dsp and active = true
  ),
  cells as (
    select d.date, s.id as station_id, s.code as station_code
    from dates d cross join stations s
  ),
  filled as (
    select sh.date, sh.station_id, count(*)::int as n
    from public.shifts sh
    where sh.dsp_id = v_dsp
      and sh.date between p_start and v_end
      and sh.status in ('scheduled','completed')
      and sh.driver_id is not null
    group by sh.date, sh.station_id
  )
  select
    c.date,
    c.station_id,
    c.station_code,
    coalesce(od.target_routes, 0) as target_routes,
    v_cushion as cushion_pct,
    ceil(coalesce(od.target_routes, 0)::numeric * (1 + v_cushion / 100))::int as needed,
    coalesce(f.n, 0) as filled,
    greatest(0, ceil(coalesce(od.target_routes, 0)::numeric * (1 + v_cushion / 100))::int - coalesce(f.n, 0)) as open_count
  from cells c
  left join public.okami_demand od on od.dsp_id = v_dsp and od.station_id = c.station_id and od.date = c.date
  left join filled f                on f.date = c.date and f.station_id = c.station_id
  order by c.date, c.station_code;
end;
$$;
grant execute on function public.okami_grid(date, int) to authenticated;


create or replace function public.okami_set_target(p_date date, p_station_id uuid, p_target int)
returns public.okami_demand
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.okami_demand;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.okami_demand (dsp_id, station_id, date, target_routes, created_by)
  values (v_dsp, p_station_id, p_date, greatest(0, p_target), auth.uid())
  on conflict (dsp_id, station_id, date) do update
    set target_routes = excluded.target_routes,
        updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.okami_set_target(date, uuid, int) to authenticated;


create or replace function public.okami_set_cushion(p_pct numeric)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_pct numeric := greatest(0, least(100, coalesce(p_pct, 10)));
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.dsps
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb),
       '{scheduling,cushion_pct}',
       to_jsonb(v_pct),
       true
     )
   where id = v_dsp;
  return v_pct;
end;
$$;
grant execute on function public.okami_set_cushion(numeric) to authenticated;


-- ─── RPCs · Shifts ─────────────────────────────────────────────────────

create or replace function public.schedule_grid(p_start date, p_weeks int default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_end date := p_start + (p_weeks * 7 - 1);
  v_grid jsonb;
  v_shifts jsonb;
begin
  -- Per-day per-station coverage from okami_grid.
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
    into v_grid
  from public.okami_grid(p_start, p_weeks) g;

  -- Every shift in the window with driver name pre-joined.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', sh.id, 'date', sh.date, 'station_id', sh.station_id,
    'driver_id', sh.driver_id, 'driver_name', d.full_name,
    'route_code', sh.route_code, 'status', sh.status,
    'starts_at', sh.starts_at, 'ends_at', sh.ends_at,
    'notes', sh.notes
  ) order by sh.date, sh.station_id, sh.starts_at), '[]'::jsonb)
    into v_shifts
  from public.shifts sh
  left join public.drivers d on d.id = sh.driver_id
  where sh.dsp_id = v_dsp
    and sh.date between p_start and v_end;

  return jsonb_build_object('coverage', v_grid, 'shifts', v_shifts,
                            'start', p_start, 'weeks', p_weeks);
end;
$$;
grant execute on function public.schedule_grid(date, int) to authenticated;


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
    (dsp_id, station_id, driver_id, date, starts_at, ends_at, route_code, status, notes, source, created_by)
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
     auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.create_shift(jsonb) to authenticated;


create or replace function public.assign_shift(p_id uuid, p_driver_id uuid)
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
  update public.shifts
     set driver_id = p_driver_id, status = 'scheduled'
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;
  if v_row.id is null then raise exception 'shift_not_found'; end if;
  return v_row;
end;
$$;
grant execute on function public.assign_shift(uuid, uuid) to authenticated;


-- ─── RPCs · Time off ───────────────────────────────────────────────────

create or replace function public.request_time_off(p_payload jsonb)
returns public.time_off_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.time_off_requests;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.time_off_requests
    (dsp_id, driver_id, start_date, end_date, reason)
  values
    (v_dsp,
     (p_payload->>'driver_id')::uuid,
     (p_payload->>'start_date')::date,
     (p_payload->>'end_date')::date,
     p_payload->>'reason')
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.request_time_off(jsonb) to authenticated;


create or replace function public.decide_time_off(p_id uuid, p_decision text, p_notes text default null)
returns public.time_off_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.time_off_requests;
  v_status public.time_off_status;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_status := case lower(p_decision)
    when 'approve' then 'approved'::public.time_off_status
    when 'deny'    then 'denied'::public.time_off_status
    when 'cancel'  then 'cancelled'::public.time_off_status
    else 'pending'::public.time_off_status
  end;
  update public.time_off_requests
     set status = v_status,
         decided_by = auth.uid(),
         decided_at = now(),
         decision_notes = p_notes
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;
  if v_row.id is null then raise exception 'request_not_found'; end if;
  return v_row;
end;
$$;
grant execute on function public.decide_time_off(uuid, text, text) to authenticated;


-- ─── Realtime publication ──────────────────────────────────────────────

do $$
declare
  t text;
begin
  foreach t in array array['okami_demand','shifts','time_off_requests'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;
