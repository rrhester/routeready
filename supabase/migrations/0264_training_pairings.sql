-- Migration 0264 · Training pairings (ride-along + Day 1+2 station training)
--
-- New drivers complete a 3-day onboarding window:
--   Day 1 + 2 — station training at the trainee's home station
--   Day 3     — ride-along with an experienced driver
-- The 3rd-day partner is preferably a trainer (drivers.is_trainer = true),
-- but on busy onboarding cohorts the operator may fall back to a regular
-- active driver who already has a route that day.
--
-- The pairing is *staged* on the orientation screen while the driver is
-- still in status='onboarding'. When the operator activates the driver,
-- the pairing is materialized into three real shift rows:
--   - 2 × shift_kind='training' shifts on (trainee, training_start_date+0/1)
--   - 1 × shift_kind='ride_along' shift on (trainee, ride_along_date)
--     copying the partner driver's regular shift fields (station, times,
--     route_code, wave, service_type) and setting trainer_driver_id.
--
-- The ride_along shift is not a route-staffing assignment, so the coverage
-- denominator (okami_demand.target_routes) doesn't move. The frontend also
-- excludes shift_kind IN ('training','ride_along') from the filled count.
--
-- Author note: drivers.is_trainer + shifts.trainer_driver_id already exist
-- (0143). shift_kind enum already includes 'training' + 'ride_along' (0261).
-- All this migration adds is the staging table, eligibility/materialization
-- RPCs, and a couple of triggers.


