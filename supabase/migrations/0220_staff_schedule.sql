-- Migration 0220 · Staff schedule (support roles, separate from drivers)
--
-- DSPs schedule more than drivers — dispatchers, fleet managers, HR,
-- ops managers, and other support staff all need to know when they're
-- on.  Keeping them on the drivers table or shifts table pollutes
-- every downstream query (today_roster, schedule_grid, attendance,
-- van assignments, driver-app feeds).  Two new tables, a clean parallel
-- to drivers + shifts, isolated by design.
--
--   staff_members  · standalone roster of support people for the DSP.
--                    Independent of app_users (a person can be on the
--                    staff schedule without ever needing a RouteReady
--                    login).  Linkable to an app_user when one exists.
--   staff_shifts   · date + time-window per staff person, with the
--                    role they're filling for that shift.
--
-- The driver schedule, today_roster, fleet assignments, etc. never
-- read either of these tables.  The new Schedule → Staff sub-tab is
-- the only surface that touches them.


-- ── 1. Staff members ────────────────────────────────────────────────
create table if not exists public.staff_members (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  full_name       text not null,
  preferred_name  text,
  role            text not null default 'other',   -- dispatcher | fleet_manager | hr | ops_manager | other
  email           text,
  phone           text,
  app_user_id     uuid references public.app_users(id) on delete set null,  -- optional link to a login
  notes           text,
  archived_at     timestamptz,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists staff_members_dsp_idx on public.staff_members (dsp_id, archived_at);
create index if not exists staff_members_role_idx on public.staff_members (dsp_id, role) where archived_at is null;

alter table public.staff_members enable row level security;
drop policy if exists "staff_members_rw" on public.staff_members;
create policy "staff_members_rw" on public.staff_members
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));
grant select, insert, update, delete on public.staff_members to authenticated;


-- ── 2. Staff shifts ─────────────────────────────────────────────────
create table if not exists public.staff_shifts (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  staff_id        uuid not null references public.staff_members(id) on delete cascade,
  date            date not null,
  starts_at       timestamptz,
  ends_at         timestamptz,
  role            text,                       -- overrides staff_members.role for this shift if set
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists staff_shifts_dsp_date_idx   on public.staff_shifts (dsp_id, date);
create index if not exists staff_shifts_staff_date_idx on public.staff_shifts (staff_id, date);

alter table public.staff_shifts enable row level security;
drop policy if exists "staff_shifts_rw" on public.staff_shifts;
create policy "staff_shifts_rw" on public.staff_shifts
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));
grant select, insert, update, delete on public.staff_shifts to authenticated;


-- ── 3. CRUD RPCs ────────────────────────────────────────────────────

-- List every non-archived staff member for the caller's DSP.
create or replace function public.staff_members_list()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(j order by j->>'full_name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',             m.id,
      'full_name',      m.full_name,
      'preferred_name', m.preferred_name,
      'role',           m.role,
      'email',          m.email,
      'phone',          m.phone,
      'app_user_id',    m.app_user_id,
      'notes',          m.notes,
      'archived_at',    m.archived_at,
      'updated_at',     m.updated_at
    ) j
    from public.staff_members m
    where m.dsp_id = private.current_dsp_id()
      and m.archived_at is null
      and private.is_staff(m.dsp_id, 'dispatcher')
  ) t;
$$;
grant execute on function public.staff_members_list() to authenticated;

