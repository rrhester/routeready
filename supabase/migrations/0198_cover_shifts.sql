-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0198 · Cover this shift
--
-- "Cover this shift" is a dispatcher-driven workflow for filling open
-- shifts on the *future* schedule (tomorrow onward; not day-of callouts —
-- DSPs absorb those via the cushion built into their schedule). The
-- dispatcher opens an uncovered shift, sees a ranked list of fully
-- compliant candidates, picks one, and an Accept/Pass offer lands on
-- that driver's phone. Shift reassigns atomically on Accept; on Pass /
-- timeout, the dispatcher can advance to the next candidate. No
-- broadcast — single-driver offers only.
--
-- Hard compliance gates exclude a driver from the ranking entirely:
--   • driver's license expired or expires before the shift date
--   • required service-type cert missing (DOT, XL)
--   • approved PTO overlapping the shift
--   • already scheduled that date (no double-booking)
--   • weekly hour cap would be exceeded
--   • driver status <> 'active'
--
-- Overtime is allowed but priced. Drivers who'd cross the OT threshold
-- show up with a projected OT premium so the dispatcher decides whether
-- the cost is worth it.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Per-driver pay rate (optional; nullable; DSP default fallback) ──
alter table public.drivers
  add column if not exists hourly_rate         numeric(8,2),
  add column if not exists overtime_multiplier numeric(4,2);

comment on column public.drivers.hourly_rate is
  'Optional per-driver base hourly rate (USD). Used for projected OT cost in the Cover-shift flow. Falls back to dsps.metadata.scheduling.default_hourly_rate when null.';
comment on column public.drivers.overtime_multiplier is
  'Optional per-driver OT pay multiplier. Defaults to dsps.metadata.scheduling.default_overtime_multiplier (1.5).';

-- DSP-wide defaults live on dsps.metadata.scheduling:
--   default_hourly_rate              (numeric, dollars)
--   default_overtime_multiplier      (numeric, default 1.5)
--   max_hours_per_week               (int, default 60; the hard cap)
--   overtime_threshold_hours         (int, default 40; OT premium kicks in)


-- ── 2. shift_offers + audit ────────────────────────────────────────────
do $$ begin
  create type public.shift_offer_status as enum
    ('pending', 'accepted', 'declined', 'expired', 'cancelled');
exception when duplicate_object then null;
end $$;

