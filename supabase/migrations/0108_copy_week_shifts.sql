-- Copy last week's shifts into a target week. Operator workflow: every
-- Monday a lot of weeks look like the previous one. The Schedule
-- view's "Copy last week" toolbar button calls this RPC with the
-- visible week's Monday as p_target_week_start.
--
-- Behavior:
--   - Reads shifts from the 7 days immediately before p_target_week_start.
--   - Inserts new shift rows into the target week, dates and timestamps
--     shifted forward by exactly 7 days, preserving driver_id, route_code,
--     service_type_id, wave_index, is_cushion, block_hours, notes.
--   - status is reset to 'scheduled' regardless of source row's status —
--     we never carry forward 'completed', 'late', 'no_show', etc.
--   - source is stamped 'copy' so audits can tell these shifts apart from
--     auto/manual.
--   - When the target week already has shifts, the caller must pass
--     p_replace = true. Otherwise we raise so the JS layer can prompt
--     the operator first ("This week already has N shifts — replace?").
--   - Returns the number of shifts inserted.

create or replace function public.copy_week_shifts(
  p_target_week_start date,
  p_replace           boolean default false
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_source_start date := p_target_week_start - 7;
  v_source_end   date := p_target_week_start - 1;
  v_target_end   date := p_target_week_start + 6;
  v_existing int;
  v_inserted int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select count(*)::int into v_existing
    from public.shifts
   where dsp_id = v_dsp
     and date between p_target_week_start and v_target_end;

  if v_existing > 0 and not coalesce(p_replace, false) then
    raise exception 'target week already has % shifts; pass p_replace=true to overwrite', v_existing
      using errcode = '23514';
  end if;

  if coalesce(p_replace, false) and v_existing > 0 then
    delete from public.shifts
     where dsp_id = v_dsp
       and date between p_target_week_start and v_target_end;
  end if;

  insert into public.shifts (
    dsp_id,
    station_id,
    date,
    starts_at,
    ends_at,
    driver_id,
    status,
    source,
    block_hours,
    is_cushion,
    wave_index,
    service_type_id,
    route_code,
    notes
  )
  select
    sh.dsp_id,
    sh.station_id,
    sh.date + 7,
    sh.starts_at + interval '7 days',
    sh.ends_at   + interval '7 days',
    sh.driver_id,
    'scheduled',
    'copy',
    sh.block_hours,
    sh.is_cushion,
    sh.wave_index,
    sh.service_type_id,
    sh.route_code,
    sh.notes
  from public.shifts sh
  where sh.dsp_id = v_dsp
    and sh.date between v_source_start and v_source_end;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

grant execute on function public.copy_week_shifts(date, boolean) to authenticated;

notify pgrst, 'reload schema';
