-- 0354_attendance_autocoach_on_approve.sql
-- Make the DB trigger the single source of truth for attendance auto-coaching,
-- including the APPROVAL path.
--
-- Before: trg_shift_autocoach skipped any shift that had an attendance_decision
-- row, trusting attendance_decide's JS-driven auto-fire to handle approvals.
-- That JS path could miscompute and silently not fire (e.g. an approved NCNS
-- that crosses Final never got coached). Now the trigger fires on approved
-- occurrences too and only steps aside for EXCUSED (deny) shifts. The dashboard
-- now passes p_auto_fire=false to attendance_decide, so there's no double-fire.
--
-- Self-contained + idempotent: safe to run on its own.

-- ── Helper functions (unchanged from 0353; redefined for self-containment) ──
create or replace function private.att_window_points(p_dsp_id uuid, p_driver_id uuid)
returns numeric
language plpgsql security definer set search_path = ''
as $$
declare
  v_policy jsonb; v_decay int := 90;
  v_p_call numeric := 0; v_p_no numeric := 0; v_p_late numeric := 0;
  v_block jsonb; v_since date; v_late int; v_call int; v_no int;
begin
  select metadata->'attendance'->'policy' into v_policy from public.dsps where id = p_dsp_id;
  if v_policy is null then return 0; end if;
  for v_block in select jsonb_array_elements(coalesce(v_policy->'blocks','[]'::jsonb)) loop
    if v_block->>'type' = 'window' then
      v_decay := greatest(1, coalesce((v_block->>'days')::int, 90));
    elsif v_block->>'type' = 'event' then
      if    v_block->>'kind' = 'callout' then v_p_call := coalesce((v_block->>'points')::numeric, 0);
      elsif v_block->>'kind' = 'no_show' then v_p_no   := coalesce((v_block->>'points')::numeric, 0);
      elsif v_block->>'kind' = 'late'    then v_p_late := coalesce((v_block->>'points')::numeric, 0);
      end if;
    end if;
  end loop;
  v_since := current_date - v_decay;
  select
    count(*) filter (where s.status = 'late'       and dec.shift_id is null),
    count(*) filter (where s.status = 'called_off' and dec.shift_id is null),
    count(*) filter (where s.status = 'no_show'    and dec.shift_id is null)
  into v_late, v_call, v_no
  from public.shifts s
  left join public.attendance_decisions dec
    on dec.shift_id = s.id and dec.decision = 'deny'
  where s.dsp_id = p_dsp_id and s.driver_id = p_driver_id
    and s.date >= v_since and s.date <= current_date
    and s.status in ('late','called_off','no_show');
  return coalesce(v_late,0)*v_p_late + coalesce(v_call,0)*v_p_call + coalesce(v_no,0)*v_p_no;
end;
$$;

create or replace function private.att_rung_threshold(p_dsp_id uuid, p_sev text)
returns numeric
language plpgsql security definer set search_path = ''
as $$
declare v_policy jsonb; v_block jsonb; v_thr numeric;
begin
  select metadata->'attendance'->'policy' into v_policy from public.dsps where id = p_dsp_id;
  if v_policy is null then return null; end if;
  for v_block in select jsonb_array_elements(coalesce(v_policy->'blocks','[]'::jsonb)) loop
    if v_block->>'type' = 'ladder_rung' and v_block->>'severity' = p_sev
       and nullif(trim(coalesce(v_block->>'threshold','')), '') is not null then
      v_thr := (v_block->>'threshold')::numeric;
    end if;
  end loop;
  return v_thr;
end;
$$;

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

  if exists (
    select 1 from public.coachings c
    where c.dsp_id = p_dsp_id and c.driver_id = p_driver_id
      and c.topic = 'attendance'::public.coaching_topic and c.archived_at is null
      and c.created_at >= (current_date - v_decay)::timestamptz
      and (c.severity::text = v_sev or lower(coalesce(c.metadata->>'level','')) = v_sev)
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

-- ── Trigger: fire on any occurrence EXCEPT excused (deny) ──────────────
-- Previously skipped any shift with a decision; now it only steps aside for
-- excused shifts, so APPROVED occurrences auto-coach too. attendance_decide
-- upserts the decision row before the status update, so by the time this
-- fires the approve/deny decision is already visible.
create or replace function private.tg_shift_autocoach()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.driver_id is not null and new.status in ('late','called_off','no_show') then
    if not exists (
      select 1 from public.attendance_decisions dec
      where dec.shift_id = new.id and dec.decision = 'deny'
    ) then
      begin
        perform private.att_autocoach_for_driver(new.dsp_id, new.driver_id, new.id);
      exception when others then null;
      end;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_shift_autocoach on public.shifts;
create trigger trg_shift_autocoach
  after insert or update of status on public.shifts
  for each row execute function private.tg_shift_autocoach();

-- ── Catch-up: coach everyone currently over an auto-fire threshold ─────
-- Picks up approved-but-not-coached drivers (e.g. Ken) and any others.
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
