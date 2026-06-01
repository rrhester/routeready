-- ── private.generate_shifts — orphan-prune misplaced CUSHION too ────────
--
-- Bug (operator report, follow-up to 0347): "A lot of drivers are getting
-- the 5:30am route that is blue (Standard Parcel) when there are no SP
-- routes at that time." The 06:00 wave carries only XL demand, yet ~1
-- Standard-Parcel shift/day still lands there.
--
-- Root cause: those blue 06:00 shifts are CUSHION rows created by the old
-- apply_cushion_to_week (pre-0347), which stamped every cushion SP and
-- round-robined it across waves. 0347 fixes how NEW cushion is placed, but
-- the stale rows survive Smart Fill: Smart Fill runs generate_shifts_for_date
-- → private.generate_shifts (a soft reconcile), whose orphan-prune step
-- explicitly PROTECTED is_cushion. So a cushion shift parked on a wave/type
-- with zero demand was never cleaned, and autoAssignDriversForWeek then
-- staffed it. (Only "Save plan" → regenerate_week_shifts, a hard reset, wiped
-- them — Smart Fill never did.)
--
-- Fix: in the final orphan-prune DELETE, stop excluding is_cushion. The
-- NOT EXISTS check matches each shift's (service_type_id, wave_index) against
-- a POSITIVE okami_demand group, so:
--   • Legit cushion (sits in a wave/type that HAS demand — it's the +N%
--     over target) still matches a positive demand group → KEPT.
--   • Misplaced cushion (e.g. SP on the 06:00 wave where SP demand is 0)
--     matches no positive group → PRUNED.
-- This lets Smart Fill self-heal the stale rows on the next run, no separate
-- "Save plan" needed. 'completed' rows stay protected (status filter).
--
-- The per-group reconcile above still excludes is_cushion (cushion must stay
-- ABOVE target within a valid bucket), so only the orphan-prune touches it.
--
-- Idempotent: create or replace. Body identical to 0337 except the final
-- DELETE no longer filters out is_cushion.

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

  -- ── Prune orphan over-plan rows (cushion included) ─────────────────────
  -- Any remaining 'scheduled' shift at this station/date whose
  -- (service_type_id, wave_index) is NOT backed by a positive okami_demand
  -- group. After the per-group reconcile the demand is fully met by
  -- properly-grouped non-cushion shifts, so anything left here is misplaced:
  --   • a manual add (create_shift) with NULL wave_index/service_type_id,
  --   • or a cushion row stranded on a wave/type with no demand (e.g. an SP
  --     cushion on an XL-only wave, from the pre-0347 apply_cushion).
  -- Legit cushion sits in a wave/type that HAS demand, so it matches a
  -- positive group and is KEPT. 'completed' rows protected (status filter).
  delete from public.shifts s
   where s.dsp_id     = p_dsp_id
     and s.station_id = p_station_id
     and s.date       = p_date
     and s.status     = 'scheduled'
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
