-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0204 · Schedule templates
--
-- Save a recurring weekly pattern — which driver does which route on
-- which day, at what time, from which station — and paste it forward
-- into any future week. Big dispatcher time-saver after Cover. The
-- template is a snapshot of a single week's shifts; applying it
-- generates the same shape on the target week's dates, using the DSP
-- timezone to resolve start/end times.
--
-- Capture writes the slot rows from existing shifts. Apply creates new
-- shifts with source='template'. Conflicts (a shift already exists on
-- the target date for the same driver) are skipped silently unless the
-- dispatcher opts into overwrite.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Tables ────────────────────────────────────────────────────────────
create table if not exists public.schedule_templates (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  name        text not null,
  description text,
  created_by  uuid references public.app_users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists schedule_templates_dsp_idx
  on public.schedule_templates (dsp_id, updated_at desc);

create table if not exists public.schedule_template_slots (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references public.schedule_templates(id) on delete cascade,
  -- ISO weekday: 1 = Monday, 7 = Sunday (matches PG's extract(isodow)).
  day_of_week     int  not null check (day_of_week between 1 and 7),
  driver_id       uuid references public.drivers(id) on delete set null,
  station_id      uuid not null references public.stations(id) on delete cascade,
  service_type_id uuid references public.service_types(id) on delete set null,
  route_code      text,
  starts_local    time,
  ends_local      time,
  block_hours     int,
  wave_index      int default 0,
  sort_order      int default 0
);

create index if not exists schedule_template_slots_template_idx
  on public.schedule_template_slots (template_id, day_of_week, sort_order);

alter table public.schedule_templates       enable row level security;
alter table public.schedule_template_slots  enable row level security;

drop policy if exists schedule_templates_rw on public.schedule_templates;
create policy schedule_templates_rw on public.schedule_templates for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists schedule_template_slots_rw on public.schedule_template_slots;
create policy schedule_template_slots_rw on public.schedule_template_slots for all
  using (exists (
    select 1 from public.schedule_templates t
    where t.id = schedule_template_slots.template_id
      and t.dsp_id = private.current_dsp_id()
      and private.is_staff(t.dsp_id, 'dispatcher')
  ))
  with check (exists (
    select 1 from public.schedule_templates t
    where t.id = schedule_template_slots.template_id
      and t.dsp_id = private.current_dsp_id()
      and private.is_staff(t.dsp_id, 'dispatcher')
  ));

grant select, insert, update, delete on public.schedule_templates       to authenticated;
grant select, insert, update, delete on public.schedule_template_slots  to authenticated;

drop trigger if exists trg_schedule_templates_updated_at on public.schedule_templates;
create trigger trg_schedule_templates_updated_at
  before update on public.schedule_templates
  for each row execute function private.set_updated_at();


-- ── template_list ─────────────────────────────────────────────────────
create or replace function public.template_list()
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_rows jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',          t.id,
    'name',        t.name,
    'description', t.description,
    'slot_count',  (select count(*) from public.schedule_template_slots s where s.template_id = t.id),
    'driver_count',(select count(distinct s.driver_id) from public.schedule_template_slots s where s.template_id = t.id and s.driver_id is not null),
    'updated_at',  t.updated_at
  ) order by t.updated_at desc), '[]'::jsonb) into v_rows
  from public.schedule_templates t
  where t.dsp_id = v_dsp;
  return jsonb_build_object('templates', v_rows);
end;
$$;
grant execute on function public.template_list() to authenticated;


-- ── template_capture ──────────────────────────────────────────────────
-- Snapshot every shift in the named week into a new template. Names
-- must be unique per DSP (so 'Standard summer' doesn't get duplicated).
create or replace function public.template_capture(
  p_name        text,
  p_week_start  date,
  p_description text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_uid        uuid := auth.uid();
  v_app_user   uuid;
  v_template   public.schedule_templates;
  v_week_end   date := (p_week_start + interval '7 days')::date;
  v_name       text := nullif(trim(coalesce(p_name, '')), '');
  v_count      int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_name is null then raise exception 'name_required' using errcode = '22023'; end if;

  select id into v_app_user from public.app_users where id = v_uid limit 1;

  insert into public.schedule_templates (dsp_id, name, description, created_by)
  values (v_dsp, v_name, nullif(trim(coalesce(p_description, '')), ''), v_app_user)
  returning * into v_template;

  -- Pull every scheduled shift in the source week. day_of_week uses
  -- ISO weekday so Monday = 1 and Sunday = 7.
  insert into public.schedule_template_slots (
    template_id, day_of_week, driver_id, station_id, service_type_id,
    route_code, starts_local, ends_local, block_hours, wave_index, sort_order
  )
  select
    v_template.id,
    extract(isodow from s.date)::int,
    s.driver_id,
    s.station_id,
    s.service_type_id,
    s.route_code,
    case when s.starts_at is not null then s.starts_at::time end,
    case when s.ends_at   is not null then s.ends_at::time   end,
    s.block_hours,
    coalesce(s.wave_index, 0),
    row_number() over (partition by s.date order by coalesce(s.wave_index, 0), s.starts_at, s.route_code)::int
  from public.shifts s
  where s.dsp_id = v_dsp
    and s.date >= p_week_start
    and s.date <  v_week_end
    and s.status in ('scheduled','completed','late');

  get diagnostics v_count = row_count;

  return jsonb_build_object(
    'id',         v_template.id,
    'name',       v_template.name,
    'slot_count', v_count
  );
end;
$$;
grant execute on function public.template_capture(text, date, text) to authenticated;


-- ── template_get ──────────────────────────────────────────────────────
-- Returns a template's slots for preview / inspection.
create or replace function public.template_get(p_template_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_t   public.schedule_templates;
  v_rows jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_t from public.schedule_templates where id = p_template_id and dsp_id = v_dsp;
  if v_t.id is null then raise exception 'template_not_found' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',             s.id,
    'day_of_week',    s.day_of_week,
    'driver_id',      s.driver_id,
    'driver_name',    coalesce(nullif(trim(d.preferred_name),''),
                               nullif(trim(d.full_name),''),
                               trim(coalesce(d.first_name,'') || ' ' || coalesce(d.last_name,''))),
    'station_id',     s.station_id,
    'station_code',   st.code,
    'service_type_id',s.service_type_id,
    'route_code',     s.route_code,
    'starts_local',   s.starts_local,
    'ends_local',     s.ends_local,
    'block_hours',    s.block_hours,
    'wave_index',     s.wave_index
  ) order by s.day_of_week, s.sort_order), '[]'::jsonb) into v_rows
  from public.schedule_template_slots s
  left join public.drivers  d  on d.id  = s.driver_id
  left join public.stations st on st.id = s.station_id
  where s.template_id = p_template_id;

  return jsonb_build_object(
    'id',          v_t.id,
    'name',        v_t.name,
    'description', v_t.description,
    'slots',       v_rows
  );
