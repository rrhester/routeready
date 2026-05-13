-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0199 · Configurable WOC (working-hours compliance)
--
-- Pulls the three working-hours compliance constants — max hours per
-- week, max consecutive days, min rest hours — out of hardcoded values
-- baked into Smart Fill and into per-DSP config on
-- dsps.metadata.scheduling. The Cover-shift candidates RPC reads the
-- same source so a driver who'd violate any of the three is excluded
-- from the ranking (overtime stays a soft signal — see migration 0198).
--
-- Defaults match the prior hardcoded values: 55h / 6d / 10h.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. get_woc_settings ────────────────────────────────────────────────
-- Returns the current effective WOC settings for the caller's DSP.
-- Falls back to {55, 6, 10} when the keys aren't set.
create or replace function public.get_woc_settings()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_m   jsonb;
begin
  if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(metadata->'scheduling', '{}'::jsonb) into v_m
    from public.dsps where id = v_dsp;
  return jsonb_build_object(
    'max_hours_per_week',   coalesce((v_m->>'max_hours_per_week')::int,  55),
    'max_consecutive_days', coalesce((v_m->>'max_consecutive_days')::int, 6),
    'min_rest_hours',       coalesce((v_m->>'min_rest_hours')::int,      10)
  );
end;
$$;
grant execute on function public.get_woc_settings() to authenticated;


