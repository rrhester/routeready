-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0040 · Cushion reconciles in both directions
--
-- Operator preference: cushion % lives only in Schedule settings. When
-- saved, it should add OR remove cushion shifts to match the new target.
-- Drop to 0% → unassigned cushion rows disappear. Bump to 20% → cushion
-- rows are created up to the new target.
--
-- Replaces apply_cushion_to_week from migration 0039 (which only added).
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.apply_cushion_to_week(p_week_start date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + 6;
  v_cushion_pct numeric;
  v_settings public.scheduling_settings;
  r record;
  v_existing_cushion int;
  v_target_cushion int;
  v_to_add int;
  v_to_remove int;
  v_index int;
  v_existing_total int;
  v_starts timestamptz;
  v_ends timestamptz;
  v_wave_start text;
  v_wave_count int;
  v_added int := 0;
  v_removed int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_settings := private.get_week_settings(v_dsp, p_week_start);
  v_cushion_pct := coalesce(v_settings.cushion_pct, 0);

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then v_wave_count := 1; end if;

  for r in
    select date, station_id, target_routes
      from public.okami_demand
     where dsp_id = v_dsp
       and date between p_week_start and v_week_end
       and target_routes > 0
  loop
    -- Round up so cushion% always produces at least one shift when > 0.
    v_target_cushion := case
      when v_cushion_pct <= 0 then 0
      else ceil(r.target_routes::numeric * v_cushion_pct / 100)::int
    end;

    select count(*)::int into v_existing_cushion
      from public.shifts
     where dsp_id = v_dsp
       and station_id = r.station_id
       and date = r.date
       and is_cushion = true
       and status in ('scheduled','completed');

    -- Add direction: top up to target.
    if v_existing_cushion < v_target_cushion then
      v_to_add := v_target_cushion - v_existing_cushion;

      select count(*)::int into v_existing_total
        from public.shifts
       where dsp_id = v_dsp
         and station_id = r.station_id
         and date = r.date
         and status in ('scheduled','completed');

      for v_index in v_existing_total..(v_existing_total + v_to_add - 1) loop
        v_wave_start := coalesce(v_settings.waves->(v_index % v_wave_count)->>'start', '07:00');
        v_starts := (r.date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone;
        v_ends   := v_starts + (v_settings.default_block_hours || ' hours')::interval;

        insert into public.shifts
          (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion)
        values
          (v_dsp, r.station_id, r.date, v_starts, v_ends, 'scheduled', 'auto', v_settings.default_block_hours, true);
        v_added := v_added + 1;
      end loop;

    -- Remove direction: drop unassigned cushion rows (oldest position first).
    -- Assigned cushion rows are preserved — they're real commitments.
    elsif v_existing_cushion > v_target_cushion then
      v_to_remove := v_existing_cushion - v_target_cushion;
      delete from public.shifts
       where id in (
         select id from public.shifts
          where dsp_id = v_dsp
            and station_id = r.station_id
            and date = r.date
            and is_cushion = true
            and driver_id is null
            and status = 'scheduled'
          order by starts_at desc
          limit v_to_remove
       );
      get diagnostics v_to_remove = row_count;
      v_removed := v_removed + v_to_remove;
    end if;
  end loop;

  -- Net change (positive = added more than removed).
  return v_added - v_removed;
end;
$$;
grant execute on function public.apply_cushion_to_week(date) to authenticated;
