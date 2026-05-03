-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0033 · Honor the DSP's timezone when computing shift start
--
-- Wave times like '11:20' are entered by the operator in their LOCAL
-- time. The SQL was casting them with `(date || ' ' || time)::timestamptz`
-- which the DB interprets as the SESSION timezone (UTC on Supabase).
-- The browser then renders the UTC moment in local time, so '11:20'
-- entered in Central time displays as '6:20am'.
--
-- Fix: read dsps.metadata.scheduling.timezone (IANA, e.g.
-- 'America/Chicago') and cast `(date || ' ' || wave_start)::timestamp
-- AT TIME ZONE <tz>` so the moment matches the operator's wall clock.
-- Falls back to 'UTC' if not set (no behavior change for legacy data).
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
  v_tz text;
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
               jsonb_build_array(jsonb_build_object('start', coalesce(metadata->'scheduling'->>'wave_start', '07:00')))),
      coalesce(metadata->'scheduling'->>'timezone', 'UTC')
    into v_cushion, v_block_hours, v_waves, v_tz
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

  for v_index in v_existing..(v_needed - 1) loop
    v_wave_start := v_waves->(v_index % v_wave_count)->>'start';
    v_starts := (p_date::text || ' ' || v_wave_start)::timestamp at time zone v_tz;
    v_ends   := v_starts + (v_block_hours || ' hours')::interval;

    insert into public.shifts
      (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion)
    values
      (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto', v_block_hours, v_index >= v_target);
  end loop;

  return v_to_create;
end;
$$;


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
  v_tz text;
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
                  jsonb_build_array(jsonb_build_object('start', coalesce(metadata->'scheduling'->>'wave_start', '07:00')))),
         coalesce(metadata->'scheduling'->>'timezone', 'UTC')
    into v_block_hours, v_waves, v_tz
  from public.dsps where id = v_dsp;

  v_wave_count := jsonb_array_length(coalesce(v_waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;

  delete from public.shifts
   where dsp_id = v_dsp
     and driver_id is null
     and status = 'scheduled';

  for r in
    select date, station_id from public.okami_demand where dsp_id = v_dsp
  loop
    v_count := v_count + private.generate_shifts(v_dsp, r.date, r.station_id);
  end loop;

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
      v_starts := (r.date::text || ' ' || v_wave_start)::timestamp at time zone v_tz;
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
