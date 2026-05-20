-- Migration 0307 · Fleet calendar — events belong to a van
--
-- The Fleet Calendar is now a week grid with one row per van (it
-- reads like the driver schedule, but the left column is a van name
-- instead of a driver). So each event is attached to a vehicle.
--
--   · adds fleet_calendar_events.vehicle_id
--   · fleet_calendar_events_list  — now returns vehicle_id
--   · fleet_calendar_event_upsert — now takes p_vehicle_id

alter table public.fleet_calendar_events
  add column if not exists vehicle_id uuid references public.vehicles(id) on delete cascade;

create index if not exists fleet_calendar_events_vehicle_idx
  on public.fleet_calendar_events (vehicle_id);


-- ── Read · include the vehicle ──────────────────────────────────────
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
           'vehicle_id', e.vehicle_id,
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


-- ── Write · now carries the vehicle ─────────────────────────────────
-- The 0306 signature gains a p_vehicle_id parameter, so drop the old
-- 6-arg overload before recreating it (idempotent).
drop function if exists public.fleet_calendar_event_upsert(uuid, text, date, time, time, text);
create or replace function public.fleet_calendar_event_upsert(
  p_id         uuid,
  p_title      text,
  p_event_date date,
  p_vehicle_id uuid default null,
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
  if p_vehicle_id is not null and not exists (
    select 1 from public.vehicles where id = p_vehicle_id and dsp_id = v_dsp
  ) then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;

  if p_id is null then
    insert into public.fleet_calendar_events
      (dsp_id, title, event_date, vehicle_id, start_time, end_time, notes, created_by)
    values
      (v_dsp, btrim(p_title), p_event_date, p_vehicle_id, p_start_time, p_end_time,
       nullif(btrim(p_notes), ''), auth.uid())
    returning * into v_row;
  else
    update public.fleet_calendar_events
       set title      = btrim(p_title),
           event_date = p_event_date,
           vehicle_id = p_vehicle_id,
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
    'vehicle_id', v_row.vehicle_id,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time',   to_char(v_row.end_time,   'HH24:MI'),
    'notes',      v_row.notes
  );
end;
$$;
grant execute on function public.fleet_calendar_event_upsert(uuid, text, date, uuid, time, time, text) to authenticated;


notify pgrst, 'reload schema';
