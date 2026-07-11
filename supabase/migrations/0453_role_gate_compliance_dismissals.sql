-- Migration 0453 · Intra-tenant role gate on compliance_dismissals (RLS + RPC).
--
-- WHY
-- ───
-- The B7 follow-up deferred from 0452. compliance_dismissals (0240) still
-- carried `for all to authenticated using (dsp_id = current_dsp_id())` with
-- NO is_staff check, AND its primary write path — the SECURITY DEFINER
-- compliance_dismiss() RPC — did not gate is_staff either. So any
-- authenticated tenant member (incl. role='driver') could dismiss/suppress
-- compliance exceptions for the whole DSP, either directly via PostgREST or
-- through the RPC (which bypasses RLS). Dismissing a compliance risk hides it
-- from the ops workspace bundle — a decision that belongs to dispatcher+.
--
-- Two surfaces, so two gates:
--   1. RLS — split the _rw policy the 0445/0452 way. Grant is
--      select/insert/delete (no update), so no update policy.
--   2. RPC — add an is_staff(dsp,'dispatcher') guard to compliance_dismiss.
--      Because it is SECURITY DEFINER it bypasses RLS, so the RLS split alone
--      would not close the RPC path; the guard does. Full body reproduced
--      verbatim from 0240 with only the guard added.
--
-- WHO IS UNAFFECTED
-- ─────────────────
--   · Dispatcher / ops / owner — the normal "dismiss" click still works.
--   · The driver PWA never holds a Supabase session.
--
-- Idempotent: drop policy if exists / create; create or replace. Safe to re-run.

-- ─── 1. RLS split ─────────────────────────────────────────────────────────

drop policy if exists "compliance_dismissals_rw" on public.compliance_dismissals;

drop policy if exists "compliance_dismissals_tenant_select" on public.compliance_dismissals;
create policy "compliance_dismissals_tenant_select"
  on public.compliance_dismissals for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "compliance_dismissals_staff_insert" on public.compliance_dismissals;
create policy "compliance_dismissals_staff_insert"
  on public.compliance_dismissals for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "compliance_dismissals_staff_delete" on public.compliance_dismissals;
create policy "compliance_dismissals_staff_delete"
  on public.compliance_dismissals for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── 2. RPC gate ──────────────────────────────────────────────────────────
-- Verbatim from 0240 with a single added is_staff guard at the top.

create or replace function public.compliance_dismiss(
  p_kind text,
  p_object_id text,
  p_days int default 14
) returns public.compliance_dismissals
language plpgsql security definer set search_path = public
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.compliance_dismissals;
begin
  -- NEW (0453): dismissing a compliance exception is a dispatcher+ action.
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if coalesce(btrim(p_kind), '') = '' then
    raise exception 'kind_required' using errcode = '22023';
  end if;
  if coalesce(p_days, 0) <= 0 then p_days := 14; end if;

  -- Replace any earlier non-expired dismissal for the same target so
  -- a re-click extends the snooze rather than stacking rows.
  delete from public.compliance_dismissals
   where dsp_id = v_dsp
     and exception_kind = p_kind
     and coalesce(object_id, '') = coalesce(p_object_id, '')
     and expires_at > now();

  insert into public.compliance_dismissals
    (dsp_id, exception_kind, object_id, expires_at, dismissed_by)
  values (
    v_dsp, p_kind, p_object_id,
    now() + (p_days || ' days')::interval,
    auth.uid()
  )
  returning * into v_row;

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (
    v_dsp, 'user', auth.uid(), 'exception_dismissed',
    'Dismissed compliance exception · ' || p_kind || ' for ' || p_days || ' days',
    p_object_id, p_kind, p_object_id::uuid
  );

  return v_row;
exception when invalid_text_representation then
  -- object_id wasn't a UUID (e.g., an FMCSA dsp_id-as-text); still
  -- record the audit row with a null object_id so we don't drop the
  -- audit trail just because of the cast.
  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (
    v_dsp, 'user', auth.uid(), 'exception_dismissed',
    'Dismissed compliance exception · ' || p_kind || ' for ' || p_days || ' days',
    p_object_id, p_kind, null
  );
  return v_row;
end $$;
grant execute on function public.compliance_dismiss(text, text, int) to authenticated;

notify pgrst, 'reload schema';
