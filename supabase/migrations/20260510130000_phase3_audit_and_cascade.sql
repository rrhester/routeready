-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510130000 · Phase 3 audit + suspension → shift cascade
-- Audit triggers on the new tables, and the missing piece from Phase 2:
-- when a driver is suspended/pending-term/terminated, future shifts are
-- released to status='open' so dispatchers see the gap immediately.
-- Also flips on reinstatement: if a driver was reinstated, prior 'open'
-- shifts are NOT auto-reassigned (would be surprising). Dispatcher
-- reassigns manually.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── Audit triggers ──────────────────────────────────────────────────────

create trigger trg_audit_routes
  after insert or update or delete on public.routes
  for each row execute function private.fn_audit_log();

create trigger trg_audit_shifts
  after insert or update or delete on public.shifts
  for each row execute function private.fn_audit_log();

create trigger trg_audit_swap_requests
  after insert or update or delete on public.swap_requests
  for each row execute function private.fn_audit_log();

create trigger trg_audit_time_off_requests
  after insert or update or delete on public.time_off_requests
  for each row execute function private.fn_audit_log();

create trigger trg_audit_okami_weeks
  after insert or update or delete on public.okami_weeks
  for each row execute function private.fn_audit_log();

-- ─── Suspension → shift release cascade ─────────────────────────────────
-- When an hr_event of type suspension/pending_termination/termination is
-- inserted, release the driver's future shifts. The function uses
-- security_definer privileges to bypass the RLS write check (since the
-- caller is technically a trigger).

create or replace function private.cascade_suspension_to_shifts()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_count int;
begin
  if new.event_type not in ('suspension','pending_termination','termination') then
    return new;
  end if;

  -- Don't cascade for void events (those are handled separately) and only
  -- the original event creates the cascade. Voiding doesn't reassign — that's
  -- a manual dispatcher decision.
  if new.event_type = 'void' or new.superseded_by is not null then
    return new;
  end if;

  with upd as (
    update public.shifts
       set status = 'open',
           driver_id = null,
           swap_request_id = null,
           notes = coalesce(notes, '') ||
                   case when notes is null or notes = '' then '' else ' · ' end ||
                   'Released after ' || new.event_type::text
     where dsp_id = new.dsp_id
       and driver_id = new.driver_id
       and shift_date >= coalesce(new.effective_date, current_date)
       and status in ('scheduled','swap_pending','vto')
    returning 1
  )
  select count(*) into v_count from upd;

  if v_count > 0 then
    raise notice 'cascade_suspension_to_shifts: released % shift(s) for driver %',
      v_count, new.driver_id;
  end if;

  return new;
end $$;

create trigger trg_hr_events_cascade_to_shifts
  after insert on public.hr_events
  for each row execute function private.cascade_suspension_to_shifts();

comment on function private.cascade_suspension_to_shifts() is
  'On hr_events insert of suspension/pending_termination/termination, ' ||
  'flips that driver''s future shifts to status=open. Reinstatement does ' ||
  'NOT auto-reassign (dispatcher decision).';

-- ─── Time-off → schedule sync (documentation only) ───────────────────
-- We intentionally do NOT pre-block shifts when a time_off_request is
-- created. Shifts flip to 'timeoff' only on approve (in decide_time_off).
-- This is the conservative behavior: a pending request doesn't block the
-- schedule, so the shift is still expected. If you want to pre-block,
-- add an AFTER INSERT trigger on time_off_requests here.
