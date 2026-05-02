-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510060000 · hr_events + coaching + suspension cascade
--
-- HR events are STRICTLY append-only. Once written, a row never changes.
-- Voiding an event creates a new event of type='void' with superseded_by
-- pointing at the original. The original is preserved so the audit chain
-- is complete.
--
-- Driver status (`drivers.status`) is kept in sync with active suspension
-- and termination events via a trigger. The `active_suspensions` view is
-- the source of truth — the trigger just propagates that into the
-- `drivers` table for query convenience.
-- ─────────────────────────────────────────────────────────────────────────

create type public.hr_event_type as enum (
  'verbal_warning',
  'written_warning',
  'final_warning',
  'suspension',
  'reinstatement',
  'pending_termination',
  'termination',
  'license_reminder_sent',
  'document_signed',
  'exempt_granted',
  'void'                  -- supersedes a prior event; used to "undo"
);

create type public.hr_severity as enum ('info','minor','major','critical');

create table public.hr_events (
  id              uuid              primary key default gen_random_uuid(),
  dsp_id          uuid              not null references public.dsps(id) on delete cascade,
  driver_id       uuid              not null references public.drivers(id) on delete cascade,
  event_type      public.hr_event_type not null,
  severity        public.hr_severity   not null,
  effective_date  date              not null,
  return_date     date,                          -- for suspensions
  reason_category text,                          -- 'attendance','safety','conduct','scorecard','theft','other'
  reason_detail   text              not null,
  evidence_refs   jsonb,                         -- e.g. {"attendance_event_ids": [...], "safety_event_ids": [...]}
  attached_files  text[],                        -- Storage paths
  initiated_by    uuid              references public.app_users(id),
  acknowledged_at timestamptz,                   -- when driver signed
  acknowledged_by uuid              references public.app_users(id),
  superseded_by   uuid              references public.hr_events(id),
                                                 -- ↑ a void event references the original
  notes           text,
  created_at      timestamptz       not null default now()
);

create index hr_events_driver_idx
  on public.hr_events (dsp_id, driver_id, effective_date desc);
create index hr_events_type_idx
  on public.hr_events (dsp_id, event_type);
create index hr_events_active_suspensions_idx
  on public.hr_events (dsp_id, driver_id, effective_date desc)
  where event_type = 'suspension' and superseded_by is null;

comment on table public.hr_events is
  'Append-only personnel-file events. Never UPDATE or DELETE rows here. ' ||
  'Voiding an event = inserting a new void event with superseded_by → original. ' ||
  'This is required documentation for unemployment defense and wrongful-termination claims.';

-- ─── RLS — STRICT APPEND ONLY ────────────────────────────────────────────

alter table public.hr_events enable row level security;

-- Read: staff in DSP, OR the driver themselves (transparency: driver
-- can see their own personnel file)
create policy "hr_events_tenant_select"
  on public.hr_events for select
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'ops')
      or driver_id = private.current_driver_id()
    )
  );

-- Insert: ops+ within DSP. Driver can never insert.
create policy "hr_events_ops_insert"
  on public.hr_events for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'ops')
  );

-- NO UPDATE policy. NO DELETE policy. With RLS on, both are denied.
-- This is the entire point of the table.

grant select, insert on public.hr_events to authenticated;
revoke update, delete on public.hr_events from public, anon, authenticated;

-- ─── Coaching events (mutable; logged) ──────────────────────────────────

create table public.coaching_events (
  id                   uuid        primary key default gen_random_uuid(),
  dsp_id               uuid        not null references public.dsps(id) on delete cascade,
  driver_id            uuid        not null references public.drivers(id) on delete cascade,
  category             text        not null
                       check (category in ('attendance','safety','quality','behavior','license','other')),
  channel              text        not null
                       check (channel in ('sms','in_person','pull_route','suspend')),
  message_body         text,                     -- if channel='sms'
  context_summary      text,                     -- "Why this coaching" — shown in drawer
  evidence_refs        jsonb,
  initiated_by         uuid        references public.app_users(id),
  related_hr_event_id  uuid        references public.hr_events(id),
  created_at           timestamptz not null default now()
);

create index coaching_events_driver_idx
  on public.coaching_events (dsp_id, driver_id, created_at desc);
