-- 0352_attendance_autocoach_fix_window_and_cleanup.sql
-- Fixes two bugs in the 0351 auto-coach backfill/trigger and cleans up the
-- phantom coachings it created.
--
-- Bug 1 — window had no upper bound. 0351 scored occurrences with
--   `s.date >= current_date - decay` but never capped at today, while the
--   live roster/report cap at today. So the backfill could score future-
--   dated shifts the live view ignores, fire a coaching, and leave the
--   driver showing 0 live points.
--
-- Bug 2 — a ladder rung with a missing/blank threshold was coalesced to 0,
--   so it matched at 0 points and fired a coaching for a driver with no
--   occurrences at all. A rung without a real threshold must be skipped.
--
-- Cleanup — archive every auto_accrual coaching where the driver does NOT
--   currently qualify for that rung under the corrected math (points capped
--   at today, missing-threshold rungs ignored). This removes phantom Finals
--   (e.g. Jack's) from standing. The driver-facing push already went out and
--   can't be unsent — archiving just clears the record/standing.
--
-- Idempotent: create or replace + guarded updates.

-- ── Capped, deny-excused window points for one driver ──────────────────
create or replace function private.att_window_points(p_dsp_id uuid, p_driver_id uuid)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy jsonb;
  v_decay  int := 90;
  v_p_call numeric := 0; v_p_no numeric := 0; v_p_late numeric := 0;
  v_block  jsonb;
  v_since  date;
  v_late int; v_call int; v_no int;
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
  where s.dsp_id = p_dsp_id
    and s.driver_id = p_driver_id
    and s.date >= v_since
    and s.date <= current_date            -- ← cap at today, matching the live view
    and s.status in ('late','called_off','no_show');

  return coalesce(v_late,0) * v_p_late
       + coalesce(v_call,0) * v_p_call
       + coalesce(v_no,0)   * v_p_no;
end;
$$;

-- ── Threshold for a severity in the dsp's ladder (null if no real rung) ─
-- A rung with a missing/blank threshold is NOT a threshold of 0 — it's
-- skipped, so it can never match at 0 points.
create or replace function private.att_rung_threshold(p_dsp_id uuid, p_sev text)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare v_policy jsonb; v_block jsonb; v_thr numeric;
begin
  select metadata->'attendance'->'policy' into v_policy from public.dsps where id = p_dsp_id;
  if v_policy is null then return null; end if;
  for v_block in select jsonb_array_elements(coalesce(v_policy->'blocks','[]'::jsonb)) loop
    if v_block->>'type' = 'ladder_rung'
       and v_block->>'severity' = p_sev
       and nullif(trim(coalesce(v_block->>'threshold','')), '') is not null then
      v_thr := (v_block->>'threshold')::numeric;
    end if;
  end loop;
  return v_thr;
end;
$$;

-- ── Re-evaluate one driver and auto-fire (corrected) ───────────────────
create or replace function private.att_autocoach_for_driver(
  p_dsp_id uuid, p_driver_id uuid, p_trigger_shift uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy   jsonb;
  v_enabled  boolean;
  v_auto     boolean;
  v_decay    int := 90;
  v_points   numeric;
  v_block    jsonb;
  v_best     numeric := -1;
  v_sev      text;
  v_deliv    text;
  v_autofire boolean := false;
  v_thr      numeric;
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
        v_best     := v_thr;
        v_sev      := v_block->>'severity';
        v_deliv    := coalesce(v_block->>'delivery', 'ack');
        v_autofire := coalesce((v_block->>'auto_fire')::boolean, false);
      end if;
    end if;
  end loop;

  if v_sev is null or v_sev = 'termination' or not v_autofire then return; end if;

  if exists (
    select 1 from public.coachings c
    where c.dsp_id = p_dsp_id
      and c.driver_id = p_driver_id
      and c.topic = 'attendance'::public.coaching_topic
      and c.archived_at is null
      and c.created_at >= (current_date - v_decay)::timestamptz
      and (c.severity::text = v_sev or lower(coalesce(c.metadata->>'level','')) = v_sev)
  ) then
    return;
  end if;

  insert into public.coachings
    (dsp_id, driver_id, coach_user_id, topic, type, severity,
     summary, notes, driver_visible, delivery_required, triggering_shift_id, metadata)
  values
    (p_dsp_id, p_driver_id, null,
     'attendance'::public.coaching_topic,
     'documented_warning'::public.coaching_type,
     v_sev::public.coaching_severity,
     'Attendance points reached ' || trim(to_char(v_points, 'FM999990.0')),
     '', true,
     v_deliv::public.coaching_delivery,
     p_trigger_shift,
     jsonb_build_object('source', 'auto_accrual', 'level', v_sev, 'auto', true, 'points', v_points));
end;
$$;

-- ── Clean up phantom auto-coachings from 0351 ──────────────────────────
do $$
declare c record; v_thr numeric; v_pts numeric;
begin
  for c in
    select id, dsp_id, driver_id, severity::text as sev
    from public.coachings
    where metadata->>'source' = 'auto_accrual'
      and archived_at is null
  loop
    v_thr := private.att_rung_threshold(c.dsp_id, c.sev);
    v_pts := private.att_window_points(c.dsp_id, c.driver_id);
    -- No real rung for this severity, or the driver isn't actually over it.
    if v_thr is null or v_pts < v_thr then
      update public.coachings
         set archived_at = now(),
             metadata = coalesce(metadata, '{}'::jsonb)
                        || jsonb_build_object('archived_reason', 'phantom_autocoach_0352',
                                              'archived_points', v_pts)
       where id = c.id;
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
