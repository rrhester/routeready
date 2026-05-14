-- Migration 0218 · Fleet — auto-assign toggle, manual override, driver-app push
--
-- Three additions building on 0217:
--   1. A DSP-level toggle (fleet_settings.auto_van_assign) the operator
--      can flip in Settings → Scheduling.  When on, the dashboard
--      auto-fires today_roster_auto_assign before rendering the
--      Today's roster so the gaps are filled the moment the page opens
--      (no button click needed).
--   2. vehicle_day_assignment_set(p_driver_id, p_date, p_vehicle_id)
--      — the RPC the new inline van picker calls when an operator
--      changes a driver's van for a specific date.  Upserts the
--      override; passing null clears it.
--   3. driver_vehicle_days (0187) updated to consult per-day overrides
--      first.  Without this, manual changes or auto-assigned vans on
--      the dashboard never reach the driver app.


-- ── 1. DSP-level fleet settings ─────────────────────────────────────
-- Dedicated DSP-level table (same pattern as availability_settings,
-- 0098).  Don't try to use scheduling_settings — its week_start IS
-- NULL "DSP default" pattern is documented broken (see 0098 header).
create table if not exists public.fleet_settings (
  dsp_id           uuid           primary key references public.dsps(id) on delete cascade,
  auto_van_assign  boolean        not null default false,
  created_at       timestamptz    not null default now(),
  updated_at       timestamptz    not null default now()
);

alter table public.fleet_settings enable row level security;
drop policy if exists "fleet_settings_rw" on public.fleet_settings;
create policy "fleet_settings_rw" on public.fleet_settings
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));
grant select, insert, update, delete on public.fleet_settings to authenticated;

-- Read helper — returns the DSP's row, creating defaults on the fly
-- so callers never have to handle "no row yet".
create or replace function public.fleet_settings_get()
returns public.fleet_settings
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.fleet_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from public.fleet_settings where dsp_id = v_dsp;
  if v_row.dsp_id is null then
    v_row := row(v_dsp, false, now(), now())::public.fleet_settings;
  end if;
  return v_row;
end;
$$;
grant execute on function public.fleet_settings_get() to authenticated;

-- Write helper — upserts.  Returns the saved row.
create or replace function public.fleet_settings_set(p_auto_van_assign boolean)
returns public.fleet_settings
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.fleet_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.fleet_settings (dsp_id, auto_van_assign)
  values (v_dsp, coalesce(p_auto_van_assign, false))
  on conflict (dsp_id) do update set auto_van_assign = excluded.auto_van_assign, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.fleet_settings_set(boolean) to authenticated;


-- ── 2. Manual per-day override setter ───────────────────────────────
-- Used by the inline picker on the Today's roster card.  Passing
-- p_vehicle_id = null clears the override entirely (the resolver
-- falls back to the standing chain).  Honors the (driver, date) and
-- (vehicle, date) uniqueness — if the target van already has a
-- different driver on that date, the call fails with a clear errcode.
create or replace function public.vehicle_day_assignment_set(
  p_driver_id uuid,
  p_date      date,
  p_vehicle_id uuid default null,
  p_source    text default 'manual',
  p_notes     text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vehicle_day_assignments;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_driver_id is null or p_date is null then
    raise exception 'driver_id_and_date_required' using errcode = '22023';
  end if;

  -- Clear path
  if p_vehicle_id is null then
    delete from public.vehicle_day_assignments
     where driver_id = p_driver_id and date = p_date and dsp_id = v_dsp;
    return jsonb_build_object('cleared', true);
  end if;

  -- Validate vehicle is owned by this DSP and isn't archived.
  if not exists (
    select 1 from public.vehicles
    where id = p_vehicle_id and dsp_id = v_dsp and archived_at is null
  ) then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;

  -- If another driver already owns this van on this date, surface a
  -- clean error the UI can show ("4271 is already assigned to Jose for
  -- today — clear that first.").
  if exists (
    select 1 from public.vehicle_day_assignments
    where vehicle_id = p_vehicle_id and date = p_date and dsp_id = v_dsp
      and driver_id <> p_driver_id
  ) then
    raise exception 'vehicle_already_assigned' using errcode = '23505';
  end if;

  insert into public.vehicle_day_assignments (
    dsp_id, vehicle_id, driver_id, date, source, notes, created_by
  ) values (
    v_dsp, p_vehicle_id, p_driver_id, p_date,
    coalesce(nullif(trim(p_source), ''), 'manual'),
    nullif(trim(p_notes), ''),
    auth.uid()
  )
  on conflict (driver_id, date) do update
    set vehicle_id = excluded.vehicle_id,
        source     = excluded.source,
        notes      = excluded.notes,
        updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'id',         v_row.id,
    'driver_id',  v_row.driver_id,
    'vehicle_id', v_row.vehicle_id,
    'date',       v_row.date,
    'source',     v_row.source
  );
end;
$$;
grant execute on function public.vehicle_day_assignment_set(uuid, date, uuid, text, text) to authenticated;


-- ── 3. Available-vans-for-date picker helper ────────────────────────
-- For the inline picker dropdown: returns every van the operator
-- could plausibly hand to this driver for this date, sorted by name.
-- We include even committed vans (marked as such) so the operator can
-- see who currently holds them; the UI greys-out the unavailable ones.
create or replace function public.vehicles_pickable_for_day(
  p_date      date,
  p_driver_id uuid default null
) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(j order by j->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',                v.id,
      'name',              v.name,
      'plate',             v.plate,
      'kind',              v.kind,
      'status',            v.status,
      'operational_status',v.operational_status,
      'committed',         (com.committed_to is not null),
      'committed_to',      com.committed_to,
      'committed_kind',    com.committed_kind,
      'is_current',        (cur.driver_id = p_driver_id)
    ) j
    from public.vehicles v
    left join lateral (
      -- Who, if anyone, currently has this van for the date.
      -- Order: override → standing primary scheduled today → backup covering.
      with cand as (
        select 'override' as kind, oa.driver_id, d.full_name, d.preferred_name
          from public.vehicle_day_assignments oa
          join public.drivers d on d.id = oa.driver_id
          where oa.vehicle_id = v.id and oa.date = p_date
        union all
        select 'primary' as kind, a.driver_id, d.full_name, d.preferred_name
          from public.vehicle_driver_assignments a
          join public.drivers d on d.id = a.driver_id
          join public.shifts s on s.driver_id = a.driver_id
          where a.vehicle_id = v.id and a.rank = 0
            and s.date = p_date and s.dsp_id = v.dsp_id
            and s.status in ('scheduled','completed','late')
        union all
        select 'backup' as kind, a.driver_id, d.full_name, d.preferred_name
          from public.vehicle_driver_assignments a
          join public.drivers d on d.id = a.driver_id
          join public.shifts s on s.driver_id = a.driver_id
          where a.vehicle_id = v.id and a.rank > 0
            and s.date = p_date and s.dsp_id = v.dsp_id
            and s.status in ('scheduled','completed','late')
            and not exists (
              select 1 from public.vehicle_driver_assignments pa
              join public.shifts ps on ps.driver_id = pa.driver_id
              where pa.vehicle_id = v.id and pa.rank = 0
                and ps.date = p_date and ps.dsp_id = v.dsp_id
                and ps.status in ('scheduled','completed','late')
            )
      )
      select coalesce(nullif(trim(preferred_name), ''), nullif(trim(full_name), '')) as committed_to,
             kind as committed_kind, driver_id
        from cand
        order by case kind when 'override' then 0 when 'primary' then 1 else 2 end
        limit 1
    ) com on true
    left join lateral (
      select com.driver_id as driver_id
    ) cur on true
    where v.dsp_id = private.current_dsp_id()
      and v.archived_at is null
      and private.is_staff(v.dsp_id, 'dispatcher')
  ) t;
