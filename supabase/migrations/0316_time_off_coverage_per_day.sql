-- 0316_time_off_coverage_per_day.sql
--
-- Extends dispatch_time_off_coverage so the Requests page can show the
-- DSP a per-day coverage picture for every pending PTO / time-off
-- request — not just the aggregate eligibility verdict.
--
-- For each day in the request range (today onward) the function now
-- returns:
--   date          : the calendar day
--   needed        : route-staffing shifts planned that day
--   filled        : how many of those have a driver assigned
--   driver_on     : whether the requesting driver staffs a route that
--                   day (i.e. approving would free one of those shifts)
--   filled_after  : staffed count if the request is approved
--
-- The dashboard turns this into "11/12 · 92% → 10/12 · 83%" style
-- telemetry so the DSP can see the coverage impact of approving,
-- including for days the driver isn't scheduled (no change).
--
-- Training / ride-along shifts are excluded — they don't staff a route.
-- Re-runnable: `create or replace`.

create or replace function public.dispatch_time_off_coverage(
  p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp           uuid := private.current_dsp_id();
  v_req           public.time_off_requests;
  v_defaults      jsonb;
  v_max_week      int;
  v_today         date := current_date;
  v_shifts_total  int  := 0;
  v_easy          int  := 0;
  v_rule_break    int  := 0;
  v_no_cover      int  := 0;
  v_status        text;
  v_shift_hours   numeric;
  v_service       public.service_types;
  v_has_easy      boolean;
  v_has_relaxed   boolean;
  v_days          jsonb;
  r               record;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_req
    from public.time_off_requests
   where id = p_request_id and dsp_id = v_dsp;
  if v_req.id is null then
    return null;
  end if;

  v_defaults := private.cover_dsp_defaults(v_dsp);
  v_max_week := coalesce((v_defaults->>'max_hours_per_week')::int, 40);

  for r in
    select s.id, s.date, s.starts_at, s.ends_at,
           s.station_id, s.route_code, s.block_hours, s.service_type_id
      from public.shifts s
     where s.driver_id = v_req.driver_id
       and s.dsp_id    = v_dsp
       and s.status    in ('scheduled', 'completed')
       and s.date      between v_req.start_date and v_req.end_date
       and s.date      >= v_today
     order by s.date, s.starts_at
  loop
    v_shifts_total := v_shifts_total + 1;
    v_shift_hours  := coalesce(r.block_hours, 10)::numeric;
    v_service      := null;
    if r.service_type_id is not null then
      select * into v_service
        from public.service_types
       where id = r.service_type_id;
    end if;

    select
      exists (
        select 1
          from public.drivers d
         where d.dsp_id   = v_dsp
           and d.id       <> v_req.driver_id
           and d.status   = 'active'
           and (d.dl_expires_on is null or d.dl_expires_on >= r.date)
           and (v_service.id is null or v_service.requires_dot is not true or coalesce(d.dot_certified, false))
           and (v_service.id is null or v_service.requires_xl  is not true or coalesce(d.xl_certified, false))
           and not exists (
             select 1 from public.shifts s2
              where s2.driver_id = d.id
                and s2.dsp_id    = v_dsp
                and s2.date      = r.date
                and s2.status   in ('scheduled', 'completed', 'late')
           )
           and not exists (
             select 1 from public.time_off_requests t
              where t.driver_id  = d.id
                and t.status     = 'approved'
                and r.date between t.start_date and t.end_date
           )
           and (private.cover_driver_week_hours(d.id, r.date, null) + v_shift_hours) <= v_max_week
      ),
      exists (
        select 1
          from public.drivers d
         where d.dsp_id   = v_dsp
           and d.id       <> v_req.driver_id
           and d.status   = 'active'
           and (d.dl_expires_on is null or d.dl_expires_on >= r.date)
           and (v_service.id is null or v_service.requires_dot is not true or coalesce(d.dot_certified, false))
           and (v_service.id is null or v_service.requires_xl  is not true or coalesce(d.xl_certified, false))
           and not exists (
             select 1 from public.shifts s2
              where s2.driver_id = d.id
                and s2.dsp_id    = v_dsp
                and s2.date      = r.date
                and s2.status   in ('scheduled', 'completed', 'late')
           )
           and not exists (
             select 1 from public.time_off_requests t
              where t.driver_id  = d.id
                and t.status     = 'approved'
                and r.date between t.start_date and t.end_date
           )
      )
    into v_has_easy, v_has_relaxed;

    if v_has_easy then
      v_easy := v_easy + 1;
    elsif v_has_relaxed then
      v_rule_break := v_rule_break + 1;
    else
      v_no_cover := v_no_cover + 1;
    end if;
  end loop;

  if v_shifts_total = 0 then
    v_status := 'no_shifts';
  elsif v_no_cover > 0 then
    v_status := 'no_coverage';
  elsif v_rule_break > 0 then
    v_status := 'rule_break';
  else
    v_status := 'covered';
  end if;

  -- Per-day coverage telemetry across the request range (today onward).
  -- needed / filled count route-staffing shifts only; the requesting
  -- driver's own route shift is what would be freed on approval.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'date',         to_char(d.date, 'YYYY-MM-DD'),
             'needed',       d.needed,
             'filled',       d.filled,
             'driver_on',    d.driver_on,
             'filled_after', case when d.driver_on
                                  then greatest(d.filled - 1, 0)
                                  else d.filled end
           )
           order by d.date
         ), '[]'::jsonb)
    into v_days
    from (
      select
        gs::date as date,
        cov.needed,
        cov.filled,
        cov.driver_on
      from generate_series(
             greatest(v_req.start_date, v_today),
             v_req.end_date,
             interval '1 day'
           ) gs
      cross join lateral (
        select
          count(*) filter (
            where s.shift_kind is null
               or s.shift_kind not in ('training', 'ride_along')
          ) as needed,
          count(*) filter (
            where (s.shift_kind is null
               or s.shift_kind not in ('training', 'ride_along'))
              and s.driver_id is not null
          ) as filled,
          coalesce(bool_or(
            s.driver_id = v_req.driver_id
            and (s.shift_kind is null
                 or s.shift_kind not in ('training', 'ride_along'))
          ), false) as driver_on
        from public.shifts s
        where s.dsp_id  = v_dsp
          and s.date    = gs::date
          and s.status in ('scheduled', 'completed')
      ) cov
    ) d;

  return jsonb_build_object(
    'status',          v_status,
    'shifts_total',    v_shifts_total,
    'covered_easy',    v_easy,
    'rule_break',      v_rule_break,
    'no_coverage',     v_no_cover,
    'max_hours_per_week', v_max_week,
    'days',            v_days
  );
end;
$$;
grant execute on function public.dispatch_time_off_coverage(uuid) to authenticated;

notify pgrst, 'reload schema';
