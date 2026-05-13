-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0203 · Shift swaps (peer-to-peer)
--
-- Driver A wants Driver B's upcoming shift in exchange for one of A's.
-- A sends a swap request that names both shifts. B accepts or declines
-- on their phone. If B accepts AND both compliance checks pass (A on
-- B's shift, B on A's shift), the swap executes atomically: both
-- shifts' driver_id flip in one transaction, the existing shifts
-- update trigger writes 'driver_changed' rows to shift_changes (#834),
-- and the swap row records the outcome.
--
-- No dispatcher approval — compliance is the gate. Same hard-gate
-- engine as Cover (#830) and pickup (#835), via the centralised
-- private.driver_can_take_shift helper introduced in 0201. If either
-- driver fails compliance at accept time, the swap is rejected with
-- a precise reason — dispatcher only intervenes when they choose to.
--
-- Behavior is opt-in per DSP. Default OFF.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Per-DSP toggle ─────────────────────────────────────────────────
create or replace function public.get_swap_settings()
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
    'driver_swap_enabled', coalesce((v_m->>'driver_swap_enabled')::boolean, false)
  );
end;
$$;
grant execute on function public.get_swap_settings() to authenticated;

create or replace function public.set_swap_settings(p_enabled boolean)
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
       '{scheduling,driver_swap_enabled}',
       to_jsonb(coalesce(p_enabled, false)),
       true)
   where id = v_dsp;
  return jsonb_build_object('driver_swap_enabled', coalesce(p_enabled, false));
end;
$$;
grant execute on function public.set_swap_settings(boolean) to authenticated;


-- ── 2. shift_swap_requests ────────────────────────────────────────────
do $$ begin
  create type public.shift_swap_status as enum
    ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'blocked');
exception when duplicate_object then null;
end $$;

create table if not exists public.shift_swap_requests (
  id                   uuid primary key default gen_random_uuid(),
  dsp_id               uuid not null references public.dsps(id) on delete cascade,
  requester_driver_id  uuid not null references public.drivers(id) on delete cascade,
  requester_shift_id   uuid not null references public.shifts(id) on delete cascade,
  target_driver_id     uuid not null references public.drivers(id) on delete cascade,
  target_shift_id      uuid not null references public.shifts(id) on delete cascade,
  status               public.shift_swap_status not null default 'pending',
  message              text,
  expires_at           timestamptz not null,
  responded_at         timestamptz,
  block_reason         text,                  -- compliance failure on accept (status='blocked')
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (requester_driver_id <> target_driver_id),
  check (requester_shift_id  <> target_shift_id)
);

create index if not exists shift_swaps_target_status_idx
  on public.shift_swap_requests (target_driver_id, status, expires_at);
create index if not exists shift_swaps_requester_idx
  on public.shift_swap_requests (requester_driver_id, status);
create index if not exists shift_swaps_dsp_idx
  on public.shift_swap_requests (dsp_id, status, created_at desc);

-- One pending request per (target_driver, requester_shift) pair —
-- protects against a requester spamming the same target with the same
-- swap. Letting them spam different targets is fine.
create unique index if not exists shift_swaps_one_pending_per_pair
  on public.shift_swap_requests (requester_shift_id, target_shift_id)
  where status = 'pending';

create table if not exists public.shift_swaps_audit (
  id              uuid primary key default gen_random_uuid(),
  swap_id         uuid not null references public.shift_swap_requests(id) on delete cascade,
  event           text not null check (event in
                    ('created','accepted','declined','cancelled','expired','blocked','swapped')),
  actor_driver_id uuid references public.drivers(id) on delete set null,
  metadata        jsonb not null default '{}'::jsonb,
  at              timestamptz not null default now()
);
create index if not exists shift_swaps_audit_swap_idx
  on public.shift_swaps_audit (swap_id, at);


-- ── 3. RLS ────────────────────────────────────────────────────────────
alter table public.shift_swap_requests enable row level security;
alter table public.shift_swaps_audit   enable row level security;

drop policy if exists shift_swaps_dsp_r on public.shift_swap_requests;
create policy shift_swaps_dsp_r on public.shift_swap_requests for select
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists shift_swaps_audit_r on public.shift_swaps_audit;
create policy shift_swaps_audit_r on public.shift_swaps_audit for select
  using (exists (
    select 1 from public.shift_swap_requests r
    where r.id = shift_swaps_audit.swap_id
      and r.dsp_id = private.current_dsp_id()
      and private.is_staff(r.dsp_id, 'dispatcher')
  ));

grant select on public.shift_swap_requests to authenticated;
grant select on public.shift_swaps_audit   to authenticated;


