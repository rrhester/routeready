-- Shift end time was 20 minutes short whenever a report-lead was set.
--
-- Operator report: the driver app showed a shift "9:40am-7:40pm with a
-- wave of 10am", but the shift actually runs until 8:00pm.
--
-- Root cause. private.generate_shifts (migration 0102 onward) builds:
--     starts_at = wave_time - report_lead_minutes   (driver clock-in)
--     ends_at   = starts_at + default_block_hours
-- So ends_at = wave_time - lead + block — the block was anchored to the
-- clock-in time, ending `lead` minutes BEFORE wave + block. With a
-- 10:00 wave, 20-min lead and a 10h block that yields 7:40pm.
--
-- The schedule-page chip already treats the wave end (wave + block =
-- 8:00pm) as the real end and ignores the stored ends_at; the driver
-- app reads ends_at straight, so the two surfaces disagreed.
--
-- Fix: the report-lead is a clock-in buffer ON TOP of the block, not a
-- shift of the whole block earlier. ends_at must be wave + block:
--     ends_at = starts_at + report_lead_minutes + block
-- This migration corrects both shift-generating functions and backfills
-- existing upcoming shifts so every surface reads 8:00pm.

-- ── private.generate_shifts — ends_at = wave + block ────────────────────
-- Body identical to migration 0118 except v_ends now adds v_lead.
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
      delete from public.shifts
       where id in (
         select id from public.shifts
          where dsp_id          = p_dsp_id
            and station_id      = p_station_id
            and date            = p_date
            and wave_index      = r.wave_index
            and service_type_id = r.service_type_id
            and status          = 'scheduled'
            and driver_id       is null
            and coalesce(is_cushion, false) = false
          order by created_at desc
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

  return v_total_created;
end;
$$;


-- ── public.apply_cushion_to_week — ends_at = wave + block ───────────────
-- Body identical to migration 0111 except v_ends now adds v_lead.
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
        v_ends := v_starts
                  + make_interval(mins => v_lead)
                  + (v_settings.default_block_hours || ' hours')::interval;

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


-- ── Backfill existing shifts ────────────────────────────────────────────
-- Correct upcoming shifts that still carry the short end time. We only
-- touch a shift when:
--   • its week has a report-lead set (lead = 0 means no change anyway),
--   • it is still 'scheduled' and dated today or later (never rewrite
--     historical / completed rows),
--   • it isn't a training shift (those carry hand-set times),
--   • ends_at still equals exactly starts_at + block_hours — i.e. the
--     auto-generated value, untouched by a manual per-shift edit.
-- Re-running is a no-op: once corrected, ends_at no longer matches the
-- starts_at + block_hours predicate.
update public.shifts sh
   set ends_at = sh.starts_at
                 + make_interval(mins => ss.report_lead_minutes)
                 + (sh.block_hours || ' hours')::interval
  from public.scheduling_settings ss
 where ss.dsp_id     = sh.dsp_id
   and ss.week_start = private.week_start_for(sh.date)
   and coalesce(ss.report_lead_minutes, 0) > 0
   and sh.status     = 'scheduled'
   and sh.date       >= current_date
   and coalesce(sh.shift_kind, 'regular') <> 'training'
   and sh.block_hours is not null
   and sh.block_hours > 0
   and sh.starts_at is not null
   and sh.ends_at = sh.starts_at + (sh.block_hours || ' hours')::interval;


notify pgrst, 'reload schema';
