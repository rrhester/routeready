-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0030 · Regenerate-all RPC + assigned-shift block_hours sync
--
-- When the operator changes scheduling settings (cushion, wave times,
-- block length), existing unassigned shifts have STALE starts_at /
-- block_hours / counts. The Sync schedule button only trimmed and
-- filled — it didn't relocate existing shifts to the new wave times
-- or update durations.
--
-- regenerate_all_shifts:
--   • Deletes all unassigned 'scheduled' shifts for the DSP
--   • Re-runs private.generate_shifts for every okami_demand row
--   • Updates assigned shifts in place: block_hours + ends_at
--   • Returns the total shifts created
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.regenerate_all_shifts()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_block_hours int;
  v_count int := 0;
  r record;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce((metadata->'scheduling'->>'default_block_hours')::int, 10)
    into v_block_hours
  from public.dsps where id = v_dsp;

  -- Update assigned shifts in place: block_hours + ends_at align with the
  -- new default. Operator keeps their assignments; durations refresh.
  update public.shifts
     set block_hours = v_block_hours,
         ends_at     = starts_at + (v_block_hours || ' hours')::interval
   where dsp_id = v_dsp
     and driver_id is not null
     and status = 'scheduled';

  -- Wipe unassigned scheduled shifts so wave / count / block changes apply.
  delete from public.shifts
   where dsp_id = v_dsp
     and driver_id is null
     and status = 'scheduled';

  -- Regenerate from every okami_demand row using current scheduling config.
  for r in
    select date, station_id from public.okami_demand where dsp_id = v_dsp
  loop
    v_count := v_count + private.generate_shifts(v_dsp, r.date, r.station_id);
  end loop;

  return v_count;
end;
$$;

grant execute on function public.regenerate_all_shifts() to authenticated;