create table if not exists public.shift_offers (
  id                   uuid primary key default gen_random_uuid(),
  dsp_id               uuid not null references public.dsps(id) on delete cascade,
  shift_id             uuid not null references public.shifts(id) on delete cascade,
  driver_id            uuid not null references public.drivers(id) on delete cascade,
  status               public.shift_offer_status not null default 'pending',
  offered_at           timestamptz not null default now(),
  offered_by           uuid references auth.users(id) on delete set null,
  expires_at           timestamptz not null,
  responded_at         timestamptz,
  response_reason      text,
  prior_driver_id      uuid references public.drivers(id) on delete set null,
  -- Cost snapshot at the moment the offer was made, so audit doesn't
  -- drift if rates change later.
  projected_ot_hours   numeric(6,2),
  projected_ot_premium numeric(10,2),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists shift_offers_dsp_status_idx
  on public.shift_offers (dsp_id, status, expires_at);
create index if not exists shift_offers_driver_status_idx
  on public.shift_offers (driver_id, status);
create index if not exists shift_offers_shift_idx
  on public.shift_offers (shift_id);

-- One pending offer per shift at a time — the dispatcher picks one
-- driver, waits, advances to the next if pass/expire. No broadcast.
create unique index if not exists shift_offers_one_pending_per_shift
  on public.shift_offers (shift_id) where status = 'pending';

create table if not exists public.shift_offers_audit (
  id              uuid primary key default gen_random_uuid(),
  offer_id        uuid not null references public.shift_offers(id) on delete cascade,
  event           text not null check (event in
                    ('created','accepted','declined','expired','cancelled','reassigned')),
  actor_user_id   uuid references auth.users(id) on delete set null,
  actor_driver_id uuid references public.drivers(id) on delete set null,
  metadata        jsonb not null default '{}'::jsonb,
  at              timestamptz not null default now()
);
create index if not exists shift_offers_audit_offer_idx
  on public.shift_offers_audit (offer_id, at);


-- ── 3. RLS ────────────────────────────────────────────────────────────
alter table public.shift_offers       enable row level security;
alter table public.shift_offers_audit enable row level security;

drop policy if exists shift_offers_dsp_r on public.shift_offers;
create policy shift_offers_dsp_r on public.shift_offers for select
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists shift_offers_audit_r on public.shift_offers_audit;
create policy shift_offers_audit_r on public.shift_offers_audit for select
  using (exists (
    select 1 from public.shift_offers o
    where o.id = shift_offers_audit.offer_id
      and o.dsp_id = private.current_dsp_id()
      and private.is_staff(o.dsp_id, 'dispatcher')
  ));

grant select on public.shift_offers       to authenticated;
grant select on public.shift_offers_audit to authenticated;


-- ── 4. Helpers ────────────────────────────────────────────────────────

-- DSP scheduling defaults from dsps.metadata.scheduling.
create or replace function private.cover_dsp_defaults(p_dsp_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with s as (
    select coalesce(metadata->'scheduling', '{}'::jsonb) as m
    from public.dsps where id = p_dsp_id
  )
  select jsonb_build_object(
    'overtime_threshold_hours', coalesce((m->>'overtime_threshold_hours')::int, 40),
    'max_hours_per_week',       coalesce((m->>'max_hours_per_week')::int, 60),
    'default_hourly_rate',      (m->>'default_hourly_rate')::numeric,
    'default_ot_multiplier',    coalesce((m->>'default_overtime_multiplier')::numeric, 1.5)
  )
  from s;
$$;

-- Sum of a driver's already-scheduled block hours for the calendar week
-- (Mon-anchored) containing p_date. Optionally excludes a specific shift
-- (used when re-counting for the target shift itself).
create or replace function private.cover_driver_week_hours(
  p_driver_id     uuid,
  p_date          date,
  p_exclude_shift uuid default null
) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(coalesce(s.block_hours, 10)), 0)::numeric
  from public.shifts s
  where s.driver_id = p_driver_id
    and (p_exclude_shift is null or s.id <> p_exclude_shift)
    and s.status in ('scheduled', 'completed', 'late')
    and s.date >= date_trunc('week', p_date)::date
    and s.date <  (date_trunc('week', p_date) + interval '7 days')::date;
$$;


-- ── 5. cover_shift_candidates ─────────────────────────────────────────
-- Returns the ranked candidates for a single open shift, with each
-- driver's projected total weekly hours + projected OT premium cost.
-- Hard compliance gates exclude drivers entirely; OT is allowed but
-- priced. Future schedule only (shift.date > today).
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
  ),
  scored as (
    select
      e.*,
      (e.cur_hours + v_shift_hours) as projected_hours,
      -- OT premium hours added *by this shift* — not the driver's
      -- cumulative weekly OT. Formula:
      --   max(0, (cur+shift) - max(threshold, cur))
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
    'defaults',   v_defaults,
    'candidates', v_results
  );
end;
$$;
grant execute on function public.cover_shift_candidates(uuid, int) to authenticated;