$$;
grant execute on function public.vehicles_pickable_for_day(date, uuid) to authenticated;


-- ── 4. Push to driver app — driver_vehicle_days reads overrides ────
-- The driver app's "your van today/this week" surface calls this RPC
-- with the driver's token.  Update it to check the per-day override
-- table first so manual changes and auto-assigned vans reach drivers.
create or replace function public.driver_vehicle_days(
  p_token text,
  p_from  date default current_date,
  p_to    date default (current_date + 14)
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv  public.drivers;
  v_from date := least(coalesce(p_from, current_date), coalesce(p_to, current_date + 14));
  v_to   date := greatest(coalesce(p_from, current_date), coalesce(p_to, current_date + 14));
begin
  v_drv := private.driver_validate_token(p_token);
  if v_to - v_from > 92 then v_to := v_from + 92; end if;

  return coalesce((
    with days as (
      select (v_from + g.i)::date as d from generate_series(0, (v_to - v_from)) as g(i)
    ),
    sched as (
      select d from days
      where exists (
        select 1 from public.shifts s
         where s.driver_id = v_drv.id and s.date = days.d and s.dsp_id = v_drv.dsp_id
           and s.status in ('scheduled', 'completed', 'late')
      )
    ),
    resolved as (
      select sched.d,
        -- 1. Per-day override wins
        ( select v.name from public.vehicles v
            join public.vehicle_day_assignments oa
              on oa.vehicle_id = v.id and oa.driver_id = v_drv.id and oa.date = sched.d
           where v.dsp_id = v_drv.dsp_id and v.archived_at is null
           limit 1 ) as override_van,
        -- 2. Standing primary
        ( select v.name from public.vehicles v
            join public.vehicle_driver_assignments a on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank = 0
           where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
             and not exists (
               select 1 from public.vehicle_day_assignments oa
               where oa.vehicle_id = v.id and oa.date = sched.d
             )
           order by v.name limit 1 ) as primary_van,
        -- 3. Standing backup whose primary isn't on today
        ( select v.name from public.vehicles v
            join public.vehicle_driver_assignments a on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank > 0
           where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
             and not exists (
               select 1 from public.vehicle_day_assignments oa
               where oa.vehicle_id = v.id and oa.date = sched.d
             )
             and not exists (
               select 1 from public.vehicle_driver_assignments ap
                 join public.shifts sp on sp.driver_id = ap.driver_id and sp.date = sched.d
                                       and sp.dsp_id = v_drv.dsp_id and sp.status in ('scheduled','completed','late')
                where ap.vehicle_id = v.id and ap.rank = 0
             )
           order by v.name limit 1 ) as backup_van
      from sched
    )
    select jsonb_agg(jsonb_build_object(
             'date',    d::text,
             'vehicle', coalesce(override_van, primary_van, backup_van),
             'via',     case
                          when override_van is not null then 'override'
                          when primary_van  is not null then 'primary'
                          when backup_van   is not null then 'backup'
                          else null
                        end
           ) order by d)
    from resolved
    where coalesce(override_van, primary_van, backup_van) is not null
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.driver_vehicle_days(text, date, date) to anon, authenticated;


notify pgrst, 'reload schema';
