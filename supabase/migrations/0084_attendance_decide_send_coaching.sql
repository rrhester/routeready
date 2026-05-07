-- 0084_attendance_decide_send_coaching.sql
--
-- Phase 2 of the coaching system overhaul.  When an operator hits
-- Approve on Today's Plan and the policy has auto-coaching turned
-- on for that severity level, attendance_decide should now emit a
-- coaching that drops into the driver's /tasks/coaching feed —
-- using the new severity / delivery_required / triggering_shift_id
-- fields from migration 0083.
--
-- The legacy path (driver_messages chat insert) is removed.  All
-- driver-facing communication for attendance coachings now flows
-- through the unified coaching feed; chat is only for free-form
-- back-and-forth.
--
-- Severity mapping when auto-firing:
--   p_level = 'verbal'      → coaching_severity 'verbal'
--   p_level = 'written'     → 'written'
--   p_level = 'final'       → 'final'
--   p_level = 'termination' → never auto-fires (UI prevents it)
--
-- delivery_required for auto-fired coachings comes from the
-- policy's per-severity defaults at
-- dsps.metadata.attendance.policy.delivery_<level>.  Falls back to
-- 'ack' when unset.
--
-- Non-auto-fire decisions still insert a coaching row, but with
-- driver_visible = false so the dispatcher can finalize it from the
-- coaching drawer before the driver sees it (preserves the
-- "queued for review" workflow).

create or replace function public.attendance_decide(
  p_shift_id  uuid,
  p_outcome   text,
  p_decision  text,
  p_notes     text default null,
  p_auto_fire boolean default false,
  p_level     text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_uid        uuid := auth.uid();
  v_app_user_id uuid;
  v_shift      public.shifts;
  v_drv        public.drivers;
  v_status     text;
  v_summary    text;
  v_dsp_meta   jsonb;
  v_policy     jsonb;
  v_delivery   text;
  v_severity   text;
  v_did_auto   boolean := false;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_decision not in ('approve','deny') then
    raise exception 'invalid_decision' using errcode = 'P0001';
  end if;
  if p_outcome not in ('ncns','tardy','missed_reported') then
    raise exception 'invalid_outcome' using errcode = 'P0001';
  end if;
  if p_decision = 'deny' and (p_notes is null or trim(p_notes) = '') then
    raise exception 'notes_required' using errcode = 'P0001';
  end if;

  select * into v_shift from public.shifts where id = p_shift_id and dsp_id = v_dsp;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;
  if v_shift.driver_id is null then
    raise exception 'shift_unassigned' using errcode = 'P0002';
  end if;

  select * into v_drv from public.drivers where id = v_shift.driver_id;
  select id into v_app_user_id from public.app_users where id = v_uid limit 1;

  insert into public.attendance_decisions
    (dsp_id, driver_id, shift_id, outcome, decision, notes, decided_by)
  values
    (v_dsp, v_drv.id, p_shift_id, p_outcome, p_decision,
     nullif(trim(coalesce(p_notes, '')), ''), v_uid)
  on conflict (shift_id) do update
    set outcome    = excluded.outcome,
        decision   = excluded.decision,
        notes      = excluded.notes,
        decided_by = excluded.decided_by,
        created_at = now();

  v_status := case p_outcome
    when 'ncns'            then 'no_show'
    when 'tardy'           then 'late'
    when 'missed_reported' then 'called_off'
  end;
  if p_decision = 'approve' then
    update public.shifts
       set status = v_status::public.shift_status
     where id = p_shift_id;
  end if;

  if p_decision = 'approve' then
    v_summary := case p_outcome
      when 'ncns'            then 'No-call no-show on ' || to_char(v_shift.date, 'Mon DD')
      when 'tardy'           then 'Tardy on '           || to_char(v_shift.date, 'Mon DD')
      when 'missed_reported' then 'Callout on '         || to_char(v_shift.date, 'Mon DD')
    end;

    -- Map p_level (text) → coaching_severity enum value.
    v_severity := case p_level
      when 'verbal'      then 'verbal'
      when 'written'     then 'written'
      when 'final'       then 'final'
      when 'termination' then 'termination'
      else 'verbal'  -- safety net; UI shouldn't omit this
    end;

    if p_auto_fire and (p_level is null or p_level <> 'termination') then
      -- Pull the policy's per-severity delivery default.  The policy
      -- lives on dsps.metadata.attendance.policy; field name is
      -- delivery_<level>.  Fall back to 'ack' when unset.
      select metadata into v_dsp_meta from public.dsps where id = v_dsp;
      v_policy := coalesce(v_dsp_meta->'attendance'->'policy', '{}'::jsonb);
      v_delivery := coalesce(
        v_policy->>('delivery_' || v_severity),
        'ack'
      );

      v_did_auto := true;

      -- driver_visible = true so the coaching surfaces in the new
      -- /tasks/coaching feed immediately.
      insert into public.coachings
        (dsp_id, driver_id, coach_user_id, topic, type, severity,
         summary, notes,
         driver_visible, delivery_required, triggering_shift_id,
         metadata)
      values
        (v_dsp, v_drv.id, v_app_user_id,
         'attendance'::public.coaching_topic,
         'documented_warning'::public.coaching_type,
         v_severity::public.coaching_severity,
         v_summary,
         coalesce(p_notes, ''),
         true,
         v_delivery::public.coaching_delivery,
         p_shift_id,
         jsonb_build_object(
           'source',   'attendance_decide',
           'shift_id', p_shift_id,
           'outcome',  p_outcome,
           'level',    coalesce(p_level, ''),
           'auto',     true
         ));

      -- No driver_messages chat insert here — the unified coaching
      -- feed (driver_list_coachings + /tasks/coaching) is now the
      -- delivery surface.  Chat stays for free-form messages only.
    else
      -- Approved but auto-fire is off (or level is termination).
      -- Insert a coaching row that's NOT driver-visible yet so the
      -- dispatcher finalizes it from the coaching drawer.
      insert into public.coachings
        (dsp_id, driver_id, coach_user_id, topic, type, severity,
         summary, notes,
         driver_visible, delivery_required,
         metadata)
      values
        (v_dsp, v_drv.id, v_app_user_id,
         'attendance'::public.coaching_topic,
         'documented_warning'::public.coaching_type,
         v_severity::public.coaching_severity,
         v_summary,
         coalesce(p_notes, ''),
         false,
         'ack'::public.coaching_delivery,
         jsonb_build_object(
           'source',   'attendance_decide',
           'shift_id', p_shift_id,
           'outcome',  p_outcome,
           'level',    coalesce(p_level, ''),
           'pending',  true
         ));
    end if;
  end if;

  return jsonb_build_object(
    'ok',           true,
    'decision',     p_decision,
    'auto_fired',   v_did_auto,
    'level',        p_level,
    'shift_status', case p_decision when 'approve' then v_status else v_shift.status::text end
  );
end;
$$;

notify pgrst, 'reload schema';
