-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0031 · Round-robin shift assignment to waves
--
-- A "wave" in DSP terms is a batch of drivers leaving the station at the
-- SAME exact time. The previous generate_shifts implementation only used
-- the wave list for the first N shifts; once needed > wave count, it
-- continued from the last wave at +wave_spacing_min, treating each
-- subsequent shift as its own staggered start. With a single wave at
-- 1:00 PM and 5 shifts needed, the operator saw 1:00, 1:25, 1:50, …
-- instead of all five at 1:00.
--
-- Fix: distribute shifts round-robin across the waves array. With 1 wave
-- at 1:00 and 5 shifts → all 5 at 1:00. With 2 waves [7:00, 9:00] and 5
-- shifts → 7, 9, 7, 9, 7. wave_spacing_min is unused; remove it from the
-- math (still in metadata, harmless).
-- ─────────────────────────────────────────────────────────────────────────

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
  v_waves jsonb;
  v_wave_count int;
  v_existing int;
  v_needed int;
  v_to_create int;
  v_to_delete int;
  v_index int;
  v_starts timestamptz;
  v_ends   timestamptz;
  v_wave_start text;
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
      coalesce(metadata->'scheduling'->'waves',
               jsonb_build_array(jsonb_build_object('start', coalesce(metadata->'scheduling'->>'wave_start', '07:00'))))
    into v_cushion, v_block_hours, v_waves
  from public.dsps where id = p_dsp_id;

  v_needed := ceil(v_target::numeric * (1 + v_cushion / 100))::int;
  v_wave_count := jsonb_array_length(coalesce(v_waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;

  select count(*)::int
    into v_existing
  from public.shifts
   where dsp_id = p_dsp_id
     and station_id = p_station_id
     and date = p_date
     and status in ('scheduled','completed');

  -- TRIM excess UNASSIGNED shifts when target dropped (cushion first, latest first).
  if v_existing > v_needed then
    v_to_delete := v_existing - v_needed;
    delete from public.shifts
     where id in (
       select id from public.shifts
        where dsp_id = p_dsp_id
          and station_id = p_station_id
          and date = p_date
          and status = 'scheduled'
          and driver_id is null
        order by is_cushion desc, starts_at desc
        limit v_to_delete
     );
    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id = p_dsp_id
       and station_id = p_station_id
       and date = p_date
       and status in ('scheduled','completed');
  end if;

  v_to_create := greatest(0, v_needed - v_existing);
  if v_to_create = 0 then return 0; end if;

  -- Round-robin: shift index i goes to wave (i mod wave_count). With 1
  -- wave, every shift starts at that single wave's time. With multiple
  -- waves, the workload distributes evenly across them.
  for v_index in v_existing..(v_needed - 1) loop
    v_wave_start := v_waves->(v_index % v_wave_count)->>'start';
    v_starts := (p_date::text || ' ' || v_wave_start)::timestamptz;
    v_ends   := v_starts + (v_block_hours || ' hours')::interval;

    insert into public.shifts
      (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion)
    values
      (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto', v_block_hours, v_index >= v_target);
  end loop;

  return v_to_create;
end;
$$;
