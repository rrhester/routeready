-- ── 0523 · HELPER service type generates paired seats too ───────────────────
--
-- Operator (2026-07-19): the HELPER service type (seeded inactive by 0349)
-- is "a route that has two drivers for one route — 1 driver and 1 helper.
-- A Standard-Parcel-style route that gets a helper. No certifications."
--
-- 0518 generated the paired helper seat only for requires_xl service types.
-- This re-issues private.generate_shifts verbatim from 0518 with the pair
-- condition extended: a bucket whose service type requires_xl OR whose code
-- is HELPER generates one shift_kind='helper' seat per route target.
--
-- Everything downstream already handles it:
--   · cert gates — the HELPER type has requires_dot/xl/edv all false, so
--     the driver seat is ungated; the helper seat is kind-exempt (0520);
--   · cushion — apply_cushion_to_week (0519) sizes helper cushion off
--     helper-kind seats in ANY bucket;
--   · route counts — okami_grid (0522) + the grid counter exclude
--     helper-kind seats;
--   · van sharing — 0521's mate lookup pairs by bucket, not by XL.
--
-- Idempotent: enum guard + create or replace; reconcile-to-target on rerun.

alter type public.shift_kind add value if not exists 'helper';

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
  v_existing_helper int;
  v_to_create_helper int;
  v_to_delete_helper int;
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
      sum(od.target_routes)::int  as target_routes,
      bool_or(st.requires_xl)     as requires_xl,
      bool_or(upper(st.code) = 'HELPER') as is_helper_type
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

    -- ── Driver seats (the cert-gated route seat). Excludes helper rows so
    --    the helper block below owns them. ─────────────────────────────────
    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id          = p_dsp_id
       and station_id      = p_station_id
       and date            = p_date
       and wave_index      = r.wave_index
       and service_type_id = r.service_type_id
       and status          in ('scheduled', 'completed')
       and coalesce(is_cushion, false) = false
       and coalesce(shift_kind, 'regular') <> 'helper';

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
            and coalesce(shift_kind, 'regular') <> 'helper'
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

    -- ── Helper seats (XL + HELPER-type routes). One helper per route target:
    --    second body on the road, shift_kind 'helper', NOT cert-gated. Same
    --    reconcile shape as the driver seats, filtered to helper rows. ──────
    if r.requires_xl or r.is_helper_type then
      select count(*)::int
        into v_existing_helper
      from public.shifts
       where dsp_id          = p_dsp_id
         and station_id      = p_station_id
         and date            = p_date
         and wave_index      = r.wave_index
         and service_type_id = r.service_type_id
         and status          in ('scheduled', 'completed')
         and coalesce(is_cushion, false) = false
         and coalesce(shift_kind, 'regular') = 'helper';

      if v_existing_helper > r.target_routes then
        v_to_delete_helper := v_existing_helper - r.target_routes;
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
              and coalesce(shift_kind, 'regular') = 'helper'
            order by (driver_id is not null) asc,
                     created_at desc
            limit v_to_delete_helper
         );
        v_existing_helper := r.target_routes;
      end if;

      v_to_create_helper := greatest(0, r.target_routes - v_existing_helper);
      if v_to_create_helper > 0 then
        for i in 1..v_to_create_helper loop
          insert into public.shifts
            (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id, shift_kind)
          values
            (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto',
             v_settings.default_block_hours, false, r.wave_index, r.service_type_id, 'helper');
          v_total_created := v_total_created + 1;
        end loop;
      end if;
    end if;
  end loop;

  -- ── Prune orphan over-plan rows (cushion included) ─────────────────────
  -- Any remaining 'scheduled' shift at this station/date whose
  -- (service_type_id, wave_index) is NOT backed by a positive okami_demand
  -- group. Helper seats sit on the XL service_type + wave, which HAS positive
  -- demand, so they match a positive group and are KEPT alongside their
  -- driver seats. 'completed' rows protected (status filter).
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
