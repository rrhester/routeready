-- Migration 0340 · Fleet calendar — optionally ground a van for its service
--                   window, with a roster alert to confirm un-grounding.
--
-- The Fleet calendar event modal gains a "ground this van while it's in the
-- shop" toggle. When set, the van auto-grounds on the day its service window
-- opens (single-day if no end_date), so scheduling won't assign it. It is NOT
-- auto-ungrounded — instead the Fleet roster surfaces an alert once the window
-- has ended, asking the DSP to confirm un-grounding (and only ungrounds if the
-- van is still grounded FOR THIS service event — a separate breakdown ground
-- in the meantime is left alone).
--
-- Pieces:
--   · fleet_calendar_events.service_grounds_vehicle  (bool flag)
--   · fleet_calendar_events.service_grounding_event_id (link to the grounding
--       event we opened, so we can tell "still service-grounded" later)
--   · fleet_calendar_event_upsert  — gains p_service_grounds (preserves the
--       flag; grounding itself is applied by the apply RPC below)
--   · fleet_apply_service_groundings()   — grounds flagged vans whose window
--       includes today and aren't grounded yet. Idempotent; safe to call on
--       every dashboard load (no cron needed).
--   · fleet_service_unground_alerts()    — flagged events whose window has
--       ended and whose grounding is still open → the roster alert rows.
--   · fleet_confirm_service_unground(p_event_id) — ungrounds, only if still
--       service-grounded by this event.
--
-- Idempotent throughout.

-- ── Columns ─────────────────────────────────────────────────────────────
alter table public.fleet_calendar_events
  add column if not exists service_grounds_vehicle boolean not null default false;
alter table public.fleet_calendar_events
  add column if not exists service_grounding_event_id uuid
    references public.vehicle_grounding_events(id) on delete set null;

