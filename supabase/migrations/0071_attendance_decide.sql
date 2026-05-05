-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0071 · Attendance approve/deny decisions
--
-- The Today's Plan daily attendance approvals card was visual-only; a
-- click did nothing on the server.  This migration wires up persistence
-- and the post-approval side effects:
--
--   1. attendance_decisions table — append-only audit log of every
--      Approve / Deny click with the dispatcher who pressed it and any
--      operator notes.
--
--   2. attendance_decide RPC — applies the decision:
--        - On Approve: stamps the shift with the appropriate status
--          (no_show / late / called_off) so the existing attendance
--          report and event log immediately count it.  If the policy
--          has auto_coaching enabled, also creates a coaching record
--          and sends a chat message to the driver.
--        - On Deny: leaves shifts.status alone — the audit row in
--          attendance_decisions captures the operator's denial + notes
--          so the report shows it but it does not roll into points.
--          Notes are required on deny — enforced server-side and in
--          the dashboard UI.
--
-- Auto-coaching is policy-controlled (dsps.metadata.attendance.policy
-- .auto_coaching).  Off by default — many DSPs prefer to coach in
-- person and check the box themselves rather than have the system
-- auto-paper a record.
-- ─────────────────────────────────────────────────────────────────────────


create table if not exists public.attendance_decisions (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id)    on delete cascade,
  driver_id   uuid not null references public.drivers(id) on delete cascade,
  shift_id    uuid not null references public.shifts(id)  on delete cascade,
  outcome     text not null check (outcome in ('ncns','tardy','missed_reported')),
  decision    text not null check (decision in ('approve','deny')),
  notes       text,
  decided_by  uuid references public.app_users(id),
  created_at  timestamptz not null default now()
);

create index if not exists attendance_decisions_driver_recent_idx
  on public.attendance_decisions (driver_id, created_at desc);
create index if not exists attendance_decisions_dsp_recent_idx
  on public.attendance_decisions (dsp_id, created_at desc);
create unique index if not exists attendance_decisions_one_per_shift_idx
  on public.attendance_decisions (shift_id);

alter table public.attendance_decisions enable row level security;

drop policy if exists "attendance_decisions_tenant_rw" on public.attendance_decisions;
create policy "attendance_decisions_tenant_rw"
  on public.attendance_decisions for all
  using       (dsp_id = private.current_dsp_id())
  with check  (dsp_id = private.current_dsp_id());

grant select, insert, update on public.attendance_decisions to authenticated;


-- ── attendance_decide ──────────────────────────────────────────────────
create or replace function public.attendance_decide(
  p_shift_id uuid,
  p_outcome  text,
  p_decision text,
  p_notes    text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp           uuid := private.current_dsp_id();
  v_shift         public.shifts;
  v_drv           public.drivers;
  v_meta          jsonb;
  v_policy        jsonb;
  v_auto_coaching bool;
  v_status        text;
  v_summary       text;
  v_chat_msg      text;
  v_dsp_name      text;
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

  -- Record the decision (one per shift; second click overwrites).
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

  -- Apply the decision to the shift's status.  This is what makes the
  -- attendance report + event log actually see it.
  v_status := case p_outcome
    when 'ncns'            then 'no_show'
    when 'tardy'           then 'late'
    when 'missed_reported' then 'called_off'
  end;
  if p_decision = 'approve' then
    update public.shifts set status = v_status where id = p_shift_id;
  end if;
  -- Deny: leave shifts.status alone.  The decision row above is enough
  -- to capture "operator reviewed and excused" — the existing point /
  -- occurrence math in the report keys on shifts.status, so an
  -- unchanged status means it never lands on the running total.

  -- Auto-coaching + driver chat message (approve only, policy-gated).
  v_auto_coaching := false;
  if p_decision = 'approve' then
    v_meta   := coalesce((select metadata from public.dsps where id = v_dsp), '{}'::jsonb);
    v_policy := coalesce(v_meta -> 'attendance' -> 'policy', '{}'::jsonb);
    v_auto_coaching := coalesce((v_policy ->> 'auto_coaching')::bool, false);
    v_dsp_name := coalesce((select name from public.dsps where id = v_dsp), 'Dispatch');
  end if;

  if v_auto_coaching then
    v_summary := case p_outcome
      when 'ncns'            then 'No-call no-show on ' || to_char(v_shift.date, 'Mon DD')
      when 'tardy'           then 'Tardy on '           || to_char(v_shift.date, 'Mon DD')
      when 'missed_reported' then 'Callout on '         || to_char(v_shift.date, 'Mon DD')
    end;

    insert into public.coachings
      (dsp_id, driver_id, coach_user_id, topic, type, summary, notes, metadata)
    values
      (v_dsp, v_drv.id, auth.uid(),
       'attendance'::public.coaching_topic,
       'documented_warning'::public.coaching_type,
       v_summary,
       coalesce(p_notes, ''),
       jsonb_build_object('source', 'attendance_decide', 'shift_id', p_shift_id, 'outcome', p_outcome));

    v_chat_msg := case p_outcome
      when 'ncns'            then 'You were marked no-call no-show for your '   || to_char(v_shift.date, 'Mon DD') || ' shift. Reach out if you think this is an error. — ' || v_dsp_name
      when 'tardy'           then 'You were marked tardy for your '              || to_char(v_shift.date, 'Mon DD') || ' shift. — ' || v_dsp_name
      when 'missed_reported' then 'Your callout for '                            || to_char(v_shift.date, 'Mon DD') || ' has been logged. — ' || v_dsp_name
    end;

    insert into public.driver_messages
      (driver_id, dsp_id, sender_kind, sender_user_id, body)
    values
      (v_drv.id, v_dsp, 'dispatch', auth.uid(), v_chat_msg);

    insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
    values (v_drv.id, v_dsp, now())
    on conflict (driver_id) do update
      set last_message_at = excluded.last_message_at;
  end if;

  return jsonb_build_object(
    'ok',           true,
    'decision',     p_decision,
    'auto_coached', v_auto_coaching,
    'shift_status', case p_decision when 'approve' then v_status else v_shift.status::text end
  );
end;
$$;
grant execute on function public.attendance_decide(uuid, text, text, text) to authenticated;


notify pgrst, 'reload schema';
