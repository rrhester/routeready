-- 0502_smartfill_undo.sql
--
-- Schedule improvement plan Wave 2 item #10 (docs/SCHEDULE-IMPROVEMENT-
-- PLAN.md): one-click undo for a whole Smart Fill run. The audit spine
-- (0324) already keys every run; this adds the missing piece — a
-- pre-run snapshot of who held each shift — and a revert RPC that
-- restores it WITHOUT clobbering anything a dispatcher changed after
-- the run.
--
--   · optimization_runs.pre_assignments — [{shift_id, driver_id}] as
--     the week stood before the run's writes. First-write-wins: the
--     enqueue RPC reuses run ids for identical inputs within 5 min,
--     and "undo the Smart Fill" must mean the state before the FIRST
--     application, not between two identical re-runs.
--   · revert_optimization_run(run_id) — optimistic per-shift restore:
--     a shift is only reverted while it still holds what THIS run
--     decided for it (per optimization_decisions); shifts edited since
--     are kept and counted. The 0500 double-book guard is flipped to
--     immediate inside the revert so one conflicting restore is
--     skipped + counted instead of aborting the whole revert.
--
-- Idempotent: safe to re-run end to end.

-- ── 1. Snapshot + revert bookkeeping on the run row ──────────────────
alter table public.optimization_runs
  add column if not exists pre_assignments jsonb,
  add column if not exists reverted_at     timestamptz,
  add column if not exists reverted_by     uuid references auth.users(id) on delete set null;

-- ── 2. Stash the pre-run snapshot ────────────────────────────────────
-- Called by the dashboard right after the run's writes land, with the
-- previous holder of every shift the run touched.
create or replace function public.optimization_run_set_snapshot(
  p_run_id   uuid,
  p_snapshot jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'array' then
    raise exception 'snapshot must be a jsonb array';
  end if;

  update public.optimization_runs
     set pre_assignments = coalesce(pre_assignments, p_snapshot)
   where id = p_run_id and dsp_id = v_dsp;
  if not found then
    raise exception 'run_not_found';
  end if;
end;
$$;

grant execute on function public.optimization_run_set_snapshot(uuid, jsonb)
  to authenticated;

-- ── 3. Revert a run ──────────────────────────────────────────────────
-- Returns {restored, skipped, missing, conflicted}:
--   restored   — shifts put back to their pre-run driver
--   skipped    — shifts changed since the run (kept as-is), or shifts
--                the run didn't actually write
--   missing    — snapshot shifts that no longer exist
--   conflicted — restores refused by the double-book guard (the
--                pre-run driver picked up another same-day shift since)
create or replace function public.revert_optimization_run(
  p_run_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_run        public.optimization_runs;
  e            record;
  v_cur_driver uuid;
  v_cur_found  boolean;
  v_decided    uuid;
  v_has_dec    boolean;
  restored     int := 0;
  skipped      int := 0;
  missing      int := 0;
  conflicted   int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_run from public.optimization_runs
   where id = p_run_id and dsp_id = v_dsp;
  if v_run.id is null then
    raise exception 'run_not_found';
  end if;
  if v_run.pre_assignments is null then
    raise exception 'no_snapshot'
      using detail = 'this run predates snapshot capture (0502) — nothing to revert to';
  end if;
  if v_run.reverted_at is not null then
    raise exception 'already_reverted';
  end if;

  -- Check double-books per-statement instead of at commit so a single
  -- conflicting restore is caught below and counted, not fatal.
  -- (Schema-qualified: this function runs with search_path = ''.)
  set constraints public.trg_shifts_block_double_book immediate;

  for e in
    select (x->>'shift_id')::uuid              as sid,
           nullif(x->>'driver_id','')::uuid    as prev_driver
    from jsonb_array_elements(v_run.pre_assignments) x
  loop
    select driver_id, true into v_cur_driver, v_cur_found
      from public.shifts where id = e.sid and dsp_id = v_dsp;
    if v_cur_found is not true then
      missing := missing + 1;
      v_cur_found := null;
      continue;
    end if;
    v_cur_found := null;

    -- What did THIS run write onto the shift? (Only run-authored
    -- placements count; locked/preserved rows were not the run's doing.)
    select driver_id, true into v_decided, v_has_dec
      from public.optimization_decisions
     where run_id = p_run_id and shift_id = e.sid
       and driver_id is not null
       and decision in ('assigned','swap','fifth_day','pattern_pass')
     limit 1;
    if v_has_dec is not true or v_cur_driver is distinct from v_decided then
      -- The run never wrote it, or someone edited it since — keep it.
      skipped := skipped + 1;
      v_has_dec := null;
      continue;
    end if;
    v_has_dec := null;

    begin
      update public.shifts set driver_id = e.prev_driver where id = e.sid;
      restored := restored + 1;
    exception when others then
      -- Double-book guard (or another constraint) refused the restore.
      conflicted := conflicted + 1;
    end;
  end loop;

  update public.optimization_runs
     set reverted_at = now(), reverted_by = auth.uid()
   where id = p_run_id;

  return jsonb_build_object(
    'restored', restored, 'skipped', skipped,
    'missing', missing, 'conflicted', conflicted);
end;
$$;

grant execute on function public.revert_optimization_run(uuid)
  to authenticated;

notify pgrst, 'reload schema';
