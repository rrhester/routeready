-- 0324_optimization_audit_spine.sql
--
-- Workforce Optimization Engine — Step 1: audit-spine schema.
--
-- Adds two append-only tables that capture every Smart Fill run and
-- every per-shift decision the engine makes. Nothing changes for the
-- operator yet — this is the data plumbing every downstream feature
-- (AI explainer, what-if simulation, ad-hoc constraints, the CP-SAT
-- solver migration) hangs off of.
--
-- Design notes:
--   • optimization_runs is a queue + audit log. Every Smart Fill click
--     writes a row. status flows queued → running → ok|infeasible|
--     timeout|error.
--   • optimization_decisions captures one row per shift in the run.
--     This is what the explainer reads to answer "why did X get Y?"
--   • Three RPCs let the dashboard enqueue + read + apply runs.
--   • assign_shifts_from_run is the only write-back path; it's keyed
--     by run_id so replaying it is idempotent.
--
-- Idempotent. Safe to re-run.

-- ── 1. Runs table ──────────────────────────────────────────────────
create table if not exists public.optimization_runs (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  week_start      date not null,
  triggered_by    uuid references auth.users(id),
  trigger_kind    text not null
                    check (trigger_kind in
                      ('manual','auto_recalc','simulation','what_if','api')),
  parent_run_id   uuid references public.optimization_runs(id),
  status          text not null default 'queued'
                    check (status in
                      ('queued','running','ok','infeasible','timeout','error')),
  input_hash      text not null,
  solver_version  text,                              -- 'heuristic-v1','cpsat-v1'
  solver_seed     bigint not null default 0,
  time_budget_ms  integer not null default 8000,
  payload         jsonb,                             -- full input snapshot
  result          jsonb,                             -- full output (assigned + uncovered)
  metrics         jsonb,                             -- coverage, OT exposure, stability
  enqueued_at     timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  error_message   text
);
create index if not exists idx_optimization_runs_dsp_week
  on public.optimization_runs (dsp_id, week_start, enqueued_at desc);
create index if not exists idx_optimization_runs_input_hash
  on public.optimization_runs (input_hash);
create index if not exists idx_optimization_runs_status
  on public.optimization_runs (dsp_id, status)
  where status in ('queued','running');


-- ── 2. Decisions table ─────────────────────────────────────────────
create table if not exists public.optimization_decisions (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references public.optimization_runs(id) on delete cascade,
  shift_id            uuid not null,                 -- soft FK (shifts may be re-generated)
  driver_id           uuid,                          -- null = uncovered
  decision            text not null
                        check (decision in
                          ('assigned','uncovered','locked','swap',
                           'fifth_day','pattern_pass','preserved','skipped')),
  total_score         numeric(12,3),
  score_components    jsonb,
  binding_constraints text[] default '{}',
  alternatives        jsonb,
  ad_hoc_constraint_ids uuid[] default '{}',        -- populated when ad-hoc rules ship
  reason_code         text,
  reason_message      text,
  created_at          timestamptz not null default now()
);
create index if not exists idx_optimization_decisions_run
  on public.optimization_decisions (run_id);
create index if not exists idx_optimization_decisions_shift
  on public.optimization_decisions (shift_id);
create index if not exists idx_optimization_decisions_driver
  on public.optimization_decisions (driver_id) where driver_id is not null;


-- ── 3. RLS — DSP-scoped reads, service-role writes ────────────────
alter table public.optimization_runs enable row level security;
alter table public.optimization_decisions enable row level security;

drop policy if exists optimization_runs_dsp_read on public.optimization_runs;
create policy optimization_runs_dsp_read on public.optimization_runs
  for select using (dsp_id = private.current_dsp_id());

drop policy if exists optimization_decisions_dsp_read on public.optimization_decisions;
create policy optimization_decisions_dsp_read on public.optimization_decisions
  for select using (
    exists (
      select 1 from public.optimization_runs r
       where r.id = optimization_decisions.run_id
         and r.dsp_id = private.current_dsp_id()
    )
  );

-- Writes happen through the RPCs below (security definer) — no direct
-- INSERT/UPDATE/DELETE policy for authenticated users.


-- ── 4. RPC · enqueue_optimization_run ──────────────────────────────
-- Creates a queued run. The dashboard calls this at the start of a
-- Smart Fill click; the heuristic engine (or, later, the CP-SAT
-- service) updates the same row with result + status when it finishes.
--
-- Idempotency: if a row with the same (dsp_id, week_start, input_hash)
-- already exists with status in ('queued','running','ok') within the
-- last 5 minutes, that row's id is returned instead of creating a new
-- one. Prevents duplicate solves when the operator double-clicks.

