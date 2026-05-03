-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0032 · regenerate_all_shifts also relocates assigned shifts
--
-- The 0030 version only refreshed block_hours / ends_at on assigned
-- shifts. Their starts_at stayed at the old wave time. Operator: 'wave
-- is 10am, but assigned chips still show 7am'.
--
-- New behavior: for every (date, station) the function repositions
-- BOTH assigned and unassigned shifts to the current waves config in
-- created_at order — slot index i lands on wave (i mod wave_count).
-- So a single wave at 10am moves every shift to 10am; two waves
-- alternate; etc.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.regenerate_all_shifts()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_block_hours int;
  v_waves jsonb;
  v_wave_count int;
  v_count int := 0;
  r record;
  s record;
  v_pos int;
  v_wave_start text;
  v_starts timestamptz;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce((metadata->'scheduling'->>'default_block_hours')::int, 10),
         coalesce(metadata->'scheduling'->'waves',
                  jsonb_build_array(jsonb_build_object('start', coalesce(metadata->'scheduling'->>'wave_start', '07:00'))))
    into v_block_hours, v_waves
  from public.dsps where id = v_dsp;

  v_wave_count := jsonb_array_length(coalesce(v_waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;

  -- Wipe unassigned scheduled shifts for the DSP — they'll get rebuilt
  -- by generate_shifts so cushion / count changes take effect.
  delete from public.shifts
   where dsp_id = v_dsp
     and driver_id is null
     and status = 'scheduled';

  -- Regenerate from every okami_demand row.
  for r in
    select date, station_id from public.okami_demand where dsp_id = v_dsp
  loop
    v_count := v_count + private.generate_shifts(v_dsp, r.date, r.station_id);
  end loop;

  -- Reposition ALL shifts (assigned + unassigned) for every (date, station)
  -- so they sit at the configured wave times in their natural order.
  for r in
    select distinct date, station_id from public.shifts
     where dsp_id = v_dsp and status = 'scheduled'
  loop
    v_pos := 0;
    for s in
      select id from public.shifts
       where dsp_id = v_dsp
         and date = r.date
         and station_id = r.station_id
         and status = 'scheduled'
       order by is_cushion asc, created_at asc, id asc
    loop
      v_wave_start := v_waves->(v_pos % v_wave_count)->>'start';
      v_starts := (r.date::text || ' ' || v_wave_start)::timestamptz;
      update public.shifts
         set starts_at  = v_starts,
             ends_at    = v_starts + (v_block_hours || ' hours')::interval,
             block_hours = v_block_hours
       where id = s.id;
      v_pos := v_pos + 1;
    end loop;
  end loop;

  return v_count;
end;
$$;