-- ── 6. cover_shift_offer ──────────────────────────────────────────────
-- Dispatcher picks one candidate and sends a time-boxed offer. Atomic:
-- re-validates eligibility, creates the pending row, writes audit. Does
-- not reassign the shift — that happens when the driver accepts.
create or replace function public.cover_shift_offer(
  p_shift_id        uuid,
  p_driver_id       uuid,
  p_expires_minutes int default 15
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_uid        uuid := auth.uid();
  v_shift      public.shifts;
  v_drv        public.drivers;
  v_candidates jsonb;
  v_cand       jsonb;
  v_offer      public.shift_offers;
  v_mins       int := greatest(coalesce(p_expires_minutes, 15), 1);
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

  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;

  -- Re-validate eligibility server-side. We do this by re-running the
  -- candidates RPC scoped to a larger list and confirming the driver is
  -- present. Cheaper than duplicating the gates inline.
  select cover_shift_candidates(p_shift_id, 500) into v_candidates;
  select c into v_cand
    from jsonb_array_elements(v_candidates->'candidates') c
   where (c->>'driver_id')::uuid = p_driver_id
   limit 1;
  if v_cand is null then
    raise exception 'driver_not_eligible' using errcode = 'P0001';
  end if;

  -- Reject if a pending offer already exists for this shift. The unique
  -- partial index on (shift_id) where status='pending' is the source of
  -- truth; we surface a friendlier error.
  if exists (select 1 from public.shift_offers
              where shift_id = p_shift_id and status = 'pending') then
    raise exception 'offer_already_pending' using errcode = 'P0001';
  end if;

  insert into public.shift_offers (
    dsp_id, shift_id, driver_id, status, offered_by, expires_at,
    prior_driver_id, projected_ot_hours, projected_ot_premium
  )
  values (
    v_dsp, p_shift_id, p_driver_id, 'pending', v_uid,
    now() + make_interval(mins => v_mins),
    v_shift.driver_id,
    nullif((v_cand->>'projected_ot_hours')::numeric, 0),
    (v_cand->>'projected_ot_premium')::numeric
  )
  returning * into v_offer;

  insert into public.shift_offers_audit (offer_id, event, actor_user_id, metadata)
  values (v_offer.id, 'created', v_uid,
          jsonb_build_object(
            'projected_ot_hours',   v_offer.projected_ot_hours,
            'projected_ot_premium', v_offer.projected_ot_premium,
            'expires_at',           v_offer.expires_at
          ));

  return jsonb_build_object(
    'id',                   v_offer.id,
    'shift_id',             v_offer.shift_id,
    'driver_id',            v_offer.driver_id,
    'status',               v_offer.status,
    'expires_at',           v_offer.expires_at,
    'projected_ot_hours',   v_offer.projected_ot_hours,
    'projected_ot_premium', v_offer.projected_ot_premium
  );
end;
$$;
grant execute on function public.cover_shift_offer(uuid, uuid, int) to authenticated;


-- ── 7. cover_shift_cancel ─────────────────────────────────────────────
-- Dispatcher pulls back a pending offer (e.g. wants to switch to a
-- different driver before the timer runs out).
create or replace function public.cover_shift_cancel(p_offer_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_uid   uuid := auth.uid();
  v_offer public.shift_offers;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_offer from public.shift_offers
   where id = p_offer_id and dsp_id = v_dsp;
  if v_offer.id is null then
    raise exception 'offer_not_found' using errcode = 'P0002';
  end if;
  if v_offer.status <> 'pending' then
    raise exception 'offer_not_pending' using errcode = 'P0001';
  end if;

  update public.shift_offers
     set status = 'cancelled', responded_at = now(), updated_at = now()
   where id = p_offer_id;

  insert into public.shift_offers_audit (offer_id, event, actor_user_id)
  values (p_offer_id, 'cancelled', v_uid);

  return jsonb_build_object('id', p_offer_id, 'status', 'cancelled');
end;
$$;
grant execute on function public.cover_shift_cancel(uuid) to authenticated;


-- ── 8. driver_offer_list ──────────────────────────────────────────────
-- Returns this driver's pending offer (if any), with shift details
-- shaped for the Accept/Pass card in the driver app.
create or replace function public.driver_offer_list(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drv  public.drivers;
  v_rows jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  -- Expire stale rows lazily so the driver never sees a dead offer.
  update public.shift_offers
     set status = 'expired', updated_at = now(), responded_at = now()
   where driver_id = v_drv.id
     and status    = 'pending'
     and expires_at <= now();

  -- Audit the just-expired rows.
  insert into public.shift_offers_audit (offer_id, event, actor_driver_id)
  select id, 'expired', v_drv.id
    from public.shift_offers
   where driver_id = v_drv.id
     and status    = 'expired'
     and responded_at >= now() - interval '5 seconds'
     and not exists (
       select 1 from public.shift_offers_audit a
       where a.offer_id = public.shift_offers.id and a.event = 'expired'
     );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',                  o.id,
    'shift_id',            o.shift_id,
    'status',              o.status,
    'offered_at',          o.offered_at,
    'expires_at',          o.expires_at,
    'projected_ot_hours',  o.projected_ot_hours,
    'date',                s.date,
    'starts_at',           s.starts_at,
    'ends_at',             s.ends_at,
    'route_code',          s.route_code,
    'block_hours',         s.block_hours,
    'station_code',        st.code,
    'wave_index',          s.wave_index
  ) order by o.expires_at), '[]'::jsonb) into v_rows
  from public.shift_offers o
  join public.shifts s     on s.id = o.shift_id
  left join public.stations st on st.id = s.station_id
  where o.driver_id = v_drv.id
    and o.status    = 'pending';

  return jsonb_build_object('offers', v_rows);
