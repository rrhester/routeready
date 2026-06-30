-- ───────────────────────────────────────────────────────────────────────
-- 0400 · Named interview schedules (Google "Appointment schedule" style)
--
-- Multiple named, bookable schedules per DSP (e.g. "30 min with Ryan"), each
-- with its own duration / lead / window / timezone and its own weekly windows.
--
-- SAFE BY DESIGN: the public booking engine (interview_open_slots /
-- book_interview_slot / booking_load) is left reading interview_config +
-- interview_availability exactly as before. Whenever a schedule is saved or
-- activated, the ACTIVE schedule is mirrored into those legacy tables, so the
-- booking flow always reflects the active schedule and existing /b/<token>
-- links keep working unchanged.
--
-- Idempotent — safe to re-run.
-- ───────────────────────────────────────────────────────────────────────

create table if not exists public.interview_schedules (
  id             uuid primary key default gen_random_uuid(),
  dsp_id         uuid not null references public.dsps(id) on delete cascade,
  name           text not null default 'Interview',
  timezone       text not null default 'America/Chicago',
  slot_minutes   int  not null default 30,
  buffer_minutes int  not null default 0,
  min_lead_hours int  not null default 12,
  window_days    int  not null default 21,
  location       text,
  is_active      boolean not null default false,
  sort_order     int  not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists interview_schedules_dsp_idx on public.interview_schedules (dsp_id, sort_order);
-- At most one active schedule per DSP.
create unique index if not exists interview_schedules_one_active
  on public.interview_schedules (dsp_id) where is_active;

create table if not exists public.interview_schedule_windows (
  id          uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.interview_schedules(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  start_min   int not null,
  end_min     int not null,
  capacity    int not null default 1 check (capacity >= 1),
  constraint isw_order check (end_min > start_min)
);
create index if not exists isw_sched_idx on public.interview_schedule_windows (schedule_id, weekday);

-- ── RLS ──
alter table public.interview_schedules enable row level security;
drop policy if exists interview_schedules_rw on public.interview_schedules;
create policy interview_schedules_rw on public.interview_schedules for all
  using (dsp_id = private.current_dsp_id()) with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.interview_schedules to authenticated;

alter table public.interview_schedule_windows enable row level security;
drop policy if exists isw_rw on public.interview_schedule_windows;
create policy isw_rw on public.interview_schedule_windows for all
  using (exists (select 1 from public.interview_schedules s where s.id = schedule_id and s.dsp_id = private.current_dsp_id()))
  with check (exists (select 1 from public.interview_schedules s where s.id = schedule_id and s.dsp_id = private.current_dsp_id()));
grant select, insert, update, delete on public.interview_schedule_windows to authenticated;

-- ── Backfill: every DSP that already configured availability gets one active
--    "Interview" schedule mirroring its current config + windows. ──
do $$
declare c record; v_sid uuid;
begin
  for c in select * from public.interview_config loop
    if not exists (select 1 from public.interview_schedules s where s.dsp_id = c.dsp_id) then
      insert into public.interview_schedules
        (dsp_id, name, timezone, slot_minutes, buffer_minutes, min_lead_hours, window_days, location, is_active, sort_order)
      values (c.dsp_id, 'Interview', coalesce(c.timezone,'America/Chicago'), coalesce(c.slot_minutes,30),
              coalesce(c.buffer_minutes,0), coalesce(c.min_lead_hours,12), coalesce(c.window_days,21), c.location, true, 0)
      returning id into v_sid;
      insert into public.interview_schedule_windows (schedule_id, weekday, start_min, end_min, capacity)
        select v_sid, av.weekday, av.start_min, av.end_min, av.capacity
        from public.interview_availability av where av.dsp_id = c.dsp_id;
    end if;
  end loop;
end $$;

-- ── Mirror the active schedule into the legacy booking tables (internal). ──
create or replace function private.iv_mirror_active(p_dsp uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.interview_schedules;
begin
  select * into s from public.interview_schedules where dsp_id = p_dsp and is_active limit 1;
  if s.id is null then return; end if;
  insert into public.interview_config
    (dsp_id, timezone, slot_minutes, buffer_minutes, min_lead_hours, window_days, location, updated_at)
  values (p_dsp, s.timezone, s.slot_minutes, s.buffer_minutes, s.min_lead_hours, s.window_days, s.location, now())
  on conflict (dsp_id) do update set
    timezone=excluded.timezone, slot_minutes=excluded.slot_minutes, buffer_minutes=excluded.buffer_minutes,
    min_lead_hours=excluded.min_lead_hours, window_days=excluded.window_days, location=excluded.location, updated_at=now();
  delete from public.interview_availability where dsp_id = p_dsp;
  insert into public.interview_availability (dsp_id, weekday, start_min, end_min, capacity)
    select p_dsp, w.weekday, w.start_min, w.end_min, w.capacity
    from public.interview_schedule_windows w where w.schedule_id = s.id;
end; $$;

-- ── Operator RPCs ──
create or replace function public.interview_schedules_list()
returns setof public.interview_schedules language sql stable security definer set search_path='' as $$
  select * from public.interview_schedules where dsp_id = private.current_dsp_id() order by sort_order, created_at;
$$;
grant execute on function public.interview_schedules_list() to authenticated;

create or replace function public.interview_schedule_get(p_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'schedule', (select to_jsonb(s) from public.interview_schedules s where s.id = p_id and s.dsp_id = private.current_dsp_id()),
    'windows', coalesce((select jsonb_agg(jsonb_build_object('weekday',weekday,'start_min',start_min,'end_min',end_min,'capacity',capacity)
                                 order by weekday, start_min)
                          from public.interview_schedule_windows where schedule_id = p_id), '[]'::jsonb)
  );
$$;
grant execute on function public.interview_schedule_get(uuid) to authenticated;

-- Create (p_id null) or update a schedule + replace its windows. Mirrors the
-- active schedule into the booking tables. Returns the schedule id.
create or replace function public.interview_schedule_save(
  p_id uuid, p_name text, p_timezone text, p_slot_minutes int, p_buffer_minutes int,
  p_min_lead_hours int, p_window_days int, p_location text, p_windows jsonb, p_make_active boolean default false
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_dsp uuid := private.current_dsp_id(); v_id uuid := p_id; w jsonb;
begin
  if v_dsp is null then raise exception 'no_dsp'; end if;
  if v_id is null then
    insert into public.interview_schedules
      (dsp_id, name, timezone, slot_minutes, buffer_minutes, min_lead_hours, window_days, location, is_active, sort_order)
    values (v_dsp, coalesce(nullif(btrim(p_name),''),'Interview'), coalesce(p_timezone,'America/Chicago'),
            greatest(p_slot_minutes,5), greatest(p_buffer_minutes,0), greatest(p_min_lead_hours,0), greatest(p_window_days,1), p_location,
            coalesce(p_make_active,false) or not exists (select 1 from public.interview_schedules where dsp_id=v_dsp),
            coalesce((select max(sort_order)+1 from public.interview_schedules where dsp_id=v_dsp), 0))
    returning id into v_id;
  else
    update public.interview_schedules set
      name=coalesce(nullif(btrim(p_name),''),name), timezone=coalesce(p_timezone,timezone),
      slot_minutes=greatest(p_slot_minutes,5), buffer_minutes=greatest(p_buffer_minutes,0),
      min_lead_hours=greatest(p_min_lead_hours,0), window_days=greatest(p_window_days,1), location=p_location, updated_at=now()
    where id=v_id and dsp_id=v_dsp;
    if not found then raise exception 'schedule_not_found'; end if;
  end if;
  delete from public.interview_schedule_windows where schedule_id=v_id;
  for w in select * from jsonb_array_elements(coalesce(p_windows,'[]'::jsonb)) loop
    insert into public.interview_schedule_windows (schedule_id, weekday, start_min, end_min, capacity)
    values (v_id, (w->>'weekday')::int, (w->>'start_min')::int, (w->>'end_min')::int, greatest(coalesce((w->>'capacity')::int,1),1));
  end loop;
  if coalesce(p_make_active,false) then
    update public.interview_schedules set is_active=(id=v_id) where dsp_id=v_dsp;
  end if;
  perform private.iv_mirror_active(v_dsp);
  return v_id;
end; $$;
grant execute on function public.interview_schedule_save(uuid,text,text,int,int,int,int,text,jsonb,boolean) to authenticated;

create or replace function public.interview_schedule_activate(p_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not exists (select 1 from public.interview_schedules where id=p_id and dsp_id=v_dsp) then raise exception 'schedule_not_found'; end if;
  update public.interview_schedules set is_active=(id=p_id) where dsp_id=v_dsp;
  perform private.iv_mirror_active(v_dsp);
end; $$;
grant execute on function public.interview_schedule_activate(uuid) to authenticated;

create or replace function public.interview_schedule_delete(p_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_dsp uuid := private.current_dsp_id(); v_was_active boolean;
begin
  select is_active into v_was_active from public.interview_schedules where id=p_id and dsp_id=v_dsp;
  delete from public.interview_schedules where id=p_id and dsp_id=v_dsp;
  if coalesce(v_was_active,false) then
    update public.interview_schedules set is_active=true
      where id = (select id from public.interview_schedules where dsp_id=v_dsp order by sort_order, created_at limit 1);
    perform private.iv_mirror_active(v_dsp);
  end if;
end; $$;
grant execute on function public.interview_schedule_delete(uuid) to authenticated;

-- ── booking_load: surface the active schedule's name for the booking page. ──
create or replace function public.booking_load(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_app public.applicants;
  v_dsp public.dsps;
  v_cfg public.interview_config;
  v_name text;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;
  select * into v_dsp from public.dsps where id = v_app.dsp_id;
  select * into v_cfg from public.interview_config where dsp_id = v_app.dsp_id;
  select name into v_name from public.interview_schedules where dsp_id = v_app.dsp_id and is_active limit 1;
  return jsonb_build_object(
    'dsp', jsonb_build_object('name', v_dsp.name, 'short_code', v_dsp.short_code),
    'applicant', jsonb_build_object('first_name', v_app.first_name, 'full_name', v_app.full_name),
    'timezone', coalesce(v_cfg.timezone, 'America/Chicago'),
    'slot_minutes', coalesce(v_cfg.slot_minutes, 30),
    'schedule_name', v_name,
    'already_booked', exists(
      select 1 from public.cal_events ce
      where ce.applicant_id = v_app.id and ce.kind = 'interview'
        and ce.status in ('scheduled','rescheduled')
    )
  );
end; $$;
grant execute on function public.booking_load(text) to anon, authenticated;
