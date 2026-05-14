-- Migration 0221 · Unify staff into the drivers table via a role column
--
-- The previous design (0220) used a parallel staff_members + staff_shifts
-- pair, but staff and drivers are the same kind of person — a member
-- of the DSP team — with the same need for a record drawer, profile,
-- documents, chat, time-off, etc.  The split forced every "who works
-- here" surface to query two tables and made it impossible to put a
-- dispatcher on the driver record drawer without a second migration.
--
-- This migration:
--   1. Adds `role` to the drivers table (default 'driver'); existing
--      driver rows keep role='driver' so nothing changes for them.
--   2. Migrates any rows from staff_members into drivers, preserving
--      ids via a mapping table, and re-points staff_shifts.staff_id at
--      drivers.id.
--   3. Drops staff_members.
--   4. Rewrites the staff_* RPCs to read drivers where role <> 'driver'.
--   5. Adds a role='driver' filter on today_roster and driver_vehicle_days
--      so the driver schedule + driver-app surfaces stay drivers-only.
--
-- staff_shifts stays separate from shifts.  The columns don't line up
-- (shifts has station_id NOT NULL, a shift_status enum keyed to
-- attendance flows, etc.) and merging would cascade into far too many
-- downstream queries.  People are unified; shift tables stay split by
-- purpose.


-- ── 1. Role column ──────────────────────────────────────────────────
alter table public.drivers
  add column if not exists role text not null default 'driver';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'drivers_role_chk') then
    alter table public.drivers
      add constraint drivers_role_chk
      check (role in ('driver','dispatcher','fleet_manager','hr','ops_manager','other'));
  end if;
end $$;

create index if not exists drivers_dsp_role_idx on public.drivers (dsp_id, role);


-- ── 2. Migrate staff_members → drivers ──────────────────────────────
-- staff_members might not exist (fresh installs without 0220 applied
-- locally) — wrap the migration in a guard so this file is safe to
-- replay on any state.
do $$
declare m record; v_new uuid;
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'staff_members') then
    create temp table staff_migration_map (old_id uuid primary key, new_id uuid not null);

    -- Drop the old FK first so we can repoint shift rows mid-migration
    -- without the constraint rejecting the new (drivers) ids.
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'staff_shifts') then
      alter table public.staff_shifts
        drop constraint if exists staff_shifts_staff_id_fkey;
    end if;

    for m in select * from public.staff_members loop
      insert into public.drivers (
        dsp_id, full_name, preferred_name, email, phone, role,
        status, hire_date
      ) values (
        m.dsp_id, m.full_name, m.preferred_name, m.email, m.phone, m.role,
        case when m.archived_at is not null then 'inactive'::public.driver_status else 'active'::public.driver_status end,
        coalesce(m.created_at::date, current_date)
      )
      returning id into v_new;
      insert into staff_migration_map(old_id, new_id) values (m.id, v_new);
    end loop;

    -- Repoint + re-add the FK now pointing at drivers.
    -- Alias the temp table as `map` so it doesn't shadow the loop record `m`.
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'staff_shifts') then
      update public.staff_shifts s
         set staff_id = map.new_id
        from staff_migration_map map
       where s.staff_id = map.old_id;

      alter table public.staff_shifts
        add constraint staff_shifts_staff_id_fkey
        foreign key (staff_id) references public.drivers(id) on delete cascade;
    end if;

    drop table public.staff_members cascade;
    drop table staff_migration_map;
  end if;
end $$;


-- ── 3. Rewrite the staff_* RPCs to read from drivers ────────────────
create or replace function public.staff_members_list()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(j order by j->>'full_name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',             d.id,
      'full_name',      d.full_name,
      'preferred_name', d.preferred_name,
      'role',           d.role,
      'email',          d.email,
      'phone',          d.phone,
      'app_user_id',    null,
      'notes',          null,
      'archived_at',    case when d.status in ('inactive','terminated') then d.updated_at else null end,
      'updated_at',     d.updated_at
    ) j
    from public.drivers d
    where d.dsp_id = private.current_dsp_id()
      and d.role <> 'driver'
      and d.status not in ('terminated')
      and private.is_staff(d.dsp_id, 'dispatcher')
  ) t;
$$;
grant execute on function public.staff_members_list() to authenticated;


