-- ───────────────────────────────────────────────────────────────────────
-- 0369 · Native interview scheduling — Phase 1: availability + open-slots
--
-- RouteReady-owned alternative to Cal.com. This phase adds:
--   • interview_config         · per-DSP timezone / slot length / rules
--   • interview_availability   · weekly recurring windows (weekday + minutes)
--   • interview_availability_get/set()  · operator reads/writes its own
--   • interview_open_slots(token)        · the booking engine: availability
--       minus existing bookings, honoring lead time + buffers + timezone.
--
-- Parallel + safe: nothing here touches the live Cal.com path. The booking
-- page (Phase 2), Whereby room + emails (Phase 3) build on this. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

create table if not exists public.interview_config (
  dsp_id          uuid primary key references public.dsps(id) on delete cascade,
  timezone        text    not null default 'America/Chicago',
  slot_minutes    int     not null default 30,
  buffer_minutes  int     not null default 0,
  min_lead_hours  int     not null default 12,
  window_days     int     not null default 21,
  location        text,                          -- 'whereby' (video) or an address
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.interview_availability (
  id         uuid primary key default gen_random_uuid(),
  dsp_id     uuid not null references public.dsps(id) on delete cascade,
  weekday    smallint not null check (weekday between 0 and 6),   -- 0=Sun … 6=Sat
  start_min  int not null check (start_min between 0 and 1440),   -- minutes from local midnight
  end_min    int not null check (end_min between 0 and 1440),
  created_at timestamptz not null default now(),
  constraint interview_availability_order check (end_min > start_min)
);
create index if not exists interview_availability_dsp_idx
  on public.interview_availability (dsp_id, weekday);

alter table public.interview_config       enable row level security;
alter table public.interview_availability enable row level security;

drop policy if exists interview_config_rw on public.interview_config;
create policy interview_config_rw on public.interview_config for all
  using (dsp_id = private.current_dsp_id()) with check (dsp_id = private.current_dsp_id());

drop policy if exists interview_availability_rw on public.interview_availability;
create policy interview_availability_rw on public.interview_availability for all
  using (dsp_id = private.current_dsp_id()) with check (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.interview_config       to authenticated;
grant select, insert, update, delete on public.interview_availability to authenticated;

-- ── Operator: read current availability + config ──
create or replace function public.interview_availability_get()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'config',  (select to_jsonb(c) from public.interview_config c
                where c.dsp_id = private.current_dsp_id()),
    'windows', coalesce((
      select jsonb_agg(jsonb_build_object('weekday', weekday, 'start_min', start_min, 'end_min', end_min)
                        order by weekday, start_min)
      from public.interview_availability where dsp_id = private.current_dsp_id()
    ), '[]'::jsonb)
  );
$$;
grant execute on function public.interview_availability_get() to authenticated;

-- ── Operator: replace availability + config in one call ──
-- p_windows = [{"weekday":1,"start_min":540,"end_min":1020}, …]
create or replace function public.interview_availability_set(
  p_timezone text, p_slot_minutes int, p_buffer_minutes int,
  p_min_lead_hours int, p_window_days int, p_location text, p_windows jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  w jsonb;
begin
  if v_dsp is null then raise exception 'no_dsp'; end if;
  insert into public.interview_config
    (dsp_id, timezone, slot_minutes, buffer_minutes, min_lead_hours, window_days, location, updated_at)
  values
    (v_dsp, p_timezone, greatest(p_slot_minutes,5), greatest(p_buffer_minutes,0),
     greatest(p_min_lead_hours,0), greatest(p_window_days,1), p_location, now())
  on conflict (dsp_id) do update set
    timezone=excluded.timezone, slot_minutes=excluded.slot_minutes,
    buffer_minutes=excluded.buffer_minutes, min_lead_hours=excluded.min_lead_hours,
    window_days=excluded.window_days, location=excluded.location, updated_at=now();

  delete from public.interview_availability where dsp_id = v_dsp;
  for w in select * from jsonb_array_elements(coalesce(p_windows, '[]'::jsonb)) loop
    insert into public.interview_availability (dsp_id, weekday, start_min, end_min)
    values (v_dsp, (w->>'weekday')::int, (w->>'start_min')::int, (w->>'end_min')::int);
  end loop;
end; $$;
grant execute on function public.interview_availability_set(text,int,int,int,int,text,jsonb) to authenticated;

-- ── Booking engine: open slots for an applicant's booking token ──
-- Returns bookable start/end times = availability windows, chopped into
-- slot_minutes (+ buffer between), within [now+lead, now+window_days],
-- excluding anything that overlaps an existing interview/orientation.
create or replace function public.interview_open_slots(p_token text)
returns table (slot_start timestamptz, slot_end timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_app public.applicants;
  v_dsp uuid;
  v_cfg public.interview_config;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;
  v_dsp := v_app.dsp_id;

  select * into v_cfg from public.interview_config where dsp_id = v_dsp;
  if v_cfg.dsp_id is null then          -- sensible defaults if unconfigured
    v_cfg.timezone := 'America/Chicago'; v_cfg.slot_minutes := 30;
    v_cfg.buffer_minutes := 0; v_cfg.min_lead_hours := 12; v_cfg.window_days := 21;
  end if;

  return query
  with days as (
    select d::date as local_date
    from generate_series(
      (now() at time zone v_cfg.timezone)::date,
      (now() at time zone v_cfg.timezone)::date + v_cfg.window_days,
      interval '1 day'
    ) d
  ),
  windows as (
    select dy.local_date, av.start_min, av.end_min
    from days dy
    join public.interview_availability av
      on av.dsp_id = v_dsp
     and av.weekday = extract(dow from dy.local_date)::int
  ),
  slots as (
    select
      ((w.local_date::timestamp + make_interval(mins => s)) at time zone v_cfg.timezone) as ss,
      ((w.local_date::timestamp + make_interval(mins => s + v_cfg.slot_minutes)) at time zone v_cfg.timezone) as se
    from windows w
    cross join lateral generate_series(
      w.start_min, w.end_min - v_cfg.slot_minutes, v_cfg.slot_minutes + v_cfg.buffer_minutes
    ) s
  )
  select sl.ss, sl.se
  from slots sl
  where sl.ss >= now() + make_interval(hours => v_cfg.min_lead_hours)
    and not exists (
      select 1 from public.cal_events ce
      where ce.dsp_id = v_dsp
        and ce.kind in ('interview','orientation')
        and ce.status in ('scheduled','rescheduled')
        and tstzrange(ce.starts_at,
                      coalesce(ce.ends_at, ce.starts_at + make_interval(mins => v_cfg.slot_minutes)))
            && tstzrange(sl.ss, sl.se)
    )
  order by sl.ss;
end; $$;
grant execute on function public.interview_open_slots(text) to anon, authenticated;
