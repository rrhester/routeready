-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0027 · Block-aware shifts + auto-gen from OKAMI
--
-- Models the way DSPs actually schedule:
--   • A shift is a BLOCK with a length (default 10h, sometimes 8h or 4h).
--   • Drivers leave the station in WAVES — start times spaced 20–25 min
--     apart from a base wave_start (e.g. 07:00).
--   • Cushion (the over-plan buffer) is set once and rarely changes; the
--     EXTRA shifts beyond the route target get marked is_cushion=true so
--     the operator can see the buffer at a glance.
--   • Shifts auto-generate from okami_demand. Setting target_routes=10
--     with cushion 10% creates 11 shifts at the correct wave start
--     times — no manual Auto-fill week click required.
--
-- Single-station today; per-station wave config can be layered on later.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── DSP scheduling defaults ────────────────────────────────────────────
update public.dsps
   set metadata = coalesce(metadata, '{}'::jsonb)
        || jsonb_build_object('scheduling',
             coalesce(metadata->'scheduling', '{}'::jsonb)
             || jsonb_build_object(
                  'default_block_hours',     10,
                  'standup_minutes_before',  20,
                  'wave_start',              '07:00',
                  'wave_spacing_min',        25
                ));


-- ─── shifts: block_hours + is_cushion ───────────────────────────────────
alter table public.shifts add column if not exists block_hours int;
alter table public.shifts add column if not exists is_cushion  boolean not null default false;

create index if not exists shifts_dsp_date_cushion_idx
  on public.shifts (dsp_id, date, is_cushion);


-- ─── private.generate_shifts(dsp_id, date, station) ─────────────────────
-- Creates missing open shifts so the count matches:
--   target_routes × (1 + cushion%) rounded up.
-- First N (=target_routes) shifts have is_cushion=false. Remainder cushion.
-- starts_at = date @ wave_start + index * wave_spacing_min minutes.
-- ends_at   = starts_at + block_hours.
-- Existing scheduled/completed shifts are left alone; only the gap is
-- filled. Targets going DOWN don't auto-delete — that's an operator call.
create or replace function private.generate_shifts(p_dsp_id uuid, p_date date, p_station_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target int;
  v_cushion numeric;
  v_block_hours int;
  v_wave_start text;
  v_wave_spacing_min int;
  v_existing int;
  v_needed int;
  v_to_create int;
  v_index int;
  v_starts timestamptz;
  v_ends   timestamptz;
begin
  select coalesce(target_routes, 0)
    into v_target
  from public.okami_demand
   where dsp_id = p_dsp_id
     and station_id = p_station_id
     and date = p_date;
  v_target := coalesce(v_target, 0);

  select
      coalesce((metadata->'scheduling'->>'cushion_pct')::numeric, 10),
      coalesce((metadata->'scheduling'->>'default_block_hours')::int, 10),
      coalesce(metadata->'scheduling'->>'wave_start', '07:00'),
      coalesce((metadata->'scheduling'->>'wave_spacing_min')::int, 25)
    into v_cushion, v_block_hours, v_wave_start, v_wave_spacing_min
  from public.dsps where id = p_dsp_id;

  v_needed := ceil(v_target::numeric * (1 + v_cushion / 100))::int;

  select count(*)::int
    into v_existing
  from public.shifts
   where dsp_id = p_dsp_id
     and station_id = p_station_id
     and date = p_date
     and status in ('scheduled','completed');

  v_to_create := greatest(0, v_needed - v_existing);
  if v_to_create = 0 then return 0; end if;

  for v_index in v_existing..(v_needed - 1) loop
    v_starts := (p_date::text || ' ' || v_wave_start)::timestamptz
                + (v_index * v_wave_spacing_min || ' minutes')::interval;
    v_ends   := v_starts + (v_block_hours || ' hours')::interval;

    insert into public.shifts
      (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion)
    values
      (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto', v_block_hours, v_index >= v_target);
  end loop;

  return v_to_create;
end;
$$;


-- Public RPC: lets the UI manually regenerate (e.g. after deleting a shift).
create or replace function public.generate_shifts_for_date(p_date date, p_station_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return private.generate_shifts(v_dsp, p_date, p_station_id);
end;
$$;
grant execute on function public.generate_shifts_for_date(date, uuid) to authenticated;


-- ─── Trigger: regenerate when okami_demand changes ──────────────────────
create or replace function private.tg_okami_demand_regenerate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT'
     or coalesce(OLD.target_routes, -1) <> coalesce(NEW.target_routes, -1) then
    perform private.generate_shifts(NEW.dsp_id, NEW.date, NEW.station_id);
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_okami_demand_regenerate on public.okami_demand;
create trigger trg_okami_demand_regenerate
  after insert or update on public.okami_demand
  for each row execute function private.tg_okami_demand_regenerate();


-- ─── Backfill: regenerate for existing okami_demand rows ────────────────
do $$
declare r record;
begin
  for r in select dsp_id, date, station_id from public.okami_demand loop
    perform private.generate_shifts(r.dsp_id, r.date, r.station_id);
  end loop;
end $$;


-- ─── schedule_grid v2 — expose is_cushion + block_hours to the UI ──────
create or replace function public.schedule_grid(p_start date, p_weeks int default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_end date := p_start + (p_weeks * 7 - 1);
  v_grid jsonb;
  v_shifts jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
    into v_grid
  from public.okami_grid(p_start, p_weeks) g;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', sh.id, 'date', sh.date, 'station_id', sh.station_id,
    'driver_id', sh.driver_id, 'driver_name', d.full_name,
    'route_code', sh.route_code, 'status', sh.status,
    'starts_at', sh.starts_at, 'ends_at', sh.ends_at,
    'block_hours', sh.block_hours, 'is_cushion', sh.is_cushion,
    'notes', sh.notes
  ) order by sh.date, sh.station_id, sh.starts_at), '[]'::jsonb)
    into v_shifts
  from public.shifts sh
  left join public.drivers d on d.id = sh.driver_id
  where sh.dsp_id = v_dsp
    and sh.date between p_start and v_end;

  return jsonb_build_object('coverage', v_grid, 'shifts', v_shifts,
                            'start', p_start, 'weeks', p_weeks);
end;
$$;
grant execute on function public.schedule_grid(date, int) to authenticated;
