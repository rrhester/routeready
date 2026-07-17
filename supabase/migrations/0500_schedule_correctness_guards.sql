-- 0500_schedule_correctness_guards.sql
--
-- Schedule improvement plan Wave 2 (docs/SCHEDULE-IMPROVEMENT-PLAN.md
-- items #1, #2, #5, #6, #7, #9): make the SERVER the authority on
-- schedule correctness instead of trusting client-side warnings.
--
--   1. private.staff_assign_violations() — the dispatcher-flow twin of
--      private.driver_can_take_shift (0201): same rules, same
--      dsps.metadata->'scheduling' knobs, but returns the reasons
--      instead of a boolean, skips the driver-self-serve-only gates
--      (future-only, must-be-open), and leaves double-booking to the
--      hard trigger below.
--   2. assign_shift / create_shift now run that check server-side.
--      Violations block with `assign_blocked` (reasons in DETAIL)
--      unless the caller passes an explicit override, which is
--      recorded in the new schedule_overrides table.
--   3. A BEFORE trigger on shifts makes same-day double-booking
--      impossible at the DB layer (engine/client checks were the only
--      guard). Per-DSP escape hatch: metadata->scheduling->
--      same_day_multi_shift = 'allow'.
--   4. time_off_requests: overlap-exclusion constraint (first gist
--      exclusion in the schema — requires btree_gist), preceded by a
--      deterministic dedupe of already-overlapping rows.
--   5. time_off_requests joins the generic audit spine (0433) — its
--      decisions were previously unaudited.
--   6. A pg_cron sweeper expires stale offers / swaps / 5th-day
--      confirmations globally. Until now rows expired lazily only when
--      the DRIVER polled, so dispatchers saw ghost "pending" rows.
--
-- Idempotent: safe to re-run end to end.

-- ── 0. Extension for the exclusion constraint ────────────────────────
create extension if not exists btree_gist;

-- ── 1. schedule_overrides · record of every compliance override ──────
create table if not exists public.schedule_overrides (
  id            uuid        primary key default gen_random_uuid(),
  dsp_id        uuid        not null references public.dsps(id)    on delete cascade,
  shift_id      uuid        not null references public.shifts(id)  on delete cascade,
  driver_id     uuid                 references public.drivers(id) on delete set null,
  violations    text[]      not null,
  reason        text,
  actor_user_id uuid                 references auth.users(id)     on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists schedule_overrides_dsp_at_idx
  on public.schedule_overrides (dsp_id, created_at desc);
create index if not exists schedule_overrides_shift_idx
  on public.schedule_overrides (shift_id, created_at desc);

alter table public.schedule_overrides enable row level security;

-- Reads for staff; all writes flow through the definer RPCs below.
drop policy if exists "schedule_overrides_staff_r" on public.schedule_overrides;
create policy "schedule_overrides_staff_r"
  on public.schedule_overrides for select
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

grant select on public.schedule_overrides to authenticated;

-- ── 2. The dispatcher-flow compliance check ──────────────────────────
-- Mirrors private.driver_can_take_shift (0201) rule-for-rule — same
-- metadata knobs, same defaults (55h / 6 days / 10h rest), same active
-- statuses — so driver self-serve and dispatcher assigns can never
-- disagree about what "legal" means. Differences, all deliberate:
--   · returns text[] reasons (for the override dialog), not boolean
--   · no future-only rule — dispatchers legitimately correct the past
--   · no must-be-open rule — reassignment is a dispatcher power
--   · no double-book rule — trg_shifts_block_double_book (below) is
--     the single authority on that
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

  if v_shift.service_type_id is not null then
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

-- ── 3. assign_shift · compliance-gated, override recorded ────────────
-- Same drop-then-recreate dance as 0446: PostgREST can't disambiguate
-- overloads, so the old signature must go.
drop function if exists public.assign_shift(uuid, uuid, uuid, boolean);

create or replace function public.assign_shift(
  p_id                 uuid,
  p_driver_id          uuid,
  p_expected_driver_id uuid    default null,
  p_check_expected     boolean default false,
  p_override           boolean default false,
  p_override_reason    text    default null
)
returns public.shifts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_row  public.shifts;
  v_viol text[];
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_check_expected then
    update public.shifts
       set driver_id = p_driver_id, status = 'scheduled'
     where id = p_id and dsp_id = v_dsp
       and driver_id is not distinct from p_expected_driver_id
     returning * into v_row;
    if v_row.id is null then
      select * into v_row from public.shifts where id = p_id and dsp_id = v_dsp;
      if v_row.id is null then
        raise exception 'shift_not_found';
      end if;
      -- The shift exists but its assignment changed since the caller
      -- last looked. Surface who holds it now so the UI can explain.
      raise exception 'shift_conflict'
        using errcode = 'P0001',
              detail  = coalesce(v_row.driver_id::text, 'unassigned');
    end if;
  else
    update public.shifts
       set driver_id = p_driver_id, status = 'scheduled'
     where id = p_id and dsp_id = v_dsp
     returning * into v_row;
    if v_row.id is null then raise exception 'shift_not_found'; end if;
  end if;

  -- Compliance gate (0500). Runs AFTER the concurrency-guarded write,
  -- inside the same transaction: a raise rolls the write back. Only
  -- assignment needs checking — unassign (null driver) is always legal.
  if p_driver_id is not null then
    v_viol := private.staff_assign_violations(p_id, p_driver_id);
    if coalesce(array_length(v_viol, 1), 0) > 0 then
      if not p_override then
        raise exception 'assign_blocked'
          using errcode = 'P0001',
                detail  = array_to_string(v_viol, '; '),
                hint    = 'pass p_override => true to assign anyway; the override is recorded';
      end if;
      insert into public.schedule_overrides
        (dsp_id, shift_id, driver_id, violations, reason, actor_user_id)
      values
        (v_dsp, p_id, p_driver_id, v_viol, p_override_reason, auth.uid());
    end if;
  end if;

  return v_row;
end;
$$;

grant execute on function
  public.assign_shift(uuid, uuid, uuid, boolean, boolean, text)
  to authenticated;

-- ── 4. create_shift · same gate when it lands with a driver ──────────
-- Signature unchanged (jsonb), so a plain replace. Override rides in
-- the payload: {"override": true, "override_reason": "..."}.
create or replace function public.create_shift(p_payload jsonb)
returns public.shifts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_row  public.shifts;
  v_viol text[];
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.shifts
    (dsp_id, station_id, driver_id, date, starts_at, ends_at,
     route_code, status, notes, source, shift_kind,
     route_classification, service_type_id, created_by)
  values
    (v_dsp,
     (p_payload->>'station_id')::uuid,
     nullif(p_payload->>'driver_id','')::uuid,
     (p_payload->>'date')::date,
     nullif(p_payload->>'starts_at','')::timestamptz,
     nullif(p_payload->>'ends_at','')::timestamptz,
     p_payload->>'route_code',
     coalesce((p_payload->>'status')::public.shift_status, 'scheduled'),
     p_payload->>'notes',
     coalesce((p_payload->>'source')::public.shift_source, 'manual'),
     coalesce((p_payload->>'shift_kind')::public.shift_kind, 'regular'),
     nullif(p_payload->>'route_classification',''),
     nullif(p_payload->>'service_type_id','')::uuid,
     auth.uid())
  returning * into v_row;

  -- Compliance gate (0500) — mirror of assign_shift's.
  if v_row.driver_id is not null then
    v_viol := private.staff_assign_violations(v_row.id, v_row.driver_id);
    if coalesce(array_length(v_viol, 1), 0) > 0 then
      if coalesce((p_payload->>'override')::boolean, false) is not true then
        raise exception 'assign_blocked'
          using errcode = 'P0001',
                detail  = array_to_string(v_viol, '; '),
                hint    = 'pass "override": true in the payload to create anyway; the override is recorded';
      end if;
      insert into public.schedule_overrides
        (dsp_id, shift_id, driver_id, violations, reason, actor_user_id)
      values
        (v_dsp, v_row.id, v_row.driver_id, v_viol,
         p_payload->>'override_reason', auth.uid());
    end if;
  end if;

  return v_row;
end;
$$;

grant execute on function public.create_shift(jsonb) to authenticated;

-- ── 5. Same-day double-book: impossible at the DB layer ──────────────
-- Every write path (RPCs, PostgREST table writes, future code) goes
-- through this. Not overridable — a DSP that runs multi-shift days
-- flips metadata->scheduling->same_day_multi_shift to 'allow' instead
-- (matching the engine's same_day_multi_shift setting vocabulary).
--
-- DEFERRED constraint trigger, checked at COMMIT, because legitimate
-- multi-row flows pass through transient double-books mid-transaction —
-- a same-day route swap (driver_swap_respond) assigns driver B onto
-- shift 1 while B still holds shift 2 until the next statement. Only
-- the transaction's FINAL state matters, so the check re-reads the row
-- at commit time (NEW may be a stale intermediate version). The
-- advisory xact-lock serializes concurrent writers for the same
-- driver+date so two simultaneous transactions can't both pass.
create or replace function private.tg_shifts_block_double_book()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cur    public.shifts;
  v_policy text;
begin
  -- Deferred: evaluate the row as it stands at commit, not as it was
  -- when this event was queued (it may have been updated again since,
  -- or deleted).
  select * into v_cur from public.shifts where id = new.id;
  if v_cur.id is null or v_cur.driver_id is null then return null; end if;
  if v_cur.status not in ('scheduled', 'completed', 'late') then return null; end if;

  select metadata->'scheduling'->>'same_day_multi_shift' into v_policy
    from public.dsps where id = v_cur.dsp_id;
  if v_policy = 'allow' then return null; end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_cur.driver_id::text || '|' || v_cur.date::text, 42));

  if exists (
    select 1 from public.shifts s
    where s.driver_id = v_cur.driver_id
      and s.dsp_id    = v_cur.dsp_id
      and s.date      = v_cur.date
      and s.id       <> v_cur.id
      and s.status in ('scheduled', 'completed', 'late')
  ) then
    raise exception 'shift_double_book'
      using errcode = 'P0001',
            detail  = 'driver already has an active shift on ' || v_cur.date::text,
            hint    = 'unassign the other shift first, or set scheduling.same_day_multi_shift = allow for this DSP';
  end if;

  return null;
end;
$$;

drop trigger if exists trg_shifts_block_double_book on public.shifts;
create constraint trigger trg_shifts_block_double_book
  after insert or update on public.shifts
  deferrable initially deferred
  for each row execute function private.tg_shifts_block_double_book();

-- ── 6. time_off_requests · dedupe, then overlap-exclusion ────────────
-- The constraint below would refuse to build over existing overlaps,
-- so resolve them first, deterministically:
--   (a) a pending request overlapping an approved one is cancelled
--       (the approved row is the decided reality);
--   (b) among same-status overlapping rows, the newest created_at
--       wins (latest request reflects current intent), older ones are
--       cancelled. Every auto-cancel is stamped in decision_notes.
do $$
declare
  r record;
begin
  update public.time_off_requests p
     set status = 'cancelled',
         decision_notes = coalesce(p.decision_notes || ' · ', '')
           || 'auto-cancelled (0500 dedupe): overlaps an approved request',
         updated_at = now()
   where p.status = 'pending'
     and exists (
       select 1 from public.time_off_requests a
       where a.driver_id = p.driver_id
         and a.id       <> p.id
         and a.status    = 'approved'
         and daterange(a.start_date, a.end_date, '[]')
             && daterange(p.start_date, p.end_date, '[]')
     );

  for r in
    select p1.id
    from public.time_off_requests p1
    join public.time_off_requests p2
      on  p2.driver_id = p1.driver_id
      and p2.id       <> p1.id
      and p1.status in ('pending', 'approved')
      and p2.status  = p1.status
      and daterange(p1.start_date, p1.end_date, '[]')
          && daterange(p2.start_date, p2.end_date, '[]')
      and (p2.created_at > p1.created_at
           or (p2.created_at = p1.created_at and p2.id > p1.id))
  loop
    update public.time_off_requests
       set status = 'cancelled',
           decision_notes = coalesce(decision_notes || ' · ', '')
             || 'auto-cancelled (0500 dedupe): superseded by a newer overlapping request',
           updated_at = now()
     where id = r.id
       and status in ('pending', 'approved');
  end loop;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'time_off_requests_no_overlap'
  ) then
    alter table public.time_off_requests
      add constraint time_off_requests_no_overlap
      exclude using gist (
        driver_id with =,
        daterange(start_date, end_date, '[]') with &&
      )
      where (status in ('pending', 'approved'));
  end if;
