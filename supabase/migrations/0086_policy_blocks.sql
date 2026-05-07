-- 0086_policy_blocks.sql
--
-- Restructures the attendance policy as an ordered array of typed
-- "blocks" so dispatchers can build their policy click-and-drag in
-- the new policy builder, instead of filling out a fixed form of
-- numeric thresholds.  The block model:
--
--   { id, type, ...config }
--
-- where `type` is one of:
--   • window           — { days: int }                                   rolling decay window
--   • event            — { kind: 'callout'|'no_show'|'late', points }    points per occurrence
--   • ladder_rung      — { severity, threshold, delivery, auto_fire }    a coaching level
--   • auto_escalation  — { kind: 'ncns_terminates'|'first_30_strict', days? }
--   • recovery         — { clean_days, drop_rungs }                      "X clean days = drop one rung"
--
-- This migration:
--   1. Backfills `blocks` on every existing dsp's policy by translating
--      the legacy fields (decay_days / count_* / threshold_* /
--      auto_* / delivery_* / ncns_terminates / first_30_*) into the
--      equivalent block array.  Continuity for existing tenants is
--      total — they open the new builder and see exactly what their
--      policy already was.
--
--   2. Updates attendance_decide to accept a new optional
--      `p_delivery` parameter so the Today's Plan flow can pass the
--      ladder rung's delivery requirement straight from the dashboard
--      JS (which evaluates the blocks).  attendance_decide stops
--      reading delivery_<level> from dsps.metadata — that legacy path
--      is no longer the source of truth.

-- ── 1. Backfill blocks on every existing dsp ──────────────────────
do $$
declare
  r record;
  v_meta     jsonb;
  v_policy   jsonb;
  v_blocks   jsonb := '[]'::jsonb;
  v_decay    int;
  v_warn     int;
  v_count_t  bool;
  v_count_c  bool;
  v_count_n  bool;
  v_auto_v   bool;
  v_auto_w   bool;
  v_auto_f   bool;
  v_del_v    text;
  v_del_w    text;
  v_del_f    text;
  v_del_t    text;
  v_ncns     bool;
  v_first30  bool;
  v_first30d int;
  v_uid      text;
  v_id_seq   int := 0;
begin
  for r in select id, metadata from public.dsps loop
    v_meta   := coalesce(r.metadata, '{}'::jsonb);
    v_policy := coalesce(v_meta->'attendance'->'policy', '{}'::jsonb);

    -- Skip if blocks already exist (idempotent for re-runs).
    if (v_policy->'blocks') is not null and jsonb_typeof(v_policy->'blocks') = 'array' then
      continue;
    end if;

    v_decay    := coalesce((v_policy->>'decay_days')::int, 90);
    v_warn     := coalesce((v_policy->>'threshold_warn')::int, 3);
    v_count_t  := coalesce((v_policy->>'count_tardy')::bool, false);
    v_count_c  := coalesce((v_policy->>'count_callout')::bool, true);
    v_count_n  := coalesce((v_policy->>'count_noshow')::bool, true);
    v_auto_v   := coalesce((v_policy->>'auto_verbal')::bool, false);
    v_auto_w   := coalesce((v_policy->>'auto_written')::bool, false);
    v_auto_f   := coalesce((v_policy->>'auto_final')::bool, false);
    v_del_v    := coalesce(v_policy->>'delivery_verbal', 'ack');
    v_del_w    := coalesce(v_policy->>'delivery_written', 'ack_and_sign');
    v_del_f    := coalesce(v_policy->>'delivery_final', 'ack_and_sign');
    v_del_t    := coalesce(v_policy->>'delivery_termination', 'ack_and_sign');
    v_ncns     := coalesce((v_policy->>'ncns_terminates')::bool, false);
    v_first30  := coalesce((v_policy->>'first_30_strict')::bool, false);
    v_first30d := coalesce((v_policy->>'first_30_window_days')::int, 30);

    -- Fresh block id helper — uuids are generated on demand.
    v_blocks := '[]'::jsonb;

    -- Window block
    v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
      'id',   gen_random_uuid()::text,
      'type', 'window',
      'days', v_decay
    ));

    -- Event blocks (only the kinds the operator was actually counting).
    if v_count_c then
      v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
        'id',     gen_random_uuid()::text,
        'type',   'event',
        'kind',   'callout',
        'points', 1
      ));
    end if;
    if v_count_n then
      v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
        'id',     gen_random_uuid()::text,
        'type',   'event',
        'kind',   'no_show',
        'points', 1
      ));
    end if;
    if v_count_t then
      v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
        'id',     gen_random_uuid()::text,
        'type',   'event',
        'kind',   'late',
        'points', 1
      ));
    end if;

    -- Ladder rungs.  Legacy thresholds were warn / warn+1 / warn+2 / warn+3
    -- (1pt per event), so we translate that to four rungs at those exact
    -- points.  Termination's auto_fire is locked off by design.
    v_blocks := v_blocks || jsonb_build_array(
      jsonb_build_object(
        'id',         gen_random_uuid()::text,
        'type',       'ladder_rung',
        'severity',   'verbal',
        'threshold',  v_warn,
        'delivery',   v_del_v,
        'auto_fire',  v_auto_v
      ),
      jsonb_build_object(
        'id',         gen_random_uuid()::text,
        'type',       'ladder_rung',
        'severity',   'written',
        'threshold',  v_warn + 1,
        'delivery',   v_del_w,
        'auto_fire',  v_auto_w
      ),
      jsonb_build_object(
        'id',         gen_random_uuid()::text,
        'type',       'ladder_rung',
        'severity',   'final',
        'threshold',  v_warn + 2,
        'delivery',   v_del_f,
        'auto_fire',  v_auto_f
      ),
      jsonb_build_object(
        'id',         gen_random_uuid()::text,
        'type',       'ladder_rung',
        'severity',   'termination',
        'threshold',  v_warn + 3,
        'delivery',   v_del_t,
        'auto_fire',  false
      )
    );

    -- Auto-escalations
    if v_ncns then
      v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
        'id',   gen_random_uuid()::text,
        'type', 'auto_escalation',
        'kind', 'ncns_terminates'
      ));
    end if;
    if v_first30 then
      v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
        'id',   gen_random_uuid()::text,
        'type', 'auto_escalation',
        'kind', 'first_30_strict',
        'days', v_first30d
      ));
    end if;

    -- Splice the new blocks array into the existing policy.
    update public.dsps
       set metadata = jsonb_set(
             coalesce(metadata, '{}'::jsonb),
             '{attendance,policy,blocks}',
             v_blocks,
             true
           )
     where id = r.id;
  end loop;
end $$;


-- ── 2. attendance_decide gains p_delivery ─────────────────────────
-- Drops the function first because we're widening the signature
-- (default param at the end keeps existing callers working but
-- Postgres still requires DROP for a signature change).

drop function if exists public.attendance_decide(uuid, text, text, text, boolean, text);

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
  v_severity   text;
  v_delivery   text;
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
  -- deliver.  Termination never auto-fires by design.  Caller passes
  -- p_delivery (from the matching ladder rung block) so SQL doesn't
  -- need to walk the policy itself.
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
    v_delivery := coalesce(p_delivery, 'ack');

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

grant execute on function public.attendance_decide(uuid, text, text, text, boolean, text, text) to authenticated;

notify pgrst, 'reload schema';
