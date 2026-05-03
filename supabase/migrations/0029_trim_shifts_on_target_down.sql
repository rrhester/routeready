-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0029 · generate_shifts trims excess when target goes DOWN
--
-- Previous behavior: setting OKAMI target = 17 created 17 shifts. Lowering
-- to 2 left the 17 in place. Operator expected schedule to mirror OKAMI.
--
-- New behavior: when existing > needed, delete excess UNASSIGNED shifts
-- (driver_id is null) to bring the count down. Cushion-flagged shifts are
-- removed first (they're the buffer) then the latest-start ones, so the
-- earliest waves stay intact. Assigned shifts are NEVER auto-deleted —
-- the operator must clear those manually.
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
  v_wave_spacing_min int;
  v_waves jsonb;
  v_wave_count int;
  v_existing int;
  v_unassigned int;
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
      coalesce((metadata->'scheduling'->>'wave_spacing_min')::int, 25),
      coalesce(metadata->'scheduling'->'waves', jsonb_build_array(jsonb_build_object('start', coalesce(metadata->'scheduling'->>'wave_start', '07:00'))))
    into v_cushion, v_block_hours, v_wave_spacing_min, v_waves
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

  -- TRIM: target dropped — delete excess UNASSIGNED shifts, cushion first.
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
    -- Re-count after delete (might still exceed needed if all extras were assigned).
    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id = p_dsp_id
       and station_id = p_station_id
       and date = p_date
       and status in ('scheduled','completed');
  end if;

  -- FILL: target rose (or fresh) — add the gap.
  v_to_create := greatest(0, v_needed - v_existing);
  if v_to_create = 0 then return 0; end if;

  for v_index in v_existing..(v_needed - 1) loop
    if v_index < v_wave_count then
      v_wave_start := v_waves->v_index->>'start';
      v_starts := (p_date::text || ' ' || v_wave_start)::timestamptz;
    else
      v_wave_start := v_waves->(v_wave_count - 1)->>'start';
      v_starts := (p_date::text || ' ' || v_wave_start)::timestamptz
                  + ((v_index - v_wave_count + 1) * v_wave_spacing_min || ' minutes')::interval;
    end if;
    v_ends := v_starts + (v_block_hours || ' hours')::interval;

    insert into public.shifts
      (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion)
    values
      (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto', v_block_hours, v_index >= v_target);
  end loop;

  return v_to_create;
end;
$$;


-- Backfill: re-run generate_shifts on every existing okami_demand row
-- so deployed DSPs get the trimmed counts immediately.
do $$
declare r record;
begin
  for r in select dsp_id, date, station_id from public.okami_demand loop
    perform private.generate_shifts(r.dsp_id, r.date, r.station_id);
  end loop;
end $$;
