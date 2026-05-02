-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510120000 · Phase 3 RPCs
-- High-level operations for schedule + swap + time-off + OKAMI.
-- These are the "verbs" the frontend calls. All security-definer with
-- explicit DSP-scope checks so they can perform multi-table writes safely.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── assign_shift: dispatcher assigns a driver to a route+date ──────────

create or replace function public.assign_shift(
  p_driver_id  uuid,
  p_route_id   uuid,
  p_shift_date date,
  p_start_at   timestamptz default null,
  p_end_at     timestamptz default null,
  p_notes      text        default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_caller  uuid := auth.uid();
  v_station uuid;
  v_id      uuid;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'assign_shift: caller is not staff';
  end if;

  -- Driver belongs to this DSP and is assignable
  perform 1
    from public.drivers
   where id = p_driver_id and dsp_id = v_dsp
     and status in ('active','onboarding');
  if not found then
    raise exception 'assign_shift: driver % not assignable in DSP %', p_driver_id, v_dsp;
  end if;

  -- Route belongs to this DSP
  select station_id into v_station
    from public.routes
   where id = p_route_id and dsp_id = v_dsp and active = true;
  if not found then
    raise exception 'assign_shift: route % not active in DSP %', p_route_id, v_dsp;
  end if;

  insert into public.shifts
    (dsp_id, station_id, driver_id, route_id, shift_date,
     start_at, end_at, status, notes, published, created_by)
  values
    (v_dsp, v_station, p_driver_id, p_route_id, p_shift_date,
     p_start_at, p_end_at, 'scheduled'::public.shift_status,
     p_notes, false, v_caller)
  returning id into v_id;

  return v_id;
exception
  when exclusion_violation then
    raise exception 'assign_shift: driver % already has a shift on %', p_driver_id, p_shift_date;
end $$;

revoke execute on function public.assign_shift(uuid, uuid, date, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.assign_shift(uuid, uuid, date, timestamptz, timestamptz, text) to authenticated;

-- ─── unassign_shift: remove driver, flip to open ────────────────────────

create or replace function public.unassign_shift(p_shift_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'unassign_shift: caller is not staff';
  end if;

  update public.shifts
     set driver_id = null,
         status = 'open',
         swap_request_id = null
   where id = p_shift_id and dsp_id = v_dsp;

  if not found then
    raise exception 'unassign_shift: shift % not in DSP %', p_shift_id, v_dsp;
  end if;
end $$;

revoke execute on function public.unassign_shift(uuid) from public, anon;
grant execute on function public.unassign_shift(uuid) to authenticated;

-- ─── publish_week: lifecycle Draft → Posted ─────────────────────────────

create or replace function public.publish_week(p_week_start date)
returns int
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_count int;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'publish_week: caller is not ops staff';
  end if;

  with upd as (
    update public.shifts
       set published = true
     where dsp_id = v_dsp
       and shift_date >= p_week_start
       and shift_date <  p_week_start + 7
       and published = false
    returning 1
  )
  select count(*) into v_count from upd;

  return v_count;
end $$;

revoke execute on function public.publish_week(date) from public, anon;
grant execute on function public.publish_week(date) to authenticated;

-- ─── request_swap: driver creates a swap request ────────────────────────

create or replace function public.request_swap(
  p_shift_id    uuid,
  p_to_driver   uuid default null,        -- null = open marketplace
  p_reason      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp           uuid := private.current_dsp_id();
  v_caller_driver uuid := private.current_driver_id();
  v_role          text := private.current_role_claim();
  v_shift         public.shifts%rowtype;
  v_id            uuid;
begin
  if v_dsp is null then
    raise exception 'request_swap: not authenticated';
  end if;

  select * into v_shift
    from public.shifts
   where id = p_shift_id and dsp_id = v_dsp;
  if not found then
    raise exception 'request_swap: shift % not in DSP %', p_shift_id, v_dsp;
  end if;

  -- Authorization: either staff acting on driver's behalf, or the assigned
  -- driver requesting their own swap
  if not (
    private.is_staff(v_dsp, 'dispatcher')
    or (v_role = 'driver' and v_shift.driver_id = v_caller_driver)
  ) then
    raise exception 'request_swap: must be staff or the assigned driver';
  end if;

  if v_shift.driver_id is null then
    raise exception 'request_swap: shift has no assigned driver';
  end if;

  if v_shift.shift_date < current_date then
    raise exception 'request_swap: cannot swap past shifts';
  end if;

  -- Insert the request and mark the shift swap_pending
  insert into public.swap_requests
    (dsp_id, shift_id, from_driver_id, to_driver_id, reason, status)
  values
    (v_dsp, p_shift_id, v_shift.driver_id, p_to_driver,
     p_reason, 'pending')
  returning id into v_id;

  update public.shifts
     set status = 'swap_pending', swap_request_id = v_id
   where id = p_shift_id;

  return v_id;
exception
  when unique_violation then
    raise exception 'request_swap: shift % already has a pending swap', p_shift_id;
end $$;

revoke execute on function public.request_swap(uuid, uuid, text) from public, anon;
grant execute on function public.request_swap(uuid, uuid, text) to authenticated;

-- ─── decide_swap: ops approves or denies ────────────────────────────────

create or replace function public.decide_swap(
  p_swap_id uuid,
  p_approve boolean,
  p_notes   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_caller  uuid := auth.uid();
  v_swap    public.swap_requests%rowtype;
  v_target  uuid;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'decide_swap: caller is not ops staff';
  end if;

  select * into v_swap
    from public.swap_requests
   where id = p_swap_id and dsp_id = v_dsp;
  if not found then
    raise exception 'decide_swap: swap % not in DSP %', p_swap_id, v_dsp;
  end if;
  if v_swap.status <> 'pending' then
    raise exception 'decide_swap: swap is already %', v_swap.status;
  end if;

  -- For open marketplace swaps the target driver is selected at decide time
  -- via p_notes containing the to_driver_id, OR caller specifies via direct
  -- update of the swap row. Simplest: require to_driver_id to be set on
  -- the row before approval.
  if p_approve then
    if v_swap.to_driver_id is null then
      raise exception 'decide_swap: open swap must have to_driver_id set before approval';
    end if;

    select id into v_target
      from public.drivers
     where id = v_swap.to_driver_id
       and dsp_id = v_dsp
       and status in ('active','onboarding');
    if not found then
      raise exception 'decide_swap: target driver not assignable';
    end if;

    update public.shifts
       set driver_id = v_swap.to_driver_id,
           status    = 'scheduled',
           swap_request_id = null
     where id = v_swap.shift_id;
  else
    -- Denial: revert shift status
    update public.shifts
       set status = 'scheduled', swap_request_id = null
     where id = v_swap.shift_id and status = 'swap_pending';
  end if;

  update public.swap_requests
     set status         = case when p_approve then 'approved' else 'denied' end,
         decided_by     = v_caller,
         decided_at     = now(),
         decision_notes = p_notes
   where id = p_swap_id;

  return jsonb_build_object(
    'swap_id',  p_swap_id,
    'approved', p_approve,
    'shift_id', v_swap.shift_id,
    'message',  case when p_approve then 'Swap approved; shift reassigned'
                                    else 'Swap denied; shift restored' end
  );
end $$;

revoke execute on function public.decide_swap(uuid, boolean, text) from public, anon;
grant execute on function public.decide_swap(uuid, boolean, text) to authenticated;

-- ─── request_time_off / decide_time_off ─────────────────────────────────

create or replace function public.request_time_off(
  p_driver_id  uuid,
  p_start_date date,
  p_end_date   date,
  p_category   text,
  p_reason     text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp           uuid := private.current_dsp_id();
  v_caller_driver uuid := private.current_driver_id();
  v_role          text := private.current_role_claim();
  v_id            uuid;
begin
  if v_dsp is null then
    raise exception 'request_time_off: not authenticated';
  end if;

  -- Driver requesting on themselves, or staff requesting on driver's behalf
  if not (
    private.is_staff(v_dsp, 'ops')
    or (v_role = 'driver' and p_driver_id = v_caller_driver)
  ) then
    raise exception 'request_time_off: caller cannot request on this driver';
  end if;

  perform 1 from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if not found then
    raise exception 'request_time_off: driver % not in DSP %', p_driver_id, v_dsp;
  end if;

  insert into public.time_off_requests
    (dsp_id, driver_id, start_date, end_date, category, reason, status)
  values
    (v_dsp, p_driver_id, p_start_date, p_end_date, p_category, p_reason, 'pending')
  returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.request_time_off(uuid, date, date, text, text) from public, anon;
grant execute on function public.request_time_off(uuid, date, date, text, text) to authenticated;

create or replace function public.decide_time_off(
  p_request_id uuid,
  p_approve    boolean,
  p_notes      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_caller  uuid := auth.uid();
  v_req     public.time_off_requests%rowtype;
  v_shifts_flipped int;
  v_exempt_category text;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'decide_time_off: caller is not ops staff';
  end if;

  select * into v_req
    from public.time_off_requests
   where id = p_request_id and dsp_id = v_dsp;
  if not found then
    raise exception 'decide_time_off: request % not in DSP %', p_request_id, v_dsp;
  end if;
  if v_req.status <> 'pending' then
    raise exception 'decide_time_off: request is already %', v_req.status;
  end if;

  update public.time_off_requests
     set status         = case when p_approve then 'approved' else 'denied' end,
         decided_by     = v_caller,
         decided_at     = now(),
         decision_notes = p_notes
   where id = p_request_id;

  v_shifts_flipped := 0;
  if p_approve then
    -- Flip matching future shifts to 'timeoff' (clears driver_id so they
    -- become open). The check-in flow auto-skips drivers with a status
    -- other than 'active'/'onboarding'.
    with upd as (
      update public.shifts
         set status = 'timeoff'
       where dsp_id = v_dsp
         and driver_id = v_req.driver_id
         and shift_date >= v_req.start_date
         and shift_date <= v_req.end_date
         and status in ('scheduled','swap_pending')
      returning 1
    )
    select count(*) into v_shifts_flipped from upd;

    -- Map TOR category → attendance exempt category, for any callout/no-show
    -- that landed in the date range. Auto-mark them exempt.
    v_exempt_category := case v_req.category
      when 'pto'              then 'Approved PTO'
      when 'jury'             then 'Jury duty'
      when 'bereavement'      then 'Bereavement'
      when 'fmla'             then 'FMLA'
      when 'workplace_injury' then 'Workplace injury'
      when 'sick'             then 'Approved PTO'
      else null
    end;

    if v_exempt_category is not null then
      update public.attendance_events
         set exempt = true,
             exempt_category = v_exempt_category,
             notes = coalesce(notes, '') ||
                     case when notes is null or notes = '' then '' else ' · ' end ||
                     'Auto-exempted by approved time-off request'
       where dsp_id = v_dsp
         and driver_id = v_req.driver_id
         and event_date >= v_req.start_date
         and event_date <= v_req.end_date
         and exempt = false;
    end if;
  end if;

  return jsonb_build_object(
    'request_id', p_request_id,
    'approved',   p_approve,
    'shifts_flipped_to_timeoff', v_shifts_flipped,
    'exempt_category_applied',   v_exempt_category
  );
end $$;

revoke execute on function public.decide_time_off(uuid, boolean, text) from public, anon;
grant execute on function public.decide_time_off(uuid, boolean, text) to authenticated;

-- ─── set_okami_week: upsert daily targets and cushion ───────────────────

create or replace function public.set_okami_week(
  p_iso_year      int,
  p_iso_week      int,
  p_week_start    date,
  p_routes_max    int,
  p_daily_targets jsonb default '{}'::jsonb,
  p_cushion_mode  text  default 'percent',
  p_cushion_value numeric default 10,
  p_dpr           numeric default null,
  p_adw           numeric default null,
  p_ot_hours      int    default null,
  p_is_hve        boolean default false,
  p_is_peak       boolean default false,
  p_station_id    uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp    uuid := private.current_dsp_id();
  v_caller uuid := auth.uid();
  v_id     uuid;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'set_okami_week: caller is not ops staff';
  end if;

  insert into public.okami_weeks
    (dsp_id, station_id, iso_year, iso_week, week_start,
     routes_max, daily_targets, cushion_mode, cushion_value,
     dpr, adw, ot_hours, is_hve, is_peak, updated_by)
  values
    (v_dsp, p_station_id, p_iso_year, p_iso_week, p_week_start,
     p_routes_max, p_daily_targets, p_cushion_mode, p_cushion_value,
     coalesce(p_dpr, 2.0), coalesce(p_adw, 5.0), coalesce(p_ot_hours, 0),
     p_is_hve, p_is_peak, v_caller)
  on conflict (dsp_id, station_id, iso_year, iso_week)
  do update set
    week_start    = excluded.week_start,
    routes_max    = excluded.routes_max,
    daily_targets = excluded.daily_targets,
    cushion_mode  = excluded.cushion_mode,
    cushion_value = excluded.cushion_value,
    dpr           = coalesce(excluded.dpr, public.okami_weeks.dpr),
    adw           = coalesce(excluded.adw, public.okami_weeks.adw),
    ot_hours      = coalesce(excluded.ot_hours, public.okami_weeks.ot_hours),
    is_hve        = excluded.is_hve,
    is_peak       = excluded.is_peak,
    updated_by    = v_caller,
    updated_at    = now()
  returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.set_okami_week(int, int, date, int, jsonb, text, numeric, numeric, numeric, int, boolean, boolean, uuid) from public, anon;
grant execute on function public.set_okami_week(int, int, date, int, jsonb, text, numeric, numeric, numeric, int, boolean, boolean, uuid) to authenticated;

-- ─── release_future_shifts: helper for suspension cascade ───────────────

create or replace function public.release_future_shifts(p_driver_id uuid)
returns int
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_count   int;
begin
  -- Caller must be staff in the driver's DSP; we look up the driver to
  -- determine the DSP (works for both authenticated callers and the
  -- internal trigger which sets dsp_id claim).
  declare
    v_driver_dsp uuid;
  begin
    select dsp_id into v_driver_dsp from public.drivers where id = p_driver_id;
    if v_driver_dsp is null then
      raise exception 'release_future_shifts: driver % not found', p_driver_id;
    end if;
    if v_dsp is not null and v_dsp <> v_driver_dsp then
      raise exception 'release_future_shifts: driver % not in caller DSP', p_driver_id;
    end if;

    if v_dsp is not null and not private.is_staff(v_dsp, 'ops') then
      raise exception 'release_future_shifts: caller is not ops staff';
    end if;

    with upd as (
      update public.shifts
         set status = 'open',
             driver_id = null,
             swap_request_id = null,
             notes = coalesce(notes, '') ||
                     case when notes is null or notes = '' then '' else ' · ' end ||
                     'Released after driver suspension'
       where dsp_id = v_driver_dsp
         and driver_id = p_driver_id
         and shift_date >= current_date
         and status in ('scheduled','swap_pending','vto')
      returning 1
    )
    select count(*) into v_count from upd;
  end;

  return v_count;
end $$;

revoke execute on function public.release_future_shifts(uuid) from public, anon;
grant execute on function public.release_future_shifts(uuid) to authenticated;

comment on function public.release_future_shifts(uuid) is
  'Releases all future shifts for a driver to status=open. Called both ' ||
  'manually by ops and automatically by the suspension cascade trigger.';
