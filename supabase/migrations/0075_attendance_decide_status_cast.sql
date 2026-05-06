-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0075 · Hotfix · attendance_decide enum cast
--
-- 0071's body assigns `v_status` (declared text) into shifts.status, which
-- is the enum public.shift_status.  Postgres rejects the assignment with:
--
--   column "status" is of type public.shift_status but expression is of
--   type text
--
-- Re-create the function with an explicit cast on the assignment.  Logic
-- is otherwise identical to 0071.  Safe to re-apply.
-- ─────────────────────────────────────────────────────────────────────────

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
  v_shift      public.shifts;
  v_drv        public.drivers;
  v_status     text;
  v_summary    text;
  v_chat_msg   text;
  v_dsp_name   text;
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

  insert into public.attendance_decisions
    (dsp_id, driver_id, shift_id, outcome, decision, notes, decided_by)
  values
    (v_dsp, v_drv.id, p_shift_id, p_outcome, p_decision,
     nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
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
    -- Cast the text into the shift_status enum.  Without this Postgres
    -- rejects the assignment because v_status is declared text.
    update public.shifts
       set status = v_status::public.shift_status
     where id = p_shift_id;
  end if;

  if p_decision = 'approve' then
    v_dsp_name := coalesce((select name from public.dsps where id = v_dsp), 'Dispatch');
    v_summary := case p_outcome
      when 'ncns'            then 'No-call no-show on ' || to_char(v_shift.date, 'Mon DD')
      when 'tardy'           then 'Tardy on '           || to_char(v_shift.date, 'Mon DD')
      when 'missed_reported' then 'Callout on '         || to_char(v_shift.date, 'Mon DD')
    end;

    if p_auto_fire and (p_level is null or p_level <> 'termination') then
      v_did_auto := true;

      insert into public.coachings
        (dsp_id, driver_id, coach_user_id, topic, type, summary, notes, metadata)
      values
        (v_dsp, v_drv.id, auth.uid(),
         'attendance'::public.coaching_topic,
         'documented_warning'::public.coaching_type,
         v_summary,
         coalesce(p_notes, ''),
         jsonb_build_object(
           'source',   'attendance_decide',
           'shift_id', p_shift_id,
           'outcome',  p_outcome,
           'level',    coalesce(p_level, ''),
           'auto',     true
         ));

      v_chat_msg := case p_outcome
        when 'ncns'            then 'You were marked no-call no-show for your '   || to_char(v_shift.date, 'Mon DD') || ' shift. Reach out if you think this is an error. — ' || v_dsp_name
        when 'tardy'           then 'You were marked tardy for your '              || to_char(v_shift.date, 'Mon DD') || ' shift. — ' || v_dsp_name
        when 'missed_reported' then 'Your callout for '                            || to_char(v_shift.date, 'Mon DD') || ' has been logged. — ' || v_dsp_name
      end;
      insert into public.driver_messages
        (driver_id, dsp_id, sender_kind, sender_user_id, body)
      values (v_drv.id, v_dsp, 'dispatch', auth.uid(), v_chat_msg);
      insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
      values (v_drv.id, v_dsp, now())
      on conflict (driver_id) do update set last_message_at = excluded.last_message_at;
    else
      insert into public.coachings
        (dsp_id, driver_id, coach_user_id, topic, type, summary, notes, metadata)
      values
        (v_dsp, v_drv.id, auth.uid(),
         'attendance'::public.coaching_topic,
         'documented_warning'::public.coaching_type,
         v_summary,
         coalesce(p_notes, ''),
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
