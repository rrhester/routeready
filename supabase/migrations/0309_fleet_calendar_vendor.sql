-- Migration 0309 · Fleet calendar — events can name a service provider
--
-- The Fleet Calendar gains a "Service providers" rail (vendors). An
-- operator drags a provider onto a day cell to schedule service, so a
-- calendar event can now reference the vendor it is booked with.
--
--   · adds fleet_calendar_events.vendor_id
--   · fleet_calendar_events_list  — returns vendor_id + vendor_name
--   · fleet_calendar_event_upsert — takes p_vendor_id

alter table public.fleet_calendar_events
  add column if not exists vendor_id uuid references public.vendors(id) on delete set null;

create index if not exists fleet_calendar_events_vendor_idx
  on public.fleet_calendar_events (vendor_id);


-- ── Read · include the service provider ─────────────────────────────
create or replace function public.fleet_calendar_events_list(
  p_from date,
  p_to   date
) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',          e.id,
           'title',       e.title,
           'event_date',  e.event_date::text,
           'vehicle_id',  e.vehicle_id,
           'vendor_id',   e.vendor_id,
           'vendor_name', vn.name,
           'start_time',  to_char(e.start_time, 'HH24:MI'),
           'end_time',    to_char(e.end_time,   'HH24:MI'),
           'notes',       e.notes
         ) order by e.event_date, e.start_time nulls first, e.created_at), '[]'::jsonb)
  from public.fleet_calendar_events e
  left join public.vendors vn on vn.id = e.vendor_id
  where e.dsp_id = private.current_dsp_id()
    and private.is_staff(private.current_dsp_id(), 'dispatcher')
    and e.event_date >= p_from
    and e.event_date <= p_to;
$$;
grant execute on function public.fleet_calendar_events_list(date, date) to authenticated;


-- ── Write · now carries the service provider ────────────────────────
-- The 0307 signature gains p_vendor_id, so drop the old 7-arg overload
-- before recreating it (idempotent).
drop function if exists public.fleet_calendar_event_upsert(uuid, text, date, uuid, time, time, text);
create or replace function public.fleet_calendar_event_upsert(
  p_id         uuid,
  p_title      text,
  p_event_date date,
  p_vehicle_id uuid default null,
  p_vendor_id  uuid default null,
  p_start_time time default null,
  p_end_time   time default null,
  p_notes      text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.fleet_calendar_events;
  v_vendor_name text;
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
  if p_vendor_id is not null and not exists (
    select 1 from public.vendors where id = p_vendor_id and dsp_id = v_dsp
  ) then
    raise exception 'vendor_not_found' using errcode = 'P0002';
  end if;

  if p_id is null then
    insert into public.fleet_calendar_events
      (dsp_id, title, event_date, vehicle_id, vendor_id, start_time, end_time, notes, created_by)
    values
      (v_dsp, btrim(p_title), p_event_date, p_vehicle_id, p_vendor_id, p_start_time, p_end_time,
       nullif(btrim(p_notes), ''), auth.uid())
    returning * into v_row;
  else
    update public.fleet_calendar_events
       set title      = btrim(p_title),
           event_date = p_event_date,
           vehicle_id = p_vehicle_id,
           vendor_id  = p_vendor_id,
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

  select name into v_vendor_name from public.vendors where id = v_row.vendor_id;

  return jsonb_build_object(
    'id',          v_row.id,
    'title',       v_row.title,
    'event_date',  v_row.event_date::text,
    'vehicle_id',  v_row.vehicle_id,
    'vendor_id',   v_row.vendor_id,
    'vendor_name', v_vendor_name,
    'start_time',  to_char(v_row.start_time, 'HH24:MI'),
    'end_time',    to_char(v_row.end_time,   'HH24:MI'),
    'notes',       v_row.notes
  );
end;
$$;
grant execute on function public.fleet_calendar_event_upsert(uuid, text, date, uuid, uuid, time, time, text) to authenticated;


notify pgrst, 'reload schema';
