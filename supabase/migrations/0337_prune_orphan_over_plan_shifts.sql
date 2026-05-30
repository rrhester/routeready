-- ── private.generate_shifts — prune ORPHAN over-plan shifts too ─────────
--
-- Bug (operator report): "I assigned a rescue shift to a driver, hit
-- 'Unassign all shifts', then ran Smart Fill again — and it re-assigned the
-- rescue shift to another driver and went over plan."
--
-- Root cause: manual adds go through public.create_shift, which inserts with
-- wave_index = NULL and service_type_id = NULL. The per-demand-group reconcile
-- below counts and prunes shifts by (wave_index, service_type_id) against
-- okami_demand, so a NULL-grouped manual row belongs to NO group: it is
-- counted by none and pruned by none. "Unassign all shifts" only nulls
-- driver_id (the rows stay), so the orphan rescue shift lingers as an open
-- shift and every Smart Fill (generate_shifts_for_date → generate_shifts)
-- re-fills it, pushing the day over plan.
--
-- (The Route-planning Save path uses regenerate_week_shifts, which hard-deletes
-- every 'scheduled' row first, so it never hit this. Smart Fill is the soft
-- reconcile path that did.)
--
-- Fix: after the per-group reconcile, delete any remaining 'scheduled',
-- non-cushion shift at this (dsp, station, date) that is NOT backed by a
-- positive okami_demand group. Once the demand groups are satisfied, such a
-- row is by definition pure over-plan surplus. This catches the NULL-grouped
-- manual rescue shift (NULL service_type_id never matches a demand row) and
-- any shift left over for a service/wave with no remaining demand.
--
-- Same product decision as 0335: over-plan adds are allowed in the moment but
-- don't survive the next reconcile. 'completed' rows stay protected
-- (status = 'scheduled' only); cushion rows stay protected (is_cushion).
--
-- Idempotent: create or replace. Body identical to migration 0335 plus the
-- final orphan-prune DELETE before RETURN.

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

  for r in
    select
      coalesce(od.wave_index, 0) as wave_index,
      od.service_type_id          as service_type_id,
      sum(od.target_routes)::int  as target_routes
      from public.okami_demand od
      join public.service_types st
        on st.id = od.service_type_id
       and st.active = true
     where od.dsp_id     = p_dsp_id
       and od.date       = p_date
       and od.station_id = p_station_id
       and od.target_routes > 0
       and coalesce(od.wave_index, 0) >= 0
       and coalesce(od.wave_index, 0) < v_wave_count
     group by 1, 2
  loop
    v_wave_start := coalesce(v_settings.waves->r.wave_index->>'start', '07:00');
    v_starts := ((p_date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                - make_interval(mins => v_lead);
    -- ends_at = wave + block: re-add the lead so the block is anchored
    -- to the wave time, not the earlier clock-in time.
    v_ends := v_starts
              + make_interval(mins => v_lead)
              + (v_settings.default_block_hours || ' hours')::interval;

    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id          = p_dsp_id
       and station_id      = p_station_id
       and date            = p_date
       and wave_index      = r.wave_index
       and service_type_id = r.service_type_id
       and status          in ('scheduled', 'completed')
       and coalesce(is_cushion, false) = false;

    if v_existing > r.target_routes then
      v_to_delete := v_existing - r.target_routes;
      -- Prune the surplus back to plan. Delete unassigned rows first, then
      -- the newest assigned rows (manual/auto over-plan adds). Never touch
      -- 'completed' shifts (status = 'scheduled' filter).
      delete from public.shifts
       where id in (
         select id from public.shifts
          where dsp_id          = p_dsp_id
            and station_id      = p_station_id
            and date            = p_date
            and wave_index      = r.wave_index
            and service_type_id = r.service_type_id
            and status          = 'scheduled'
            and coalesce(is_cushion, false) = false
          order by (driver_id is not null) asc,
                   created_at desc
          limit v_to_delete
       );
      v_existing := r.target_routes;
    end if;

    v_to_create := greatest(0, r.target_routes - v_existing);
    if v_to_create > 0 then
      for i in 1..v_to_create loop
        insert into public.shifts
          (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
        values
          (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto',
           v_settings.default_block_hours, false, r.wave_index, r.service_type_id);
        v_total_created := v_total_created + 1;
      end loop;
    end if;

    update public.shifts
       set starts_at  = v_starts,
           ends_at    = v_ends,
           block_hours = v_settings.default_block_hours
     where dsp_id          = p_dsp_id
       and station_id      = p_station_id
       and date            = p_date
       and wave_index      = r.wave_index
       and service_type_id = r.service_type_id
       and status          = 'scheduled'
       and (starts_at is distinct from v_starts
            or ends_at  is distinct from v_ends);
  end loop;

  -- ── Prune orphan over-plan rows ────────────────────────────────────────
  -- Any remaining 'scheduled', non-cushion shift at this station/date that
  -- is NOT backed by a positive okami_demand group. After the per-group
  -- reconcile above the demand is fully met by properly-grouped shifts, so
  -- these are pure over-plan surplus — typically a manual add (create_shift)
  -- with NULL wave_index/service_type_id (e.g. a "rescue" shift) that the
  -- group reconcile can't see. NULL service_type_id never matches a demand
  -- row, so it is deleted. 'completed' rows protected (status filter);
  -- cushion rows protected (is_cushion filter).
  delete from public.shifts s
   where s.dsp_id     = p_dsp_id
     and s.station_id = p_station_id
     and s.date       = p_date
     and s.status     = 'scheduled'
     and coalesce(s.is_cushion, false) = false
     and not exists (
       select 1
         from public.okami_demand od
         join public.service_types st
           on st.id = od.service_type_id
          and st.active = true
        where od.dsp_id        = p_dsp_id
          and od.date          = p_date
          and od.station_id    = p_station_id
          and od.target_routes > 0
          and od.service_type_id = s.service_type_id
          and coalesce(od.wave_index, 0) = coalesce(s.wave_index, 0)
     );

  return v_total_created;
end;
$$;

notify pgrst, 'reload schema';
