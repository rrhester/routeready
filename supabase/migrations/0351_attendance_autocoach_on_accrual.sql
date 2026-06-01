-- 0351_attendance_autocoach_on_accrual.sql
-- Auto-coaching the moment attendance points cross a ladder rung.
--
-- Behaviour the operator asked for:
--   • Policy ON  + auto-coach ON  → a coaching is created automatically as
--     soon as a driver's window points cross an auto-fire ladder rung,
--     from ANY source (seed, manual status edit, daily approval).
--   • Policy ON  + auto-coach OFF → nothing auto-fires; the crossing simply
--     sits as the "Send coaching" suggestion on the report (the queue).
--   • Policy OFF → no auto-coaching at all.
--   • Termination NEVER auto-fires.
--
-- This trigger covers the non-approval sources. The existing approval path
-- (attendance_decide, 0086) already auto-fires on Approve, and it upserts
-- an attendance_decisions row BEFORE updating shifts.status — so this
-- trigger skips any shift that has a decision (the approval path owns it),
-- which prevents double-coaching. A driver-visible coaching insert also
-- fires the 0350 push trigger, so the driver is notified.
--
-- Idempotent: create or replace + drop trigger if exists. Everything is
-- wrapped so a policy/parse error can never block a shift write.

-- ── Core: evaluate one driver and auto-fire if warranted ───────────────
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
  v_p_call   numeric := 0;
  v_p_no     numeric := 0;
  v_p_late   numeric := 0;
  v_block    jsonb;
  v_since    date;
  v_late int; v_call int; v_no int;
  v_points   numeric := 0;
  v_best     numeric := -1;
  v_sev      text;
  v_deliv    text;
  v_autofire boolean := false;
begin
  select metadata->'attendance'->'policy' into v_policy
  from public.dsps where id = p_dsp_id;
  if v_policy is null then return; end if;

  v_enabled := coalesce((v_policy->>'policy_enabled')::boolean, true);
  v_auto    := coalesce((v_policy->>'auto_coaching')::boolean, false);
  if not v_enabled or not v_auto then return; end if;

  -- Window + per-event point weights from the block policy.
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

  -- Occurrence counts in the window, minus operator-excused (deny) shifts.
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
    and s.status in ('late','called_off','no_show');

  v_points := coalesce(v_late,0) * v_p_late
            + coalesce(v_call,0) * v_p_call
            + coalesce(v_no,0)   * v_p_no;

  -- Highest ladder rung whose threshold <= points.
  for v_block in select jsonb_array_elements(coalesce(v_policy->'blocks','[]'::jsonb)) loop
    if v_block->>'type' = 'ladder_rung'
       and coalesce((v_block->>'threshold')::numeric, 0) <= v_points
       and coalesce((v_block->>'threshold')::numeric, 0) > v_best then
      v_best     := coalesce((v_block->>'threshold')::numeric, 0);
      v_sev      := v_block->>'severity';
      v_deliv    := coalesce(v_block->>'delivery', 'ack');
      v_autofire := coalesce((v_block->>'auto_fire')::boolean, false);
    end if;
  end loop;

  -- Nothing to do: below all rungs, termination, or this rung isn't auto-fire.
  if v_sev is null or v_sev = 'termination' or not v_autofire then return; end if;

  -- Don't re-fire: skip if a live attendance coaching at this severity
  -- already exists in the window (covers the approval path + prior runs).
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

-- ── Trigger: fire on a shift becoming an attendance occurrence ─────────
create or replace function private.tg_shift_autocoach()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.driver_id is not null and new.status in ('late','called_off','no_show') then
    -- The approval path (attendance_decide) auto-fires for shifts it
    -- decides, and it upserts the decision row before this status change,
    -- so a decision on this shift means "approval owns it" → skip.
    if not exists (
      select 1 from public.attendance_decisions dec where dec.shift_id = new.id
    ) then
      begin
        perform private.att_autocoach_for_driver(new.dsp_id, new.driver_id, new.id);
      exception when others then
        null;  -- never block the shift write on an auto-coach failure
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

-- ── One-time backfill: catch drivers already over a threshold ──────────
-- For every driver with attendance occurrences, evaluate once now. The
-- function self-gates on policy/auto-coach being on and de-dups against
-- existing coachings, so this only fires for genuinely over-threshold,
-- not-yet-coached drivers in DSPs that have auto-coach enabled.
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