end;
$$;
grant execute on function public.driver_offer_list(text) to anon, authenticated;


-- ── 9. driver_offer_respond ───────────────────────────────────────────
-- Driver accepts or declines. Accept atomically reassigns the shift's
-- driver_id (capturing the prior_driver_id again in case it changed
-- since the offer was created) and writes the audit row.
create or replace function public.driver_offer_respond(
  p_token    text,
  p_offer_id uuid,
  p_accept   boolean,
  p_reason   text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drv      public.drivers;
  v_offer    public.shift_offers;
  v_shift    public.shifts;
begin
  v_drv := private.driver_validate_token(p_token);

  select * into v_offer from public.shift_offers
   where id = p_offer_id and driver_id = v_drv.id;
  if v_offer.id is null then
    raise exception 'offer_not_found' using errcode = 'P0002';
  end if;

  if v_offer.status <> 'pending' then
    raise exception 'offer_not_pending' using errcode = 'P0001';
  end if;
  if v_offer.expires_at <= now() then
    update public.shift_offers
       set status='expired', responded_at=now(), updated_at=now()
     where id = p_offer_id;
    insert into public.shift_offers_audit (offer_id, event, actor_driver_id)
    values (p_offer_id, 'expired', v_drv.id);
    raise exception 'offer_expired' using errcode = 'P0001';
  end if;

  if p_accept then
    select * into v_shift from public.shifts where id = v_offer.shift_id;
    if v_shift.id is null then
      raise exception 'shift_not_found' using errcode = 'P0002';
    end if;

    update public.shifts
       set driver_id = v_drv.id, updated_at = now()
     where id = v_offer.shift_id;

    update public.shift_offers
       set status='accepted', responded_at=now(),
           response_reason=nullif(trim(coalesce(p_reason,'')),''),
           updated_at=now()
     where id = p_offer_id;

    insert into public.shift_offers_audit (offer_id, event, actor_driver_id, metadata)
    values (p_offer_id, 'accepted', v_drv.id,
            jsonb_build_object('prior_driver_id', v_shift.driver_id));
    insert into public.shift_offers_audit (offer_id, event, actor_driver_id, metadata)
    values (p_offer_id, 'reassigned', v_drv.id,
            jsonb_build_object('from', v_shift.driver_id, 'to', v_drv.id));

    return jsonb_build_object('status','accepted','shift_id', v_offer.shift_id);
  else
    update public.shift_offers
       set status='declined', responded_at=now(),
           response_reason=nullif(trim(coalesce(p_reason,'')),''),
           updated_at=now()
     where id = p_offer_id;

    insert into public.shift_offers_audit (offer_id, event, actor_driver_id, metadata)
    values (p_offer_id, 'declined', v_drv.id,
            jsonb_build_object('reason', nullif(trim(coalesce(p_reason,'')),'')));

    return jsonb_build_object('status','declined');
  end if;
end;
$$;
grant execute on function public.driver_offer_respond(text, uuid, boolean, text) to anon, authenticated;


-- ── 10. updated_at trigger ────────────────────────────────────────────
create trigger trg_shift_offers_updated_at
  before update on public.shift_offers
  for each row execute function private.set_updated_at();


-- ── 11. Realtime publication ──────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['shift_offers','shift_offers_audit'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';
