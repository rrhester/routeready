-- Operator: "Every time I hit the route planning save button all
-- routes should clear out and start over with the math again."
--
-- Make Save a true hard reset for the week. Previous regenerate
-- only deleted UNASSIGNED scheduled shifts; assigned shifts stuck
-- around and skewed the count via the existing-vs-target math
-- inside generate_shifts.
--
-- New regenerate_week_shifts:
--   1. Delete every status='scheduled' shift in the week, assigned
--      or not. Drivers who had pending assignments get unassigned —
--      they'll need to be re-staffed (Smart Fill, drag-drop). This
--      is the operator's stated intent: clear out, then math.
--   2. Run generate_shifts per (date, station) with demand →
--      creates exactly target_routes shifts per (wave, type).
--   3. apply_cushion_to_week is called separately by JS, adds
--      floor(base × cushion% / 100) EX shifts per (date, station).
--
-- 'completed', 'no_show', 'late', 'called_off', 'vto' rows are
-- preserved — they're worked / decided history. Anything in the
-- 'scheduled' state is treated as a draft and gets rewritten.

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

  -- HARD RESET: drop every 'scheduled' shift in the week. Assigned
  -- and unassigned alike. History rows (completed, no_show, etc.)
  -- are not touched.
  delete from public.shifts
   where dsp_id = v_dsp
     and status = 'scheduled'
     and date between p_week_start and v_week_end;

  -- Rebuild from okami_demand. generate_shifts iterates active-type
  -- demand rows for each (date, station) and creates one shift per
  -- target_route at the appropriate wave_index.
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