-- ── Write · fleet_calendar_event_upsert gains p_service_grounds ──────────
-- New trailing param (defaulted) → drop the 9-arg overload from 0312 first.
drop function if exists public.fleet_calendar_event_upsert(uuid, text, date, date, uuid, uuid, time, time, text);
create or replace function public.fleet_calendar_event_upsert(
  p_id              uuid,
  p_title           text,
  p_event_date      date,
  p_end_date        date default null,
  p_vehicle_id      uuid default null,
  p_vendor_id       uuid default null,
  p_start_time      time default null,
  p_end_time        time default null,
  p_notes           text default null,
  p_service_grounds boolean default false
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.fleet_calendar_events;
  v_vendor_name text;
  v_end date;
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
  if p_end_date is not null and p_end_date < p_event_date then
    raise exception 'end_before_start' using errcode = '22023';
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
  -- Grounding requires a van to ground.
  if p_service_grounds and p_vehicle_id is null then
    raise exception 'grounding_requires_vehicle' using errcode = '22023';
  end if;

  v_end := case when p_end_date is null or p_end_date <= p_event_date
                then null else p_end_date end;

  if p_id is null then
    insert into public.fleet_calendar_events
      (dsp_id, title, event_date, end_date, vehicle_id, vendor_id,
       start_time, end_time, notes, service_grounds_vehicle, created_by)
    values
      (v_dsp, btrim(p_title), p_event_date, v_end, p_vehicle_id, p_vendor_id,
       p_start_time, p_end_time, p_notes, coalesce(p_service_grounds, false), auth.uid())
    returning * into v_row;
  else
    update public.fleet_calendar_events
       set title = btrim(p_title), event_date = p_event_date, end_date = v_end,
           vehicle_id = p_vehicle_id, vendor_id = p_vendor_id,
           start_time = p_start_time, end_time = p_end_time, notes = p_notes,
           service_grounds_vehicle = coalesce(p_service_grounds, false)
     where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then
      raise exception 'event_not_found' using errcode = 'P0002';
    end if;
  end if;

  select name into v_vendor_name from public.vendors where id = v_row.vendor_id;

  return jsonb_build_object(
    'id', v_row.id, 'title', v_row.title,
    'event_date', v_row.event_date::text,
    'end_date', coalesce(v_row.end_date, v_row.event_date)::text,
    'vehicle_id', v_row.vehicle_id, 'vendor_id', v_row.vendor_id,
    'vendor_name', v_vendor_name,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time', to_char(v_row.end_time, 'HH24:MI'),
    'notes', v_row.notes,
    'service_grounds_vehicle', v_row.service_grounds_vehicle
  );
end;
$$;
grant execute on function public.fleet_calendar_event_upsert(uuid, text, date, date, uuid, uuid, time, time, text, boolean) to authenticated;

-- ── Apply groundings whose window includes today ────────────────────────
-- Grounds any flagged event's van when the service window covers today and
-- the van isn't already grounded. Links the opened grounding event back to
-- the calendar row so we can later tell whether it's still service-grounded.
-- Idempotent: skips vans already grounded (whatever the reason). Returns the
-- number of vans newly grounded. Safe to call on every dashboard load.
create or replace function public.fleet_apply_service_groundings()
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_today date := current_date;
  r record;
  v_count int := 0;
  v_ge_id uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for r in
    select e.id, e.vehicle_id, e.title
      from public.fleet_calendar_events e
      join public.vehicles v on v.id = e.vehicle_id and v.dsp_id = v_dsp
     where e.dsp_id = v_dsp
       and e.service_grounds_vehicle = true
       and e.vehicle_id is not null
       and v.archived_at is null
       and e.event_date <= v_today
       and coalesce(e.end_date, e.event_date) >= v_today
       and coalesce(v.operational_status, 'operational') <> 'grounded'
  loop
    -- Ground via the same path the roster uses; the 0228 trigger opens a
    -- vehicle_grounding_events row from the status change.
    update public.vehicles
       set operational_status = 'grounded', updated_at = now()
     where id = r.vehicle_id and dsp_id = v_dsp;

    -- Stamp reason/category on the just-opened grounding event + link it.
    select id into v_ge_id
      from public.vehicle_grounding_events
     where vehicle_id = r.vehicle_id and ungrounded_at is null
     order by grounded_at desc
     limit 1;
    if v_ge_id is not null then
      update public.vehicle_grounding_events
         set reason   = coalesce(nullif(btrim(reason), ''), 'Scheduled service · ' || r.title),
             category = coalesce(category, 'preventive')
       where id = v_ge_id;
      update public.fleet_calendar_events
         set service_grounding_event_id = v_ge_id
       where id = r.id;
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
grant execute on function public.fleet_apply_service_groundings() to authenticated;

-- ── Roster alert · service windows that have ended but are still grounded ─
-- Returns one row per flagged calendar event whose window ended before today
-- and whose linked grounding event is still open (van still service-grounded).
-- Powers the "this van is scheduled to be out of the shop — un-ground it?"
-- roster alert.
create or replace function public.fleet_service_unground_alerts()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'event_id',    e.id,
             'vehicle_id',  e.vehicle_id,
             'vehicle_name', v.name,
             'title',       e.title,
             'event_date',  e.event_date::text,
             'end_date',    coalesce(e.end_date, e.event_date)::text
           ) order by coalesce(e.end_date, e.event_date))
      from public.fleet_calendar_events e
      join public.vehicles v on v.id = e.vehicle_id and v.dsp_id = v_dsp
      join public.vehicle_grounding_events ge
        on ge.id = e.service_grounding_event_id and ge.ungrounded_at is null
     where e.dsp_id = v_dsp
       and e.service_grounds_vehicle = true
       and v.archived_at is null
       and coalesce(v.operational_status, 'operational') = 'grounded'
       and coalesce(e.end_date, e.event_date) < current_date
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.fleet_service_unground_alerts() to authenticated;

-- ── Confirm un-ground · DSP accepts the alert ───────────────────────────
-- Ungrounds the van, but ONLY if it is still grounded by THIS service event
-- (its linked grounding event is still the open one). If a separate breakdown
-- ground happened since, we leave it grounded and report that.
create or replace function public.fleet_confirm_service_unground(p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_ev public.fleet_calendar_events;
  v_open_ge uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_ev from public.fleet_calendar_events
   where id = p_event_id and dsp_id = v_dsp;
  if v_ev.id is null then
    raise exception 'event_not_found' using errcode = 'P0002';
  end if;

  -- The van's currently-open grounding event.
  select id into v_open_ge
    from public.vehicle_grounding_events
   where vehicle_id = v_ev.vehicle_id and ungrounded_at is null
   order by grounded_at desc
   limit 1;

  -- Still service-grounded only if the open event is the one we linked.
  if v_open_ge is null or v_open_ge is distinct from v_ev.service_grounding_event_id then
    return jsonb_build_object('ungrounded', false, 'reason', 'not_service_grounded');
  end if;

  update public.vehicles
     set operational_status = 'operational', updated_at = now()
   where id = v_ev.vehicle_id and dsp_id = v_dsp;

  return jsonb_build_object('ungrounded', true, 'vehicle_id', v_ev.vehicle_id);
end;
$$;
grant execute on function public.fleet_confirm_service_unground(uuid) to authenticated;

notify pgrst, 'reload schema';
