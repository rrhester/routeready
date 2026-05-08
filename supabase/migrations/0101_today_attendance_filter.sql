-- Hotfix for #506/#507: a VTO'd row reappeared on the Today's plan
-- after the auto-refresh. Migration 0099 expanded today_attendance's
-- status filter from ('scheduled','completed') to also include
-- 'vto','no_show','late','called_off' so attendance_approve_day
-- could see those rows on finalize. But today_attendance is the
-- "needs operator attention today" view — once a shift's been
-- decided, the row should drop out.
--
-- Fix: revert today_attendance to only include scheduled/completed
-- shifts (the original filter). attendance_approve_day already has
-- its own expanded filter — it doesn't share this query.

create or replace function public.today_attendance()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_set   public.scheduling_settings;
  v_grace int;
  v_ncns  int;
  v_now   timestamptz := now();
  v_today date := current_date;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_set from public.scheduling_settings
   where dsp_id = v_dsp and week_start is null;
  v_grace := coalesce(v_set.tardy_grace_minutes,  10);
  v_ncns  := coalesce(v_set.ncns_after_minutes,   60);

  return jsonb_build_object(
    'as_of',       to_jsonb(v_now),
    'tardy_grace_minutes', v_grace,
    'ncns_after_minutes',  v_ncns,
    'rows', coalesce((
      select jsonb_agg(t order by
        case t->>'computed_outcome'
          when 'ncns'             then 1
          when 'tardy'            then 2
          when 'ready_to_checkin' then 3
          when 'waiting'          then 4
          when 'missed_reported'  then 5
          when 'checked_in'       then 6
          when 'checked_out'      then 7
          else 8
        end,
        t->>'starts_at',
        t->>'driver_name'
      ) from (
        select jsonb_build_object(
          'shift_id',          s.id,
          'driver_id',         d.id,
          'driver_name',       coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
          'station_code',      st.code,
          'starts_at',         to_jsonb(s.starts_at),
          'wave_index',        s.wave_index,
          'service_type_code', svc.code,
          'service_type_color',svc.color,
          'is_cushion',        s.is_cushion,
          'checked_in_at',     to_jsonb(c.checked_in_at),
          'checked_out_at',    to_jsonb(c.checked_out_at),
          'missed_reported_at',to_jsonb(c.missed_reported_at),
          'missed_reason',     c.missed_reason,
          'distance_meters',   c.distance_meters,
          'finalized',         coalesce(c.finalized, false),
          'final_outcome',     c.final_outcome,
          'decision',          ad.decision,
          'decision_notes',    ad.notes,
          'computed_outcome',
            case
              when c.checked_out_at is not null then 'checked_out'
              when c.checked_in_at  is not null then 'checked_in'
              when c.missed_reported_at is not null then 'missed_reported'
              when s.starts_at is not null
                   and v_now > s.starts_at + make_interval(mins => v_ncns)
                then 'ncns'
              when s.starts_at is not null
                   and v_now > s.starts_at + make_interval(mins => v_grace)
                then 'tardy'
              when s.starts_at is not null
                   and v_now >= s.starts_at - make_interval(mins => coalesce(v_set.checkin_lead_minutes, 15))
                then 'ready_to_checkin'
              else 'waiting'
            end
        ) as t
        from public.shifts s
        join public.drivers d on d.id = s.driver_id
        left join public.stations st on st.id = s.station_id
        left join public.service_types svc on svc.id = s.service_type_id
        left join public.driver_checkins c on c.shift_id = s.id
        left join public.attendance_decisions ad on ad.shift_id = s.id
        where s.dsp_id = v_dsp
          and s.date = v_today
          and s.status in ('scheduled','completed')
      ) sub
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.today_attendance() to authenticated;

notify pgrst, 'reload schema';
