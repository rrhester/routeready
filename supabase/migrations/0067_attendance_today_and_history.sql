-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0067 · Today's-attendance dashboard + history + approval
--
-- Today's view computes each driver's live outcome from their scheduled
-- shift + the DSP's tardy/NCNS thresholds:
--   waiting        = scheduled, check-in window not open yet
--   ready_to_checkin = scheduled, window open, not yet checked in
--   checked_in     = present, currently working
--   checked_out    = present, shift complete
--   missed_reported = driver pre-reported a call-out
--   tardy          = past start + grace, no check-in or report yet
--   ncns           = past start + ncns_after, still no check-in/report
--
-- attendance_approve_day stamps every checkin row for the day with
-- finalized=true so it locks into the permanent record. The permanent
-- view comes back via attendance_history.
-- ─────────────────────────────────────────────────────────────────────────


alter table public.driver_checkins
  add column if not exists finalized      boolean not null default false,
  add column if not exists finalized_at   timestamptz,
  add column if not exists finalized_by   uuid references auth.users(id),
  add column if not exists final_outcome  text;
-- final_outcome captures the computed status at approval time so the
-- permanent record doesn't drift if scheduling_settings change later.


-- ── 1. today_attendance · the live KPI/list view ──
create or replace function public.today_attendance()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_set public.scheduling_settings;
  v_grace int;
  v_ncns int;
  v_now timestamptz := now();
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
        where s.dsp_id = v_dsp
          and s.date = v_today
          and s.status in ('scheduled','completed')
      ) sub
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.today_attendance() to authenticated;


