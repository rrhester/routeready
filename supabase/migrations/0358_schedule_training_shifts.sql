-- 0358_schedule_training_shifts.sql
--
-- Adds schedule_training_shifts(): puts ONLY the trainee's training shifts
-- on the schedule — the 2 classroom days (training_start_date + 0/1) and the
-- 1 ride-along — WITHOUT activating the driver and WITHOUT adding any
-- productive shifts. This lets an operator schedule the training while the
-- new hire stays in onboarding; activate_driver_with_pairing (which also
-- flips the driver to active, and is idempotent on these same shifts) can
-- finalize later.
--
-- This is a trimmed copy of activate_driver_with_pairing's shift-insert
-- logic minus the two status flips (driver -> active, pairing ->
-- materialized). Idempotent: create or replace + per-shift existence checks,
-- so re-running is safe and never duplicates a training shift.

create or replace function public.schedule_training_shifts(
  p_driver_id            uuid,
  p_training_hours_start text default '09:00',
  p_training_hours_end   text default '16:00'
)
returns public.drivers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers;
  v_pair public.training_pairings;
  v_partner_shift public.shifts;
  v_tz text;
  v_day1 date;
  v_day2 date;
  v_day1_starts timestamptz;
  v_day1_ends   timestamptz;
  v_day2_starts timestamptz;
  v_day2_ends   timestamptz;
  v_station_for_training uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_drv
    from public.drivers
   where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then
    raise exception 'driver not found' using errcode = 'P0002';
  end if;

  -- Fetch the active pairing.
  select * into v_pair
    from public.training_pairings
   where trainee_id = p_driver_id
     and dsp_id     = v_dsp
     and status in ('proposed', 'needs_repair')
   order by created_at desc
   limit 1;

  if v_pair.id is null then
    raise exception 'no active training pairing for this driver' using errcode = 'P0002';
  end if;
  if v_pair.trainer_id is null or v_pair.ride_along_date is null
     or v_pair.training_start_date is null then
    raise exception 'pairing is incomplete — set trainer, ride-along date, and training start date'
      using errcode = '22023';
  end if;

  -- Re-validate the partner's shift exists on ride_along_date (the ride-along
  -- copies the partner's shift fields).
  select * into v_partner_shift
    from public.shifts
   where driver_id  = v_pair.trainer_id
     and dsp_id     = v_dsp
     and date       = v_pair.ride_along_date
     and status     = 'scheduled'
     and shift_kind = 'regular'
   order by starts_at nulls last
   limit 1;
  if v_partner_shift.id is null then
    raise exception 'trainer has no scheduled shift on % — pick a trainer scheduled that day', v_pair.ride_along_date
      using errcode = 'P0002';
  end if;

  -- Resolve the DSP timezone for the training shifts.
  select coalesce((d.metadata->>'timezone'), 'America/Chicago')
    into v_tz
    from public.dsps d
   where d.id = v_dsp;

  -- Classroom (Day 1+2) happens at the station, not on the road.
  v_station_for_training := coalesce(v_drv.station_id, v_partner_shift.station_id);

  v_day1 := v_pair.training_start_date;
  v_day2 := v_pair.training_start_date + 1;

  v_day1_starts := ((v_day1::text || ' ' || p_training_hours_start)::timestamp at time zone v_tz);
  v_day1_ends   := ((v_day1::text || ' ' || p_training_hours_end  )::timestamp at time zone v_tz);
  v_day2_starts := ((v_day2::text || ' ' || p_training_hours_start)::timestamp at time zone v_tz);
  v_day2_ends   := ((v_day2::text || ' ' || p_training_hours_end  )::timestamp at time zone v_tz);

  -- Day 1 + Day 2 classroom training (skip if already present).
  if not exists (
    select 1 from public.shifts
     where driver_id = p_driver_id and dsp_id = v_dsp
       and date = v_day1 and shift_kind = 'training'
  ) then
    insert into public.shifts
      (dsp_id, station_id, driver_id, date, starts_at, ends_at,
       status, source, shift_kind, created_by)
    values
      (v_dsp, v_station_for_training, p_driver_id, v_day1, v_day1_starts, v_day1_ends,
       'scheduled', 'manual', 'training', auth.uid());
  end if;
  if not exists (
    select 1 from public.shifts
     where driver_id = p_driver_id and dsp_id = v_dsp
       and date = v_day2 and shift_kind = 'training'
  ) then
    insert into public.shifts
      (dsp_id, station_id, driver_id, date, starts_at, ends_at,
       status, source, shift_kind, created_by)
    values
      (v_dsp, v_station_for_training, p_driver_id, v_day2, v_day2_starts, v_day2_ends,
       'scheduled', 'manual', 'training', auth.uid());
  end if;

  -- Ride-along, copying the partner's shift fields.
  if not exists (
    select 1 from public.shifts
     where driver_id = p_driver_id and dsp_id = v_dsp
       and date = v_pair.ride_along_date and shift_kind = 'ride_along'
  ) then
    insert into public.shifts
      (dsp_id, station_id, driver_id, date, starts_at, ends_at, route_code,
       status, source, shift_kind, trainer_driver_id, wave_index, service_type_id, created_by)
    values
      (v_dsp, v_partner_shift.station_id, p_driver_id, v_pair.ride_along_date,
       v_partner_shift.starts_at, v_partner_shift.ends_at, v_partner_shift.route_code,
       'scheduled', 'manual', 'ride_along', v_pair.trainer_id,
       v_partner_shift.wave_index, v_partner_shift.service_type_id, auth.uid());
  end if;

  -- Intentionally NO status flips: the driver stays in onboarding and the
  -- pairing stays 'proposed', so Activate driver can finalize later.
  return v_drv;
end;
$$;

grant execute on function public.schedule_training_shifts(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