-- ── 1. Enums ─────────────────────────────────────────────────────────
do $$ begin
  create type public.training_pairing_status as enum (
    'proposed',       -- operator picked a partner, awaiting activate
    'materialized',   -- shifts created, driver active
    'needs_repair',   -- partner's shift moved/cancelled after pairing
    'cancelled'       -- operator cleared the pairing
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.training_pairing_source as enum (
    'trainer',        -- partner is a designated trainer
    'fallback'        -- partner is a regular active driver
  );
exception when duplicate_object then null; end $$;


-- ── 2. Table ─────────────────────────────────────────────────────────
create table if not exists public.training_pairings (
  id                    uuid primary key default gen_random_uuid(),
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  trainee_id            uuid not null references public.drivers(id) on delete cascade,
  trainer_id            uuid references public.drivers(id) on delete set null,
  training_start_date   date,
  ride_along_date       date,
  status                public.training_pairing_status not null default 'proposed',
  source                public.training_pairing_source,
  repair_reason         text,
  materialized_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references public.app_users(id) on delete set null
);

-- One active pairing per trainee. Cancelled/materialized rows can coexist
-- (history); only one proposed/needs_repair at a time. Enforced via partial
-- unique index rather than a strict UNIQUE so we can keep the audit trail.
create unique index if not exists training_pairings_trainee_active_idx
  on public.training_pairings(trainee_id)
  where status in ('proposed', 'needs_repair');

create index if not exists training_pairings_dsp_status_idx
  on public.training_pairings(dsp_id, status);
create index if not exists training_pairings_trainer_date_idx
  on public.training_pairings(trainer_id, ride_along_date)
  where trainer_id is not null and ride_along_date is not null;

drop trigger if exists trg_training_pairings_updated_at on public.training_pairings;
create trigger trg_training_pairings_updated_at
  before update on public.training_pairings
  for each row execute function private.set_updated_at();

alter table public.training_pairings enable row level security;

drop policy if exists training_pairings_tenant_rw on public.training_pairings;
create policy training_pairings_tenant_rw on public.training_pairings
  for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.training_pairings to authenticated;


-- ── 3. RPC · eligible ride-along partners for a given date ───────────
-- Returns drivers eligible to take a trainee on their existing shift.
-- Eligibility:
--   • Active driver in the trainee's DSP
--   • Not the trainee themselves
--   • Has a scheduled regular shift on p_date as their own driver_id
--   • Not on approved PTO that day
--   • Not already paired with a different trainee on p_date
--   • Station matches the trainee's home station (if both have one)
-- Each row carries the partner's shift details so the picker can render
-- "Sarah Chen · KMO1-14B · 07:00–17:00 · 32h wk" and a soft hours-cap
-- warning. is_trainer drives the UI grouping (Trainers / Other drivers).
create or replace function public.eligible_ride_along_drivers(
  p_trainee_id uuid,
  p_date       date
)
returns table (
  driver_id       uuid,
  full_name       text,
  is_trainer      boolean,
  shift_id        uuid,
  station_id      uuid,
  station_code    text,
  starts_at       timestamptz,
  ends_at         timestamptz,
  route_code      text,
  weekly_hours    numeric,
  warnings        jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_trainee_station uuid;
  v_week_start date;
  v_week_end   date;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select t.station_id into v_trainee_station
    from public.drivers t
   where t.id = p_trainee_id
     and t.dsp_id = v_dsp;

  -- ISO week containing the ride-along date, for the hours-cap soft warning.
  v_week_start := p_date - ((extract(isodow from p_date)::int - 1));
  v_week_end   := v_week_start + 6;

  return query
  with candidate as (
    select d.id, d.full_name, d.is_trainer, d.station_id,
           s.id          as shift_id,
           s.station_id  as shift_station_id,
           st.code       as station_code,
           s.starts_at,
           s.ends_at,
           s.route_code
      from public.drivers d
      join public.shifts s
        on s.driver_id  = d.id
       and s.dsp_id     = v_dsp
       and s.date       = p_date
       and s.status     = 'scheduled'
       and s.shift_kind = 'regular'
      left join public.stations st on st.id = s.station_id
     where d.dsp_id  = v_dsp
       and d.status  = 'active'
       and d.role    = 'driver'
       and d.id     <> p_trainee_id
       -- station match (only enforce if trainee has a home station)
       and (v_trainee_station is null or s.station_id = v_trainee_station)
       -- not on approved PTO that day
       and not exists (
         select 1 from public.time_off_requests tor
          where tor.driver_id = d.id
            and tor.status    = 'approved'
            and p_date between tor.start_date and tor.end_date
       )
       -- not already paired as trainer for another trainee on p_date
       and not exists (
         select 1 from public.training_pairings tp
          where tp.trainer_id      = d.id
            and tp.ride_along_date = p_date
            and tp.status in ('proposed', 'needs_repair', 'materialized')
            and tp.trainee_id <> p_trainee_id
       )
  ),
  weekly as (
    select c.id, sum(
             coalesce(
               extract(epoch from (s2.ends_at - s2.starts_at)) / 3600.0,
               coalesce(s2.block_hours, 10)
             )
           ) as hours
      from candidate c
      join public.shifts s2
        on s2.driver_id = c.id
       and s2.dsp_id    = v_dsp
       and s2.date between v_week_start and v_week_end
       and s2.status in ('scheduled', 'completed')
     group by c.id
  )
  select
    c.id,
    c.full_name,
    coalesce(c.is_trainer, false),
    c.shift_id,
    c.shift_station_id,
    c.station_code,
    c.starts_at,
    c.ends_at,
    c.route_code,
    coalesce(w.hours, 0)::numeric as weekly_hours,
    case
      when coalesce(w.hours, 0) > 45 then
        jsonb_build_array(jsonb_build_object(
          'level', 'warn',
          'code',  'high_hours',
          'text',  'Already over 45h this week'
        ))
      else '[]'::jsonb
    end as warnings
  from candidate c
  left join weekly w on w.id = c.id
  order by coalesce(c.is_trainer, false) desc, c.full_name;
end;
$$;
grant execute on function public.eligible_ride_along_drivers(uuid, date) to authenticated;


-- ── 4. RPC · propose pairing ─────────────────────────────────────────
-- Idempotent upsert: one active pairing per trainee at a time.
create or replace function public.propose_training_pairing(
  p_trainee_id          uuid,
  p_trainer_id          uuid,
  p_ride_along_date     date,
  p_training_start_date date,
  p_source              text  -- 'trainer' | 'fallback'
)
returns public.training_pairings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.training_pairings;
  v_is_trainer boolean;
  v_existing_id uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Validate the partner is real, active, in this DSP.
  select d.is_trainer into v_is_trainer
    from public.drivers d
   where d.id = p_trainer_id
     and d.dsp_id = v_dsp
     and d.status = 'active';
  if v_is_trainer is null then
    raise exception 'partner driver not found or not active' using errcode = 'P0002';
  end if;

  -- Validate trainee.
  if not exists (
    select 1 from public.drivers d
     where d.id = p_trainee_id
       and d.dsp_id = v_dsp
  ) then
    raise exception 'trainee not found' using errcode = 'P0002';
  end if;

  -- Source must match the partner's actual is_trainer flag — operator
  -- can't smuggle a non-trainer in under the 'trainer' label.
  if (p_source = 'trainer') <> coalesce(v_is_trainer, false) then
    raise exception 'pairing_source mismatches partner is_trainer flag' using errcode = '22023';
  end if;

  -- Find an existing proposed/needs_repair row to update in place; otherwise insert.
  select tp.id into v_existing_id
    from public.training_pairings tp
   where tp.trainee_id = p_trainee_id
     and tp.status in ('proposed', 'needs_repair')
   limit 1;

  if v_existing_id is not null then
    update public.training_pairings
       set trainer_id          = p_trainer_id,
           ride_along_date     = p_ride_along_date,
           training_start_date = coalesce(p_training_start_date, training_start_date),
           source              = p_source::public.training_pairing_source,
           status              = 'proposed',
           repair_reason       = null,
           updated_at          = now()
     where id = v_existing_id
     returning * into v_row;
  else
    insert into public.training_pairings
      (dsp_id, trainee_id, trainer_id, ride_along_date, training_start_date,
       source, status, created_by)
    values
      (v_dsp, p_trainee_id, p_trainer_id, p_ride_along_date, p_training_start_date,
       p_source::public.training_pairing_source, 'proposed', auth.uid())
    returning * into v_row;
  end if;

  return v_row;
end;
$$;
grant execute on function public.propose_training_pairing(uuid, uuid, date, date, text) to authenticated;


-- ── 5. RPC · clear pairing ───────────────────────────────────────────
create or replace function public.clear_training_pairing(p_trainee_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.training_pairings
     set status = 'cancelled', updated_at = now()
   where dsp_id     = v_dsp
     and trainee_id = p_trainee_id
     and status in ('proposed', 'needs_repair');
end;
$$;
grant execute on function public.clear_training_pairing(uuid) to authenticated;


-- ── 6. RPC · activate driver (gated on pairing) ──────────────────────
-- Replaces the dashboard's previous direct UPDATE drivers SET status='active'.
-- Materializes:
--   • 2 station-training shifts on training_start_date + 0/1 at the trainee's
--     home station, 09:00–16:00 local (default; operator can edit after).
--   • 1 ride-along shift on ride_along_date, copying the partner's regular
--     shift fields and setting trainer_driver_id.
-- All-or-nothing: either everything inserts and the driver flips to active,
-- or the function raises and the operator sees what's missing.
create or replace function public.activate_driver_with_pairing(
  p_driver_id        uuid,
  p_training_hours_start text default '09:00',
  p_training_hours_end   text default '16:00'
)
returns public.drivers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers;
  v_pair public.training_pairings;
  v_partner_shift public.shifts;
  v_tz text;
  v_day1 date;
  v_day2 date;
  v_day1_starts timestamptz;
  v_day1_ends   timestamptz;
  v_day2_starts timestamptz;
  v_day2_ends   timestamptz;
  v_station_for_training uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_drv
    from public.drivers
   where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then
    raise exception 'driver not found' using errcode = 'P0002';
  end if;

  -- Fetch the active pairing.
  select * into v_pair
    from public.training_pairings
   where trainee_id = p_driver_id
     and dsp_id     = v_dsp
     and status in ('proposed', 'needs_repair')
   order by created_at desc
   limit 1;

  if v_pair.id is null then
    raise exception 'no active training pairing for this driver' using errcode = 'P0002';
  end if;
  if v_pair.status = 'needs_repair' then
    raise exception 'pairing needs repair (%) — fix it before activating', coalesce(v_pair.repair_reason, 'unknown reason')
      using errcode = 'P0002';
  end if;
  if v_pair.trainer_id is null or v_pair.ride_along_date is null
     or v_pair.training_start_date is null then
    raise exception 'pairing is incomplete — set trainer, ride-along date, and training start date'
      using errcode = '22023';
  end if;

  -- Re-validate the partner's shift exists on ride_along_date.
  select * into v_partner_shift
    from public.shifts
   where driver_id  = v_pair.trainer_id
     and dsp_id     = v_dsp
     and date       = v_pair.ride_along_date
     and status     = 'scheduled'
     and shift_kind = 'regular'
   order by starts_at nulls last
   limit 1;
  if v_partner_shift.id is null then
    update public.training_pairings
       set status = 'needs_repair',
           repair_reason = 'partner no longer has a scheduled regular shift on ride-along date',
           updated_at = now()
     where id = v_pair.id;
    raise exception 'partner driver no longer has a scheduled shift on % — re-pair the trainee', v_pair.ride_along_date
      using errcode = 'P0002';
  end if;

  -- Resolve the DSP timezone for the training shifts.
  select coalesce((d.metadata->>'timezone'), 'America/Chicago')
    into v_tz
    from public.dsps d
   where d.id = v_dsp;

  -- Training shifts use the trainee's home station if set, else the partner's
  -- shift station (Day 1+2 happen at the station, not on the road).
  v_station_for_training := coalesce(v_drv.station_id, v_partner_shift.station_id);

  v_day1 := v_pair.training_start_date;
  v_day2 := v_pair.training_start_date + 1;

  v_day1_starts := ((v_day1::text || ' ' || p_training_hours_start)::timestamp at time zone v_tz);
  v_day1_ends   := ((v_day1::text || ' ' || p_training_hours_end  )::timestamp at time zone v_tz);
  v_day2_starts := ((v_day2::text || ' ' || p_training_hours_start)::timestamp at time zone v_tz);
  v_day2_ends   := ((v_day2::text || ' ' || p_training_hours_end  )::timestamp at time zone v_tz);

  -- Insert Day 1 + Day 2 training shifts (skip if a same-day training row
  -- already exists for this trainee, so re-running is safe).
  if not exists (
    select 1 from public.shifts
     where driver_id = p_driver_id and dsp_id = v_dsp
       and date = v_day1 and shift_kind = 'training'
  ) then
    insert into public.shifts
      (dsp_id, station_id, driver_id, date, starts_at, ends_at,
       status, source, shift_kind, created_by)
    values
      (v_dsp, v_station_for_training, p_driver_id, v_day1, v_day1_starts, v_day1_ends,
       'scheduled', 'manual', 'training', auth.uid());
  end if;
  if not exists (
    select 1 from public.shifts
     where driver_id = p_driver_id and dsp_id = v_dsp
       and date = v_day2 and shift_kind = 'training'
  ) then
    insert into public.shifts
      (dsp_id, station_id, driver_id, date, starts_at, ends_at,
       status, source, shift_kind, created_by)
    values
      (v_dsp, v_station_for_training, p_driver_id, v_day2, v_day2_starts, v_day2_ends,
       'scheduled', 'manual', 'training', auth.uid());
  end if;

  -- Insert the ride-along shift copying the partner's shift fields.
  if not exists (
    select 1 from public.shifts
     where driver_id = p_driver_id and dsp_id = v_dsp
       and date = v_pair.ride_along_date and shift_kind = 'ride_along'
  ) then
    insert into public.shifts
      (dsp_id, station_id, driver_id, date, starts_at, ends_at, route_code,
       status, source, shift_kind, trainer_driver_id, wave_index, service_type_id, created_by)
    values
      (v_dsp, v_partner_shift.station_id, p_driver_id, v_pair.ride_along_date,
       v_partner_shift.starts_at, v_partner_shift.ends_at, v_partner_shift.route_code,
       'scheduled', 'manual', 'ride_along', v_pair.trainer_id,
       v_partner_shift.wave_index, v_partner_shift.service_type_id, auth.uid());
  end if;

  -- Flip the pairing to materialized (drives the notify trigger).
  update public.training_pairings
     set status          = 'materialized',
         materialized_at = now(),
         updated_at      = now()
   where id = v_pair.id;

  -- Flip the driver to active.
  update public.drivers
     set status = 'active', updated_at = now()
   where id = p_driver_id
   returning * into v_drv;

  return v_drv;
end;
$$;
grant execute on function public.activate_driver_with_pairing(uuid, text, text) to authenticated;


-- ── 7. Trigger · enqueue SMS to both drivers on materialization ──────
create or replace function private.tg_training_pairing_notify()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_trainee public.drivers;
  v_trainer public.drivers;
  v_date_text text;
  v_start_text text;
  v_tz text;
  v_partner_shift public.shifts;
  v_trainee_body text;
  v_trainer_body text;
begin
  -- Only fire on the proposed → materialized edge.
  if NEW.status <> 'materialized' or OLD.status = 'materialized' then
    return NEW;
  end if;

  select * into v_trainee from public.drivers where id = NEW.trainee_id;
  select * into v_trainer from public.drivers where id = NEW.trainer_id;
  if v_trainee.id is null or v_trainer.id is null then
    return NEW;
  end if;

  select coalesce((d.metadata->>'timezone'), 'America/Chicago')
    into v_tz
    from public.dsps d where d.id = NEW.dsp_id;

  select * into v_partner_shift
    from public.shifts
   where driver_id  = NEW.trainer_id
     and dsp_id     = NEW.dsp_id
     and date       = NEW.ride_along_date
     and status     = 'scheduled'
     and shift_kind = 'regular'
   order by starts_at nulls last
   limit 1;

  v_date_text := to_char(NEW.ride_along_date, 'FMDay, FMMon DD');
  v_start_text := case
    when v_partner_shift.starts_at is not null
      then to_char(v_partner_shift.starts_at at time zone v_tz, 'FMHH12:MIam')
    else ''
  end;

  v_trainee_body := 'You''re riding along with ' || v_trainer.full_name
    || ' on ' || v_date_text
    || case when v_start_text <> '' then ' starting ' || v_start_text else '' end
    || case when v_partner_shift.route_code is not null then ' · route ' || v_partner_shift.route_code else '' end
    || '. Day 1 + 2 are station training before that.';

  if v_trainer.is_trainer then
    v_trainer_body := 'You''re training ' || v_trainee.full_name
      || ' on ' || v_date_text
      || '. They''ll join you for your route — same start time.';
  else
    v_trainer_body := v_trainee.full_name || ' will ride along with you on '
      || v_date_text || ' to learn the route. Same start time as your shift.';
  end if;

  if v_trainee.phone is not null then
    insert into public.sms_messages
      (dsp_id, applicant_id, direction, status, to_phone, body)
    values
      (NEW.dsp_id, v_trainee.applicant_id, 'outbound', 'queued', v_trainee.phone, v_trainee_body);
  end if;
  if v_trainer.phone is not null then
    insert into public.sms_messages
      (dsp_id, applicant_id, direction, status, to_phone, body)
    values
      (NEW.dsp_id, v_trainer.applicant_id, 'outbound', 'queued', v_trainer.phone, v_trainer_body);
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_training_pairings_notify on public.training_pairings;
create trigger trg_training_pairings_notify
  after update on public.training_pairings
  for each row execute function private.tg_training_pairing_notify();


-- ── 8. Trigger · flip pairing to needs_repair when partner shift moves ──
-- Fires when a regular shift the partner owns on the pairing date is deleted,
-- gets called_off, or has its driver_id reassigned away. Doesn't try to
-- re-pair; just surfaces the break so the operator can fix it.
create or replace function private.tg_shifts_check_pairings()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_old_driver uuid;
  v_old_date   date;
  v_status     public.shift_status;
  v_kind       public.shift_kind;
begin
  if TG_OP = 'DELETE' then
    v_old_driver := OLD.driver_id; v_old_date := OLD.date;
    v_status := OLD.status; v_kind := OLD.shift_kind;
  else
    v_old_driver := OLD.driver_id; v_old_date := OLD.date;
    v_status := NEW.status; v_kind := NEW.shift_kind;
  end if;

  if v_old_driver is null or v_kind <> 'regular' then
    return coalesce(NEW, OLD);
  end if;

  -- Pre-activation pairings (status='proposed') that depend on this driver+date.
  update public.training_pairings tp
     set status = 'needs_repair',
         repair_reason = case
           when TG_OP = 'DELETE' then 'partner shift was deleted'
           when v_status = 'called_off' then 'partner called off'
           when NEW.driver_id is distinct from OLD.driver_id then 'partner shift was reassigned'
           when NEW.date is distinct from OLD.date then 'partner shift was moved to a different date'
           else 'partner shift changed'
         end,
         updated_at = now()
   where tp.trainer_id      = v_old_driver
     and tp.ride_along_date = v_old_date
     and tp.status          = 'proposed'
     and (
       TG_OP = 'DELETE'
       or v_status = 'called_off'
       or NEW.driver_id is distinct from OLD.driver_id
       or NEW.date is distinct from OLD.date
     );

  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists trg_shifts_check_pairings on public.shifts;
create trigger trg_shifts_check_pairings
  after update or delete on public.shifts
  for each row execute function private.tg_shifts_check_pairings();


-- ── 9. RPC · orphaned ride-alongs for the today home page ────────────
-- Returns one row per orphaned ride-along — either a pre-activate pairing
-- whose partner can't be reached anymore, or a materialized ride-along whose
-- partner's underlying regular shift went sideways (called off, deleted,
-- reassigned). Used by the home-page alert card.
create or replace function public.orphaned_ride_alongs(p_from date default current_date,
                                                       p_to   date default null)
returns table (
  source        text,           -- 'pre_activate' | 'materialized'
  pairing_id    uuid,
  shift_id      uuid,
  trainee_id    uuid,
  trainee_name  text,
  trainer_id    uuid,
  trainer_name  text,
  ride_date     date,
  reason        text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_to  date := coalesce(p_to, p_from + 14);
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  -- A. Pre-activate pairings flagged needs_repair.
  select
    'pre_activate'::text                  as source,
    tp.id                                  as pairing_id,
    null::uuid                             as shift_id,
    tp.trainee_id,
    coalesce(dt.full_name, '?')            as trainee_name,
    tp.trainer_id,
    coalesce(dr.full_name, '?')            as trainer_name,
    tp.ride_along_date                     as ride_date,
    coalesce(tp.repair_reason, 'partner unavailable') as reason
  from public.training_pairings tp
  left join public.drivers dt on dt.id = tp.trainee_id
  left join public.drivers dr on dr.id = tp.trainer_id
  where tp.dsp_id = v_dsp
    and tp.status = 'needs_repair'
    and tp.ride_along_date between p_from and v_to

  union all

  -- B. Materialized ride-alongs whose partner has no scheduled regular
  --    shift on the date (called off, deleted, or reassigned post-activate).
  select
    'materialized'::text                   as source,
    null::uuid                             as pairing_id,
    rs.id                                  as shift_id,
    rs.driver_id                           as trainee_id,
    coalesce(dt.full_name, '?')            as trainee_name,
    rs.trainer_driver_id                   as trainer_id,
    coalesce(dr.full_name, '?')            as trainer_name,
    rs.date                                as ride_date,
    'partner has no scheduled regular shift on this date' as reason
  from public.shifts rs
  left join public.drivers dt on dt.id = rs.driver_id
  left join public.drivers dr on dr.id = rs.trainer_driver_id
  where rs.dsp_id     = v_dsp
    and rs.shift_kind = 'ride_along'
    and rs.status     = 'scheduled'
    and rs.date between p_from and v_to
    and rs.trainer_driver_id is not null
    and not exists (
      select 1 from public.shifts ts
       where ts.dsp_id     = v_dsp
         and ts.driver_id  = rs.trainer_driver_id
         and ts.date       = rs.date
         and ts.status     = 'scheduled'
         and ts.shift_kind = 'regular'
    );
end;
$$;
grant execute on function public.orphaned_ride_alongs(date, date) to authenticated;


-- ── 10. RPC · current pairing for a trainee (drives the card UI) ─────
create or replace function public.training_pairing_for(p_trainee_id uuid)
returns public.training_pairings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.training_pairings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_row
    from public.training_pairings
   where dsp_id = v_dsp
     and trainee_id = p_trainee_id
     and status in ('proposed', 'needs_repair', 'materialized')
   order by case status
              when 'needs_repair' then 0
              when 'proposed'     then 1
              when 'materialized' then 2
            end,
            created_at desc
   limit 1;

  return v_row;
end;
$$;
grant execute on function public.training_pairing_for(uuid) to authenticated;


notify pgrst, 'reload schema';
