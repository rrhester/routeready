-- Migration 0333 · Surface route_classification on the schedule_grid RPC
--
-- 0332 added `shifts.route_classification` so operators can tag each
-- shift as Rescue / Nursery / Reduction / Cycle 1 / Cycle 2 / Backup.
-- The dashboard's color-coding rule (Week view popover) needs this
-- value on every chip render to decide which palette to apply.
--
-- This recreate is a verbatim copy of 0269's schedule_grid plus one
-- new JSON key: route_classification. No other schema changes.

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
    'route_classification', sh.route_classification,
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