-- ── 2. attendance_approve_day · lock the day's checkins as the record ──
create or replace function public.attendance_approve_day(p_day date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_set public.scheduling_settings;
  v_grace int;
  v_ncns int;
  v_count int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_set from public.scheduling_settings
   where dsp_id = v_dsp and week_start is null;
  v_grace := coalesce(v_set.tardy_grace_minutes,  10);
  v_ncns  := coalesce(v_set.ncns_after_minutes,   60);

  -- Stamp every checkin row for shifts on p_day with the final outcome
  -- as of NOW. If a driver has no checkin row yet, create one with the
  -- computed outcome so the permanent record reflects the absence.
  insert into public.driver_checkins (driver_id, dsp_id, shift_id, station_id,
                                       outcome, finalized, finalized_at, finalized_by, final_outcome)
  select s.driver_id, s.dsp_id, s.id, s.station_id,
         'ncns', true, now(), auth.uid(),
         case
           when s.starts_at is not null
                and now() > s.starts_at + make_interval(mins => v_ncns)
             then 'ncns'
           when s.starts_at is not null
                and now() > s.starts_at + make_interval(mins => v_grace)
             then 'tardy'
           else 'absent'
         end
    from public.shifts s
    left join public.driver_checkins c on c.shift_id = s.id
   where s.dsp_id = v_dsp
     and s.date = p_day
     and s.status in ('scheduled','completed')
     and c.id is null;

  with upd as (
    update public.driver_checkins c
       set finalized    = true,
           finalized_at = coalesce(c.finalized_at, now()),
           finalized_by = coalesce(c.finalized_by, auth.uid()),
           final_outcome = coalesce(c.final_outcome,
             case
               when c.checked_in_at is not null and c.checked_out_at is not null then 'present'
               when c.checked_in_at is not null then 'present'
               when c.missed_reported_at is not null then 'excused'
               when (select s.starts_at from public.shifts s where s.id = c.shift_id) is not null
                    and now() > (select s.starts_at from public.shifts s where s.id = c.shift_id) + make_interval(mins => v_ncns)
                 then 'ncns'
               when (select s.starts_at from public.shifts s where s.id = c.shift_id) is not null
                    and now() > (select s.starts_at from public.shifts s where s.id = c.shift_id) + make_interval(mins => v_grace)
                 then 'tardy'
               else 'absent'
             end)
     where c.dsp_id = v_dsp
       and c.shift_id in (select id from public.shifts where dsp_id = v_dsp and date = p_day)
       and c.finalized = false
     returning 1
  )
  select count(*) into v_count from upd;

  return jsonb_build_object('finalized_rows', v_count, 'day', p_day);
end;
$$;
grant execute on function public.attendance_approve_day(date) to authenticated;


-- ── 3. attendance_history · permanent record for any range ──
create or replace function public.attendance_history(
  p_from date default null,
  p_to   date default null,
  p_driver_id uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_from date := coalesce(p_from, current_date - 30);
  v_to   date := coalesce(p_to,   current_date);
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'from', v_from,
    'to',   v_to,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date',           s.date,
        'driver_id',      d.id,
        'driver_name',    coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
        'station_code',   st.code,
        'final_outcome',  c.final_outcome,
        'finalized',      c.finalized,
        'checked_in_at',  to_jsonb(c.checked_in_at),
        'checked_out_at', to_jsonb(c.checked_out_at)
      ) order by s.date desc, d.full_name)
        from public.driver_checkins c
        join public.shifts s   on s.id = c.shift_id
        join public.drivers d  on d.id = c.driver_id
        left join public.stations st on st.id = s.station_id
       where c.dsp_id = v_dsp
         and c.finalized = true
         and s.date between v_from and v_to
         and (p_driver_id is null or c.driver_id = p_driver_id)
    ), '[]'::jsonb),
    -- Per-driver summary in the same window so the operator can see
    -- the breakdown at a glance (e.g. "3 tardy, 1 ncns, 18 present").
    'summary_by_driver', coalesce((
      select jsonb_agg(jsonb_build_object(
        'driver_id',   driver_id,
        'driver_name', driver_name,
        'present',     present_n,
        'tardy',       tardy_n,
        'ncns',        ncns_n,
        'absent',      absent_n,
        'excused',     excused_n,
        'total',       total_n
      ) order by driver_name)
        from (
          select d.id as driver_id,
                 coalesce(nullif(trim(d.preferred_name), ''), d.full_name) as driver_name,
                 sum(case when c.final_outcome = 'present' then 1 else 0 end) as present_n,
                 sum(case when c.final_outcome = 'tardy'   then 1 else 0 end) as tardy_n,
                 sum(case when c.final_outcome = 'ncns'    then 1 else 0 end) as ncns_n,
                 sum(case when c.final_outcome = 'absent'  then 1 else 0 end) as absent_n,
                 sum(case when c.final_outcome = 'excused' then 1 else 0 end) as excused_n,
                 count(*) as total_n
            from public.driver_checkins c
            join public.shifts s on s.id = c.shift_id
            join public.drivers d on d.id = c.driver_id
           where c.dsp_id = v_dsp and c.finalized = true
             and s.date between v_from and v_to
             and (p_driver_id is null or c.driver_id = p_driver_id)
           group by d.id, driver_name
        ) t
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.attendance_history(date, date, uuid) to authenticated;


-- ── 4. attendance_settings_get/set · DSP knobs for lead/grace/NCNS ──
create or replace function public.attendance_settings_get()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_s public.scheduling_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_s from public.scheduling_settings
   where dsp_id = v_dsp and week_start is null;
  return jsonb_build_object(
    'checkin_lead_minutes', coalesce(v_s.checkin_lead_minutes, 15),
    'tardy_grace_minutes',  coalesce(v_s.tardy_grace_minutes,  10),
    'ncns_after_minutes',   coalesce(v_s.ncns_after_minutes,   60)
  );
end;
$$;
grant execute on function public.attendance_settings_get() to authenticated;

create or replace function public.attendance_settings_set(
  p_lead int, p_grace int, p_ncns int
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.scheduling_settings
    (dsp_id, week_start, checkin_lead_minutes, tardy_grace_minutes, ncns_after_minutes)
  values
    (v_dsp, null,
     greatest(0, least(120, coalesce(p_lead,  15))),
     greatest(0, least(120, coalesce(p_grace, 10))),
     greatest(0, least(720, coalesce(p_ncns,  60))))
  on conflict (dsp_id, week_start) do update set
    checkin_lead_minutes = excluded.checkin_lead_minutes,
    tardy_grace_minutes  = excluded.tardy_grace_minutes,
    ncns_after_minutes   = excluded.ncns_after_minutes,
    updated_at = now();
end;
$$;
grant execute on function public.attendance_settings_set(int, int, int) to authenticated;


notify pgrst, 'reload schema';