create index coaching_events_category_idx
  on public.coaching_events (dsp_id, category);

comment on table public.coaching_events is
  'Mutable coaching log: SMS, 1:1, pull-from-route. Less strict than ' ||
  'hr_events — can be edited to correct typos. Significant actions ' ||
  '(suspend, written warning) ALSO write hr_events, which are immutable.';

alter table public.coaching_events enable row level security;

create policy "coaching_tenant_select"
  on public.coaching_events for select
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or driver_id = private.current_driver_id()
    )
  );

create policy "coaching_dispatcher_insert"
  on public.coaching_events for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
  );

create policy "coaching_ops_update"
  on public.coaching_events for update
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

create policy "coaching_owner_delete"
  on public.coaching_events for delete
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'));

grant select, insert, update, delete on public.coaching_events to authenticated;

-- ─── Active suspensions view ─────────────────────────────────────────────
-- The latest non-void, non-expired suspension event per driver. Drives the
-- driver-status sync trigger and any UI that wants "currently suspended"
-- without recomputing from scratch.

create view public.active_suspensions
with (security_invoker = true)
as
select s.*
  from public.hr_events s
 where s.event_type = 'suspension'
   and not exists (
     select 1 from public.hr_events v
      where v.event_type = 'void'
        and v.superseded_by = s.id
   )
   and not exists (
     -- A reinstatement after this suspension cancels its effect
     select 1 from public.hr_events r
      where r.event_type = 'reinstatement'
        and r.driver_id = s.driver_id
        and r.effective_date >= s.effective_date
        and r.created_at > s.created_at
   )
   and (s.return_date is null or s.return_date >= current_date);

comment on view public.active_suspensions is
  'Currently-active suspensions per driver. Filters out voided events and ' ||
  'expired return dates. The driver-status sync trigger reads this.';

-- ─── Driver status sync trigger ──────────────────────────────────────────
-- After ANY hr_events insert, recompute drivers.status for the affected
-- driver. This is how "suspending" actually changes the roster + check-in
-- + schedule visibility downstream.

create or replace function private.sync_driver_status_from_hr()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_driver_id uuid;
begin
  v_driver_id := new.driver_id;

  -- Check for an active (non-voided) termination — highest precedence
  if exists (
    select 1
      from public.hr_events e
     where e.driver_id  = v_driver_id
       and e.event_type = 'termination'
       and not exists (
         select 1 from public.hr_events v
          where v.event_type    = 'void'
            and v.superseded_by = e.id
       )
  ) then
    update public.drivers
       set status = 'terminated',
           termination_date = coalesce(termination_date, current_date)
     where id = v_driver_id and status <> 'terminated';
    return new;
  end if;

  -- Active pending_termination (not voided, not reinstated since)
  if exists (
    select 1
      from public.hr_events e
     where e.driver_id  = v_driver_id
       and e.event_type = 'pending_termination'
       and not exists (
         select 1 from public.hr_events v
          where v.event_type    = 'void'
            and v.superseded_by = e.id
       )
       and not exists (
         select 1 from public.hr_events r
          where r.event_type = 'reinstatement'
            and r.driver_id  = e.driver_id
            and r.created_at > e.created_at
       )
  ) then
    update public.drivers
       set status = 'suspended'
     where id = v_driver_id and status not in ('terminated','suspended');
    return new;
  end if;

  -- Active suspension via the materialized-style view
  if exists (
    select 1 from public.active_suspensions where driver_id = v_driver_id
  ) then
    update public.drivers
       set status = 'suspended'
     where id = v_driver_id and status not in ('terminated','suspended');
    return new;
  end if;

  -- No active blocking event — flip back to active if currently suspended.
  -- (Drivers in 'inactive' or 'onboarding' are set by other flows; we
  -- don't auto-flip those.)
  update public.drivers
     set status = 'active'
   where id = v_driver_id and status = 'suspended';

  return new;
end $$;

create trigger trg_hr_events_sync_status
  after insert on public.hr_events
  for each row execute function private.sync_driver_status_from_hr();

comment on function private.sync_driver_status_from_hr() is
  'After any hr_events insert, recomputes drivers.status by checking for ' ||
  'active termination / pending_termination / suspension. Reinstatement ' ||
  'and void events flip the status back to active.';