-- ── 2. set_woc_settings ────────────────────────────────────────────────
-- Dispatcher-level write. Null inputs leave the existing key unchanged.
-- Sanity bounds (1..168h per week, 1..14 consecutive days, 0..24h rest)
-- guard against typos that would make Cover impossible.
create or replace function public.set_woc_settings(
  p_max_hours_per_week    int default null,
  p_max_consecutive_days  int default null,
  p_min_rest_hours        int default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_m   jsonb;
begin
  if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_max_hours_per_week is not null
     and (p_max_hours_per_week < 1 or p_max_hours_per_week > 168) then
    raise exception 'max_hours_per_week_out_of_range' using errcode = '22023';
  end if;
  if p_max_consecutive_days is not null
     and (p_max_consecutive_days < 1 or p_max_consecutive_days > 14) then
    raise exception 'max_consecutive_days_out_of_range' using errcode = '22023';
  end if;
  if p_min_rest_hours is not null
     and (p_min_rest_hours < 0 or p_min_rest_hours > 24) then
    raise exception 'min_rest_hours_out_of_range' using errcode = '22023';
  end if;

  update public.dsps
     set metadata = jsonb_set(
       jsonb_set(
         jsonb_set(
           coalesce(metadata, '{}'::jsonb)
             #- '{scheduling}' || jsonb_build_object('scheduling', coalesce(metadata->'scheduling', '{}'::jsonb)),
           '{scheduling,max_hours_per_week}',
           to_jsonb(coalesce(p_max_hours_per_week, (metadata->'scheduling'->>'max_hours_per_week')::int, 55)),
           true),
         '{scheduling,max_consecutive_days}',
         to_jsonb(coalesce(p_max_consecutive_days, (metadata->'scheduling'->>'max_consecutive_days')::int, 6)),
         true),
       '{scheduling,min_rest_hours}',
       to_jsonb(coalesce(p_min_rest_hours, (metadata->'scheduling'->>'min_rest_hours')::int, 10)),
       true)
   where id = v_dsp;

  select coalesce(metadata->'scheduling', '{}'::jsonb) into v_m
    from public.dsps where id = v_dsp;
  return jsonb_build_object(
    'max_hours_per_week',   (v_m->>'max_hours_per_week')::int,
    'max_consecutive_days', (v_m->>'max_consecutive_days')::int,
    'min_rest_hours',       (v_m->>'min_rest_hours')::int
  );
end;
$$;
grant execute on function public.set_woc_settings(int, int, int) to authenticated;


-- ── 3. Extend the Cover-candidates RPC with consecutive-days + rest ───
-- Reuses everything from migration 0198. Drivers who'd violate
-- max_consecutive_days (sliding window centered on the shift date) or
-- min_rest_hours (gap to the adjacent shift on either side) join the
-- license / cert / PTO / double-book / hour-cap exclusions: gone from
-- the ranking entirely.
create or replace function public.cover_shift_candidates(
  p_shift_id uuid,
  p_limit    int default 3
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp           uuid := private.current_dsp_id();
  v_shift         public.shifts;
  v_defaults      jsonb;
  v_threshold     int;
  v_max_week      int;
  v_max_cons_days int;
  v_min_rest_hrs  int;
  v_default_rate  numeric;
  v_default_mult  numeric;
  v_shift_hours   numeric;
  v_service       public.service_types;
  v_results       jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_shift from public.shifts where id = p_shift_id and dsp_id = v_dsp;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;
  if v_shift.date <= current_date then
    raise exception 'cover_future_only' using errcode = 'P0001';
  end if;

  v_defaults     := private.cover_dsp_defaults(v_dsp);
  v_threshold    := (v_defaults->>'overtime_threshold_hours')::int;
  v_max_week     := (v_defaults->>'max_hours_per_week')::int;
  v_default_rate := (v_defaults->>'default_hourly_rate')::numeric;
  v_default_mult := (v_defaults->>'default_ot_multiplier')::numeric;
  v_shift_hours  := coalesce(v_shift.block_hours, 10)::numeric;

  -- WOC settings (per-DSP, configurable). Defaults match the prior
  -- hardcoded constants so existing deployments behave identically
  -- until an owner tweaks them.
  select coalesce((m->>'max_consecutive_days')::int, 6),
         coalesce((m->>'min_rest_hours')::int, 10)
    into v_max_cons_days, v_min_rest_hrs
  from (select coalesce(d.metadata->'scheduling', '{}'::jsonb) as m
        from public.dsps d where d.id = v_dsp) s;

  if v_shift.service_type_id is not null then
    select * into v_service from public.service_types where id = v_shift.service_type_id;
  end if;

  with eligible as (
    select
      d.id,
      d.full_name,
      d.preferred_name,
      d.first_name, d.last_name,
      d.tier,
      d.score,
      d.dl_expires_on,
      coalesce(d.hourly_rate, v_default_rate)         as rate,
      coalesce(d.overtime_multiplier, v_default_mult) as mult,
      private.cover_driver_week_hours(d.id, v_shift.date, p_shift_id) as cur_hours
    from public.drivers d
    where d.dsp_id = v_dsp
      and d.status = 'active'
      and (d.dl_expires_on is null or d.dl_expires_on >= v_shift.date)
      and (v_service.id is null or v_service.requires_dot is not true or coalesce(d.dot_certified, false))
      and (v_service.id is null or v_service.requires_xl  is not true or coalesce(d.xl_certified, false))
      and not exists (
        select 1 from public.shifts s2
        where s2.driver_id = d.id
          and s2.dsp_id    = v_dsp
          and s2.date      = v_shift.date
          and s2.id       <> p_shift_id
          and s2.status in ('scheduled','completed','late')
      )
      and not exists (
        select 1 from public.time_off_requests t
        where t.driver_id  = d.id
          and t.status     = 'approved'
          and v_shift.date between t.start_date and t.end_date
      )
      -- Max consecutive days. Counts the longest run of consecutive
      -- scheduled days inside a sliding window of (max_cons_days + 1)
      -- around the target date that includes our hypothetical add.
      and not exists (
        select 1
        from (
          -- Generate the candidate date set: the driver's actual
          -- shifts in the window plus the hypothetical new date.
          select gs::date as d
          from generate_series(
            v_shift.date - make_interval(days => v_max_cons_days),
            v_shift.date + make_interval(days => v_max_cons_days),
            interval '1 day'
          ) gs
          where exists (
            select 1 from public.shifts s3
            where s3.driver_id = d.id
              and s3.dsp_id    = v_dsp
              and s3.date      = gs::date
              and s3.status in ('scheduled','completed','late')
              and s3.id       <> p_shift_id
          )
          union
          select v_shift.date
        ) days
        -- Look for max_cons_days+1 consecutive dates including the
        -- new one. Use a window function to detect runs.
        group by ()
        having (
          select max(run_len) from (
            select count(*) as run_len
            from (
              select d, d - (row_number() over (order by d))::int * interval '1 day' as grp
              from days
            ) g
            group by grp
          ) r
        ) > v_max_cons_days
      )
      -- Min rest hours. Compare to the driver's adjacent shift
      -- start/end times. We treat shifts without explicit times as
      -- non-overlapping (cur_hours weekly check covers their load).
      and not exists (
        select 1 from public.shifts s4
        where s4.driver_id = d.id
          and s4.dsp_id    = v_dsp
          and s4.id       <> p_shift_id
          and s4.status in ('scheduled','completed','late')
          and s4.starts_at is not null and s4.ends_at is not null
          and v_shift.starts_at is not null and v_shift.ends_at is not null
          and (
            -- New shift starts too soon after this one ends:
            (s4.ends_at <= v_shift.starts_at
             and extract(epoch from (v_shift.starts_at - s4.ends_at)) / 3600.0 < v_min_rest_hrs)
            or
            -- New shift ends too soon before this one starts:
            (v_shift.ends_at <= s4.starts_at
             and extract(epoch from (s4.starts_at - v_shift.ends_at)) / 3600.0 < v_min_rest_hrs)
          )
      )
  ),
  scored as (
    select
      e.*,
      (e.cur_hours + v_shift_hours) as projected_hours,
      greatest(
        (e.cur_hours + v_shift_hours)
          - greatest(v_threshold::numeric, e.cur_hours),
        0
      )::numeric as projected_ot_hours
    from eligible e
  )
  select coalesce(jsonb_agg(row_to_json(c)::jsonb order by
                              c.projected_ot_hours asc,
                              c.cur_hours asc,
                              c.driver_name asc), '[]'::jsonb)
    into v_results
  from (
    select
      s.id                                            as driver_id,
      coalesce(nullif(trim(s.preferred_name),''),
               nullif(trim(s.full_name),''),
               trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')))
                                                       as driver_name,
      s.tier,
      s.score,
      s.dl_expires_on,
      round(s.cur_hours, 2)            as current_week_hours,
      round(s.projected_hours, 2)      as projected_total_hours,
      round(s.projected_ot_hours, 2)   as projected_ot_hours,
      case when s.rate is null or s.projected_ot_hours = 0 then null
           else round(s.projected_ot_hours * s.rate * (s.mult - 1), 2)
      end                              as projected_ot_premium,
      (s.projected_hours > v_max_week) as exceeds_weekly_cap
    from scored s
    where s.projected_hours <= v_max_week
    limit greatest(p_limit, 1)
  ) c;

  return jsonb_build_object(
    'shift', jsonb_build_object(
      'id',               v_shift.id,
      'date',             v_shift.date,
      'starts_at',        v_shift.starts_at,
      'ends_at',          v_shift.ends_at,
      'route_code',       v_shift.route_code,
      'station_id',       v_shift.station_id,
      'wave_index',       v_shift.wave_index,
      'block_hours',      v_shift.block_hours,
      'service_type_id',  v_shift.service_type_id
    ),
    'defaults', v_defaults,
    'woc',      jsonb_build_object(
      'max_hours_per_week',   v_max_week,
      'max_consecutive_days', v_max_cons_days,
      'min_rest_hours',       v_min_rest_hrs
    ),
    'candidates', v_results
  );
end;
$$;
grant execute on function public.cover_shift_candidates(uuid, int) to authenticated;

notify pgrst, 'reload schema';
