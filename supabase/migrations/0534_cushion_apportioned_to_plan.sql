-- ── 0534 · Cushion seats apportioned to the plan total (phantom-seat fix) ──
--
-- Root cause of "N cushion seats open" that no Smart Fill run can ever close
-- (operator report 2026-07-20: drivers with zero shifts while the board shows
-- 7 cushion seats open, one per day, every day).
--
-- The schedule board's planned denominator is round(day_target × (1 +
-- cushion%)) — ONE rounding of the day's total. apply_cushion_to_week (since
-- 0347/0519) reconciles cushion per (date, station, wave, service_type)
-- bucket with round(bucket_base × cushion%/100) — a rounding PER BUCKET.
-- Sum-of-rounds ≠ round-of-sum: e.g. 25 routes split 24 SP + 1 XL at 10%
-- cushion materializes round(2.4) + round(0.1) = 2 cushion rows while the
-- plan promises round(2.5) = 3. The missing seat has NO shift row, so the
-- solver never receives it, no driver can ever take it, and the board reads
-- "1 cushion seat open" per day forever — while idle drivers sit unused.
--
-- Fix: apportion each (date, station)'s cushion TOTAL — round(Σ base ×
-- cushion%/100), the same single rounding the plan uses — across that
-- station-day's buckets by largest remainder (floor each bucket's share,
-- hand the leftover seats to the largest fractional parts; ties broken by
-- bigger bucket, then wave, then service type, so re-runs are stable).
-- Helper-seat cushion gets the identical treatment over helper bases.
-- Buckets with zero fractional part can never receive a remainder seat
-- (remainders ≤ count of fractional buckets), so cushion still lands only
-- where real demand sits. Single-bucket days are byte-identical to 0519.
--
-- The dashboard's denominator switches to per-station rounding in the same
-- change, so plan == materialized on multi-station DSPs too.
--
-- Idempotent: create-or-replace, reconcile-to-target (re-runs add/trim to
-- the same targets), enum guard re-asserted.

