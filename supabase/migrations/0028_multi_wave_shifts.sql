-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0028 · Multi-wave shift generation
--
-- Replaces the single wave_start + wave_spacing model with an explicit list
-- of wave start times (dsps.metadata.scheduling.waves). The DSP can add
-- another wave whenever they like; private.generate_shifts uses that list
-- when it exists, falling back to the old wave_start + wave_spacing_min
-- pair if it doesn't.
--
-- Wave allocation: shifts fill waves in order. Slots beyond the wave count
-- continue from the last wave at the original wave_spacing_min interval —
-- so an under-configured DSP still produces a reasonable schedule instead
-- of failing.
-- ─────────────────────────────────────────────────────────────────────────

-- Seed the waves array from the existing single wave_start so behavior
-- doesn't change for already-deployed DSPs that haven't touched settings.
update public.dsps
   set metadata = jsonb_set(
        metadata,
        '{scheduling,waves}',
        coalesce(metadata->'scheduling'->'waves',
                 jsonb_build_array(jsonb_build_object('start', coalesce(metadata->'scheduling'->>'wave_start', '07:00')))),
        true
       )
 where metadata->'scheduling' is not null
   and metadata->'scheduling'->'waves' is null;


-- Replace private.generate_shifts to honor the waves array.
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
  v_needed int;
  v_to_create int;
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
  if v_wave_count = 0 then v_wave_count := 1; v_waves := jsonb_build_array(jsonb_build_object('start','07:00')); end if;

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
    if v_index < v_wave_count then
      v_wave_start := v_waves->v_index->>'start';
      v_starts := (p_date::text || ' ' || v_wave_start)::timestamptz;
    else
      -- Past the configured waves: continue from the LAST wave at +spacing.
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
