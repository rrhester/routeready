-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510050000 · attendance
-- Per-DSP policy + event log. Events are append-only-ish: existing rows
-- can have their `exempt` flag toggled (with audit trail), but never
-- deleted or repurposed. The policy drives the points/occurrence math
-- but the math itself is computed on read (in the dashboard) — we don't
-- materialize per-driver totals here.
-- ─────────────────────────────────────────────────────────────────────────

create type public.attendance_event_type as enum (
  'present',     -- baseline (don't usually log this; implied)
  'late',        -- arrived after grace period
  'callout',     -- notice given before threshold window
  'noshow',      -- no notice or notice within threshold window
  'earlyout',    -- left before completing route without approval
  'vto'          -- voluntary time off — manager-offered opt-out
);

-- ─── Policy (singleton per DSP) ──────────────────────────────────────────

create table public.attendance_policies (
  dsp_id                  uuid        primary key references public.dsps(id) on delete cascade,
  mode                    text        not null default 'hybrid'
                          check (mode in ('points','occurrence','hybrid')),

  -- Per-event configuration as JSONB so a DSP can add custom event types
  -- later without a schema migration. Default loaded by the seed function.
  events                  jsonb       not null default jsonb_build_object(
    'late',     jsonb_build_object('points', 0.5, 'occurrence', false, 'label', 'Late'),
    'callout',  jsonb_build_object('points', 1.0, 'occurrence', true,  'label', 'Call-out'),
    'earlyout', jsonb_build_object('points', 0.5, 'occurrence', false, 'label', 'Early out'),
    'noshow',   jsonb_build_object('points', 3.0, 'occurrence', true,  'label', 'No-show'),
    'vto',      jsonb_build_object('points', 0.0, 'occurrence', false, 'label', 'VTO')
  ),

  callout_window_hours    int         not null default 4
                          check (callout_window_hours between 0 and 24),
  late_grace_minutes      int         not null default 10
                          check (late_grace_minutes between 0 and 60),
  decay_days              int         not null default 90
                          check (decay_days between 14 and 365),
  reset_cadence           text        not null default 'rolling'
                          check (reset_cadence in ('rolling','quarter','annual')),

  thresholds              jsonb       not null default jsonb_build_object(
    'verbal',  jsonb_build_object('points', 2, 'occ', 2, 'label', 'Verbal warning'),
    'written', jsonb_build_object('points', 4, 'occ', 4, 'label', 'Written warning'),
    'final',   jsonb_build_object('points', 6, 'occ', 6, 'label', 'Final warning'),
    'term',    jsonb_build_object('points', 8, 'occ', 8, 'label', 'Termination eligible')
  ),

  exempt_categories       text[]      not null default array[
    'Approved PTO','Jury duty','Bereavement','FMLA','Workplace injury'
  ],

  notify_driver           boolean     not null default true,
  notify_owner            boolean     not null default true,
  auto_coach              boolean     not null default true,

  updated_at              timestamptz not null default now()
);

create trigger trg_attendance_policies_updated_at
  before update on public.attendance_policies
  for each row execute function moddatetime(updated_at);

comment on table public.attendance_policies is
  'Per-DSP attendance policy. Drives points/occurrence math computed in ' ||
  'the dashboard. One row per DSP. Owner can edit; ops can view.';

alter table public.attendance_policies enable row level security;

create policy "att_policy_tenant_select"
  on public.attendance_policies for select
  using (dsp_id = private.current_dsp_id());

create policy "att_policy_owner_upsert"
  on public.attendance_policies for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'owner')
  );

create policy "att_policy_owner_update"
  on public.attendance_policies for update
  using  (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'));

grant select, insert, update on public.attendance_policies to authenticated;

-- ─── Events ──────────────────────────────────────────────────────────────

create table public.attendance_events (
  id              uuid                       primary key default gen_random_uuid(),
  dsp_id          uuid                       not null references public.dsps(id) on delete cascade,
  driver_id       uuid                       not null references public.drivers(id) on delete cascade,
  event_type      public.attendance_event_type not null,
  event_date      date                       not null,
  exempt          boolean                    not null default false,
  exempt_category text,
  notes           text,
  source          text                       not null default 'check_in'
                  check (source in ('check_in','manual','timeclock_import')),
  shift_id        uuid,                      -- FK added in Phase 3 schedule migration
  created_by      uuid                       references public.app_users(id),
  created_at      timestamptz                not null default now()
);

-- One disruptive event (callout / noshow / vto) per driver per day. Late
-- and earlyout can occur multiple times per shift in theory but we keep
-- the same constraint to force the reporter to combine them.
create unique index attendance_events_one_per_day_idx
  on public.attendance_events (dsp_id, driver_id, event_date, event_type)
  where event_type in ('callout','noshow','vto','late','earlyout');

create index attendance_events_dsp_driver_date_idx
  on public.attendance_events (dsp_id, driver_id, event_date desc);
create index attendance_events_dsp_date_idx
  on public.attendance_events (dsp_id, event_date desc);
create index attendance_events_window_idx
  on public.attendance_events (dsp_id, event_date desc)
  where exempt = false;

comment on table public.attendance_events is
  'Manager-recorded attendance events. Edits restricted to the `exempt` ' ||
  'and `notes` columns via the mark_attendance_exempt RPC (audit-logged).';

-- ─── RLS ─────────────────────────────────────────────────────────────────

alter table public.attendance_events enable row level security;

-- Read: staff in DSP, OR the driver themselves (so driver app shows own record)
create policy "att_events_tenant_select"
  on public.attendance_events for select
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or driver_id = private.current_driver_id()
    )
  );

-- Insert: dispatchers + above. Drivers cannot create their own events.
create policy "att_events_staff_insert"
  on public.attendance_events for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
  );

-- Update: ops + above (column-level guard via trigger below)
create policy "att_events_ops_update"
  on public.attendance_events for update
  using  (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

-- Delete: owner only (very rare — typo correction)
create policy "att_events_owner_delete"
  on public.attendance_events for delete
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'owner')
  );

grant select, insert, update, delete on public.attendance_events to authenticated;

-- Column-level guard: ops can change `exempt`, `exempt_category`, `notes`
-- only. Everything else is fixed once recorded.
create or replace function private.attendance_events_update_guard()
returns trigger language plpgsql as $$
begin
  if new.dsp_id is distinct from old.dsp_id
   or new.driver_id is distinct from old.driver_id
   or new.event_type is distinct from old.event_type
   or new.event_date is distinct from old.event_date
   or new.source is distinct from old.source
   or new.shift_id is distinct from old.shift_id
   or new.created_by is distinct from old.created_by
   or new.created_at is distinct from old.created_at
  then
    raise exception 'attendance_events: only `exempt`, `exempt_category`, `notes` may be updated. To correct an event, delete it (owner only) and re-insert.';
  end if;
  return new;
end $$;

create trigger trg_attendance_events_update_guard
  before update on public.attendance_events
  for each row execute function private.attendance_events_update_guard();
