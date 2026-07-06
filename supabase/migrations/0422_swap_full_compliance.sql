-- 0422_swap_full_compliance.sql
-- Route peer-to-peer shift swaps through the SAME hard-compliance gate
-- that Cover (0198) and Pickup (0201) already enforce.
--
-- Before this, driver_swap_respond (0203) only checked driver status +
-- driver's-license expiry, and its own comment deferred cert / PTO /
-- hour-cap / rest checks to "future iterations". That meant a driver
-- could SWAP into a shift they'd be BLOCKED from picking up — e.g. a DOT
-- route they aren't certified for, a 7th consecutive day, an over-cap
-- week, or a day they have approved PTO. This closes that gap.
--
-- private.driver_can_take_shift (0201) can't be reused directly for a
-- swap: it rejects any shift that already has a driver, and it has no way
-- to discount the shift the driver is GIVING UP. So we add a swap-aware
-- sibling, private.driver_can_take_shift_after_swap, that mirrors the
-- same gates but (a) evaluates an already-assigned "take" shift and
-- (b) excludes BOTH the taken shift and the given-up shift from every
-- count (double-book, weekly hours, min-rest, consecutive days).
--
-- Hour-cap / consecutive-day / week-boundary math intentionally mirrors
-- private.driver_can_take_shift and private.cover_driver_week_hours so
-- the three entry points (pickup / cover / swap) stay consistent.
--
-- Idempotent: create or replace.

-- ── 1. Swap-aware compliance gate ──
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
  v_hours := coalesce((
    select sum(coalesce(s.block_hours, 10))
    from public.shifts s
    where s.driver_id = p_driver_id
      and s.id       not in (p_take_shift_id, p_give_shift_id)
      and s.status    in ('scheduled','completed','late')
      and s.date >= date_trunc('week', v_take.date)::date
      and s.date <  (date_trunc('week', v_take.date) + interval '7 days')::date
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

-- ── 2. driver_swap_respond now enforces the full gate for BOTH drivers ──
create or replace function public.driver_swap_respond(
  p_token      text,
  p_request_id uuid,
  p_accept     boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drv         public.drivers;
  v_req         public.shift_swap_requests;
  v_my_shift    public.shifts;
  v_their_shift public.shifts;
  v_other_drv   public.drivers;
  v_block       text;
  v_eligible    boolean;
begin
  v_drv := private.driver_validate_token(p_token);

  select * into v_req from public.shift_swap_requests
   where id = p_request_id for update;
  if v_req.id is null or v_req.target_driver_id <> v_drv.id then
    raise exception 'swap_not_found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'swap_not_pending' using errcode = 'P0001';
  end if;
  if v_req.expires_at <= now() then
    update public.shift_swap_requests
       set status='expired', responded_at=now(), updated_at=now()
     where id = p_request_id;
    insert into public.shift_swaps_audit (swap_id, event, actor_driver_id)
    values (p_request_id, 'expired', v_drv.id);
    raise exception 'swap_expired' using errcode = 'P0001';
  end if;

  if not p_accept then
    update public.shift_swap_requests
       set status='declined', responded_at=now(), updated_at=now()
     where id = p_request_id;
    insert into public.shift_swaps_audit (swap_id, event, actor_driver_id)
    values (p_request_id, 'declined', v_drv.id);
    return jsonb_build_object('status','declined');
  end if;

  -- p_accept = true → attempt the swap.
  select * into v_my_shift    from public.shifts where id = v_req.target_shift_id    for update;
  select * into v_their_shift from public.shifts where id = v_req.requester_shift_id for update;
  if v_my_shift.id is null or v_their_shift.id is null then
    v_block := 'shift_missing';
  elsif v_my_shift.driver_id    <> v_drv.id then
    v_block := 'your_shift_changed';
  elsif v_their_shift.driver_id <> v_req.requester_driver_id then
    v_block := 'their_shift_changed';
  elsif v_my_shift.date    <= current_date or v_their_shift.date <= current_date then
    v_block := 'shift_in_past';
  end if;

  if v_block is null then
    -- Compliance: each driver must remain eligible against the shift they
    -- would receive, after accounting for the shift they give up. This
    -- runs the SAME hard gates as Cover / Pickup (status, DL, certs, PTO,
    -- double-book, weekly hour cap, min-rest, consecutive days) via
    -- private.driver_can_take_shift_after_swap — closing the old gap where
    -- a swap could pass gates a pickup of the same shift would fail.
    --
    -- Responder (v_drv) receives v_their_shift, gives up v_my_shift.
    -- Requester (v_other_drv) receives v_my_shift, gives up v_their_shift.
    select * into v_other_drv from public.drivers where id = v_req.requester_driver_id;

    v_eligible := (
          private.driver_can_take_shift_after_swap(v_drv.id,       v_their_shift.id, v_my_shift.id)
      and private.driver_can_take_shift_after_swap(v_other_drv.id, v_my_shift.id,    v_their_shift.id)
    );

    if not v_eligible then
      v_block := 'compliance_failed';
    end if;
  end if;

  -- Execute the swap if nothing blocked us. The two UPDATEs run in
  -- the same function-level transaction; any later RAISE would roll
  -- them both back automatically.
  if v_block is null then
    update public.shifts set driver_id = v_drv.id,                  updated_at = now()
     where id = v_their_shift.id;
    update public.shifts set driver_id = v_req.requester_driver_id, updated_at = now()
     where id = v_my_shift.id;
  end if;

  if v_block is not null then
    update public.shift_swap_requests
       set status='blocked', responded_at=now(), block_reason=v_block, updated_at=now()
     where id = p_request_id;
    insert into public.shift_swaps_audit (swap_id, event, actor_driver_id, metadata)
    values (p_request_id, 'blocked', v_drv.id,
            jsonb_build_object('reason', v_block));
    return jsonb_build_object('status','blocked','reason', v_block);
  end if;

  update public.shift_swap_requests
     set status='accepted', responded_at=now(), updated_at=now()
   where id = p_request_id;
  insert into public.shift_swaps_audit (swap_id, event, actor_driver_id)
  values (p_request_id, 'accepted', v_drv.id);
  insert into public.shift_swaps_audit (swap_id, event, actor_driver_id, metadata)
  values (p_request_id, 'swapped', v_drv.id,
          jsonb_build_object(
            'my_shift_id',    v_my_shift.id,
            'their_shift_id', v_their_shift.id
          ));

  return jsonb_build_object('status','accepted');
end;
$$;
grant execute on function public.driver_swap_respond(text, uuid, boolean) to anon, authenticated;

notify pgrst, 'reload schema';
