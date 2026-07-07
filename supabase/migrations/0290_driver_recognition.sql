-- Migration 0290 · Driver Recognition
--
-- Stands up the data layer for the Recognition workspace — a new
-- top-level page where leadership tracks upcoming birthdays + work
-- anniversaries, sends custom celebrations, and (when Performance is
-- wired up) recognises safety milestones.
--
-- Tables added:
--   driver_recognitions — every recognition event (sent, scheduled,
--   or drafted) attached to a driver.  The driver app will read this
--   table once celebration animations are built; until then this is
--   write-only from the dispatcher dashboard.
--
-- RPCs added (all dispatcher-only · RLS-scoped to the caller's DSP):
--   recognition_upcoming(p_days)        — birthdays + anniversaries in window
--   recognition_send(...)               — send-now or schedule a recognition
--   recognition_cancel(p_id)            — cancel a scheduled one
--   recognition_list(p_status, p_limit) — Sent / Scheduled history table
--
-- Reuses drivers.birthday (added in 0021) and drivers.hire_date (in
-- 0013) — no schema changes on the drivers table.


-- ── 1. driver_recognitions table ────────────────────────────────────
create table if not exists public.driver_recognitions (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  driver_id     uuid not null references public.drivers(id) on delete cascade,
  -- birthday | work_anniversary | safety_milestone | custom
  kind          text not null default 'custom',
  title         text not null,
  message       text,
  -- confetti | fireworks | balloons | cake | trophy | hearts | sparkle | custom
  animation     text not null default 'confetti',
  -- For birthdays / anniversaries the dashboard sets this to the
  -- celebration date so the driver app can play the animation on the
  -- right day.  For safety milestones / custom sends it's the day the
  -- dispatcher chose (defaults to today on send-now).
  occasion_on   date,
  scheduled_for date,
  sent_at       timestamptz,
  read_at       timestamptz,
  -- draft | scheduled | sent | cancelled
  status        text not null default 'sent',
  -- For anniversaries — number of years (1, 5, 10).  Null otherwise.
  years         int,
  -- For safety milestones once Performance is wired up: the slug of the
  -- milestone (e.g. 'safe_driving_30d').  Null today.
  milestone_key text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists driver_recognitions_dsp_idx
  on public.driver_recognitions (dsp_id, status, sent_at desc nulls last, scheduled_for);
create index if not exists driver_recognitions_driver_idx
  on public.driver_recognitions (driver_id, sent_at desc nulls last);
-- For the "already celebrated this year?" lookups in recognition_upcoming.
create index if not exists driver_recognitions_kind_year_idx
  on public.driver_recognitions (driver_id, kind, occasion_on);

alter table public.driver_recognitions enable row level security;

drop policy if exists "driver_recognitions_rw" on public.driver_recognitions;
create policy "driver_recognitions_rw" on public.driver_recognitions
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

-- The driver app will eventually need a SELECT-only path keyed by
-- the driver token.  We don't grant it yet — the table is dispatcher
-- write-only until the animations are built.  Grant the table now so
-- dashboard RPCs (security definer) can operate as the authenticated
-- caller.
grant select, insert, update, delete on public.driver_recognitions to authenticated;


-- ── 2. recognition_upcoming(p_days) ─────────────────────────────────
-- Returns birthdays + work anniversaries for active drivers whose
-- celebration date falls within the next p_days (default 30) AND
-- haven't already been recognised this year for that kind.  Each row
-- carries enough context to render a single "Celebrate" button —
-- driver name, photo, kind, occurs_on, years (for anniversaries),
-- and an already_sent flag for safety.
--
-- The "already recognised this year" check is a left-join against
-- driver_recognitions on (driver_id, kind, extract(year from occasion_on)).
-- We expose `already_sent` rather than filter so the operator can see
-- a green "Sent ✓" pill next to drivers who've already been celebrated.
create or replace function public.recognition_upcoming(p_days int default 30)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with today as (
    select current_date as d
  ),
  -- Compute the next occurrence of a MM-DD anchor (birthday or hire
  -- anniversary).  Leap-day birthdays (Feb 29) fall back to Feb 28 in
  -- non-leap years so they always have a celebration date.
  base as (
    select
      d.id            as driver_id,
      coalesce(nullif(trim(d.preferred_name), ''),
               nullif(trim(d.full_name), ''),
               'Driver') as name,
      d.photo_path,
      d.birthday,
      d.hire_date,
      (select d from today) as today_d
    from public.drivers d
    where d.dsp_id = private.current_dsp_id()
      and d.status = 'active'
      and private.is_staff(d.dsp_id, 'dispatcher')
  ),
  -- Project birthdays into the future.  For each driver, derive the
  -- next occurrence by combining the current/next year with the
  -- birthday's MM-DD.  Feb-29 anchors land on Feb-28 / Mar-1 depending
  -- on leap-year alignment — we just clamp to Feb-28 in non-leap years.
  birthdays as (
    select
      b.driver_id,
      b.name,
      b.photo_path,
      'birthday'::text as kind,
      case
        when b.birthday is null then null
        when extract(month from b.birthday) = 2 and extract(day from b.birthday) = 29 then
          -- next Feb 28/29 — try Feb 29 if the candidate year is leap, else Feb 28
          (
            select case
              when (y::int % 4 = 0
                    and (y::int % 100 <> 0
                         or y::int % 400 = 0))
                then make_date(y::int, 2, 29)
              else make_date(y::int, 2, 28)
            end
            from (select case
                when make_date(extract(year from b.today_d)::int, 2, 28) >= b.today_d
                  then extract(year from b.today_d)::int
                else extract(year from b.today_d)::int + 1
              end as y) yr
          )
        else
          case
            when make_date(extract(year from b.today_d)::int, extract(month from b.birthday)::int, extract(day from b.birthday)::int) >= b.today_d
              then make_date(extract(year from b.today_d)::int, extract(month from b.birthday)::int, extract(day from b.birthday)::int)
            else make_date(extract(year from b.today_d)::int + 1, extract(month from b.birthday)::int, extract(day from b.birthday)::int)
          end
      end as occurs_on,
      null::int as years
    from base b
    where b.birthday is not null
  ),
  -- Same projection for hire-date anniversaries.  `years` is computed
  -- against the occurrence year so the celebration card can say "5 years".
  anniversaries as (
    select
      b.driver_id,
      b.name,
      b.photo_path,
      'work_anniversary'::text as kind,
      case
        when b.hire_date is null then null
        when extract(month from b.hire_date) = 2 and extract(day from b.hire_date) = 29 then
          make_date(
            (case when make_date(extract(year from b.today_d)::int, 2, 28) >= b.today_d
                  then extract(year from b.today_d)::int
                  else extract(year from b.today_d)::int + 1 end)::int,
            2, 28
          )
        else
          case
            when make_date(extract(year from b.today_d)::int, extract(month from b.hire_date)::int, extract(day from b.hire_date)::int) >= b.today_d
              then make_date(extract(year from b.today_d)::int, extract(month from b.hire_date)::int, extract(day from b.hire_date)::int)
            else make_date(extract(year from b.today_d)::int + 1, extract(month from b.hire_date)::int, extract(day from b.hire_date)::int)
          end
      end as occurs_on,
      -- Years served on that occurrence date.  Skip the 0-year case
      -- (hire date in the future, or hired this year and not yet
      -- crossed the anniversary) by filtering it out below.
      (extract(year from
        case
          when extract(month from b.hire_date) = 2 and extract(day from b.hire_date) = 29 then
            make_date(
              (case when make_date(extract(year from b.today_d)::int, 2, 28) >= b.today_d
                    then extract(year from b.today_d)::int
                    else extract(year from b.today_d)::int + 1 end)::int,
              2, 28
            )
          else
            case
              when make_date(extract(year from b.today_d)::int, extract(month from b.hire_date)::int, extract(day from b.hire_date)::int) >= b.today_d
                then make_date(extract(year from b.today_d)::int, extract(month from b.hire_date)::int, extract(day from b.hire_date)::int)
              else make_date(extract(year from b.today_d)::int + 1, extract(month from b.hire_date)::int, extract(day from b.hire_date)::int)
            end
        end
      ) - extract(year from b.hire_date))::int as years
    from base b
    where b.hire_date is not null
  ),
  combined as (
    select * from birthdays where occurs_on is not null
    union all
    select * from anniversaries where occurs_on is not null and years >= 1
  ),
  -- Filter to the next p_days window.
  windowed as (
    select c.*
    from combined c, today t
    where c.occurs_on between t.d and (t.d + (p_days || ' days')::interval)::date
  ),
  -- Decorate with "already sent this year for this kind" so the UI
  -- can show a "Sent ✓" pill instead of (or alongside) the Celebrate
  -- button — operators see at a glance who's been recognised.
  decorated as (
    select
      w.*,
      exists (
        select 1 from public.driver_recognitions r
        where r.driver_id = w.driver_id
          and r.kind = w.kind
          and r.status in ('sent','scheduled')
          and r.occasion_on is not null
          and extract(year from r.occasion_on) = extract(year from w.occurs_on)
      ) as already_sent
    from windowed w
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'driver_id',     driver_id,
    'name',          name,
    'photo_path',    photo_path,
    'kind',          kind,
    'occurs_on',     occurs_on,
    'days_away',     (occurs_on - current_date)::int,
    'years',         years,
    'already_sent',  already_sent
  ) order by occurs_on asc, name asc), '[]'::jsonb)
  from decorated;
