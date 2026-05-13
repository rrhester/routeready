-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0201 · Driver self-service pickup of open shifts
--
-- Inverse of the Cover flow (#830): instead of the dispatcher offering
-- a specific shift to a specific driver, an eligible driver opens the
-- app and claims a future open shift on their own. Atomic claim, same
-- hard-compliance gates as Cover (license / certs / PTO / double-book
-- / weekly hour cap / consecutive days / rest hours / future-only), no
-- broadcast. The shifts table's existing update triggers (and the
-- shift_changes trigger from #834) take care of audit and downstream
-- effects.
--
-- Behavior is gated by a per-DSP toggle. Default OFF so existing
-- deployments keep Cover-only flow; owners flip it on in Schedule →
-- Rules → Driver self-service.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Per-DSP toggle helpers ─────────────────────────────────────────
create or replace function public.get_pickup_settings()
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
    'driver_pickup_enabled', coalesce((v_m->>'driver_pickup_enabled')::boolean, false)
  );
end;
$$;
grant execute on function public.get_pickup_settings() to authenticated;

create or replace function public.set_pickup_settings(p_enabled boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.dsps
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb)
         #- '{scheduling}' || jsonb_build_object('scheduling', coalesce(metadata->'scheduling', '{}'::jsonb)),
       '{scheduling,driver_pickup_enabled}',
       to_jsonb(coalesce(p_enabled, false)),
       true)
   where id = v_dsp;

  return jsonb_build_object('driver_pickup_enabled', coalesce(p_enabled, false));
end;
$$;
grant execute on function public.set_pickup_settings(boolean) to authenticated;


-- ── 2. Eligibility helper ─────────────────────────────────────────────
-- Centralised hard-compliance check for a (driver, shift) pair. Returns
-- true iff the driver could pick up or be Cover-offered that shift.
-- Mirrors the gates in cover_shift_candidates (#830, extended in #833).
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

  -- Service-type certs
  if v_shift.service_type_id is not null then
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


-- ── 3. driver_open_shifts_list ────────────────────────────────────────
-- Returns the open shifts the calling driver is eligible to pick up.
-- Empty when the DSP has driver_pickup_enabled = false. Future-only,
-- bounded to the next 21 days so the list stays a reasonable size.
--
-- VOLATILE (not STABLE) — private.driver_validate_token bumps a
-- last-seen timestamp, which is an UPDATE. STABLE would force a
-- read-only context and reject the write.
create or replace function public.driver_open_shifts_list(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drv     public.drivers;
  v_enabled boolean;
  v_rows    jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  select coalesce((metadata->'scheduling'->>'driver_pickup_enabled')::boolean, false)
    into v_enabled
  from public.dsps where id = v_drv.dsp_id;
  if not v_enabled then return jsonb_build_object('enabled', false, 'shifts', '[]'::jsonb); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',           s.id,
    'date',         s.date,
    'starts_at',    s.starts_at,
    'ends_at',      s.ends_at,
    'route_code',   s.route_code,
    'block_hours',  s.block_hours,
    'station_code', st.code,
    'wave_index',   s.wave_index
  ) order by s.date, s.starts_at), '[]'::jsonb) into v_rows
  from public.shifts s
  left join public.stations st on st.id = s.station_id
  where s.dsp_id     = v_drv.dsp_id
    and s.driver_id is null
    and s.date     >  current_date
    and s.date     <= current_date + interval '21 days'
    and s.status    = 'scheduled'
    and private.driver_can_take_shift(v_drv.id, s.id);

  return jsonb_build_object('enabled', true, 'shifts', v_rows);
end;
$$;
grant execute on function public.driver_open_shifts_list(text) to anon, authenticated;


-- ── 4. driver_open_shift_pickup ───────────────────────────────────────
-- Atomic claim. Re-validates eligibility, locks the shift row, refuses
-- if the shift is no longer open (raced) or the driver is no longer
-- eligible (e.g. PTO just got approved). On success the shifts UPDATE
-- trigger fires and writes a 'driver_assigned' row to shift_changes.
create or replace function public.driver_open_shift_pickup(
  p_token    text,
  p_shift_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drv     public.drivers;
  v_shift   public.shifts;
  v_enabled boolean;
begin
  v_drv := private.driver_validate_token(p_token);

  select coalesce((metadata->'scheduling'->>'driver_pickup_enabled')::boolean, false)
    into v_enabled
  from public.dsps where id = v_drv.dsp_id;
  if not v_enabled then
    raise exception 'pickup_disabled' using errcode = 'P0001';
  end if;

  select * into v_shift from public.shifts where id = p_shift_id for update;
  if v_shift.id is null or v_shift.dsp_id <> v_drv.dsp_id then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;
  if v_shift.driver_id is not null then
    raise exception 'shift_already_taken' using errcode = 'P0001';
  end if;
  if v_shift.date <= current_date then
    raise exception 'shift_not_future' using errcode = 'P0001';
  end if;

  if not private.driver_can_take_shift(v_drv.id, p_shift_id) then
    raise exception 'not_eligible' using errcode = 'P0001';
  end if;

  update public.shifts
     set driver_id = v_drv.id, updated_at = now()
   where id = p_shift_id;

  return jsonb_build_object(
    'ok',       true,
    'shift_id', p_shift_id,
    'date',     v_shift.date,
    'route',    v_shift.route_code
  );
end;
$$;
grant execute on function public.driver_open_shift_pickup(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
