-- seed_attendance_test.sql
--
-- One-shot seed for testing the Attendance system end-to-end.
-- Generates ~30 shifts per active driver across the last 90 days
-- with a realistic spread of statuses, so the Attendance Report,
-- the per-driver Attendance tab, and Today's Plan have something
-- to surface.
--
-- Spread (drivers bucketed by hash of their UUID for reproducibility):
--   ~50% drivers · 0–1 events     · Clear
--   ~30% drivers · 2–3 events     · Verbal / Written
--   ~15% drivers · 4–5 events     · Final
--   ~5%  drivers · 6–8 events     · Termination
--
-- Each event lands on a random day in the window and gets one of
-- callout / no-show / late.  Other ~50% of shift days are 'completed'.
--
-- Every shift inserted by this seed has notes = '[SEEDED ATT]' so
-- you can clean up with the matching DELETE at the bottom.
--
-- Adjust v_dsp_id manually if you have multiple DSPs and want to
-- target a specific one.

do $$
declare
  v_dsp_id     uuid;
  v_station_id uuid;
  v_drv        record;
  v_day_offset int;
  v_date       date;
  v_status     text;
  v_starts     timestamptz;
  v_ends       timestamptz;
  v_event_count int;
  v_bucket     int;
  v_random     numeric;
  v_skipped    bool;
  v_inserted   int := 0;
begin
  -- Pick the first DSP (replace this with a specific id if you have
  -- more than one and want to target a particular tenant).
  select id into v_dsp_id from public.dsps order by created_at limit 1;
  if v_dsp_id is null then
    raise exception 'no DSP found — seed needs at least one row in public.dsps';
  end if;
  -- Pick any station from that DSP for the shift's required station_id.
  select id into v_station_id from public.stations where dsp_id = v_dsp_id order by code limit 1;
  if v_station_id is null then
    raise exception 'no station found for dsp %', v_dsp_id;
  end if;

  raise notice 'Seeding for dsp=% station=%', v_dsp_id, v_station_id;

  -- One driver at a time — assign each a target event count via a
  -- deterministic hash so re-running gives stable buckets.
  for v_drv in
    select id, full_name from public.drivers
     where dsp_id = v_dsp_id and status = 'active'
     order by full_name
  loop
    v_bucket := (abs(hashtext(v_drv.id::text)) % 100);
    if v_bucket < 50 then
      v_event_count := (random() * 1)::int;       -- 0–1 events
    elsif v_bucket < 80 then
      v_event_count := 2 + (random() * 1)::int;   -- 2–3 events
    elsif v_bucket < 95 then
      v_event_count := 4 + (random() * 1)::int;   -- 4–5 events
    else
      v_event_count := 6 + (random() * 2)::int;   -- 6–8 events
    end if;

    -- Walk back 90 days; each day the driver "works" with ~60%
    -- probability.  Spread the assigned events across the work days.
    for v_day_offset in 0..89 loop
      if random() > 0.6 then
        continue;  -- driver didn't work this day
      end if;

      v_date   := current_date - v_day_offset;
      v_starts := (v_date::text || ' 07:00')::timestamp at time zone 'UTC';
      v_ends   := v_starts + interval '10 hours';

      -- Pick status: when the driver still has events to spend, ~12%
      -- of work days become a tardy / callout / no-show.  Otherwise
      -- 'completed'.
      if v_event_count > 0 and random() < 0.12 then
        v_event_count := v_event_count - 1;
        v_random := random();
        if v_random < 0.4 then
          v_status := 'called_off';
        elsif v_random < 0.75 then
          v_status := 'late';
        else
          v_status := 'no_show';
        end if;
      else
        v_status := 'completed';
      end if;

      -- Skip if a real shift already exists for this driver on this
      -- day (don't trample real data).
      perform 1 from public.shifts
       where dsp_id = v_dsp_id
         and driver_id = v_drv.id
         and date = v_date
       limit 1;
      if found then
        continue;
      end if;

      insert into public.shifts
        (dsp_id, station_id, driver_id, date, starts_at, ends_at,
         status, source, notes)
      values
        (v_dsp_id, v_station_id, v_drv.id, v_date, v_starts, v_ends,
         v_status::public.shift_status, 'manual', '[SEEDED ATT]');

      v_inserted := v_inserted + 1;
    end loop;
  end loop;

  raise notice 'Seeded % shift rows.  Refresh Drivers → Attendance → Report to see the data.', v_inserted;
end $$;


-- ─── Cleanup (run separately when you're done) ─────────────────────
--
-- Removes every shift this seed inserted.  Real shifts are untouched
-- because the seed never overwrote existing rows and tagged its own
-- inserts with notes = '[SEEDED ATT]'.
--
-- delete from public.shifts where notes = '[SEEDED ATT]';