create or replace function public.staff_member_upsert(
  p_id             uuid default null,
  p_full_name      text default null,
  p_preferred_name text default null,
  p_role           text default 'other',
  p_email          text default null,
  p_phone          text default null,
  p_app_user_id    uuid default null,         -- ignored for now (kept for sig compat)
  p_notes          text default null          -- ignored for now (kept for sig compat)
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_id  uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_full_name), '') = '' then raise exception 'full_name_required' using errcode = '22023'; end if;
  if coalesce(p_role, '') not in ('dispatcher','fleet_manager','hr','ops_manager','other') then
    raise exception 'invalid_staff_role' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.drivers (
      dsp_id, full_name, preferred_name, role,
      email, phone, status, hire_date
    ) values (
      v_dsp, trim(p_full_name), nullif(trim(p_preferred_name), ''), p_role,
      nullif(trim(p_email), ''), nullif(trim(p_phone), ''),
      'active'::public.driver_status, current_date
    )
    returning id into v_id;
  else
    update public.drivers
       set full_name      = trim(p_full_name),
           preferred_name = nullif(trim(p_preferred_name), ''),
           role           = p_role,
           email          = nullif(trim(p_email), ''),
           phone          = nullif(trim(p_phone), ''),
           updated_at     = now()
     where id = p_id and dsp_id = v_dsp
     returning id into v_id;
    if v_id is null then raise exception 'staff_member_not_found' using errcode = 'P0002'; end if;
  end if;

  return jsonb_build_object('id', v_id, 'role', p_role);
end;
$$;
grant execute on function public.staff_member_upsert(uuid, text, text, text, text, text, uuid, text) to authenticated;


create or replace function public.staff_member_archive(p_id uuid, p_unarchive boolean default false)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.drivers
     set status = case when p_unarchive then 'active'::public.driver_status else 'inactive'::public.driver_status end,
         updated_at = now()
   where id = p_id and dsp_id = v_dsp and role <> 'driver';
  if not found then raise exception 'staff_member_not_found' using errcode = 'P0002'; end if;
end;
$$;
grant execute on function public.staff_member_archive(uuid, boolean) to authenticated;


