-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510070000 · Phase 2 RPCs
-- High-level operations that touch multiple tables in a single transaction.
-- These are the "verbs" the frontend calls — record_attendance,
-- process_suspension, process_reinstatement, void_hr_event,
-- mark_attendance_exempt. Implemented as security_definer functions that
-- enforce DSP scope manually so they can perform multi-table writes safely.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── record_attendance: insert one event ────────────────────────────────
-- Replaces ciMark(). Idempotent for callout/noshow/vto via the unique
-- index on (dsp_id, driver_id, event_date, event_type).
--
-- Args:
--   p_driver_id      uuid     who
--   p_event_type     text     'late' | 'callout' | 'noshow' | 'earlyout' | 'vto' | 'present'
--   p_event_date     date     defaults to current_date
--   p_notes          text     optional
--   p_replace_today  boolean  if true, supersede any existing same-day event
--                             for this driver (used when a marker mistakenly
--                             clicked "callout" then realized they wanted "vto")
--
-- Returns: jsonb { event_id, was_replaced, message }

create or replace function public.record_attendance(
  p_driver_id     uuid,
  p_event_type    text,
  p_event_date    date    default current_date,
  p_notes         text    default null,
  p_replace_today boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, extensions
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_caller     uuid := auth.uid();
  v_event_id   uuid;
  v_existing   uuid;
  v_was_replaced boolean := false;
begin
  if v_dsp is null then
    raise exception 'record_attendance: not authenticated for any DSP';
  end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'record_attendance: caller is not staff';
  end if;

  -- Validate driver belongs to this DSP
  perform 1 from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if not found then
    raise exception 'record_attendance: driver % not in DSP %', p_driver_id, v_dsp;
  end if;

  -- 'present' is a non-event in our model — clear any same-day record instead
  if p_event_type = 'present' then
    delete from public.attendance_events
     where dsp_id = v_dsp
       and driver_id = p_driver_id
       and event_date = p_event_date
       and event_type in ('late','callout','noshow','earlyout','vto')
    returning id into v_existing;
    return jsonb_build_object(
      'event_id', null,
      'was_replaced', v_existing is not null,
      'message', 'Marked present; cleared any prior same-day disruption.'
    );
  end if;

  -- For replaceable types, optionally supersede an existing same-day event
  if p_replace_today and p_event_type in ('late','callout','noshow','earlyout','vto') then
    delete from public.attendance_events
     where dsp_id = v_dsp
       and driver_id = p_driver_id
       and event_date = p_event_date
       and event_type in ('late','callout','noshow','earlyout','vto')
    returning id into v_existing;
    v_was_replaced := v_existing is not null;
  end if;

  insert into public.attendance_events
    (dsp_id, driver_id, event_type, event_date, notes, source, created_by)
  values
    (v_dsp, p_driver_id, p_event_type::public.attendance_event_type,
     p_event_date, p_notes, 'check_in', v_caller)
  returning id into v_event_id;

  return jsonb_build_object(
    'event_id', v_event_id,
    'was_replaced', v_was_replaced,
    'message', 'Recorded ' || p_event_type
  );
end $$;

revoke execute on function public.record_attendance(uuid, text, date, text, boolean)
  from public, anon;
grant execute on function public.record_attendance(uuid, text, date, text, boolean)
  to authenticated;

-- ─── mark_attendance_exempt: toggle exempt + optional category ──────────

create or replace function public.mark_attendance_exempt(
  p_event_id  uuid,
  p_exempt    boolean,
  p_category  text default null,
  p_notes     text default null
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'mark_attendance_exempt: caller is not ops staff';
  end if;

  update public.attendance_events
     set exempt = p_exempt,
         exempt_category = case when p_exempt then coalesce(p_category, exempt_category)
                                else null end,
         notes  = coalesce(p_notes, notes)
   where id = p_event_id and dsp_id = v_dsp;

  if not found then
    raise exception 'mark_attendance_exempt: event % not in DSP %', p_event_id, v_dsp;
  end if;
end $$;

revoke execute on function public.mark_attendance_exempt(uuid, boolean, text, text)
  from public, anon;
grant execute on function public.mark_attendance_exempt(uuid, boolean, text, text)
  to authenticated;

-- ─── process_suspension: HR event + cascade ─────────────────────────────
-- Single-transaction cascade:
--   1. Insert hr_events row (which fires sync_driver_status_from_hr trigger)
--   2. Insert coaching_events row (channel='suspend') tied to the HR event
--   3. drivers.status flips to 'suspended' via the trigger
-- The frontend should also (separately) call send-driver-sms in Phase 4.

create or replace function public.process_suspension(
  p_driver_id      uuid,
  p_effective_date date,
  p_return_date    date,           -- null = indefinite or pending termination
  p_pending_term   boolean,        -- true = type='pending_termination', else 'suspension'
  p_category       text,           -- 'attendance','safety','conduct','scorecard','theft','other'
  p_detail         text,
  p_evidence_refs  jsonb default '{}'::jsonb,
  p_attached_files text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_caller     uuid := auth.uid();
  v_hr_id      uuid;
  v_coach_id   uuid;
  v_event_type public.hr_event_type;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'process_suspension: caller is not ops staff';
  end if;
  if p_detail is null or length(trim(p_detail)) < 10 then
    raise exception 'process_suspension: reason_detail required (≥ 10 chars) for HR record';
  end if;

  perform 1 from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if not found then
    raise exception 'process_suspension: driver % not in DSP %', p_driver_id, v_dsp;
  end if;

  v_event_type := case when p_pending_term then 'pending_termination'::public.hr_event_type
                                            else 'suspension'::public.hr_event_type end;

  insert into public.hr_events
    (dsp_id, driver_id, event_type, severity, effective_date, return_date,
     reason_category, reason_detail, evidence_refs, attached_files, initiated_by)
  values
    (v_dsp, p_driver_id, v_event_type,
     case when p_pending_term then 'critical'::public.hr_severity
                              else 'major'::public.hr_severity end,
     p_effective_date, p_return_date,
     p_category, p_detail, p_evidence_refs, p_attached_files, v_caller)
  returning id into v_hr_id;

  insert into public.coaching_events
    (dsp_id, driver_id, category, channel, context_summary, related_hr_event_id, initiated_by)
  values
    (v_dsp, p_driver_id, coalesce(p_category, 'other'), 'suspend',
     'Suspension: ' || left(p_detail, 200),
     v_hr_id, v_caller)
  returning id into v_coach_id;

  -- Phase 3 will add: release future shifts to status=open
  -- Phase 4 will add: send driver SMS notice

  return jsonb_build_object(
    'hr_event_id',     v_hr_id,
    'coaching_event_id', v_coach_id,
    'driver_status',  (select status from public.drivers where id = p_driver_id),
    'message',        'Driver suspended; HR record created and driver status flipped.'
  );
end $$;

revoke execute on function public.process_suspension(uuid, date, date, boolean, text, text, jsonb, text[])
  from public, anon;
grant execute on function public.process_suspension(uuid, date, date, boolean, text, text, jsonb, text[])
  to authenticated;

-- ─── process_reinstatement: undo suspension ─────────────────────────────

create or replace function public.process_reinstatement(
  p_driver_id  uuid,
  p_reason     text,
  p_effective_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_caller  uuid := auth.uid();
  v_hr_id   uuid;
  v_coach_id uuid;
  v_active  uuid;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'process_reinstatement: caller is not ops staff';
  end if;

  -- Verify there's actually an active suspension to reinstate from
  select id into v_active
    from public.active_suspensions
   where driver_id = p_driver_id and dsp_id = v_dsp
   limit 1;

  if v_active is null then
    -- Look for pending_termination as well
    select id into v_active
      from public.hr_events
     where driver_id = p_driver_id
       and dsp_id = v_dsp
       and event_type = 'pending_termination'
       and not exists (
         select 1 from public.hr_events v
          where v.event_type = 'void' and v.superseded_by = hr_events.id
       )
     order by effective_date desc
     limit 1;
  end if;

  if v_active is null then
    raise exception 'process_reinstatement: no active suspension or pending termination for driver %', p_driver_id;
  end if;

  insert into public.hr_events
    (dsp_id, driver_id, event_type, severity, effective_date,
     reason_category, reason_detail, initiated_by)
  values
    (v_dsp, p_driver_id, 'reinstatement', 'info',
     p_effective_date, 'other', coalesce(nullif(trim(p_reason),''), 'Reinstatement'),
     v_caller)
  returning id into v_hr_id;

  insert into public.coaching_events
    (dsp_id, driver_id, category, channel, context_summary,
     related_hr_event_id, initiated_by)
  values
    (v_dsp, p_driver_id, 'other', 'in_person',
     'Reinstatement from prior suspension',
     v_hr_id, v_caller)
  returning id into v_coach_id;

  return jsonb_build_object(
    'hr_event_id', v_hr_id,
    'coaching_event_id', v_coach_id,
    'driver_status', (select status from public.drivers where id = p_driver_id),
    'message', 'Driver reinstated; HR record updated.'
  );
end $$;

revoke execute on function public.process_reinstatement(uuid, text, date)
  from public, anon;
grant execute on function public.process_reinstatement(uuid, text, date)
  to authenticated;

-- ─── void_hr_event: undo a prior HR event ───────────────────────────────
-- Voiding inserts a new event with event_type='void' and superseded_by
-- pointing at the original. The original row is preserved.

create or replace function public.void_hr_event(
  p_event_id uuid,
  p_reason   text
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_caller  uuid := auth.uid();
  v_orig    public.hr_events%rowtype;
  v_void_id uuid;
begin
  -- Only owner can void; this is a high-stakes action
  if v_dsp is null or not private.is_staff(v_dsp, 'owner') then
    raise exception 'void_hr_event: owner only';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'void_hr_event: reason required (≥ 10 chars)';
  end if;

  select * into v_orig
    from public.hr_events
   where id = p_event_id and dsp_id = v_dsp;

  if not found then
    raise exception 'void_hr_event: event % not in DSP %', p_event_id, v_dsp;
  end if;
  if v_orig.event_type = 'void' then
    raise exception 'void_hr_event: cannot void a void event';
  end if;
  if exists (select 1 from public.hr_events where superseded_by = v_orig.id) then
    raise exception 'void_hr_event: event % is already voided', p_event_id;
  end if;

  insert into public.hr_events
    (dsp_id, driver_id, event_type, severity, effective_date,
     reason_category, reason_detail, superseded_by, initiated_by)
  values
    (v_dsp, v_orig.driver_id, 'void', 'info', current_date,
     v_orig.reason_category,
     'VOID of ' || v_orig.event_type::text || '. ' || p_reason,
     v_orig.id, v_caller)
  returning id into v_void_id;

  return v_void_id;
end $$;

revoke execute on function public.void_hr_event(uuid, text) from public, anon;
grant execute on function public.void_hr_event(uuid, text) to authenticated;

-- ─── log_coaching: convenience wrapper for non-HR coaching ──────────────

create or replace function public.log_coaching(
  p_driver_id      uuid,
  p_category       text,
  p_channel        text,
  p_message_body   text default null,
  p_context        text default null,
  p_evidence_refs  jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp    uuid := private.current_dsp_id();
  v_caller uuid := auth.uid();
  v_id     uuid;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'log_coaching: caller is not staff';
  end if;
  if p_channel = 'suspend' then
    raise exception 'log_coaching: use process_suspension() for channel=suspend';
  end if;

  insert into public.coaching_events
    (dsp_id, driver_id, category, channel,
     message_body, context_summary, evidence_refs, initiated_by)
  values
    (v_dsp, p_driver_id, p_category, p_channel,
     p_message_body, p_context, p_evidence_refs, v_caller)
  returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.log_coaching(uuid, text, text, text, text, jsonb)
  from public, anon;
grant execute on function public.log_coaching(uuid, text, text, text, text, jsonb)
  to authenticated;
