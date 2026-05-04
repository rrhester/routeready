-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0050 · Service types (route categories)
--
-- DSPs run different route categories — Standard Parcel (SP), Extra
-- Large (XL), Hub, ASU, etc. — each requiring its own demand plan.
-- Until now every shift / demand row was implicitly SP. This migration
-- adds a service_type dimension so each (date, station, wave, type)
-- gets its own demand bucket and shift count.
--
-- Each DSP is seeded with SP (active by default) plus XL / HUB / ASU
-- (inactive). DSPs activate additional types in Scheduling Settings.
-- All existing okami_demand and shifts rows are backfilled to SP — a
-- DSP that doesn't activate other types sees the exact same UI it sees
-- today. Once another type is activated, the OKAMI panel renders one
-- input row per (active type × wave) per day; generate_shifts buckets
-- by (wave × type) so each pair is independently managed.
--
-- Cushion stays an OKAMI-level total (per the operator's rule "cushion
-- is for total routes only") and stamps service_type_id = SP for
-- queryability — driver qualifications come in a later phase, where
-- cushion shifts will likely become type-agnostic.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. service_types table ──
create table if not exists public.service_types (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  code        text not null,
  label       text not null,
  color       text not null default '#3b82f6',
  sort_order  int  not null default 0,
  active      bool not null default true,
  created_at  timestamptz not null default now(),
  unique (dsp_id, code)
);

create index if not exists service_types_dsp_active_idx
  on public.service_types (dsp_id, active, sort_order);

alter table public.service_types enable row level security;

drop policy if exists "service_types_tenant_rw" on public.service_types;
create policy "service_types_tenant_rw"
  on public.service_types for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

grant select, insert, update on public.service_types to authenticated;


-- ── 2. Seed each existing DSP with the four standard types ──
-- SP active by default. XL / HUB / ASU dormant — operators enable in
-- Scheduling Settings when their DSP actually runs those routes.
insert into public.service_types (dsp_id, code, label, color, sort_order, active)
select d.id, x.code, x.label, x.color, x.sort_order, x.active
from public.dsps d
cross join (values
  ('SP',  'Standard Parcel', '#3b82f6', 0, true),
  ('XL',  'Extra Large',     '#f97316', 1, false),
  ('HUB', 'Hub',             '#10b981', 2, false),
  ('ASU', 'ASU',             '#a855f7', 3, false)
) as x(code, label, color, sort_order, active)
on conflict (dsp_id, code) do nothing;


-- ── 3. Auto-seed for newly created DSPs ──
create or replace function private.tg_dsp_seed_service_types()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.service_types (dsp_id, code, label, color, sort_order, active) values
    (NEW.id, 'SP',  'Standard Parcel', '#3b82f6', 0, true),
    (NEW.id, 'XL',  'Extra Large',     '#f97316', 1, false),
    (NEW.id, 'HUB', 'Hub',             '#10b981', 2, false),
    (NEW.id, 'ASU', 'ASU',             '#a855f7', 3, false)
  on conflict (dsp_id, code) do nothing;
  return NEW;
end;
$$;

drop trigger if exists trg_dsp_seed_service_types on public.dsps;
create trigger trg_dsp_seed_service_types
  after insert on public.dsps
  for each row execute function private.tg_dsp_seed_service_types();


-- ── 4. okami_demand: add service_type_id, backfill SP, update unique ──
alter table public.okami_demand
  add column if not exists service_type_id uuid references public.service_types(id);

update public.okami_demand od
   set service_type_id = (
     select id from public.service_types st
      where st.dsp_id = od.dsp_id and st.code = 'SP'
      limit 1
   )
 where od.service_type_id is null;

alter table public.okami_demand
  alter column service_type_id set not null;

alter table public.okami_demand
  drop constraint if exists okami_demand_unique;

alter table public.okami_demand
  add constraint okami_demand_unique
  unique (dsp_id, station_id, date, wave_index, service_type_id);


-- ── 5. shifts: add service_type_id, backfill SP ──
alter table public.shifts
  add column if not exists service_type_id uuid references public.service_types(id);

update public.shifts sh
   set service_type_id = (
     select id from public.service_types st
      where st.dsp_id = sh.dsp_id and st.code = 'SP'
      limit 1
   )
 where sh.service_type_id is null;

create index if not exists shifts_dsp_date_wave_type_idx
  on public.shifts (dsp_id, date, wave_index, service_type_id);


-- ── 6. okami_set_target — add p_service_type_id ──
-- Defaults to SP when caller doesn't supply a type, so existing 4-arg
-- callers keep working unchanged until the JS UI is updated.
drop function if exists public.okami_set_target(date, uuid, int, int);

create or replace function public.okami_set_target(
  p_date date,
  p_station_id uuid,
  p_target int,
  p_wave_index int default 0,
  p_service_type_id uuid default null
)
returns public.okami_demand
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_st  uuid := p_service_type_id;
  v_row public.okami_demand;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_st is null then
    select id into v_st from public.service_types
     where dsp_id = v_dsp and code = 'SP' limit 1;
  end if;

  insert into public.okami_demand
    (dsp_id, station_id, date, wave_index, service_type_id, target_routes, created_by)
  values
    (v_dsp, p_station_id, p_date, greatest(0, p_wave_index), v_st, greatest(0, p_target), auth.uid())
  on conflict (dsp_id, station_id, date, wave_index, service_type_id) do update
    set target_routes = excluded.target_routes,
        updated_at    = now()
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.okami_set_target(date, uuid, int, int, uuid) to authenticated;


-- ── 7. set_okami_week_demand — writes to SP, wave 0 ──
create or replace function public.set_okami_week_demand(p_week_start date, p_target_routes int)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + 6;
  v_sp_id uuid;
  r record;
  v_count int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select id into v_sp_id from public.service_types
   where dsp_id = v_dsp and code = 'SP' limit 1;

  for r in select id from public.stations where dsp_id = v_dsp and active = true loop
    insert into public.okami_demand (dsp_id, station_id, date, wave_index, service_type_id, target_routes)
    select v_dsp, r.id, d, 0, v_sp_id, p_target_routes
      from generate_series(p_week_start, v_week_end, interval '1 day') d
    on conflict (dsp_id, station_id, date, wave_index, service_type_id) do update
      set target_routes = excluded.target_routes;
    v_count := v_count + 7;
  end loop;
  return v_count;
end;
$$;
grant execute on function public.set_okami_week_demand(date, int) to authenticated;


-- ── 8. generate_shifts — bucket by (wave × active service_type) ──
-- Each (wave, type) pair is its own independent bucket. Trim only
-- removes unassigned non-cushion shifts within the bucket; create
-- inserts at the wave's start time stamped with both wave_index and
-- service_type_id. Inactive service types are skipped — a DSP with
-- only SP active behaves identically to pre-0050.
create or replace function private.generate_shifts(p_dsp_id uuid, p_date date, p_station_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_settings public.scheduling_settings;
  v_wave_count int;
  v_wave_idx int;
  v_wave_start text;
  v_st record;
  v_target int;
  v_existing int;
  v_to_create int;
  v_to_delete int;
  v_starts timestamptz;
  v_ends timestamptz;
  v_total_created int := 0;
begin
  v_settings := private.get_week_settings(p_dsp_id, private.week_start_for(p_date));

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_settings.waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;

  for v_wave_idx in 0..(v_wave_count - 1) loop
    v_wave_start := v_settings.waves->v_wave_idx->>'start';
    if v_wave_start is null then v_wave_start := '07:00'; end if;

    for v_st in
      select id from public.service_types
       where dsp_id = p_dsp_id and active = true
       order by sort_order
    loop
      select coalesce(target_routes, 0)
        into v_target
      from public.okami_demand
       where dsp_id          = p_dsp_id
         and station_id      = p_station_id
         and date            = p_date
         and wave_index      = v_wave_idx
         and service_type_id = v_st.id;
      v_target := coalesce(v_target, 0);

      select count(*)::int
        into v_existing
      from public.shifts
       where dsp_id          = p_dsp_id
         and station_id      = p_station_id
         and date            = p_date
         and wave_index      = v_wave_idx
         and service_type_id = v_st.id
         and status in ('scheduled','completed')
         and coalesce(is_cushion, false) = false;

      if v_existing > v_target then
        v_to_delete := v_existing - v_target;
        delete from public.shifts
         where id in (
           select id from public.shifts
            where dsp_id          = p_dsp_id
              and station_id      = p_station_id
              and date            = p_date
              and wave_index      = v_wave_idx
              and service_type_id = v_st.id
              and status          = 'scheduled'
              and driver_id       is null
              and coalesce(is_cushion, false) = false
            order by created_at desc
            limit v_to_delete
         );
        select count(*)::int
          into v_existing
        from public.shifts
         where dsp_id          = p_dsp_id
           and station_id      = p_station_id
           and date            = p_date
           and wave_index      = v_wave_idx
           and service_type_id = v_st.id
           and status in ('scheduled','completed')
           and coalesce(is_cushion, false) = false;
      end if;

      v_to_create := greatest(0, v_target - v_existing);
      if v_to_create > 0 then
        v_starts := (p_date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone;
        v_ends   := v_starts + (v_settings.default_block_hours || ' hours')::interval;

        for i in 1..v_to_create loop
          insert into public.shifts
            (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
          values
            (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto', v_settings.default_block_hours, false, v_wave_idx, v_st.id);
          v_total_created := v_total_created + 1;
        end loop;
      end if;
    end loop;
  end loop;

  return v_total_created;
end;
$$;


-- ── 9. apply_cushion_to_week — cushion stays total-route, stamps SP ──
create or replace function public.apply_cushion_to_week(p_week_start date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + 6;
  v_cushion_pct numeric;
  v_settings public.scheduling_settings;
  v_sp_id uuid;
  r record;
  v_existing_cushion int;
  v_target_cushion int;
  v_to_add int;
  v_index int;
  v_wave_idx int;
  v_existing_total int;
  v_starts timestamptz;
  v_ends timestamptz;
  v_wave_start text;
  v_wave_count int;
  v_added int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_settings := private.get_week_settings(v_dsp, p_week_start);
  v_cushion_pct := coalesce(v_settings.cushion_pct, 0);
  if v_cushion_pct <= 0 then return 0; end if;

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then v_wave_count := 1; end if;

  select id into v_sp_id from public.service_types
   where dsp_id = v_dsp and code = 'SP' limit 1;

  for r in
    select date, station_id, sum(target_routes)::int as target_routes
      from public.okami_demand
     where dsp_id = v_dsp
       and date between p_week_start and v_week_end
     group by date, station_id
    having sum(target_routes) > 0
  loop
    v_target_cushion := ceil(r.target_routes::numeric * v_cushion_pct / 100)::int;

    select count(*)::int into v_existing_cushion
      from public.shifts
     where dsp_id     = v_dsp
       and station_id = r.station_id
       and date       = r.date
       and is_cushion = true
       and status in ('scheduled','completed');

    select count(*)::int into v_existing_total
      from public.shifts
     where dsp_id     = v_dsp
       and station_id = r.station_id
       and date       = r.date
       and status in ('scheduled','completed');

    v_to_add := greatest(0, v_target_cushion - v_existing_cushion);

    for v_index in v_existing_total..(v_existing_total + v_to_add - 1) loop
      v_wave_idx   := v_index % v_wave_count;
      v_wave_start := coalesce(v_settings.waves->v_wave_idx->>'start', '07:00');
      v_starts     := (r.date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone;
      v_ends       := v_starts + (v_settings.default_block_hours || ' hours')::interval;

      insert into public.shifts
        (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
      values
        (v_dsp, r.station_id, r.date, v_starts, v_ends, 'scheduled', 'auto', v_settings.default_block_hours, true, v_wave_idx, v_sp_id);
      v_added := v_added + 1;
    end loop;
  end loop;

  return v_added;
end;
$$;
grant execute on function public.apply_cushion_to_week(date) to authenticated;


-- ── 10. okami_grid — include service_type breakdown in targets_by_wave ──
drop function if exists public.okami_grid(date, int);

create or replace function public.okami_grid(p_start date, p_weeks int default 3)
returns table (
  date            date,
  station_id      uuid,
  station_code    text,
  target_routes   int,
  targets_by_wave jsonb,
  filled_by_wave  jsonb,
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
    select generate_series(p_start, v_end, interval '1 day')::date as d
  ),
  stations as (
    select * from public.stations where dsp_id = v_dsp and active = true
  ),
  cells as (
    select dt.d as date, s.id as station_id, s.code as station_code
    from dates dt cross join stations s
  ),
  demand as (
    select
      od.date          as date,
      od.station_id    as station_id,
      sum(od.target_routes)::int as total_routes,
      jsonb_agg(
        jsonb_build_object(
          'wave_index',         od.wave_index,
          'service_type_id',    od.service_type_id,
          'service_type_code',  st.code,
          'target_routes',      od.target_routes
        )
        order by od.wave_index, st.sort_order
      ) as by_wave
    from public.okami_demand od
    left join public.service_types st on st.id = od.service_type_id
    where od.dsp_id = v_dsp
      and od.date between p_start and v_end
    group by od.date, od.station_id
  ),
  filled_per_bucket as (
    select sh.date as date, sh.station_id as station_id,
           sh.wave_index as wave_index, sh.service_type_id as service_type_id,
           count(*)::int as n
    from public.shifts sh
    where sh.dsp_id = v_dsp
      and sh.date between p_start and v_end
      and sh.status in ('scheduled','completed')
      and sh.driver_id is not null
    group by sh.date, sh.station_id, sh.wave_index, sh.service_type_id
  ),
  filled_agg as (
    select fpb.date as date, fpb.station_id as station_id,
           sum(fpb.n)::int as total_filled,
           jsonb_agg(
             jsonb_build_object(
               'wave_index',      fpb.wave_index,
               'service_type_id', fpb.service_type_id,
               'service_type_code', st.code,
               'filled',          fpb.n
             )
             order by fpb.wave_index, st.sort_order
           ) as by_wave
    from filled_per_bucket fpb
    left join public.service_types st on st.id = fpb.service_type_id
    group by fpb.date, fpb.station_id
  )
  select
    c.date,
    c.station_id,
    c.station_code,
    coalesce(d.total_routes, 0)              as target_routes,
    coalesce(d.by_wave, '[]'::jsonb)         as targets_by_wave,
    coalesce(fa.by_wave, '[]'::jsonb)        as filled_by_wave,
    v_cushion                                 as cushion_pct,
    coalesce(d.total_routes, 0)              as needed,
    coalesce(fa.total_filled, 0)             as filled,
    greatest(0, coalesce(d.total_routes, 0) - coalesce(fa.total_filled, 0)) as open_count
  from cells c
  left join demand     d  on d.date  = c.date and d.station_id  = c.station_id
  left join filled_agg fa on fa.date = c.date and fa.station_id = c.station_id
  order by c.date, c.station_code;
end;
$$;
grant execute on function public.okami_grid(date, int) to authenticated;


-- ── 11. schedule_grid — surface service_type on each shift ──
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
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
    into v_grid
  from public.okami_grid(p_start, p_weeks) g;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', sh.id, 'date', sh.date, 'station_id', sh.station_id,
    'driver_id', sh.driver_id, 'driver_name', d.full_name,
    'route_code', sh.route_code, 'status', sh.status,
    'starts_at', sh.starts_at, 'ends_at', sh.ends_at,
    'block_hours', sh.block_hours, 'is_cushion', sh.is_cushion,
    'wave_index', sh.wave_index,
    'service_type_id',    sh.service_type_id,
    'service_type_code',  st.code,
    'service_type_label', st.label,
    'service_type_color', st.color,
    'notes', sh.notes
  ) order by sh.date, sh.station_id, sh.wave_index, sh.starts_at), '[]'::jsonb)
    into v_shifts
  from public.shifts sh
  left join public.drivers d on d.id = sh.driver_id
  left join public.service_types st on st.id = sh.service_type_id
  where sh.dsp_id = v_dsp
    and sh.date between p_start and v_end;

  return jsonb_build_object('coverage', v_grid, 'shifts', v_shifts,
                            'start', p_start, 'weeks', p_weeks);
end;
$$;
grant execute on function public.schedule_grid(date, int) to authenticated;


-- ── 12. RPCs for the Settings panel ──
create or replace function public.list_service_types()
returns setof public.service_types
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.service_types
   where dsp_id = private.current_dsp_id()
   order by sort_order, code;
$$;
grant execute on function public.list_service_types() to authenticated;


create or replace function public.set_service_type(
  p_id uuid,
  p_active boolean default null,
  p_label  text default null,
  p_color  text default null
)
returns public.service_types
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.service_types;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.service_types
     set active = coalesce(p_active, active),
         label  = coalesce(p_label,  label),
         color  = coalesce(p_color,  color)
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;

  if not found then
    raise exception 'service type not found';
  end if;

  return v_row;
end;
$$;
grant execute on function public.set_service_type(uuid, boolean, text, text) to authenticated;


-- ── 13. diagnose_day — include service_types for debugging ──
create or replace function public.diagnose_day(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_settings public.scheduling_settings;
  v_demand jsonb;
  v_shifts jsonb;
  v_service_types jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_settings := private.get_week_settings(v_dsp, private.week_start_for(p_date));

  select coalesce(jsonb_agg(to_jsonb(st) order by st.sort_order), '[]'::jsonb)
    into v_service_types
  from public.service_types st
   where st.dsp_id = v_dsp;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',                d.id,
      'station_id',        d.station_id,
      'wave_index',        d.wave_index,
      'service_type_id',   d.service_type_id,
      'service_type_code', st.code,
      'target_routes',     d.target_routes
    ) order by d.station_id, d.wave_index, st.sort_order
  ), '[]'::jsonb)
    into v_demand
  from public.okami_demand d
  left join public.service_types st on st.id = d.service_type_id
   where d.dsp_id = v_dsp
     and d.date = p_date;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',                sh.id,
        'station_id',        sh.station_id,
        'starts_at',         sh.starts_at,
        'ends_at',           sh.ends_at,
        'wave_index',        sh.wave_index,
        'service_type_id',   sh.service_type_id,
        'service_type_code', st.code,
        'driver_id',         sh.driver_id,
        'status',            sh.status,
        'is_cushion',        sh.is_cushion,
        'source',            sh.source
      )
      order by sh.station_id, sh.wave_index, sh.starts_at
    ),
    '[]'::jsonb
  )
    into v_shifts
  from public.shifts sh
  left join public.service_types st on st.id = sh.service_type_id
   where sh.dsp_id = v_dsp
     and sh.date = p_date;

  return jsonb_build_object(
    'date',          p_date,
    'settings',      jsonb_build_object(
      'week_start',  v_settings.week_start,
      'waves',       v_settings.waves,
      'timezone',    v_settings.timezone,
      'block_hours', v_settings.default_block_hours
    ),
    'service_types', v_service_types,
    'demand',        v_demand,
    'shifts',        v_shifts
  );
end;
$$;
grant execute on function public.diagnose_day(date) to authenticated;