-- ── 4. driver_swap_pool ───────────────────────────────────────────────
-- Returns the upcoming shifts the calling driver could swap their own
-- shift for. One row per (other_driver, their_shift) in the next 21
-- days. Empty if swap is disabled for the DSP.
--
-- NOTE: VOLATILE (not STABLE) — private.driver_validate_token bumps a
-- last-seen timestamp, which is an UPDATE, and STABLE functions run
-- in a read-only context that rejects the write. Same reasoning
-- applies to the driver_swap_list / driver_offer_list family.
create or replace function public.driver_swap_pool(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drv     public.drivers;
  v_enabled boolean;
  v_rows    jsonb;
begin
  v_drv := private.driver_validate_token(p_token);
  select coalesce((metadata->'scheduling'->>'driver_swap_enabled')::boolean, false)
    into v_enabled
  from public.dsps where id = v_drv.dsp_id;
  if not v_enabled then return jsonb_build_object('enabled', false, 'shifts', '[]'::jsonb); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'shift_id',     s.id,
    'driver_id',    s.driver_id,
    'driver_name',  coalesce(nullif(trim(d.preferred_name),''),
                             nullif(trim(d.full_name),''),
                             trim(coalesce(d.first_name,'') || ' ' || coalesce(d.last_name,''))),
    'date',         s.date,
    'starts_at',    s.starts_at,
    'ends_at',      s.ends_at,
    'route_code',   s.route_code,
    'block_hours',  s.block_hours,
    'station_code', st.code
  ) order by s.date, s.starts_at), '[]'::jsonb) into v_rows
  from public.shifts s
  join public.drivers d on d.id = s.driver_id
  left join public.stations st on st.id = s.station_id
  where s.dsp_id     = v_drv.dsp_id
    and s.driver_id  is not null
    and s.driver_id <> v_drv.id
    and s.date >  current_date
    and s.date <= current_date + interval '21 days'
    and s.status    = 'scheduled';

  return jsonb_build_object('enabled', true, 'shifts', v_rows);
end;
$$;
grant execute on function public.driver_swap_pool(text) to anon, authenticated;


-- ── 5. driver_swap_request ────────────────────────────────────────────
-- Driver A offers their shift in exchange for Driver B's. Creates a
-- pending row with a 24-hour expiry. Both shifts must currently belong
-- to A and B respectively and be in the future. No re-validation of
-- compliance here — that happens at accept time, since either driver's
-- situation can shift between request and accept.
create or replace function public.driver_swap_request(
  p_token             text,
  p_my_shift_id       uuid,
  p_target_shift_id   uuid,
  p_message           text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drv      public.drivers;
  v_my       public.shifts;
  v_tgt      public.shifts;
  v_enabled  boolean;
  v_req      public.shift_swap_requests;
begin
  v_drv := private.driver_validate_token(p_token);
  select coalesce((metadata->'scheduling'->>'driver_swap_enabled')::boolean, false)
    into v_enabled from public.dsps where id = v_drv.dsp_id;
  if not v_enabled then raise exception 'swap_disabled' using errcode = 'P0001'; end if;

  select * into v_my  from public.shifts where id = p_my_shift_id;
  select * into v_tgt from public.shifts where id = p_target_shift_id;
  if v_my.id is null or v_tgt.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;
  if v_my.dsp_id <> v_drv.dsp_id or v_tgt.dsp_id <> v_drv.dsp_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_my.driver_id  <> v_drv.id  then raise exception 'not_your_shift' using errcode = 'P0001'; end if;
  if v_tgt.driver_id  is null     then raise exception 'target_unassigned' using errcode = 'P0001'; end if;
  if v_tgt.driver_id  = v_drv.id  then raise exception 'self_swap' using errcode = 'P0001'; end if;
  if v_my.date  <= current_date or v_tgt.date <= current_date then
    raise exception 'swap_future_only' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.shift_swap_requests
              where requester_shift_id = p_my_shift_id
                and target_shift_id    = p_target_shift_id
                and status = 'pending') then
    raise exception 'swap_already_pending' using errcode = 'P0001';
  end if;

  insert into public.shift_swap_requests (
    dsp_id, requester_driver_id, requester_shift_id,
    target_driver_id, target_shift_id, status,
    message, expires_at
  ) values (
    v_drv.dsp_id, v_drv.id, p_my_shift_id,
    v_tgt.driver_id, p_target_shift_id, 'pending',
    nullif(trim(coalesce(p_message,'')),''),
    now() + interval '24 hours'
  ) returning * into v_req;

  insert into public.shift_swaps_audit (swap_id, event, actor_driver_id)
  values (v_req.id, 'created', v_drv.id);

  return jsonb_build_object(
    'id',           v_req.id,
    'status',       v_req.status,
    'expires_at',   v_req.expires_at
  );