$$;
grant execute on function public.recognition_upcoming(int) to authenticated;


-- ── 3. recognition_send — create / schedule a recognition ───────────
-- One RPC handles both "send now" and "schedule for date".  If
-- p_scheduled_for is null or <= today, the row lands as status='sent'
-- with sent_at = now(); otherwise it's 'scheduled' and a future job
-- (separate piece of work) will flip status to 'sent' on the day.
create or replace function public.recognition_send(
  p_driver_id    uuid,
  p_kind         text default 'custom',
  p_title        text default null,
  p_message      text default null,
  p_animation    text default 'confetti',
  p_occasion_on  date default null,
  p_scheduled_for date default null,
  p_years        int  default null,
  p_milestone_key text default null
) returns public.driver_recognitions
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_row   public.driver_recognitions;
  v_title text;
  v_kind  text := coalesce(nullif(trim(p_kind), ''), 'custom');
  v_anim  text := coalesce(nullif(trim(p_animation), ''), 'confetti');
  v_today date := current_date;
  v_status text;
  v_sent_at timestamptz;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_driver_id is null then
    raise exception 'driver_required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.drivers where id = p_driver_id and dsp_id = v_dsp) then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;
  if v_kind not in ('birthday','work_anniversary','safety_milestone','custom') then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if v_anim not in ('confetti','fireworks','balloons','cake','trophy','hearts','sparkle','custom') then
    raise exception 'bad_animation' using errcode = '22023';
  end if;

  -- Default title per kind when none supplied — keeps the History tab
  -- readable even when an operator sent a minimal payload.
  v_title := nullif(trim(coalesce(p_title, '')), '');
  if v_title is null then
    v_title := case v_kind
      when 'birthday'         then 'Happy birthday!'
      when 'work_anniversary' then case when p_years is null then 'Happy work anniversary!'
                                       else p_years || '-year anniversary' end
      when 'safety_milestone' then 'Safety milestone'
      else 'A note from your team' end;
  end if;

  if p_scheduled_for is null or p_scheduled_for <= v_today then
    v_status := 'sent';
    v_sent_at := now();
  else
    v_status := 'scheduled';
    v_sent_at := null;
  end if;

  insert into public.driver_recognitions (
    dsp_id, driver_id, kind, title, message, animation,
    occasion_on, scheduled_for, sent_at, status, years, milestone_key,
    created_by
  ) values (
    v_dsp, p_driver_id, v_kind, v_title, nullif(trim(p_message), ''),
    v_anim,
    coalesce(p_occasion_on, p_scheduled_for, v_today),
    p_scheduled_for, v_sent_at, v_status, p_years, nullif(trim(p_milestone_key), ''),
    auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.recognition_send(uuid, text, text, text, text, date, date, int, text) to authenticated;


-- ── 4. recognition_cancel ───────────────────────────────────────────
create or replace function public.recognition_cancel(p_id uuid)
returns public.driver_recognitions
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.driver_recognitions;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.driver_recognitions
     set status = 'cancelled', updated_at = now()
   where id = p_id and dsp_id = v_dsp and status = 'scheduled'
   returning * into v_row;
  if v_row.id is null then
    raise exception 'recognition_not_cancellable' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;
grant execute on function public.recognition_cancel(uuid) to authenticated;


-- ── 5. recognition_list — Sent / Scheduled history table ────────────
-- Returns the most recent N recognitions (any status) decorated with
-- the driver's display name + photo so the dashboard can render the
-- History table without a second query.
create or replace function public.recognition_list(
  p_status text default null,   -- null | 'sent' | 'scheduled' | 'cancelled' | 'all'
  p_limit  int  default 200
) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(j order by j->>'occurs_at' desc nulls last), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',            r.id,
      'driver_id',     r.driver_id,
      'driver_name',   coalesce(nullif(trim(d.preferred_name), ''), nullif(trim(d.full_name), ''), 'Driver'),
      'photo_path',    d.photo_path,
      'kind',          r.kind,
      'title',         r.title,
      'message',       r.message,
      'animation',     r.animation,
      'occasion_on',   r.occasion_on,
      'scheduled_for', r.scheduled_for,
      'sent_at',       r.sent_at,
      'read_at',       r.read_at,
      'status',        r.status,
      'years',         r.years,
      'occurs_at',     coalesce(r.sent_at::date, r.scheduled_for, r.occasion_on, r.created_at::date),
      'created_at',    r.created_at
    ) j
    from public.driver_recognitions r
    join public.drivers d on d.id = r.driver_id
    where r.dsp_id = private.current_dsp_id()
      and private.is_staff(r.dsp_id, 'dispatcher')
      and (
        p_status is null
        or p_status = 'all'
        or r.status = p_status
      )
    order by coalesce(r.sent_at, (r.scheduled_for + time '00:00')::timestamptz, r.created_at) desc
    limit greatest(p_limit, 1)
  ) t;
$$;
grant execute on function public.recognition_list(text, int) to authenticated;


notify pgrst, 'reload schema';
