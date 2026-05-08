-- Operator: "still not working." Final cleanup of the regenerate
-- pipeline.
--
-- regenerate_week_shifts (last touched in 0107) had a positional
-- "reposition" loop at the end that re-stamped every scheduled
-- shift's starts_at to (waves->[v_pos % wave_count]).start. That
-- iteration is positional — it ignores each shift's actual
-- wave_index — so for any DSP with two or more waves it scrambled
-- shift wave times, putting wave-0 demand at wave-1's clock and
-- vice versa. Even on single-wave DSPs the loop was redundant
-- (generate_shifts already stamps starts_at correctly per demand
-- row, per #535).
--
-- New regenerate_week_shifts: just wipe unassigned scheduled
-- shifts for the week, then call generate_shifts for each (date,
-- station) that has demand. generate_shifts (private, from #535)
-- iterates okami_demand directly so each row's wave_index drives
-- where its shifts land. apply_cushion_to_week (public, from
-- #535) is called separately by the JS Save flow.

create or replace function public.regenerate_week_shifts(p_week_start date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + 6;
  v_count int := 0;
  r record;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Wipe unassigned scheduled shifts for the week (cushion or not)
  -- so we rebuild from a clean slate. Assigned shifts and historical
  -- statuses (completed, no_show, called_off, vto, late) are
  -- preserved.
  delete from public.shifts
   where dsp_id = v_dsp
     and driver_id is null
     and status = 'scheduled'
     and date between p_week_start and v_week_end;

  -- Materialize one shift per route in okami_demand. generate_shifts
  -- handles the per-(wave, service_type) bucketing and clamps stale
  -- wave_index to a valid wave.
  for r in
    select distinct date, station_id
      from public.okami_demand
     where dsp_id = v_dsp
       and date between p_week_start and v_week_end
  loop
    v_count := v_count + private.generate_shifts(v_dsp, r.date, r.station_id);
  end loop;

  return v_count;
end;
$$;

grant execute on function public.regenerate_week_shifts(date) to authenticated;

notify pgrst, 'reload schema';