end;
$$;
grant execute on function public.template_get(uuid) to authenticated;


-- ── template_apply ────────────────────────────────────────────────────
-- Paste the template into a target week. Generates new shifts; skips
-- (driver, date) pairs that already have a shift unless overwrite.
-- Overwrite is intentionally narrow: it only deletes shifts whose
-- source='template' on the target week, so a dispatcher's manual edits
-- never get clobbered.
create or replace function public.template_apply(
  p_template_id  uuid,
  p_target_week  date,
  p_overwrite    boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp         uuid := private.current_dsp_id();
  v_t           public.schedule_templates;
  v_tz          text;
  v_week_end    date := (p_target_week + interval '7 days')::date;
  v_slot_count  int := 0;
  v_inserted    int := 0;
  v_replaced    int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_t from public.schedule_templates where id = p_template_id and dsp_id = v_dsp;
  if v_t.id is null then raise exception 'template_not_found' using errcode = 'P0002'; end if;

  -- DSP timezone for local-time → timestamptz conversion.
  v_tz := coalesce(
    (select (metadata->'scheduling'->>'timezone')::text from public.dsps where id = v_dsp),
    'UTC'
  );

  select count(*) into v_slot_count
    from public.schedule_template_slots
    where template_id = p_template_id;

  -- Optional clean slate: drop any prior template-sourced shifts on
  -- the target week. Narrow on purpose — manual edits are preserved.
  if p_overwrite then
    delete from public.shifts
      where dsp_id = v_dsp
        and date >= p_target_week
        and date <  v_week_end
        and source = 'template';
    get diagnostics v_replaced = row_count;
  end if;

  -- Insert one shift per slot, skipping (date, driver_id) pairs that
  -- already have an active shift on the target week.
  with planned as (
    select
      (p_target_week + (s.day_of_week - 1) * interval '1 day')::date as target_date,
      s.driver_id,
      s.station_id,
      s.service_type_id,
      s.route_code,
      s.starts_local,
      s.ends_local,
      s.block_hours,
      s.wave_index
    from public.schedule_template_slots s
    where s.template_id = p_template_id
  )
  insert into public.shifts (
    dsp_id, station_id, driver_id, date, starts_at, ends_at,
    route_code, status, source, block_hours, wave_index, service_type_id
  )
  select
    v_dsp, p.station_id, p.driver_id, p.target_date,
    case when p.starts_local is not null
         then (p.target_date::timestamp + p.starts_local) at time zone v_tz end,
    case when p.ends_local is not null
         then (p.target_date::timestamp + p.ends_local)   at time zone v_tz end,
    p.route_code,
    'scheduled'::public.shift_status,
    'template'::public.shift_source,
    p.block_hours,
    coalesce(p.wave_index, 0),
    p.service_type_id
  from planned p
  where not exists (
    select 1 from public.shifts existing
    where existing.dsp_id = v_dsp
      and existing.date   = p.target_date
      and existing.driver_id is not distinct from p.driver_id
      and existing.status in ('scheduled','completed','late')
  );
  get diagnostics v_inserted = row_count;

  -- Bump updated_at so most-recently-used floats to the top.
  update public.schedule_templates set updated_at = now() where id = p_template_id;

  return jsonb_build_object(
    'inserted', v_inserted,
    'skipped',  greatest(v_slot_count - v_inserted, 0),
    'replaced', v_replaced,
    'week',     p_target_week
  );
end;
$$;
grant execute on function public.template_apply(uuid, date, boolean) to authenticated;


-- ── template_delete ───────────────────────────────────────────────────
create or replace function public.template_delete(p_template_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_deleted int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.schedule_templates
   where id = p_template_id and dsp_id = v_dsp;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.template_delete(uuid) to authenticated;


-- ── Realtime ─────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['schedule_templates','schedule_template_slots'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';
