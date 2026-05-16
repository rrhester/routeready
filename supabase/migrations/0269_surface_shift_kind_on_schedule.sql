-- Migration 0269 · Surface shift_kind on schedule RPCs
--
-- After 0264 brought training pairings back, the two RPCs that drive
-- the schedule UIs still return the legacy shift payload without
-- shift_kind or trainer_driver_id. As a result:
--
--   • The dispatcher schedule grid renders training + ride-along shifts
--     as if they were regular shifts, with no badge, and the operator
--     has no way to see that Charlie (the trainer) has a trainee
--     riding along on day 3. The existing "skip training/ride-along
--     when computing coverage" branch in live.js (#22789) is also
--     dead because `sh.shift_kind` is always undefined.
--
--   • The driver app shows training shifts in the schedule list with
--     no station / route fallback label, indistinguishable from a
--     regular shift, and never surfaces the trainer's name on the
--     ride-along card.
--
-- Both RPCs need shift_kind, plus the driver one needs the partner's
-- name when shift_kind = 'ride_along' so the trainee's card can read
-- "Ride-along with Sarah Chen".

create or replace function public.schedule_grid(p_start date, p_weeks int default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_end date := p_start + (p_weeks * 7 - 1);
  v_grid jsonb;
  v_shifts jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
    into v_grid
  from public.okami_grid(p_start, p_weeks) g;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', sh.id, 'date', sh.date, 'station_id', sh.station_id,
    'driver_id', sh.driver_id, 'driver_name', d.full_name,
    'route_code', sh.route_code, 'status', sh.status,
    'starts_at', sh.starts_at, 'ends_at', sh.ends_at,
    'block_hours', sh.block_hours, 'is_cushion', sh.is_cushion,
    'wave_index', sh.wave_index,
    'service_type_id',    sh.service_type_id,
    'service_type_code',  st.code,
    'service_type_label', st.label,
    'service_type_color', st.color,
    'shift_kind',         sh.shift_kind,
    'trainer_driver_id',  sh.trainer_driver_id,
    'trainer_name',       tr.full_name,
    'notes', sh.notes
  ) order by sh.date, sh.station_id, sh.wave_index, sh.starts_at), '[]'::jsonb)
    into v_shifts
  from public.shifts sh
  left join public.drivers d  on d.id  = sh.driver_id
  left join public.drivers tr on tr.id = sh.trainer_driver_id
  left join public.service_types st on st.id = sh.service_type_id
  where sh.dsp_id = v_dsp
    and sh.date between p_start and v_end;

  return jsonb_build_object('coverage', v_grid, 'shifts', v_shifts,
                            'start', p_start, 'weeks', p_weeks);
end;
$$;
grant execute on function public.schedule_grid(date, int) to authenticated;


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
      'wave_starts_at',    sh.starts_at + make_interval(mins => coalesce((
        select ss.report_lead_minutes
          from public.scheduling_settings ss
         where ss.dsp_id = sh.dsp_id
           and ss.week_start = private.week_start_for(sh.date)
      ), 0)),
      'report_lead_minutes', coalesce((
        select ss.report_lead_minutes
          from public.scheduling_settings ss
         where ss.dsp_id = sh.dsp_id
           and ss.week_start = private.week_start_for(sh.date)
      ), 0),
      'station_id',        sh.station_id,
      'station_code',      s.code,
      'status',            sh.status,
      'block_hours',       sh.block_hours,
      'wave_index',        sh.wave_index,
      'service_type_code', st.code,
      'service_type_color',st.color,
      'is_cushion',        sh.is_cushion,
      'route_code',        sh.route_code,
      'shift_kind',        sh.shift_kind,
      'trainer_driver_id', sh.trainer_driver_id,
      'trainer_name',      tr.full_name,
      'notes',             sh.notes
    ) order by sh.date, sh.starts_at), '[]'::jsonb)
    into v_shifts
  from public.shifts sh
  left join public.stations     s  on s.id  = sh.station_id
  left join public.service_types st on st.id = sh.service_type_id
  left join public.drivers      tr on tr.id = sh.trainer_driver_id
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
grant execute on function public.driver_my_schedule(text, int) to anon, authenticated;


notify pgrst, 'reload schema';
