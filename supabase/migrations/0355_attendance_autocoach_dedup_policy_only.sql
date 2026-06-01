-- 0355_attendance_autocoach_dedup_policy_only.sql
-- Fix: a seed/manual attendance coaching (no policy source, no triggering
-- shift) was blocking the auto-coach de-dup, so the real policy coaching was
-- never created — yet the report hides that seed coaching, so the driver kept
-- showing "Send coaching" forever (e.g. Jack Hester: final/no-source/no-trig).
--
-- The de-dup now only counts POLICY coachings (auto_accrual / attendance_decide
-- / report, or anything tied to a triggering occurrence) — the same definition
-- the report uses to display them. A stray manual/seed Final can no longer
-- block a genuine auto-coaching. Then re-run the catch-up so wedged drivers
-- get their real policy coaching now.
--
-- Self-contained-ish: redefines att_autocoach_for_driver (att_window_points is
-- unchanged from 0353/0354 and already installed). Idempotent.

create or replace function private.att_autocoach_for_driver(
  p_dsp_id uuid, p_driver_id uuid, p_trigger_shift uuid default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_policy jsonb; v_enabled boolean; v_auto boolean;
  v_decay int := 90; v_points numeric; v_block jsonb;
  v_best numeric := -1; v_sev text; v_deliv text; v_autofire boolean := false;
  v_thr numeric; v_shift uuid;
begin
  select metadata->'attendance'->'policy' into v_policy from public.dsps where id = p_dsp_id;
  if v_policy is null then return; end if;
  v_enabled := coalesce((v_policy->>'policy_enabled')::boolean, true);
  v_auto    := coalesce((v_policy->>'auto_coaching')::boolean, false);
  if not v_enabled or not v_auto then return; end if;

  v_points := private.att_window_points(p_dsp_id, p_driver_id);

  for v_block in select jsonb_array_elements(coalesce(v_policy->'blocks','[]'::jsonb)) loop
    if v_block->>'type' = 'window' then
      v_decay := greatest(1, coalesce((v_block->>'days')::int, 90));
    elsif v_block->>'type' = 'ladder_rung'
          and nullif(trim(coalesce(v_block->>'threshold','')), '') is not null then
      v_thr := (v_block->>'threshold')::numeric;
      if v_thr <= v_points and v_thr > v_best then
        v_best := v_thr; v_sev := v_block->>'severity';
        v_deliv := coalesce(v_block->>'delivery','ack');
        v_autofire := coalesce((v_block->>'auto_fire')::boolean, false);
      end if;
    end if;
  end loop;

  if v_sev is null or v_sev = 'termination' or not v_autofire then return; end if;

  -- Don't re-fire: only count POLICY coachings (matches the report's display
  -- rule). A manual/seed coaching with no source + no triggering shift must
  -- NOT block a genuine auto-coaching.
  if exists (
    select 1 from public.coachings c
    where c.dsp_id = p_dsp_id and c.driver_id = p_driver_id
      and c.topic = 'attendance'::public.coaching_topic and c.archived_at is null
      and c.created_at >= (current_date - v_decay)::timestamptz
      and (c.severity::text = v_sev or lower(coalesce(c.metadata->>'level','')) = v_sev)
      and (c.metadata->>'source' in ('auto_accrual','attendance_decide','report')
           or c.triggering_shift_id is not null)
  ) then
    return;
  end if;

  v_shift := p_trigger_shift;
  if v_shift is null then
    select s.id into v_shift
    from public.shifts s
    left join public.attendance_decisions dec on dec.shift_id = s.id and dec.decision = 'deny'
    where s.dsp_id = p_dsp_id and s.driver_id = p_driver_id
      and s.date <= current_date and s.date >= current_date - v_decay
      and s.status in ('late','called_off','no_show') and dec.shift_id is null
    order by s.date desc
    limit 1;
  end if;

  insert into public.coachings
    (dsp_id, driver_id, coach_user_id, topic, type, severity,
     summary, notes, driver_visible, delivery_required, triggering_shift_id, metadata)
  values
    (p_dsp_id, p_driver_id, null,
     'attendance'::public.coaching_topic, 'documented_warning'::public.coaching_type,
     v_sev::public.coaching_severity,
     'Attendance points reached ' || trim(to_char(v_points, 'FM999990.0')),
     '', true, v_deliv::public.coaching_delivery, v_shift,
     jsonb_build_object('source','auto_accrual','level',v_sev,'auto',true,'points',v_points));
end;
$$;

-- Re-run the catch-up so wedged drivers (Jack, Chucky) get their real
-- policy coaching now.
do $$
declare r record;
begin
  for r in
    select distinct s.dsp_id, s.driver_id
    from public.shifts s
    where s.driver_id is not null
      and s.status in ('late','called_off','no_show')
  loop
    begin
      perform private.att_autocoach_for_driver(r.dsp_id, r.driver_id, null);
    exception when others then null;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';
