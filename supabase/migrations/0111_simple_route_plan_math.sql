-- Operator's spec, plain English:
--   "You take the number of routes in the route plan (by service
--    type / wave time) and you generate a matching shift. Then if the
--    DSP wants a 20% cushion, you look at how many shifts there are
--    in the day, multiply that by 20%, and that's the number of extra
--    EX shifts you create. If that number is less than 1 — don't
--    build an extra route."
--
-- Two functions get rewritten to match this exactly.
--
-- 1. private.generate_shifts: iterate okami_demand rows directly
--    instead of looping (wave × service_type) buckets. One shift per
--    route in target_routes. Wave_index that's gone stale (>=
--    wave_count after a wave was deleted) folds to wave_count − 1
--    so the demand still produces a shift at a real wave time. No
--    more "demand exists but generates zero shifts" drift.
--
-- 2. public.apply_cushion_to_week: count the actual base shifts in
--    the day, multiply by cushion%, FLOOR. If the result is < 1,
--    add nothing. Was: round(target_routes × pct / 100), which
--    rounded 0.6 up to 1 instead of dropping it.

create or replace function private.generate_shifts(p_dsp_id uuid, p_date date, p_station_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_settings public.scheduling_settings;
  v_wave_count int;
  v_lead int;
  v_total_created int := 0;
  r record;
  v_existing int;
  v_to_create int;
  v_to_delete int;
  v_wave_idx int;
  v_wave_start text;
  v_starts timestamptz;
  v_ends timestamptz;
begin
  v_settings := private.get_week_settings(p_dsp_id, private.week_start_for(p_date));

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_settings.waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;
  v_lead := coalesce(v_settings.report_lead_minutes, 0);

  -- One iteration per okami_demand row. Each row is a (wave_index,
  -- service_type_id, target_routes) entry the operator typed in the
  -- route planner. We materialize exactly target_routes shifts in
  -- this bucket — no more, no less.
  for r in
    select od.wave_index, od.service_type_id, od.target_routes
      from public.okami_demand od
      join public.service_types st
        on st.id = od.service_type_id
       and st.active = true
     where od.dsp_id     = p_dsp_id
       and od.date       = p_date
       and od.station_id = p_station_id
       and od.target_routes > 0
  loop
    -- Clamp out-of-range wave_index (e.g. demand for wave 1 after the
    -- DSP dropped to a single wave) so the shift still lands at a
    -- real wave time rather than being skipped.
    v_wave_idx := least(coalesce(r.wave_index, 0), v_wave_count - 1);
    v_wave_start := coalesce(v_settings.waves->v_wave_idx->>'start', '07:00');
    v_starts := ((p_date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                - make_interval(mins => v_lead);
    v_ends := v_starts + (v_settings.default_block_hours || ' hours')::interval;

    -- Existing non-cushion shifts in this bucket.
    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id          = p_dsp_id
       and station_id      = p_station_id
       and date            = p_date
       and wave_index      = v_wave_idx
       and service_type_id = r.service_type_id
       and status          in ('scheduled', 'completed')
       and coalesce(is_cushion, false) = false;

    -- Trim excess unassigned ones if target dropped.
    if v_existing > r.target_routes then
      v_to_delete := v_existing - r.target_routes;
      delete from public.shifts
       where id in (
         select id from public.shifts
          where dsp_id          = p_dsp_id
            and station_id      = p_station_id
            and date            = p_date
            and wave_index      = v_wave_idx
            and service_type_id = r.service_type_id
            and status          = 'scheduled'
            and driver_id       is null
            and coalesce(is_cushion, false) = false
          order by created_at desc
          limit v_to_delete
       );
      v_existing := r.target_routes;
    end if;

    -- Create what's missing.
    v_to_create := greatest(0, r.target_routes - v_existing);
    if v_to_create > 0 then
      for i in 1..v_to_create loop
        insert into public.shifts
          (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
        values
          (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto',
           v_settings.default_block_hours, false, v_wave_idx, r.service_type_id);
        v_total_created := v_total_created + 1;
      end loop;
    end if;

    -- Re-stamp times on existing scheduled shifts in this bucket so
    -- a wave-time / report-lead / block-hours change propagates
    -- through. Skips assigned-but-worked rows (status != scheduled)
    -- so history isn't rewritten.
    update public.shifts
       set starts_at  = v_starts,
           ends_at    = v_ends,
           block_hours = v_settings.default_block_hours
     where dsp_id          = p_dsp_id
       and station_id      = p_station_id
       and date            = p_date
       and wave_index      = v_wave_idx
       and service_type_id = r.service_type_id
       and status          = 'scheduled'
       and (starts_at is distinct from v_starts
            or ends_at  is distinct from v_ends);
  end loop;

  return v_total_created;
end;
$$;


create or replace function public.apply_cushion_to_week(p_week_start date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + 6;
  v_cushion_pct numeric;
  v_settings public.scheduling_settings;
  v_sp_id uuid;
  v_lead int;
  v_wave_count int;
  v_added int := 0;
  r record;
  v_existing_total int;
  v_existing_cushion int;
  v_target_cushion int;
  v_to_add int;
  v_index int;
  v_wave_idx int;
  v_wave_start text;
  v_starts timestamptz;
  v_ends timestamptz;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_settings := private.get_week_settings(v_dsp, p_week_start);
  v_cushion_pct := coalesce(v_settings.cushion_pct, 0);
  if v_cushion_pct <= 0 then return 0; end if;

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then v_wave_count := 1; end if;
  v_lead := coalesce(v_settings.report_lead_minutes, 0);

  select id into v_sp_id from public.service_types
   where dsp_id = v_dsp and code = 'SP' limit 1;

  -- One iteration per (date, station) that already has at least one
  -- non-cushion shift. We base the cushion target on actual base
  -- shifts in the table — not on okami_demand totals — so the math
  -- matches what the operator can see in the schedule:
  --
  --   v_target_cushion = floor(base_shifts × cushion% / 100)
  --
  -- floor() means a 4-shift day at 20% gives 0.8 → 0 EX shifts (as
  -- the operator put it: "if that number is less than 1, don't
  -- build an extra route"). Previous round() pushed 0.6 to 1.
  for r in
    select date, station_id
      from public.shifts
     where dsp_id = v_dsp
       and date between p_week_start and v_week_end
       and status in ('scheduled', 'completed')
       and coalesce(is_cushion, false) = false
     group by date, station_id
  loop
    select count(*)::int into v_existing_total
      from public.shifts
     where dsp_id     = v_dsp
       and station_id = r.station_id
       and date       = r.date
       and status     in ('scheduled', 'completed')
       and coalesce(is_cushion, false) = false;

    select count(*)::int into v_existing_cushion
      from public.shifts
     where dsp_id     = v_dsp
       and station_id = r.station_id
       and date       = r.date
       and is_cushion = true
       and status     in ('scheduled', 'completed');

    v_target_cushion := floor(v_existing_total::numeric * v_cushion_pct / 100)::int;
    v_to_add := greatest(0, v_target_cushion - v_existing_cushion);

    if v_to_add > 0 then
      for v_index in 0..(v_to_add - 1) loop
        v_wave_idx   := (v_existing_total + v_existing_cushion + v_index) % v_wave_count;
        v_wave_start := coalesce(v_settings.waves->v_wave_idx->>'start', '07:00');
        v_starts := ((r.date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                    - make_interval(mins => v_lead);
        v_ends := v_starts + (v_settings.default_block_hours || ' hours')::interval;

        insert into public.shifts
          (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
        values
          (v_dsp, r.station_id, r.date, v_starts, v_ends, 'scheduled', 'auto',
           v_settings.default_block_hours, true, v_wave_idx, v_sp_id);
        v_added := v_added + 1;
      end loop;
    end if;
  end loop;

  return v_added;
end;
$$;

grant execute on function public.apply_cushion_to_week(date) to authenticated;

notify pgrst, 'reload schema';
