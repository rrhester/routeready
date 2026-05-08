-- Hotfix for #506: VTO from the daily decide tool returned
-- "invalid_decision" because two attendance_decide overloads coexist
-- in the database — a 6-arg version (created by 0085) and a 7-arg
-- version (re-added by 0086 with p_delivery). Migration 0099 only
-- updated the 6-arg version to accept decision='vto'. The dashboard
-- passes p_delivery on every call, so PostgREST kept routing to the
-- 7-arg overload, which still rejected 'vto'.
--
-- Replace the 7-arg overload with the same VTO-aware body. The
-- p_delivery parameter is accepted for compatibility but ignored —
-- 0085 already removed the queued-coaching path that used it, and
-- nothing currently in the function reads it.

create or replace function public.attendance_decide(
  p_shift_id  uuid,
  p_outcome   text,
  p_decision  text,
  p_notes     text default null,
  p_auto_fire boolean default false,
  p_level     text default null,
  p_delivery  text default null
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
  if p_decision not in ('approve','deny','vto') then
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
    update public.shifts set status = v_status::public.shift_status where id = p_shift_id;
  elsif p_decision = 'vto' then
    update public.shifts set status = 'vto'::public.shift_status where id = p_shift_id;
  end if;

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
    'shift_status', case
                      when p_decision = 'approve' then v_status
                      when p_decision = 'vto'     then 'vto'
                      else v_shift.status::text
                    end
  );
end;
$$;
grant execute on function public.attendance_decide(uuid, text, text, text, boolean, text, text) to authenticated;

-- Drop the now-unused 6-arg overload that 0099 created in parallel.
drop function if exists public.attendance_decide(uuid, text, text, text, boolean, text);

notify pgrst, 'reload schema';
