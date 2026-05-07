-- 0077_cushion_round_not_ceil.sql
--
-- The apply_cushion_to_week function used ceil() on the cushion target,
-- which behaved nonsensically at low daily volumes:
--   1 route × 10% = 0.1 → ceil = 1 cushion (effectively 100%)
--   1 route × 5%  = 0.05 → ceil = 1 cushion (still 100%)
-- That meant a 10% cushion on a 1-route/day station produced an extra
-- shift every day — a 7-day week with 1 route/day generated 7 base +
-- 7 cushion = 14 shifts, not the 7 + 1 = 8 the operator expected.
--
-- Switching to round() gives the math operators actually intend:
--   1 route × 10% = 0.1 → round = 0 cushion
--   5 routes × 10% = 0.5 → round = 1 cushion
--   7 routes × 10% = 0.7 → round = 1 cushion
--   10 routes × 10% = 1 → round = 1 cushion
--   15 routes × 10% = 1.5 → round = 2 cushion
-- Cushion only kicks in once daily volume × pct ≥ 0.5, which matches
-- the natural meaning of a percentage buffer.

create or replace function public.apply_cushion_to_week(p_week_start date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + 6;
  v_cushion_pct numeric;
  v_settings public.scheduling_settings;
  v_sp_id uuid;
  r record;
  v_existing_cushion int;
  v_target_cushion int;
  v_to_add int;
  v_index int;
  v_wave_idx int;
  v_existing_total int;
  v_starts timestamptz;
  v_ends timestamptz;
  v_wave_start text;
  v_wave_count int;
  v_added int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_settings := private.get_week_settings(v_dsp, p_week_start);
  v_cushion_pct := coalesce(v_settings.cushion_pct, 0);
  if v_cushion_pct <= 0 then return 0; end if;

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then v_wave_count := 1; end if;

  select id into v_sp_id from public.service_types
   where dsp_id = v_dsp and code = 'SP' limit 1;

  for r in
    select date, station_id, sum(target_routes)::int as target_routes
      from public.okami_demand
     where dsp_id = v_dsp
       and date between p_week_start and v_week_end
     group by date, station_id
    having sum(target_routes) > 0
  loop
    -- round() instead of ceil() — see migration header for the why.
    v_target_cushion := round(r.target_routes::numeric * v_cushion_pct / 100)::int;

    select count(*)::int into v_existing_cushion
      from public.shifts
     where dsp_id     = v_dsp
       and station_id = r.station_id
       and date       = r.date
       and is_cushion = true
       and status in ('scheduled','completed');

    select count(*)::int into v_existing_total
      from public.shifts
     where dsp_id     = v_dsp
       and station_id = r.station_id
       and date       = r.date
       and status in ('scheduled','completed');

    v_to_add := greatest(0, v_target_cushion - v_existing_cushion);

    for v_index in v_existing_total..(v_existing_total + v_to_add - 1) loop
      v_wave_idx   := v_index % v_wave_count;
      v_wave_start := coalesce(v_settings.waves->v_wave_idx->>'start', '07:00');
      v_starts     := (r.date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone;
      v_ends       := v_starts + (v_settings.default_block_hours || ' hours')::interval;

      insert into public.shifts
        (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
      values
        (v_dsp, r.station_id, r.date, v_starts, v_ends, 'scheduled', 'auto', v_settings.default_block_hours, true, v_wave_idx, v_sp_id);
      v_added := v_added + 1;
    end loop;
  end loop;

  return v_added;
end;
$$;

grant execute on function public.apply_cushion_to_week(date) to authenticated;

notify pgrst, 'reload schema';
