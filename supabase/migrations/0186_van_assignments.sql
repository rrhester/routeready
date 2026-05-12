-- Migration 0186 · Van assignments — vehicles & standing driver chains
--
-- The data layer for the "van assignments" workflow tool: a fleet of
-- vehicles (vans, mostly), each with a standing driver chain — rank 0 is
-- the primary, rank 1+ are backups in priority order.  The dashboard
-- editor lives under the Workflows section (a card in the board picker).
--
-- This migration is the data layer + the staff editor RPCs only.  A
-- later slice resolves the chain against the schedule + time-off so a
-- backup picks up the van when the primary is out, decorates the
-- driver's shifts with the resolved van, and surfaces it in the driver
-- app — those need no further migration to the *standing* model (the
-- per-day resolution may add a small log table later).

-- ── Tables ───────────────────────────────────────────────────────────

create table if not exists public.vehicles (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  name        text not null,                          -- the van label/number, e.g. "4271" or "Van 12"
  kind        text not null default 'van',            -- van | car | truck | trailer | other
  status      text not null default 'active' check (status in ('active','spare','out_of_service','retired')),
  notes       text,
  archived_at timestamptz,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists vehicles_dsp_idx on public.vehicles (dsp_id, archived_at);

-- The standing chain for a vehicle: rank 0 = primary, rank 1, 2… =
-- backups in priority order.  Replaced wholesale by vehicle_assignment_set.
create table if not exists public.vehicle_driver_assignments (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,   -- denormalized for RLS
  vehicle_id  uuid not null references public.vehicles(id) on delete cascade,
  driver_id   uuid not null references public.drivers(id) on delete cascade,
  rank        int  not null default 0,                -- 0 = primary
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (vehicle_id, rank),
  unique (vehicle_id, driver_id)
);
create index if not exists vehicle_driver_assignments_vehicle_idx on public.vehicle_driver_assignments (vehicle_id, rank);
create index if not exists vehicle_driver_assignments_driver_idx  on public.vehicle_driver_assignments (driver_id);

-- ── RLS — dispatchers (and up) of the owning DSP ─────────────────────
alter table public.vehicles                   enable row level security;
alter table public.vehicle_driver_assignments enable row level security;

create policy "vehicles_rw" on public.vehicles
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

create policy "vehicle_driver_assignments_rw" on public.vehicle_driver_assignments
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

grant select, insert, update, delete on public.vehicles                   to authenticated;
grant select, insert, update, delete on public.vehicle_driver_assignments to authenticated;

-- ── RPCs ─────────────────────────────────────────────────────────────

-- Every vehicle for the DSP + its driver chain, ready for the editor.
-- → [{ id, name, kind, status, notes, archived_at,
--      drivers:[{driver_id, name, rank}] (ordered by rank, rank 0 = primary) }]
create or replace function public.vehicles_list()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(v order by v->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', vh.id, 'name', vh.name, 'kind', vh.kind, 'status', vh.status,
      'notes', vh.notes, 'archived_at', vh.archived_at,
      'drivers', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'driver_id', a.driver_id, 'rank', a.rank,
                 'name', coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver')
               ) order by a.rank)
        from public.vehicle_driver_assignments a
        join public.drivers d on d.id = a.driver_id
        where a.vehicle_id = vh.id
      ), '[]'::jsonb)
    ) v
    from public.vehicles vh
    where vh.dsp_id = private.current_dsp_id()
      and private.is_staff(private.current_dsp_id(), 'dispatcher')
  ) t;
$$;
grant execute on function public.vehicles_list() to authenticated;

-- Create (p_id null) or update a vehicle.
create or replace function public.vehicle_upsert(
  p_id uuid default null, p_name text default null,
  p_kind text default 'van', p_status text default 'active', p_notes text default null
) returns public.vehicles
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_v public.vehicles;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if coalesce(p_status, 'active') not in ('active','spare','out_of_service','retired') then raise exception 'bad_status' using errcode = '22023'; end if;
  if p_id is null then
    insert into public.vehicles (dsp_id, name, kind, status, notes, created_by)
    values (v_dsp, trim(p_name), coalesce(nullif(trim(p_kind), ''), 'van'), coalesce(p_status, 'active'), nullif(trim(p_notes), ''), auth.uid())
    returning * into v_v;
  else
    update public.vehicles
       set name = trim(p_name), kind = coalesce(nullif(trim(p_kind), ''), 'van'),
           status = coalesce(p_status, 'active'), notes = nullif(trim(p_notes), ''), updated_at = now()
     where id = p_id and dsp_id = v_dsp
     returning * into v_v;
    if v_v.id is null then raise exception 'vehicle_not_found' using errcode = 'P0002'; end if;
  end if;
  return v_v;
end;
$$;
grant execute on function public.vehicle_upsert(uuid, text, text, text, text) to authenticated;

-- Soft-delete a vehicle; pass p_unarchive => true to restore it.
create or replace function public.vehicle_archive(p_id uuid, p_unarchive boolean default false)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.vehicles set archived_at = case when p_unarchive then null else now() end, updated_at = now()
   where id = p_id and dsp_id = v_dsp;
  if not found then raise exception 'vehicle_not_found' using errcode = 'P0002'; end if;
end;
$$;
grant execute on function public.vehicle_archive(uuid, boolean) to authenticated;

-- Replace a vehicle's whole driver chain.  p_driver_ids[1] = primary,
-- the rest = backups in order.  Ids not on this DSP's roster are skipped;
-- duplicates are dropped (first wins).  Pass {} to clear the chain.
create or replace function public.vehicle_assignment_set(p_vehicle_id uuid, p_driver_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_id uuid; v_rank int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.vehicles where id = p_vehicle_id and dsp_id = v_dsp) then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;
  delete from public.vehicle_driver_assignments where vehicle_id = p_vehicle_id;
  foreach v_id in array coalesce(p_driver_ids, '{}'::uuid[]) loop
    if v_id is not null
       and exists (select 1 from public.drivers d where d.id = v_id and d.dsp_id = v_dsp)
       and not exists (select 1 from public.vehicle_driver_assignments where vehicle_id = p_vehicle_id and driver_id = v_id)
    then
      insert into public.vehicle_driver_assignments (dsp_id, vehicle_id, driver_id, rank)
      values (v_dsp, p_vehicle_id, v_id, v_rank);
      v_rank := v_rank + 1;
    end if;
  end loop;
end;
$$;
grant execute on function public.vehicle_assignment_set(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';