-- Guard: 'helper' must exist before the function inserts cushion helper rows.
-- (No-op when 0518/0519 already added it.)
alter type public.shift_kind add value if not exists 'helper';

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
  v_target_helper_cushion int;
  v_existing_helper_cushion int;
  v_to_add_helper int;
  v_to_remove_helper int;
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
  -- bucket, with each bucket's TARGET apportioned from the station-day
  -- total (largest remainder) so Σ bucket targets = round(Σ base × pct/100)
  -- — the same single rounding the board's planned denominator applies.
  for r in
    with buckets as (
      select
        s.date,
        s.station_id,
        coalesce(s.wave_index, 0)  as wave_index,
        s.service_type_id          as service_type_id,
        count(*) filter (where coalesce(s.shift_kind, 'regular') <> 'helper')::int as base_count,
        count(*) filter (where coalesce(s.shift_kind, 'regular') =  'helper')::int as helper_base_count
        from public.shifts s
       where s.dsp_id = v_dsp
         and s.date between p_week_start and v_week_end
         and s.status in ('scheduled', 'completed')
         and coalesce(s.is_cushion, false) = false
         and s.service_type_id is not null
       group by s.date, s.station_id, coalesce(s.wave_index, 0), s.service_type_id
    )
    select
      b.date, b.station_id, b.wave_index, b.service_type_id,
      b.base_count, b.helper_base_count,
      -- floor share + 1 remainder seat for the R largest fractional parts,
      -- R = round(station-day total × pct) − Σ floors. round(numeric) is
      -- half-away-from-zero, which for positive totals matches the board's
      -- JS Math.round (half up) exactly.
      (floor(b.base_count * v_cushion_pct / 100)
         + case when row_number() over (
                 partition by b.date, b.station_id
                 order by (b.base_count * v_cushion_pct / 100)
                          - floor(b.base_count * v_cushion_pct / 100) desc,
                          b.base_count desc, b.wave_index, b.service_type_id)
             <= round(sum(b.base_count) over (partition by b.date, b.station_id)
                      * v_cushion_pct / 100)
                - sum(floor(b.base_count * v_cushion_pct / 100))
                      over (partition by b.date, b.station_id)
           then 1 else 0 end)::int as apportioned_cushion,
      (floor(b.helper_base_count * v_cushion_pct / 100)
         + case when row_number() over (
                 partition by b.date, b.station_id
                 order by (b.helper_base_count * v_cushion_pct / 100)
                          - floor(b.helper_base_count * v_cushion_pct / 100) desc,
                          b.helper_base_count desc, b.wave_index, b.service_type_id)
             <= round(sum(b.helper_base_count) over (partition by b.date, b.station_id)
                      * v_cushion_pct / 100)
                - sum(floor(b.helper_base_count * v_cushion_pct / 100))
                      over (partition by b.date, b.station_id)
           then 1 else 0 end)::int as apportioned_helper_cushion
    from buckets b
  loop
    v_wave_start := coalesce(v_settings.waves->r.wave_index->>'start', '07:00');
    v_starts := ((r.date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                - make_interval(mins => v_lead);
    -- ends_at = wave + block: re-add the lead so the block anchors to the
    -- wave time, not the earlier clock-in time (matches generate_shifts).
    v_ends := v_starts
              + make_interval(mins => v_lead)
              + (v_settings.default_block_hours || ' hours')::interval;

    -- ── Driver-seat cushion (regular). Counts / trims exclude helper rows. ──
    v_target_cushion := case
      when v_cushion_pct <= 0 then 0
      else r.apportioned_cushion
    end;

    select count(*)::int into v_existing_cushion
      from public.shifts
     where dsp_id                  = v_dsp
       and station_id              = r.station_id
       and date                    = r.date
       and coalesce(wave_index, 0) = r.wave_index
       and service_type_id         = r.service_type_id
       and is_cushion              = true
       and coalesce(shift_kind, 'regular') <> 'helper'
       and status                  in ('scheduled', 'completed');

    if v_existing_cushion < v_target_cushion then
      v_to_add := v_target_cushion - v_existing_cushion;
      for v_index in 1..v_to_add loop
        insert into public.shifts
          (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
        values
          (v_dsp, r.station_id, r.date, v_starts, v_ends, 'scheduled', 'auto',
           v_settings.default_block_hours, true, r.wave_index, r.service_type_id);
        v_added := v_added + 1;
      end loop;
    elsif v_existing_cushion > v_target_cushion then
      -- Trim surplus driver cushion. Unassigned rows first, then the newest
      -- assigned ones; never touch 'completed'.
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
            and coalesce(shift_kind, 'regular') <> 'helper'
            and status                  = 'scheduled'
          order by (driver_id is not null) asc,
                   created_at desc
          limit v_to_remove
       );
    end if;

    -- ── Helper-seat cushion. Only present for XL buckets (helper_base > 0). ──
    v_target_helper_cushion := case
      when v_cushion_pct <= 0 or r.helper_base_count <= 0 then 0
      else r.apportioned_helper_cushion
    end;

    select count(*)::int into v_existing_helper_cushion
      from public.shifts
     where dsp_id                  = v_dsp
       and station_id              = r.station_id
       and date                    = r.date
       and coalesce(wave_index, 0) = r.wave_index
       and service_type_id         = r.service_type_id
       and is_cushion              = true
       and coalesce(shift_kind, 'regular') = 'helper'
       and status                  in ('scheduled', 'completed');

    if v_existing_helper_cushion < v_target_helper_cushion then
      v_to_add_helper := v_target_helper_cushion - v_existing_helper_cushion;
      for v_index in 1..v_to_add_helper loop
        insert into public.shifts
          (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id, shift_kind)
        values
          (v_dsp, r.station_id, r.date, v_starts, v_ends, 'scheduled', 'auto',
           v_settings.default_block_hours, true, r.wave_index, r.service_type_id, 'helper');
        v_added := v_added + 1;
      end loop;
    elsif v_existing_helper_cushion > v_target_helper_cushion then
      v_to_remove_helper := v_existing_helper_cushion - v_target_helper_cushion;
      delete from public.shifts
       where id in (
         select id from public.shifts
          where dsp_id                  = v_dsp
            and station_id              = r.station_id
            and date                    = r.date
            and coalesce(wave_index, 0) = r.wave_index
            and service_type_id         = r.service_type_id
            and is_cushion              = true
            and coalesce(shift_kind, 'regular') = 'helper'
            and status                  = 'scheduled'
          order by (driver_id is not null) asc,
                   created_at desc
          limit v_to_remove_helper
       );
    end if;
  end loop;

  -- ── Prune orphan cushion rows ──────────────────────────────────────────
  -- Any UNASSIGNED cushion shift (driver or helper) whose (wave_index,
  -- service_type_id) no longer matches a non-cushion demand bucket on that
  -- day/station. Assigned cushion rows and 'completed' rows are protected.
  -- Helper cushion sits on the XL service_type + wave, which has non-cushion
  -- demand, so it's kept alongside its driver cushion.
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

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0534_cushion_apportioned_to_plan.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