-- Create or update a staff member.
create or replace function public.staff_member_upsert(
  p_id             uuid default null,
  p_full_name      text default null,
  p_preferred_name text default null,
  p_role           text default 'other',
  p_email          text default null,
  p_phone          text default null,
  p_app_user_id    uuid default null,
  p_notes          text default null
) returns public.staff_members
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.staff_members;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_full_name), '') = '' then raise exception 'full_name_required' using errcode = '22023'; end if;
  if coalesce(p_role, '') not in ('dispatcher','fleet_manager','hr','ops_manager','other') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.staff_members (
      dsp_id, full_name, preferred_name, role, email, phone, app_user_id, notes, created_by
    ) values (
      v_dsp, trim(p_full_name), nullif(trim(p_preferred_name), ''),
      coalesce(p_role, 'other'),
      nullif(trim(p_email), ''), nullif(trim(p_phone), ''),
      p_app_user_id, nullif(trim(p_notes), ''),
      auth.uid()
    )
    returning * into v_row;
  else
    update public.staff_members set
      full_name      = trim(p_full_name),
      preferred_name = nullif(trim(p_preferred_name), ''),
      role           = coalesce(p_role, 'other'),
      email          = nullif(trim(p_email), ''),
      phone          = nullif(trim(p_phone), ''),
      app_user_id    = p_app_user_id,
      notes          = nullif(trim(p_notes), ''),
      updated_at     = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then raise exception 'staff_member_not_found' using errcode = 'P0002'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.staff_member_upsert(uuid, text, text, text, text, text, uuid, text) to authenticated;

-- Soft-archive (or restore) a staff member.  Their shifts stay so the
-- historical schedule isn't blanked out — they just stop showing up in
-- the active roster.
create or replace function public.staff_member_archive(p_id uuid, p_unarchive boolean default false)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.staff_members
     set archived_at = case when p_unarchive then null else now() end,
         updated_at  = now()
   where id = p_id and dsp_id = v_dsp;
  if not found then raise exception 'staff_member_not_found' using errcode = 'P0002'; end if;
end;
$$;
grant execute on function public.staff_member_archive(uuid, boolean) to authenticated;


-- Week-window grid feed: every staff_member + every shift in the
-- requested date range, structured for the staff schedule renderer.
create or replace function public.staff_schedule_grid(
  p_start date default current_date,
  p_weeks int default 1
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_from  date := coalesce(p_start, current_date);
  v_to    date;
  v_staff jsonb;
  v_shifts jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  v_to := v_from + (greatest(coalesce(p_weeks, 1), 1) * 7) - 1;

  select coalesce(jsonb_agg(j order by j->>'full_name'), '[]'::jsonb)
    into v_staff
    from (
      select jsonb_build_object(
        'id',             m.id,
        'full_name',      m.full_name,
        'preferred_name', m.preferred_name,
        'role',           m.role,
        'email',          m.email,
        'phone',          m.phone
      ) j
      from public.staff_members m
      where m.dsp_id = v_dsp and m.archived_at is null
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
      where s.dsp_id = v_dsp
        and s.date between v_from and v_to
    ) t;

  return jsonb_build_object(
    'start',  v_from,
    'end',    v_to,
    'weeks',  greatest(coalesce(p_weeks, 1), 1),
    'staff',  v_staff,
    'shifts', v_shifts
  );
end;
$$;
grant execute on function public.staff_schedule_grid(date, int) to authenticated;


-- Create or update a single staff shift.
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
    if p_staff_id is null or p_date is null then
      raise exception 'staff_id_and_date_required' using errcode = '22023';
    end if;
    if not exists (select 1 from public.staff_members where id = p_staff_id and dsp_id = v_dsp) then
      raise exception 'staff_member_not_found' using errcode = 'P0002';
    end if;
    insert into public.staff_shifts (
      dsp_id, staff_id, date, starts_at, ends_at, role, notes, created_by
    ) values (
      v_dsp, p_staff_id, p_date, p_starts_at, p_ends_at,
      nullif(trim(p_role), ''), nullif(trim(p_notes), ''),
      auth.uid()
    )
    returning * into v_row;
  else
    update public.staff_shifts set
      date       = coalesce(p_date, date),
      starts_at  = p_starts_at,
      ends_at    = p_ends_at,
      role       = nullif(trim(p_role), ''),
      notes      = nullif(trim(p_notes), ''),
      updated_at = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then raise exception 'staff_shift_not_found' using errcode = 'P0002'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.staff_shift_upsert(uuid, uuid, date, timestamptz, timestamptz, text, text) to authenticated;


create or replace function public.staff_shift_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.staff_shifts where id = p_id and dsp_id = v_dsp;
  if not found then raise exception 'staff_shift_not_found' using errcode = 'P0002'; end if;
end;
$$;
grant execute on function public.staff_shift_delete(uuid) to authenticated;


notify pgrst, 'reload schema';
