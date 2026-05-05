-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0058 · Fix driver_my_schedule volatility
--
-- 0052 marked driver_my_schedule as STABLE. It calls
-- private.driver_validate_token which does
--   update driver_sessions set last_seen_at = now() ...
-- PostgREST runs STABLE functions in a read-only transaction, so the
-- UPDATE fails with:
--   "cannot execute UPDATE in a read-only transaction"
-- which surfaces in the driver app as "Couldn't load schedule".
--
-- Drop STABLE so the function defaults to VOLATILE (same fix as 0055
-- did for the chat functions).
-- ─────────────────────────────────────────────────────────────────────────


create or replace function public.driver_my_schedule(p_token text, p_weeks int default 2)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_start date := private.week_start_for(current_date);
  v_end date;
  v_shifts jsonb;
begin
  v_drv := private.driver_validate_token(p_token);
  v_end := v_start + (greatest(1, least(8, coalesce(p_weeks, 2))) * 7) - 1;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id',                sh.id,
      'date',              sh.date,
      'starts_at',         sh.starts_at,
      'ends_at',           sh.ends_at,
      'station_id',        sh.station_id,
      'station_code',      s.code,
      'status',            sh.status,
      'block_hours',       sh.block_hours,
      'wave_index',        sh.wave_index,
      'service_type_code', st.code,
      'service_type_color',st.color,
      'is_cushion',        sh.is_cushion,
      'route_code',        sh.route_code,
      'notes',             sh.notes
    ) order by sh.date, sh.starts_at), '[]'::jsonb)
    into v_shifts
  from public.shifts sh
  left join public.stations     s  on s.id  = sh.station_id
  left join public.service_types st on st.id = sh.service_type_id
  where sh.driver_id = v_drv.id
    and sh.date between v_start and v_end;

  return jsonb_build_object(
    'driver', jsonb_build_object(
      'id',        v_drv.id,
      'full_name', v_drv.full_name,
      'name',      coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name)
    ),
    'shifts', v_shifts,
    'start',  v_start,
    'end',    v_end
  );
end;
$$;


notify pgrst, 'reload schema';
