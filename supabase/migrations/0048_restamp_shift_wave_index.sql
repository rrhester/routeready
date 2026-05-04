-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0048 · Re-stamp shifts.wave_index from starts_at, then regen
--
-- 0045 added shifts.wave_index with default 0 and backfilled every
-- existing row to 0 — convenient for greenfield DSPs but wrong for any
-- DSP that already had multi-wave shifts (a shift starting at 11:45 in
-- a 2-wave config should be wave_index=1, not 0).
--
-- The visible symptom: OKAMI shows wave-1 demand=2 + wave-2 demand=2
-- (4 routes total) but the schedule renders some other mix because
-- generate_shifts buckets by wave_index, and the legacy shifts are all
-- mis-stamped. Newly created wave-1 shifts pile on top of legacy
-- "wave-0" shifts that visually look like wave 2.
--
-- This migration walks every existing shift, looks up the week's
-- scheduling_settings.waves, and re-stamps wave_index to whichever
-- configured wave start time the shift's starts_at is closest to.
-- Then it re-runs generate_shifts for every (dsp, date, station) that
-- has demand so the buckets reconcile to OKAMI's per-wave targets.
-- Assigned shifts are preserved — the regen only trims unassigned,
-- non-cushion shifts when a bucket exceeds target.
--
-- Idempotent: safe to re-run. A shift already stamped correctly stays
-- correct; a (date, station) already at target stays at target.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Re-stamp wave_index on every existing shift ──
do $$
declare
  r record;
  v_settings public.scheduling_settings;
  v_wave_count int;
  v_idx int;
  v_best_idx int;
  v_best_diff numeric;
  v_diff numeric;
  v_shift_secs numeric;
  v_wave_secs numeric;
  v_tz text;
  v_wave_start_text text;
begin
  for r in
    select id, dsp_id, date, starts_at
    from public.shifts
    where starts_at is not null
  loop
    v_settings := private.get_week_settings(r.dsp_id, private.week_start_for(r.date));
    v_tz := coalesce(v_settings.timezone, 'America/Chicago');
    v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
    if v_wave_count = 0 then
      continue;
    end if;

    -- Shift's local time-of-day in the DSP's timezone, in seconds since midnight.
    v_shift_secs := extract(epoch from (r.starts_at at time zone v_tz)::time);

    v_best_idx := 0;
    v_best_diff := 86400;  -- larger than any same-day diff

    for v_idx in 0..(v_wave_count - 1) loop
      v_wave_start_text := v_settings.waves->v_idx->>'start';
      if v_wave_start_text is null then
        continue;
      end if;
      v_wave_secs := extract(epoch from v_wave_start_text::time);
      v_diff := abs(v_shift_secs - v_wave_secs);
      if v_diff < v_best_diff then
        v_best_diff := v_diff;
        v_best_idx := v_idx;
      end if;
    end loop;

    update public.shifts
       set wave_index = v_best_idx
     where id = r.id
       and wave_index is distinct from v_best_idx;
  end loop;
end $$;


-- ── 2. Regenerate shifts for every (date, station) with demand ──
-- Runs the new per-wave generate_shifts which trims/creates per bucket.
-- After step 1 the existing shifts are correctly bucketed, so this
-- produces exactly target_routes shifts per (date, station, wave).
do $$
declare r record;
begin
  for r in
    select distinct dsp_id, date, station_id
      from public.okami_demand
  loop
    perform private.generate_shifts(r.dsp_id, r.date, r.station_id);
  end loop;
end $$;