create or replace function public.enqueue_optimization_run(
  p_week_start      date,
  p_trigger_kind    text,
  p_input_hash      text,
  p_solver_version  text default null,
  p_parent_run_id   uuid default null,
  p_time_budget_ms  integer default 8000,
  p_solver_seed     bigint default 0,
  p_payload         jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_id  uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_trigger_kind not in ('manual','auto_recalc','simulation','what_if','api') then
    raise exception 'invalid trigger_kind: %', p_trigger_kind;
  end if;

  -- Idempotency window: 5 min, same hash, not already failed.
  select id into v_id
    from public.optimization_runs
   where dsp_id = v_dsp
     and week_start = p_week_start
     and input_hash = p_input_hash
     and status in ('queued','running','ok')
     and enqueued_at > now() - interval '5 minutes'
   order by enqueued_at desc
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.optimization_runs (
    dsp_id, week_start, triggered_by, trigger_kind, parent_run_id,
    input_hash, solver_version, solver_seed, time_budget_ms, payload
  ) values (
    v_dsp, p_week_start, auth.uid(), p_trigger_kind, p_parent_run_id,
    p_input_hash, p_solver_version, p_solver_seed, p_time_budget_ms, p_payload
  )
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.enqueue_optimization_run(
  date, text, text, text, uuid, integer, bigint, jsonb
) to authenticated;


-- ── 5. RPC · record_optimization_result ───────────────────────────
-- Solver/engine writes back the final result. Updates the run row +
-- bulk-inserts all decision rows in one transaction.
--
-- p_decisions is a jsonb array; each element matches optimization_decisions
-- columns (shift_id, driver_id, decision, total_score, score_components,
-- binding_constraints, alternatives, reason_code, reason_message).

create or replace function public.record_optimization_result(
  p_run_id      uuid,
  p_status      text,
  p_result      jsonb,
  p_metrics     jsonb,
  p_decisions   jsonb,
  p_error       text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_run public.optimization_runs;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status not in ('ok','infeasible','timeout','error') then
    raise exception 'invalid terminal status: %', p_status;
  end if;

  select * into v_run from public.optimization_runs
   where id = p_run_id and dsp_id = v_dsp
   for update;
  if v_run.id is null then
    raise exception 'run_not_found';
  end if;

  update public.optimization_runs
     set status = p_status,
         result = p_result,
         metrics = p_metrics,
         error_message = p_error,
         started_at = coalesce(started_at, now()),
         finished_at = now()
   where id = p_run_id;

  -- Clear any prior decisions (in case of retry) and bulk-insert.
  delete from public.optimization_decisions where run_id = p_run_id;
  if jsonb_typeof(p_decisions) = 'array' then
    insert into public.optimization_decisions (
      run_id, shift_id, driver_id, decision,
      total_score, score_components, binding_constraints,
      alternatives, ad_hoc_constraint_ids, reason_code, reason_message
    )
    select
      p_run_id,
      (d->>'shift_id')::uuid,
      nullif(d->>'driver_id','')::uuid,
      d->>'decision',
      nullif(d->>'total_score','')::numeric,
      d->'score_components',
      coalesce(
        array(select jsonb_array_elements_text(d->'binding_constraints')),
        '{}'::text[]
      ),
      d->'alternatives',
      coalesce(
        array(select jsonb_array_elements_text(d->'ad_hoc_constraint_ids'))::uuid[],
        '{}'::uuid[]
      ),
      d->>'reason_code',
      d->>'reason_message'
    from jsonb_array_elements(p_decisions) as d;
  end if;
end;
$$;
grant execute on function public.record_optimization_result(
  uuid, text, jsonb, jsonb, jsonb, text
) to authenticated;


-- ── 6. RPC · optimization_run_detail ──────────────────────────────
-- Returns the run row + all its decisions as a single jsonb blob.
-- Powers the "Run detail" drawer in the UI.

create or replace function public.optimization_run_detail(p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'run', to_jsonb(r),
    'decisions', coalesce(
      (
        select jsonb_agg(to_jsonb(d) order by d.created_at)
          from public.optimization_decisions d
         where d.run_id = r.id
      ),
      '[]'::jsonb
    )
  )
    from public.optimization_runs r
   where r.id = p_run_id
     and r.dsp_id = private.current_dsp_id();
$$;
grant execute on function public.optimization_run_detail(uuid) to authenticated;


-- ── 7. RPC · apply_optimization_run ───────────────────────────────
-- Applies a completed run to the live shifts table. Idempotent on
-- (run_id) — replaying it touches only shifts whose current driver_id
-- differs from what the run prescribed.
--
-- Returns {applied, skipped, conflicts}. A "conflict" is a shift that
-- moved (status changed, was deleted, was reassigned by someone else)
-- since the run was computed.

create or replace function public.apply_optimization_run(
  p_run_id        uuid,
  p_only_changed  boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_run public.optimization_runs;
  v_applied integer := 0;
  v_skipped integer := 0;
  v_conflicts jsonb := '[]'::jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_run from public.optimization_runs
   where id = p_run_id and dsp_id = v_dsp;
  if v_run.id is null then raise exception 'run_not_found'; end if;
  if v_run.status <> 'ok' then
    raise exception 'run_not_applicable: status=%', v_run.status;
  end if;

  -- Apply each assigned/swap/fifth_day decision.
  with applied as (
    update public.shifts s
       set driver_id = d.driver_id,
           status    = case
             when d.decision in ('assigned','swap','fifth_day') and d.driver_id is not null
               then 'scheduled'::public.shift_status
             else s.status
           end,
           updated_at = now()
      from public.optimization_decisions d
     where d.run_id = p_run_id
       and s.id = d.shift_id
       and s.dsp_id = v_dsp
       and d.decision in ('assigned','swap','fifth_day','uncovered')
       and (not p_only_changed
            or s.driver_id is distinct from d.driver_id)
    returning s.id
  )
  select count(*) into v_applied from applied;

  -- Anything in decisions that didn't match a live shift → conflict.
  select coalesce(jsonb_agg(jsonb_build_object(
           'shift_id', d.shift_id,
           'reason', 'shift_not_found_or_modified'
         )), '[]'::jsonb)
    into v_conflicts
    from public.optimization_decisions d
   where d.run_id = p_run_id
     and d.decision in ('assigned','swap','fifth_day')
     and not exists (
       select 1 from public.shifts s
        where s.id = d.shift_id and s.dsp_id = v_dsp
     );

  v_skipped := (
    select count(*) from public.optimization_decisions
     where run_id = p_run_id
       and decision in ('locked','preserved','skipped')
  );

  return jsonb_build_object(
    'applied',   v_applied,
    'skipped',   v_skipped,
    'conflicts', v_conflicts
  );
end;
$$;
grant execute on function public.apply_optimization_run(uuid, boolean) to authenticated;


notify pgrst, 'reload schema';
