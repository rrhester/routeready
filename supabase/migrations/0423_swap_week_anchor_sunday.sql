-- 0423_swap_week_anchor_sunday.sql
-- Fix the weekly-hour-cap window in the swap compliance helper to use the
-- canonical Sunday-anchored week, matching Pickup and Cover.
--
-- 0422 introduced private.driver_can_take_shift_after_swap with an INLINE
-- weekly-hours sum (it needs to exclude BOTH swapped shifts, which
-- private.cover_driver_week_hours can't do — it excludes only one). That
-- inline sum used date_trunc('week', …), which Postgres anchors on
-- MONDAY. But migration 0276 moved the whole system to Sunday-anchored
-- weeks (Amazon DSP convention): private.week_start_for() returns the
-- Sunday-on-or-before, and private.cover_driver_week_hours() — used by the
-- Pickup (0201) and Cover (0198) hour-cap gates — was redefined to match.
--
-- With the Monday window, a driver who works e.g. Sun + Sat would have
-- those two days split across two different cap-weeks in the swap check
-- but counted together in the pickup check — so the swap gate could pass
-- (or fail) where the identical pickup would not. This realigns the swap
-- gate to Sunday so all three entry points agree.
--
-- Only the two window-bound lines change vs 0422. Idempotent: create or
-- replace.

create or replace function private.driver_can_take_shift_after_swap(
  p_driver_id     uuid,   -- the driver taking p_take_shift
  p_take_shift_id uuid,   -- the shift this driver would receive
  p_give_shift_id uuid    -- the shift this driver would give up in return
) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_drv      public.drivers;
  v_take     public.shifts;
  v_service  public.service_types;
  v_woc      jsonb;
  v_max_week int;
  v_max_cons int;
  v_min_rest int;
  v_hours    numeric;
  v_run      int;
begin
  select * into v_drv from public.drivers where id = p_driver_id;
  if v_drv.id is null or v_drv.status <> 'active' then return false; end if;

  select * into v_take from public.shifts where id = p_take_shift_id;
  if v_take.id is null or v_take.dsp_id <> v_drv.dsp_id then return false; end if;

  -- DL valid on the taken shift's date
  if v_drv.dl_expires_on is not null and v_drv.dl_expires_on < v_take.date then
    return false;
  end if;

  -- Service-type certs required by the taken shift
  if v_take.service_type_id is not null then
    select * into v_service from public.service_types where id = v_take.service_type_id;
    if v_service.requires_dot and not coalesce(v_drv.dot_certified, false) then return false; end if;
    if v_service.requires_xl  and not coalesce(v_drv.xl_certified,  false) then return false; end if;
  end if;

  -- No double-book on the taken shift's date (ignoring the two swapped shifts)
  if exists (
    select 1 from public.shifts s
    where s.driver_id = p_driver_id
      and s.dsp_id    = v_drv.dsp_id
      and s.date      = v_take.date
      and s.id       not in (p_take_shift_id, p_give_shift_id)
      and s.status    in ('scheduled','completed','late')
  ) then return false; end if;

  -- No approved PTO overlap on the taken shift's date
  if exists (
    select 1 from public.time_off_requests t
    where t.driver_id = p_driver_id
      and t.status    = 'approved'
      and v_take.date between t.start_date and t.end_date
  ) then return false; end if;

  -- WOC caps
  select coalesce(metadata->'scheduling', '{}'::jsonb) into v_woc
    from public.dsps where id = v_drv.dsp_id;
  v_max_week := coalesce((v_woc->>'max_hours_per_week')::int,  55);
  v_max_cons := coalesce((v_woc->>'max_consecutive_days')::int, 6);
  v_min_rest := coalesce((v_woc->>'min_rest_hours')::int,      10);

  -- Weekly hours in the TAKEN shift's week: driver's existing shifts that
  -- week, minus both swapped shifts, plus the taken shift's block hours.
  -- Week is Sunday-anchored via private.week_start_for (migration 0276),
  -- so this agrees with the Pickup / Cover hour-cap gate.
  v_hours := coalesce((
    select sum(coalesce(s.block_hours, 10))
    from public.shifts s
    where s.driver_id = p_driver_id
      and s.id       not in (p_take_shift_id, p_give_shift_id)
      and s.status    in ('scheduled','completed','late')
      and s.date >= private.week_start_for(v_take.date)
      and s.date <  private.week_start_for(v_take.date) + 7
  ), 0)::numeric;
  if (v_hours + coalesce(v_take.block_hours, 10)::numeric) > v_max_week then
    return false;
  end if;

  -- Min rest hours vs the driver's other shifts (only when both ends are timed)
  if v_take.starts_at is not null and v_take.ends_at is not null
     and exists (
       select 1 from public.shifts s4
       where s4.driver_id = p_driver_id and s4.dsp_id = v_drv.dsp_id
         and s4.id not in (p_take_shift_id, p_give_shift_id)
         and s4.status in ('scheduled','completed','late')
         and s4.starts_at is not null and s4.ends_at is not null
         and (
           (s4.ends_at <= v_take.starts_at
            and extract(epoch from (v_take.starts_at - s4.ends_at)) / 3600.0 < v_min_rest)
           or
           (v_take.ends_at <= s4.starts_at
            and extract(epoch from (s4.starts_at - v_take.ends_at)) / 3600.0 < v_min_rest)
         )
     ) then return false; end if;

  -- Max consecutive days (sliding window around the taken shift's date)
  select max(run_len) into v_run from (
    select count(*) as run_len
    from (
      select d::date as d, d::date - (row_number() over (order by d::date))::int as grp
      from (
        select generate_series as d
        from generate_series(
          v_take.date - make_interval(days => v_max_cons),
          v_take.date + make_interval(days => v_max_cons),
          interval '1 day'
        )
        where exists (
          select 1 from public.shifts s5
          where s5.driver_id = p_driver_id and s5.dsp_id = v_drv.dsp_id
            and s5.date = generate_series::date
            and s5.id not in (p_take_shift_id, p_give_shift_id)
            and s5.status in ('scheduled','completed','late')
        ) or generate_series::date = v_take.date
      ) d
    ) g
    group by grp
  ) r;
  if coalesce(v_run, 0) > v_max_cons then return false; end if;

  return true;
end;
$$;

notify pgrst, 'reload schema';