end $$;

-- ── 7. time_off_requests joins the audit spine (0433) ────────────────
drop trigger if exists trg_audit_time_off_requests on public.time_off_requests;
create trigger trg_audit_time_off_requests
  after insert or update or delete on public.time_off_requests
  for each row execute function private.log_audit_event();

-- ── 8. Server-side expiry sweeper ─────────────────────────────────────
-- Same predicates + audit events as the lazy per-driver expiry in
-- driver_offer_list / driver_swap_list / driver_pending_shift_confirmations
-- (0198/0203/0322), minus the driver scope. Each table is swept in its
-- own sub-block so one failure can't starve the others.
create or replace function private.sweep_expired_schedule_requests()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    with flipped as (
      update public.shift_offers
         set status = 'expired', updated_at = now(), responded_at = now()
       where status = 'pending' and expires_at <= now()
       returning id
    )
    insert into public.shift_offers_audit (offer_id, event)
    select id, 'expired' from flipped;
  exception when others then
    raise warning 'sweep_expired: shift_offers failed: %', sqlerrm;
  end;

  begin
    with flipped as (
      update public.shift_swap_requests
         set status = 'expired', responded_at = now(), updated_at = now()
       where status = 'pending' and expires_at <= now()
       returning id
    )
    insert into public.shift_swaps_audit (swap_id, event)
    select id, 'expired' from flipped;
  exception when others then
    raise warning 'sweep_expired: shift_swap_requests failed: %', sqlerrm;
  end;

  begin
    update public.shift_confirmation_requests
       set status = 'expired'
     where status = 'pending' and expires_at <= now();
  exception when others then
    raise warning 'sweep_expired: shift_confirmation_requests failed: %', sqlerrm;
  end;
end;
$$;

-- Every 5 minutes; the lazy per-driver expiry stays as belt-and-braces.
do $$ begin
  perform cron.unschedule('sweep-expired-schedule-requests');
exception when others then null; end $$;
do $$ begin
  perform cron.schedule(
    'sweep-expired-schedule-requests',
    '*/5 * * * *',
    'select private.sweep_expired_schedule_requests();');
exception when others then null; end $$;

notify pgrst, 'reload schema';