create or replace function public.staff_schedule_grid(
  p_start date default current_date,
  p_weeks int default 1
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_from date := coalesce(p_start, current_date);
  v_to   date;
  v_staff  jsonb;
  v_shifts jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  v_to := v_from + (greatest(coalesce(p_weeks, 1), 1) * 7) - 1;

  select coalesce(jsonb_agg(j order by j->>'full_name'), '[]'::jsonb)
    into v_staff
    from (
      select jsonb_build_object(
        'id',             d.id,
        'full_name',      d.full_name,
        'preferred_name', d.preferred_name,
        'role',           d.role,
        'email',          d.email,
        'phone',          d.phone
      ) j
      from public.drivers d
      where d.dsp_id = v_dsp
        and d.role <> 'driver'
        and d.status not in ('terminated','inactive')
    ) t;

  select coalesce(jsonb_agg(j order by j->>'date', j->>'starts_at'), '[]'::jsonb)
    into v_shifts
    from (
      select jsonb_build_object(
        'id',         s.id,
        'staff_id',   s.staff_id,
        'date',       s.date,
        'starts_at',  s.starts_at,
        'ends_at',    s.ends_at,
        'role',       s.role,
        'notes',      s.notes
      ) j
      from public.staff_shifts s
      where s.dsp_id = v_dsp and s.date between v_from and v_to
    ) t;

  return jsonb_build_object(
    'start',  v_from, 'end', v_to,
    'weeks',  greatest(coalesce(p_weeks, 1), 1),
    'staff',  v_staff, 'shifts', v_shifts
  );
end;
$$;
grant execute on function public.staff_schedule_grid(date, int) to authenticated;


-- Tighten staff_shift_upsert to require the target is a non-driver person.
create or replace function public.staff_shift_upsert(
  p_id         uuid default null,
  p_staff_id   uuid default null,
  p_date       date default null,
  p_starts_at  timestamptz default null,
  p_ends_at    timestamptz default null,
  p_role       text default null,
  p_notes      text default null
) returns public.staff_shifts
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.staff_shifts;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_id is null then
    if p_staff_id is null or p_date is null then raise exception 'staff_id_and_date_required' using errcode = '22023'; end if;
    if not exists (
      select 1 from public.drivers where id = p_staff_id and dsp_id = v_dsp and role <> 'driver'
    ) then
      raise exception 'staff_member_not_found' using errcode = 'P0002';
    end if;
    insert into public.staff_shifts (dsp_id, staff_id, date, starts_at, ends_at, role, notes, created_by)
    values (v_dsp, p_staff_id, p_date, p_starts_at, p_ends_at,
            nullif(trim(p_role), ''), nullif(trim(p_notes), ''), auth.uid())
    returning * into v_row;
  else
    update public.staff_shifts set
      date = coalesce(p_date, date), starts_at = p_starts_at, ends_at = p_ends_at,
      role = nullif(trim(p_role), ''), notes = nullif(trim(p_notes), ''), updated_at = now()
    where id = p_id and dsp_id = v_dsp returning * into v_row;
    if v_row.id is null then raise exception 'staff_shift_not_found' using errcode = 'P0002'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.staff_shift_upsert(uuid, uuid, date, timestamptz, timestamptz, text, text) to authenticated;


-- ── 4. Driver-facing surfaces now filter role='driver' ──────────────
-- today_roster — only show role='driver' so the Today's Plan home page
-- stays driver-focused.  Staff get their own surface.
create or replace function public.today_roster(p_date date default current_date)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(j order by j->>'starts_at' nulls last, j->>'station_code' nulls last, j->>'driver_name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'shift_id',     s.id,
      'shift_date',   s.date,
      'starts_at',    s.starts_at,
      'ends_at',      s.ends_at,
      'route_code',   s.route_code,
      'shift_status', s.status,
      'station_id',   s.station_id,
      'station_code', st.code,
      'driver_id',    d.id,
      'driver_name',  coalesce(nullif(trim(d.preferred_name), ''), nullif(trim(d.full_name), ''), 'Driver'),
      'driver_photo_path', d.photo_path,
      'tier',         d.tier,
      'van_id',       resolved.van_id,
      'van_name',     resolved.van_name,
      'van_plate',    resolved.van_plate,
      'van_via',      resolved.via,
      'covering_for', resolved.covering_for_name,
      'gap_kind',     case when resolved.van_id is null then 'no_van' else null end
    ) j
    from public.shifts s
    join public.drivers d on d.id = s.driver_id
    left join public.stations st on st.id = s.station_id
    left join lateral (
      with override_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'override'::text as via, null::text as covering_for_name
        from public.vehicle_day_assignments oa
        join public.vehicles v on v.id = oa.vehicle_id
        where oa.driver_id = d.id and oa.date = p_date
          and v.dsp_id = d.dsp_id and v.archived_at is null
        limit 1
      ),
      primary_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'primary'::text as via, null::text as covering_for_name
        from public.vehicle_driver_assignments a
        join public.vehicles v on v.id = a.vehicle_id
        where a.driver_id = d.id and a.rank = 0
          and v.dsp_id = d.dsp_id and v.status = 'active' and v.archived_at is null
          and not exists (
            select 1 from public.vehicle_day_assignments oa
            where oa.vehicle_id = v.id and oa.date = p_date
          )
        order by v.name limit 1
      ),
      backup_pick as (
        select v.id as van_id, v.name as van_name, v.plate as van_plate,
               'backup'::text as via,
               coalesce(nullif(trim(pri_d.preferred_name), ''), nullif(trim(pri_d.full_name), '')) as covering_for_name
        from public.vehicle_driver_assignments a
        join public.vehicles v on v.id = a.vehicle_id
        left join public.vehicle_driver_assignments pri_a on pri_a.vehicle_id = v.id and pri_a.rank = 0
        left join public.drivers pri_d on pri_d.id = pri_a.driver_id
        where a.driver_id = d.id and a.rank > 0
          and v.dsp_id = d.dsp_id and v.status = 'active' and v.archived_at is null
          and not exists (
            select 1 from public.vehicle_day_assignments oa
            where oa.vehicle_id = v.id and oa.date = p_date
          )
          and (
            pri_a.driver_id is null
            or not exists (
              select 1 from public.shifts ps
              where ps.driver_id = pri_a.driver_id
                and ps.date = p_date
                and ps.dsp_id = d.dsp_id
                and ps.status in ('scheduled', 'completed', 'late')
            )
          )
        order by a.rank, v.name limit 1
      )
      select * from override_pick
      union all
      select * from primary_pick where not exists (select 1 from override_pick)
      union all
      select * from backup_pick where not exists (select 1 from override_pick) and not exists (select 1 from primary_pick)
      limit 1
    ) resolved on true
    where s.dsp_id = private.current_dsp_id()
      and private.is_staff(s.dsp_id, 'dispatcher')
      and s.date = p_date
      and s.driver_id is not null
      and d.role = 'driver'
  ) t;
$$;
grant execute on function public.today_roster(date) to authenticated;


-- driver_vehicle_days — when the token resolves to a non-driver (e.g.
-- a dispatcher who logged into the driver app by mistake), return an
-- empty schedule.  Real drivers see their resolution as before.
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
  if v_drv.role is distinct from 'driver' then
    return '[]'::jsonb;
  end if;
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
        ( select v.name from public.vehicles v
            join public.vehicle_day_assignments oa
              on oa.vehicle_id = v.id and oa.driver_id = v_drv.id and oa.date = sched.d
           where v.dsp_id = v_drv.dsp_id and v.archived_at is null
           limit 1 ) as override_van,
        ( select v.name from public.vehicles v
            join public.vehicle_driver_assignments a on a.vehicle_id = v.id and a.driver_id = v_drv.id and a.rank = 0
           where v.dsp_id = v_drv.dsp_id and v.status = 'active' and v.archived_at is null
             and not exists (
               select 1 from public.vehicle_day_assignments oa
               where oa.vehicle_id = v.id and oa.date = sched.d
             )
           order by v.name limit 1 ) as primary_van,
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