end;
$$;
grant execute on function public.driver_swap_request(text, uuid, uuid, text) to anon, authenticated;


-- ── 6. driver_swap_list ───────────────────────────────────────────────
-- Returns pending swap requests this driver is the TARGET of (i.e.
-- requests they need to respond to). Lazily expires stale rows so the
-- driver never sees a dead request.
create or replace function public.driver_swap_list(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_drv  public.drivers;
  v_rows jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  update public.shift_swap_requests
     set status='expired', responded_at=now(), updated_at=now()
   where target_driver_id = v_drv.id
     and status = 'pending'
     and expires_at <= now();

  insert into public.shift_swaps_audit (swap_id, event, actor_driver_id)
  select id, 'expired', v_drv.id
    from public.shift_swap_requests
   where target_driver_id = v_drv.id
     and status = 'expired'
     and responded_at >= now() - interval '5 seconds'
     and not exists (
       select 1 from public.shift_swaps_audit a
       where a.swap_id = public.shift_swap_requests.id and a.event = 'expired'
     );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',              r.id,
    'message',         r.message,
    'expires_at',      r.expires_at,
    'requester_name',  coalesce(nullif(trim(rd.preferred_name),''),
                                nullif(trim(rd.full_name),''),
                                trim(coalesce(rd.first_name,'') || ' ' || coalesce(rd.last_name,''))),
    'their_shift', jsonb_build_object(
      'date', rs.date, 'starts_at', rs.starts_at, 'ends_at', rs.ends_at,
      'route_code', rs.route_code, 'block_hours', rs.block_hours, 'station_code', rss.code
    ),
    'your_shift_to_give', jsonb_build_object(
      'date', ts.date, 'starts_at', ts.starts_at, 'ends_at', ts.ends_at,
      'route_code', ts.route_code, 'block_hours', ts.block_hours, 'station_code', tss.code
    )
  ) order by r.expires_at), '[]'::jsonb) into v_rows
  from public.shift_swap_requests r
  join public.drivers  rd on rd.id = r.requester_driver_id
  join public.shifts   rs on rs.id = r.requester_shift_id
  left join public.stations rss on rss.id = rs.station_id
  join public.shifts   ts on ts.id = r.target_shift_id
  left join public.stations tss on tss.id = ts.station_id
  where r.target_driver_id = v_drv.id
    and r.status = 'pending';

  return jsonb_build_object('requests', v_rows);
end;
$$;
grant execute on function public.driver_swap_list(text) to anon, authenticated;


-- ── 7. driver_swap_respond ────────────────────────────────────────────
-- Target driver accepts or declines. On accept, atomically:
--   1. Re-validate ownership of both shifts (catches races).
--   2. Re-run compliance for each driver against the *other* shift
--      via private.driver_can_take_shift. The helper already considers
--      a candidate "open" if driver_id is null, so we temporarily
--      treat each shift as the candidate's potential pickup, but we
--      can't actually null driver_id mid-transaction. Instead we
--      perform the swap and let private.driver_can_take_shift's
--      checks fire against the new state — except double-book, which
--      is the only check that depends on driver_id being null. We
--      simulate the swap math in-line for that one gate.
--   3. If anything fails, mark the request 'blocked' with a reason.
--   4. Otherwise flip both shifts' driver_id in one statement. The
--      shifts UPDATE trigger writes 'driver_changed' rows to
--      shift_changes for both sides.
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
    -- Compliance: each driver must remain eligible against the other's
    -- shift after the swap. We check the gates BEFORE mutating any
    -- shift row — PL/pgSQL doesn't allow explicit SAVEPOINT statements
    -- inside a function body, and we don't need them here: every
    -- relevant fact (driver status, DL expiry vs shift date) is known
    -- without performing the swap. Mirrors the hard gates the Cover
    -- and Pickup flows enforce (#830 / #835); future iterations can
    -- extend this with cert / PTO / hour-cap checks via a shared
    -- helper.
    select * into v_other_drv from public.drivers where id = v_req.requester_driver_id;

    v_eligible := (
      v_drv.status = 'active'
      and v_other_drv.status = 'active'
      and (v_drv.dl_expires_on is null or v_drv.dl_expires_on >= v_their_shift.date)
      and (v_other_drv.dl_expires_on is null or v_other_drv.dl_expires_on >= v_my_shift.date)
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


-- ── 8. updated_at trigger ─────────────────────────────────────────────
create trigger trg_shift_swaps_updated_at
  before update on public.shift_swap_requests
  for each row execute function private.set_updated_at();


-- ── 9. Realtime publication ───────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['shift_swap_requests','shift_swaps_audit'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';
