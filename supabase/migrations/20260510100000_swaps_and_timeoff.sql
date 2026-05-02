-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510100000 · swap_requests + time_off_requests
-- Driver-initiated workflows. Swaps can be directed (Driver A → Driver B,
-- both opt in) or open marketplace (any qualified driver claims). Time-off
-- requests have a date range and a category; on approve, matching shifts
-- flip to 'timeoff' status.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── Swap requests ───────────────────────────────────────────────────────

create table public.swap_requests (
  id              uuid        primary key default gen_random_uuid(),
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  shift_id        uuid        not null references public.shifts(id) on delete cascade,
  from_driver_id  uuid        not null references public.drivers(id),
  to_driver_id    uuid        references public.drivers(id),    -- null = open marketplace
  reason          text,
  status          text        not null default 'pending'
                  check (status in ('pending','approved','denied','cancelled')),
  decided_by      uuid        references public.app_users(id),
  decided_at      timestamptz,
  decision_notes  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- A shift can have at most one pending swap at a time
create unique index swap_requests_one_pending_per_shift
  on public.swap_requests (shift_id) where status = 'pending';

create index swap_requests_dsp_status_idx
  on public.swap_requests (dsp_id, status);
create index swap_requests_from_driver_idx
  on public.swap_requests (from_driver_id, status);
create index swap_requests_to_driver_idx
  on public.swap_requests (to_driver_id) where to_driver_id is not null;

create trigger trg_swap_requests_updated_at
  before update on public.swap_requests
  for each row execute function moddatetime(updated_at);

-- Now the swap_request_id FK can be added on shifts
alter table public.shifts
  add constraint shifts_swap_request_fk
  foreign key (swap_request_id) references public.swap_requests(id) on delete set null;

comment on table public.swap_requests is
  'Driver-initiated swap of a shift. to_driver_id NULL = open marketplace ' ||
  '(any qualified driver claims). Approval flips the shift driver_id; ' ||
  'denial leaves the shift unchanged.';

-- ─── RLS on swaps ────────────────────────────────────────────────────────

alter table public.swap_requests enable row level security;

-- Read: staff in DSP + drivers involved (from or to)
create policy "swap_tenant_select"
  on public.swap_requests for select
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or from_driver_id = private.current_driver_id()
      or to_driver_id   = private.current_driver_id()
    )
  );

-- Insert: a driver inserting their own swap, OR staff inserting on a
-- driver's behalf
create policy "swap_driver_or_staff_insert"
  on public.swap_requests for insert
  with check (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or from_driver_id = private.current_driver_id()
    )
  );

-- Update: ops+ (decisions) OR the requester (cancel)
-- Field-level guard via trigger: requester can only set status=cancelled
create policy "swap_update"
  on public.swap_requests for update
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'ops')
      or from_driver_id = private.current_driver_id()
    )
  )
  with check (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'ops')
      or from_driver_id = private.current_driver_id()
    )
  );

-- No delete; cancellations use status='cancelled'.

grant select, insert, update on public.swap_requests to authenticated;

-- Trigger: a driver requester can only flip status to 'cancelled' (or
-- update reason). Staff can do anything.
create or replace function private.swap_requests_update_guard()
returns trigger language plpgsql as $$
begin
  if private.is_staff(new.dsp_id, 'ops') then
    return new;
  end if;
  -- Only the from_driver can update non-staff, and only specific fields
  if new.from_driver_id <> old.from_driver_id
   or new.to_driver_id is distinct from old.to_driver_id
   or new.shift_id <> old.shift_id
  then
    raise exception 'swap_requests: requester cannot change shift_id or driver targets';
  end if;
  if new.status not in ('pending','cancelled') then
    raise exception 'swap_requests: requester can only set status to cancelled';
  end if;
  if new.status = 'cancelled' and old.status not in ('pending') then
    raise exception 'swap_requests: can only cancel pending swaps';
  end if;
  return new;
end $$;

create trigger trg_swap_requests_update_guard
  before update on public.swap_requests
  for each row execute function private.swap_requests_update_guard();

-- ─── Time-off requests ───────────────────────────────────────────────────

create table public.time_off_requests (
  id              uuid        primary key default gen_random_uuid(),
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  driver_id       uuid        not null references public.drivers(id) on delete cascade,
  start_date      date        not null,
  end_date        date        not null,
  reason          text,
  category        text        not null default 'unpaid'
                  check (category in ('pto','sick','jury','bereavement','fmla','workplace_injury','unpaid','other')),
  status          text        not null default 'pending'
                  check (status in ('pending','approved','denied','cancelled')),
  decided_by      uuid        references public.app_users(id),
  decided_at      timestamptz,
  decision_notes  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint time_off_dates_valid check (end_date >= start_date)
);

create index time_off_dsp_status_idx
  on public.time_off_requests (dsp_id, status);
create index time_off_driver_idx
  on public.time_off_requests (driver_id, start_date desc);

create trigger trg_time_off_updated_at
  before update on public.time_off_requests
  for each row execute function moddatetime(updated_at);

comment on table public.time_off_requests is
  'Driver-initiated PTO / sick / jury / bereavement / FMLA / unpaid request. ' ||
  'On approve, matching future shifts flip to status=timeoff. category drives ' ||
  'whether attendance events on those dates are auto-exempted.';

alter table public.time_off_requests enable row level security;

create policy "time_off_tenant_select"
  on public.time_off_requests for select
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or driver_id = private.current_driver_id()
    )
  );

create policy "time_off_driver_or_staff_insert"
  on public.time_off_requests for insert
  with check (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'ops')
      or driver_id = private.current_driver_id()
    )
  );

create policy "time_off_update"
  on public.time_off_requests for update
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'ops')
      or driver_id = private.current_driver_id()
    )
  )
  with check (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'ops')
      or driver_id = private.current_driver_id()
    )
  );

grant select, insert, update on public.time_off_requests to authenticated;

create or replace function private.time_off_requests_update_guard()
returns trigger language plpgsql as $$
begin
  if private.is_staff(new.dsp_id, 'ops') then
    return new;
  end if;
  if new.driver_id <> old.driver_id then
    raise exception 'time_off_requests: cannot change driver_id';
  end if;
  if new.status not in ('pending','cancelled') then
    raise exception 'time_off_requests: requester can only set status to cancelled';
  end if;
  return new;
end $$;

create trigger trg_time_off_requests_update_guard
  before update on public.time_off_requests
  for each row execute function private.time_off_requests_update_guard();
