-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0068 · Today's Plan · coverage + expiring credentials
--
-- Powers the new sidebar "Today" view. today_plan() returns one bundle
-- with the dispatcher's morning glance:
--   - open_shifts: scheduled shifts today with no driver assigned
--   - dl_expiring: drivers whose driver's license expires soon (-1..+7)
--   - not_dot_certified: active drivers without DOT certification flagged
-- The Today's-attendance KPIs come from the existing today_attendance
-- RPC; this just covers the things that aren't in there.
-- ─────────────────────────────────────────────────────────────────────────


create or replace function public.today_plan()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_today date := current_date;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'open_shifts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'shift_id',          s.id,
        'station_code',      st.code,
        'starts_at',         to_jsonb(s.starts_at),
        'wave_index',        s.wave_index,
        'service_type_code', svc.code,
        'service_type_color',svc.color,
        'is_cushion',        s.is_cushion
      ) order by s.starts_at nulls last)
        from public.shifts s
        left join public.stations st on st.id = s.station_id
        left join public.service_types svc on svc.id = s.service_type_id
       where s.dsp_id = v_dsp
         and s.date = v_today
         and s.driver_id is null
         and s.status = 'scheduled'
    ), '[]'::jsonb),

    'dl_expiring', coalesce((
      select jsonb_agg(jsonb_build_object(
        'driver_id',   d.id,
        'driver_name', coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
        'expires_on',  to_jsonb(d.dl_expires_on::text),
        'days_left',   (d.dl_expires_on - v_today)
      ) order by d.dl_expires_on)
        from public.drivers d
       where d.dsp_id = v_dsp
         and d.status in ('active','onboarding')
         and d.dl_expires_on is not null
         and d.dl_expires_on between v_today - 1 and v_today + 7
    ), '[]'::jsonb),

    'not_dot_certified', coalesce((
      select jsonb_agg(jsonb_build_object(
        'driver_id',   d.id,
        'driver_name', coalesce(nullif(trim(d.preferred_name), ''), d.full_name)
      ) order by d.full_name)
        from public.drivers d
       where d.dsp_id = v_dsp
         and d.status = 'active'
         and coalesce(d.dot_certified, false) = false
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.today_plan() to authenticated;


notify pgrst, 'reload schema';
