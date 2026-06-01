-- ── public.apply_cushion_to_week — cushion mirrors its demand bucket ────
--
-- Bug (operator report): "Smart Fill is building a Standard Parcel route for
-- a driver at 5:30am (the 06:00 wave) when the only route planned at that
-- time is XL."
--
-- Root cause: cushion shifts were stamped with a HARD-CODED service type
-- (always SP — `select id ... where code = 'SP'`) and placed on a
-- ROUND-ROBIN wave (`v_wave_idx := (...) % v_wave_count`). Neither value was
-- tied to the demand the cushion is supposed to cover. So on a week where
-- wave 2 (06:00) carries only XL demand, a cushion shift could land on that
-- wave but be created as Standard Parcel — a standard-parcel route sitting on
-- an XL-only wave. Smart Fill then auto-assigned a driver (Pickle) to that
-- bogus SP open shift.
--
-- Fix: reconcile cushion PER demand bucket — (date, station, wave_index,
-- service_type_id) — using the real non-cushion shift count in each bucket as
-- the base. Every cushion shift now inherits the bucket's own wave_index AND
-- service_type_id, so an XL wave gets XL cushion and an SP wave gets SP
-- cushion. Buckets are rounded independently (round, matching 0077's
-- "round not ceil"), so each planned service/wave gets cushion proportional
-- to its own demand instead of a single SP pile round-robined across waves.
--
-- Also:
--   • Trim surplus cushion within a bucket (unassigned rows first, newest
--     assigned next; never 'completed') when cushion % drops.
--   • Orphan-prune any UNASSIGNED cushion row whose (wave_index,
--     service_type_id) no longer matches a non-cushion demand bucket. This
--     clears legacy SP-stamped cushion shifts that the old code parked on an
--     XL-only wave. Assigned cushion rows (real commitments) and 'completed'
--     rows are left alone.
--
-- Idempotent: create or replace.

create or replace function public.apply_cushion_to_week(p_week_start date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + 6;
  v_cushion_pct numeric;
  v_settings public.scheduling_settings;
  v_lead int;
  v_wave_count int;
  v_added int := 0;
  r record;
  v_target_cushion int;
  v_existing_cushion int;
  v_to_add int;
  v_to_remove int;
  v_index int;
  v_wave_start text;
  v_starts timestamptz;
  v_ends timestamptz;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_settings := private.get_week_settings(v_dsp, p_week_start);
  v_cushion_pct := coalesce(v_settings.cushion_pct, 0);

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then v_wave_count := 1; end if;
  v_lead := coalesce(v_settings.report_lead_minutes, 0);

  -- Reconcile cushion per (date, station, wave_index, service_type_id)
  -- bucket. base_count is the real non-cushion shift count for that bucket,
  -- so a cushion shift always mirrors the wave + service type it cushions.
  for r in
    select
      s.date,
      s.station_id,
      coalesce(s.wave_index, 0)  as wave_index,
      s.service_type_id          as service_type_id,
      count(*)::int              as base_count
      from public.shifts s
     where s.dsp_id = v_dsp
       and s.date between p_week_start and v_week_end
       and s.status in ('scheduled', 'completed')
       and coalesce(s.is_cushion, false) = false
       and s.service_type_id is not null
     group by s.date, s.station_id, coalesce(s.wave_index, 0), s.service_type_id
  loop
    v_target_cushion := case
      when v_cushion_pct <= 0 then 0
      else round(r.base_count::numeric * v_cushion_pct / 100)::int
    end;

    select count(*)::int into v_existing_cushion
      from public.shifts
     where dsp_id                  = v_dsp
       and station_id              = r.station_id
       and date                    = r.date
       and coalesce(wave_index, 0) = r.wave_index
       and service_type_id         = r.service_type_id
       and is_cushion              = true
       and status                  in ('scheduled', 'completed');

    if v_existing_cushion < v_target_cushion then
      v_to_add := v_target_cushion - v_existing_cushion;
      v_wave_start := coalesce(v_settings.waves->r.wave_index->>'start', '07:00');
      v_starts := ((r.date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                  - make_interval(mins => v_lead);
      -- ends_at = wave + block: re-add the lead so the block anchors to the
      -- wave time, not the earlier clock-in time (matches generate_shifts).
      v_ends := v_starts
                + make_interval(mins => v_lead)
                + (v_settings.default_block_hours || ' hours')::interval;
      for v_index in 1..v_to_add loop
        insert into public.shifts
          (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
        values
          (v_dsp, r.station_id, r.date, v_starts, v_ends, 'scheduled', 'auto',
           v_settings.default_block_hours, true, r.wave_index, r.service_type_id);
        v_added := v_added + 1;
      end loop;
    elsif v_existing_cushion > v_target_cushion then
      -- Trim surplus cushion in this bucket. Unassigned rows first, then the
      -- newest assigned ones; never touch 'completed'.
      v_to_remove := v_existing_cushion - v_target_cushion;
      delete from public.shifts
       where id in (
         select id from public.shifts
          where dsp_id                  = v_dsp
            and station_id              = r.station_id
            and date                    = r.date
            and coalesce(wave_index, 0) = r.wave_index
            and service_type_id         = r.service_type_id
            and is_cushion              = true
            and status                  = 'scheduled'
          order by (driver_id is not null) asc,
                   created_at desc
          limit v_to_remove
       );
    end if;
  end loop;

  -- ── Prune orphan cushion rows ──────────────────────────────────────────
  -- Any UNASSIGNED cushion shift whose (wave_index, service_type_id) no
  -- longer matches a non-cushion demand bucket on that day/station. Catches
  -- the legacy SP-stamped cushion shifts the old code round-robined onto an
  -- XL-only wave. Assigned cushion rows (real commitments) and 'completed'
  -- rows are protected.
  delete from public.shifts c
   where c.dsp_id     = v_dsp
     and c.date between p_week_start and v_week_end
     and c.is_cushion = true
     and c.status     = 'scheduled'
     and c.driver_id is null
     and not exists (
       select 1
         from public.shifts s
        where s.dsp_id     = v_dsp
          and s.date       = c.date
          and s.station_id = c.station_id
          and s.status     in ('scheduled', 'completed')
          and coalesce(s.is_cushion, false) = false
          and s.service_type_id         = c.service_type_id
          and coalesce(s.wave_index, 0) = coalesce(c.wave_index, 0)
     );

  return v_added;
end;
$$;

grant execute on function public.apply_cushion_to_week(date) to authenticated;

notify pgrst, 'reload schema';
