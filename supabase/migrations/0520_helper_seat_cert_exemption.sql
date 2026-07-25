-- ── 0520 · Helper seats are exempt from the server-side cert gates ─────────
--
-- Root cause of "Smart Fill assigns nobody to XL helper seats" (operator
-- run report 2026-07-19: "server compliance check refused 7: route requires
-- XL certification, not on file").
--
-- 0518 taught the CP-SAT solver + preview engine that a shift_kind='helper'
-- seat on an XL route needs NO certification (only the driver seat does),
-- and the solver correctly assigns uncertified drivers to helper seats. But
-- THREE server-side gates still enforced "service type requires_xl → driver
-- must be xl_certified" with no helper awareness, so:
--   • public.assign_shift (the Smart Fill / dispatcher write path) ROLLED
--     BACK every helper-seat assignment via private.staff_assign_violations
--     (0500) — this is the exact refusal in the operator's run report;
--   • private.driver_can_take_shift (0201) blocked driver self-serve pickup
--     of an open helper seat;
--   • private.driver_can_take_shift_after_swap (0423) blocked accepting a
--     helper seat in a swap.
--
-- Fix: re-issue all three functions verbatim from their latest revisions
-- (0500 / 0201 / 0423) with ONE change each — the DOT/XL cert block is
-- skipped when the shift's kind is 'helper'. The comparison casts the enum
-- to text (shift_kind::text <> 'helper') so this migration is safe to run
-- even before 0518 added the enum value. Every other rule (status, DL, PTO,
-- double-book, hour caps, rest, consecutive days) still applies to helper
-- seats — only the certification requirement is lifted.
--
-- Idempotent: create or replace throughout; enum re-assert guarded.

-- Re-assert the 'helper' shift_kind (no-op when 0518/0519 already ran).
alter type public.shift_kind add value if not exists 'helper';

-- ── 1. staff_assign_violations (dispatcher / Smart Fill writes) ──────────
-- Verbatim from 0500 except the cert block skips helper seats.
create or replace function private.staff_assign_violations(
  p_shift_id  uuid,
  p_driver_id uuid
) returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_drv      public.drivers;
  v_shift    public.shifts;
  v_service  public.service_types;
  v_woc      jsonb;
  v_max_week int;
  v_max_cons int;
  v_min_rest int;
  v_hours    numeric;
  v_block    numeric;
  v_run      int;
  v_out      text[] := '{}';
begin
  select * into v_drv from public.drivers where id = p_driver_id;
  if v_drv.id is null then
    return array['driver not found'];
  end if;

  select * into v_shift from public.shifts where id = p_shift_id;
  if v_shift.id is null or v_shift.dsp_id <> v_drv.dsp_id then
    return array['shift not found for this DSP'];
  end if;

  if v_drv.status <> 'active' then
    v_out := array_append(v_out,
      'driver status is ' || v_drv.status || ', not active');
  end if;

  if v_drv.dl_expires_on is not null and v_drv.dl_expires_on < v_shift.date then
    v_out := array_append(v_out,
      'driver''s license expires ' || v_drv.dl_expires_on || ', before the shift date');
  end if;

  -- Service-type certs. A 'helper' seat is the ride-along body on an XL
  -- route — it carries the XL service type for grouping but needs NO
  -- certification (0518), so the cert block is skipped for it.
  if v_shift.service_type_id is not null
     and coalesce(v_shift.shift_kind::text, 'regular') <> 'helper' then
    select * into v_service from public.service_types
     where id = v_shift.service_type_id;
    if coalesce(v_service.requires_dot, false)
       and not coalesce(v_drv.dot_certified, false) then
      v_out := array_append(v_out, 'route requires DOT certification, not on file');
    end if;
    if coalesce(v_service.requires_xl, false)
       and not coalesce(v_drv.xl_certified, false) then
      v_out := array_append(v_out, 'route requires XL certification, not on file');
    end if;
  end if;

  if exists (
    select 1 from public.time_off_requests t
    where t.driver_id = p_driver_id
      and t.status    = 'approved'
      and v_shift.date between t.start_date and t.end_date
  ) then
    v_out := array_append(v_out,
      'driver has approved time off covering ' || v_shift.date::text);
  end if;

  select coalesce(metadata->'scheduling', '{}'::jsonb) into v_woc
    from public.dsps where id = v_drv.dsp_id;
  v_max_week := coalesce((v_woc->>'max_hours_per_week')::int,  55);
  v_max_cons := coalesce((v_woc->>'max_consecutive_days')::int, 6);
  v_min_rest := coalesce((v_woc->>'min_rest_hours')::int,      10);
  v_block    := coalesce(v_shift.block_hours, 10)::numeric;

  v_hours := private.cover_driver_week_hours(p_driver_id, v_shift.date, p_shift_id);
  if (v_hours + v_block) > v_max_week then
    v_out := array_append(v_out,
      'would put driver at ' || round(v_hours + v_block) ||
      'h this week, over the ' || v_max_week || 'h cap');
  end if;

  if v_shift.starts_at is not null and v_shift.ends_at is not null
     and exists (
       select 1 from public.shifts s4
       where s4.driver_id = p_driver_id and s4.dsp_id = v_drv.dsp_id
         and s4.id <> p_shift_id and s4.status in ('scheduled','completed','late')
         and s4.starts_at is not null and s4.ends_at is not null
         and (
           (s4.ends_at <= v_shift.starts_at
            and extract(epoch from (v_shift.starts_at - s4.ends_at)) / 3600.0 < v_min_rest)
           or
           (v_shift.ends_at <= s4.starts_at
            and extract(epoch from (s4.starts_at - v_shift.ends_at)) / 3600.0 < v_min_rest)
         )
     ) then
    v_out := array_append(v_out,
      'less than ' || v_min_rest || 'h rest from an adjacent shift');
  end if;

  select max(run_len) into v_run from (
    select count(*) as run_len
    from (
      select d::date as d,
             d::date - (row_number() over (order by d::date))::int as grp
      from (
        select generate_series as d
        from generate_series(
          v_shift.date - make_interval(days => v_max_cons),
          v_shift.date + make_interval(days => v_max_cons),
          interval '1 day'
        )
        where exists (
          select 1 from public.shifts s5
          where s5.driver_id = p_driver_id and s5.dsp_id = v_drv.dsp_id
            and s5.date = generate_series::date
            and s5.id <> p_shift_id
            and s5.status in ('scheduled','completed','late')
        ) or generate_series::date = v_shift.date
      ) d
    ) g
    group by grp
  ) r;
  if coalesce(v_run, 0) > v_max_cons then
    v_out := array_append(v_out,
      'would put driver on ' || v_run || ' consecutive days, over the cap of ' || v_max_cons);
  end if;

  return v_out;
end;
$$;

-- ── 2. driver_can_take_shift (driver self-serve pickup) ──────────────────
-- Verbatim from 0201 except the cert block skips helper seats.
create or replace function private.driver_can_take_shift(
  p_driver_id uuid,
  p_shift_id  uuid
) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_drv      public.drivers;
  v_shift    public.shifts;
  v_service  public.service_types;
  v_woc      jsonb;
  v_max_week int;
  v_max_cons int;
  v_min_rest int;
  v_hours    numeric;
  v_run      int;
  v_block    numeric;
begin
  select * into v_drv from public.drivers where id = p_driver_id;
  if v_drv.id is null or v_drv.status <> 'active' then return false; end if;

  select * into v_shift from public.shifts where id = p_shift_id;
  if v_shift.id is null or v_shift.dsp_id <> v_drv.dsp_id then return false; end if;
  if v_shift.driver_id is not null then return false; end if;
  if v_shift.date <= current_date then return false; end if;

  -- DL valid
  if v_drv.dl_expires_on is not null and v_drv.dl_expires_on < v_shift.date then return false; end if;

  -- Service-type certs (helper seats need none — 0518/0520)
  if v_shift.service_type_id is not null
     and coalesce(v_shift.shift_kind::text, 'regular') <> 'helper' then
    select * into v_service from public.service_types where id = v_shift.service_type_id;
    if v_service.requires_dot and not coalesce(v_drv.dot_certified, false) then return false; end if;
    if v_service.requires_xl  and not coalesce(v_drv.xl_certified,  false) then return false; end if;
  end if;

  -- No double-book
  if exists (
    select 1 from public.shifts s
    where s.driver_id = p_driver_id
      and s.dsp_id    = v_drv.dsp_id
      and s.date      = v_shift.date
      and s.id       <> p_shift_id
      and s.status in ('scheduled','completed','late')
  ) then return false; end if;

  -- No approved PTO overlap
  if exists (
    select 1 from public.time_off_requests t
    where t.driver_id  = p_driver_id
      and t.status     = 'approved'
      and v_shift.date between t.start_date and t.end_date
  ) then return false; end if;

  -- WOC caps
  select coalesce(metadata->'scheduling', '{}'::jsonb) into v_woc
    from public.dsps where id = v_drv.dsp_id;
  v_max_week := coalesce((v_woc->>'max_hours_per_week')::int,  55);
  v_max_cons := coalesce((v_woc->>'max_consecutive_days')::int, 6);
  v_min_rest := coalesce((v_woc->>'min_rest_hours')::int,      10);
  v_block    := coalesce(v_shift.block_hours, 10)::numeric;

  v_hours := private.cover_driver_week_hours(p_driver_id, v_shift.date, p_shift_id);
  if (v_hours + v_block) > v_max_week then return false; end if;

  -- Min rest hours (only when both ends are timed)
  if v_shift.starts_at is not null and v_shift.ends_at is not null
     and exists (
       select 1 from public.shifts s4
       where s4.driver_id = p_driver_id and s4.dsp_id = v_drv.dsp_id
         and s4.id <> p_shift_id and s4.status in ('scheduled','completed','late')
         and s4.starts_at is not null and s4.ends_at is not null
         and (
           (s4.ends_at <= v_shift.starts_at
            and extract(epoch from (v_shift.starts_at - s4.ends_at)) / 3600.0 < v_min_rest)
           or
           (v_shift.ends_at <= s4.starts_at
            and extract(epoch from (s4.starts_at - v_shift.ends_at)) / 3600.0 < v_min_rest)
         )
     ) then return false; end if;

  -- Max consecutive days (sliding window around v_shift.date)
  select max(run_len) into v_run from (
    select count(*) as run_len
    from (
      select d::date as d, d::date - (row_number() over (order by d::date))::int as grp
      from (
        select generate_series as d
        from generate_series(
          v_shift.date - make_interval(days => v_max_cons),
          v_shift.date + make_interval(days => v_max_cons),
          interval '1 day'
        )
        where exists (
          select 1 from public.shifts s5
          where s5.driver_id = p_driver_id and s5.dsp_id = v_drv.dsp_id
            and s5.date = generate_series::date
            and s5.id <> p_shift_id
            and s5.status in ('scheduled','completed','late')
        ) or generate_series::date = v_shift.date
      ) d
    ) g
    group by grp
  ) r;
  if coalesce(v_run, 0) > v_max_cons then return false; end if;

  return true;
end;
$$;

-- ── 3. driver_can_take_shift_after_swap (swap acceptance) ────────────────
-- Verbatim from 0423 except the cert block skips helper seats.
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

  -- Service-type certs required by the taken shift (helper seats need
  -- none — 0518/0520)
  if v_take.service_type_id is not null
     and coalesce(v_take.shift_kind::text, 'regular') <> 'helper' then
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

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0520_helper_seat_cert_exemption.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
