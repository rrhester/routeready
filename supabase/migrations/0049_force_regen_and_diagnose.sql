-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0049 · Re-run shift regen + add diagnose RPC
--
-- 0048 reconciled Tue/Wed/Thu but Mon stayed at 2 shifts despite the
-- operator setting wave-0 demand=2. Possibilities:
--   (a) Mon's wave-0 demand row was added after 0048 ran, and although
--       the trigger should have fired generate_shifts, something masked it.
--   (b) The demand row wasn't actually persisted (UI showed value but
--       DB row never landed).
--   (c) generate_shifts has a state-dependent bug we haven't pinned down.
--
-- Step 1 below brute-forces the regen across every (dsp, date, station)
-- with demand — same pass 0048 did, just running again now that the
-- operator's manual save attempts are committed. If (a), this fixes it.
--
-- Step 2 adds a public.diagnose_day(date) RPC so we can see exactly what
-- the DB has for any given day if the schedule still doesn't match —
-- pulls demand rows + shift rows + the effective scheduling_settings.
-- Safe to call from the dashboard console; dispatcher-gated.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Force regen across all current demand rows ──
do $$
declare r record;
begin
  for r in
    select distinct dsp_id, date, station_id
      from public.okami_demand
  loop
    perform private.generate_shifts(r.dsp_id, r.date, r.station_id);
  end loop;
end $$;


-- ── 2. Diagnose RPC ──
create or replace function public.diagnose_day(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_settings public.scheduling_settings;
  v_demand jsonb;
  v_shifts jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_settings := private.get_week_settings(v_dsp, private.week_start_for(p_date));

  select coalesce(jsonb_agg(to_jsonb(d) order by d.station_id, d.wave_index), '[]'::jsonb)
    into v_demand
  from public.okami_demand d
   where d.dsp_id = v_dsp
     and d.date = p_date;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',           sh.id,
        'station_id',   sh.station_id,
        'starts_at',    sh.starts_at,
        'ends_at',      sh.ends_at,
        'wave_index',   sh.wave_index,
        'driver_id',    sh.driver_id,
        'status',       sh.status,
        'is_cushion',   sh.is_cushion,
        'source',       sh.source
      )
      order by sh.station_id, sh.wave_index, sh.starts_at
    ),
    '[]'::jsonb
  )
    into v_shifts
  from public.shifts sh
   where sh.dsp_id = v_dsp
     and sh.date = p_date;

  return jsonb_build_object(
    'date',     p_date,
    'settings', jsonb_build_object(
      'week_start', v_settings.week_start,
      'waves',      v_settings.waves,
      'timezone',   v_settings.timezone,
      'block_hours', v_settings.default_block_hours
    ),
    'demand',   v_demand,
    'shifts',   v_shifts
  );
end;
$$;
grant execute on function public.diagnose_day(date) to authenticated;
