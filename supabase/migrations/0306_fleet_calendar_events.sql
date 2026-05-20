-- Migration 0306 · Fleet calendar — free-form scheduled events
--
-- Backs the new Fleet Calendar sub-view on the Schedule page. The
-- operator opens a month grid and drops free-form events on any day
-- (title + optional start/end time + notes). Events are DSP-scoped
-- and shared across everyone on the DSP, same RLS shape as
-- fleet_settings (0218).
--
--   · fleet_calendar_events            — the table
--   · fleet_calendar_events_list(from,to) — month-range read
--   · fleet_calendar_event_upsert(...)  — insert (p_id null) / update
--   · fleet_calendar_event_delete(id)   — remove one

-- ── Table ───────────────────────────────────────────────────────────
create table if not exists public.fleet_calendar_events (
  id          uuid        primary key default gen_random_uuid(),
  dsp_id      uuid        not null references public.dsps(id) on delete cascade,
  title       text        not null,
  event_date  date        not null,
  start_time  time,
  end_time    time,
  notes       text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists fleet_calendar_events_dsp_date_idx
  on public.fleet_calendar_events (dsp_id, event_date);

alter table public.fleet_calendar_events enable row level security;
drop policy if exists "fleet_calendar_events_rw" on public.fleet_calendar_events;
create policy "fleet_calendar_events_rw" on public.fleet_calendar_events
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));
grant select, insert, update, delete on public.fleet_calendar_events to authenticated;


-- ── Read · events within a date range (one month grid) ──────────────
create or replace function public.fleet_calendar_events_list(
  p_from date,
  p_to   date
) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',         e.id,
           'title',      e.title,
           'event_date', e.event_date::text,
           'start_time', to_char(e.start_time, 'HH24:MI'),
           'end_time',   to_char(e.end_time,   'HH24:MI'),
           'notes',      e.notes
         ) order by e.event_date, e.start_time nulls first, e.created_at), '[]'::jsonb)
  from public.fleet_calendar_events e
  where e.dsp_id = private.current_dsp_id()
    and private.is_staff(private.current_dsp_id(), 'dispatcher')
    and e.event_date >= p_from
    and e.event_date <= p_to;
$$;
grant execute on function public.fleet_calendar_events_list(date, date) to authenticated;


-- ── Write · insert (p_id null) or update an existing event ──────────
create or replace function public.fleet_calendar_event_upsert(
  p_id         uuid,
  p_title      text,
  p_event_date date,
  p_start_time time default null,
  p_end_time   time default null,
  p_notes      text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.fleet_calendar_events;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_title is null or btrim(p_title) = '' then
    raise exception 'title_required' using errcode = '22023';
  end if;
  if p_event_date is null then
    raise exception 'event_date_required' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.fleet_calendar_events
      (dsp_id, title, event_date, start_time, end_time, notes, created_by)
    values
      (v_dsp, btrim(p_title), p_event_date, p_start_time, p_end_time,
       nullif(btrim(p_notes), ''), auth.uid())
    returning * into v_row;
  else
    update public.fleet_calendar_events
       set title      = btrim(p_title),
           event_date = p_event_date,
           start_time = p_start_time,
           end_time   = p_end_time,
           notes      = nullif(btrim(p_notes), ''),
           updated_at = now()
     where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then
      raise exception 'event_not_found' using errcode = 'P0002';
    end if;
  end if;

  return jsonb_build_object(
    'id',         v_row.id,
    'title',      v_row.title,
    'event_date', v_row.event_date::text,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time',   to_char(v_row.end_time,   'HH24:MI'),
    'notes',      v_row.notes
  );
end;
$$;
grant execute on function public.fleet_calendar_event_upsert(uuid, text, date, time, time, text) to authenticated;


-- ── Delete · remove one event ───────────────────────────────────────
create or replace function public.fleet_calendar_event_delete(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.fleet_calendar_events where id = p_id and dsp_id = v_dsp;
  return jsonb_build_object('deleted', true);
end;
$$;
grant execute on function public.fleet_calendar_event_delete(uuid) to authenticated;


notify pgrst, 'reload schema';
