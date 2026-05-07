-- 0085_attendance_decide_drop_queued.sql
--
-- Drops the "Queued" coaching state.  Migration 0084 had
-- attendance_decide write a coaching row with driver_visible=false
-- whenever an Approve happened but auto-fire wouldn't actually
-- deliver (master toggle off, level not opted-in, or termination).
-- The intent was a leader would later finalize those rows from a
-- coaching drawer — but no UI was ever built for that, so they sat
-- in the DB invisible to the driver and unactionable for the
-- dispatcher.
--
-- The clean model the dispatcher described:
--   • Auto-fire ON for a level   → write a coaching, deliver to driver
--   • Auto-fire OFF for a level  → write nothing.  Approve still
--                                  stamps shifts.status (the Event
--                                  log + Report still record the
--                                  event).  Operator manually fires
--                                  a coaching from the Report row
--                                  when they want one.
--
-- This migration:
--   1. Recreates attendance_decide without the auto-fire-off branch.
--   2. Archives every previously-queued coaching
--      (driver_visible=false AND topic='attendance' AND
--       metadata->>'source'='attendance_decide') so the existing UI
--      stops showing them.

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

  -- Coaching insert ONLY when auto-fire is set up to actually
  -- deliver.  Termination never auto-fires by design.  Otherwise the
  -- approval is silent on the coaching side — operator decides what
  -- to do from the Report row's Send coaching button.
  if p_decision = 'approve' and p_auto_fire and p_level is not null and p_level <> 'termination' then
    v_summary := case p_outcome
      when 'ncns'            then 'No-call no-show on ' || to_char(v_shift.date, 'Mon DD')
      when 'tardy'           then 'Tardy on '           || to_char(v_shift.date, 'Mon DD')
      when 'missed_reported' then 'Callout on '         || to_char(v_shift.date, 'Mon DD')
    end;

    v_severity := case p_level
      when 'verbal'      then 'verbal'
      when 'written'     then 'written'
      when 'final'       then 'final'
      else 'verbal'
    end;

    select metadata into v_dsp_meta from public.dsps where id = v_dsp;
    v_policy := coalesce(v_dsp_meta->'attendance'->'policy', '{}'::jsonb);
    v_delivery := coalesce(v_policy->>('delivery_' || v_severity), 'ack');

    v_did_auto := true;

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
         'level',    p_level,
         'auto',     true
       ));
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


-- Archive every previously-queued coaching so the UI stops showing
-- them.  Targets only attendance_decide-sourced rows that never
-- went visible — manual coachings always set driver_visible=true,
-- so they're untouched.
update public.coachings
   set archived_at      = coalesce(archived_at, now()),
       archived_reason  = coalesce(archived_reason, 'queued_state_dropped_in_0085')
 where driver_visible = false
   and topic          = 'attendance'
   and archived_at    is null
   and (metadata->>'source') = 'attendance_decide';


notify pgrst, 'reload schema';
