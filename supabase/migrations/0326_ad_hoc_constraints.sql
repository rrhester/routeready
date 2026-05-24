-- 0326_ad_hoc_constraints.sql
--
-- Workforce Optimization Engine — Step 3.5: ad-hoc constraints.
--
-- DSPs each have idiosyncratic rules: "Bob can't work with Frank",
-- "Maria always on SP-3", "Friday before holidays needs +1 cushion",
-- "New hires must shadow their trainer for 3 days." Today those rules
-- live in the operator's head and get re-enforced by hand every week.
-- This subsystem lets them encode rules once and have Smart Fill honor
-- them on every solve.
--
-- v1 ships the storage + UI listing only. The constraint compiler that
-- actually applies these rules to the solver lands in step 5.5 (after
-- the CP-SAT model is up). Until then, drafted rules are inert — but
-- operators can start writing them now.
--
-- Idempotent.

-- ── 1. Constraints table ──────────────────────────────────────────
create table if not exists public.ad_hoc_constraints (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  name            text not null,                  -- "Bob and Frank can't pair"
  description     text,                           -- shown in explainer
  -- Template id (preferred) OR 'expression' (DSL-authored).
  kind            text not null,
  payload         jsonb not null,                 -- template params or expr AST
  hardness        text not null
                    check (hardness in ('hard','soft')),
  weight          numeric(10,3),                  -- soft only; nullable
  scope           jsonb not null default '{}'::jsonb,  -- {driver_ids?, route_codes?, days?}
  effective_from  date not null default current_date,
  effective_until date,                           -- null = open-ended
  state           text not null default 'draft'
                    check (state in
                      ('draft','active','paused','expired','archived')),
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         integer not null default 1,
  prior_version_id uuid references public.ad_hoc_constraints(id),
  last_validated_at timestamptz,
  last_validation jsonb,                          -- {feasible: bool, conflicts: [...]}
  notes           text
);
create index if not exists idx_ad_hoc_active
  on public.ad_hoc_constraints (dsp_id, state)
  where state = 'active';
create index if not exists idx_ad_hoc_effective
  on public.ad_hoc_constraints (dsp_id, effective_from, effective_until);

-- ── 2. Per-run overrides (mute a rule for a single week) ──────────
create table if not exists public.ad_hoc_constraint_overrides (
  id              uuid primary key default gen_random_uuid(),
  constraint_id   uuid not null references public.ad_hoc_constraints(id) on delete cascade,
  week_start      date not null,
  muted_by        uuid references auth.users(id),
  reason          text not null,
  created_at      timestamptz not null default now(),
  unique (constraint_id, week_start)
);
create index if not exists idx_ad_hoc_overrides_week
  on public.ad_hoc_constraint_overrides (week_start, constraint_id);


-- ── 3. RLS · DSP-scoped reads, RPC-only writes ────────────────────
alter table public.ad_hoc_constraints enable row level security;
alter table public.ad_hoc_constraint_overrides enable row level security;

drop policy if exists ad_hoc_constraints_dsp_read on public.ad_hoc_constraints;
create policy ad_hoc_constraints_dsp_read on public.ad_hoc_constraints
  for select using (dsp_id = private.current_dsp_id());

drop policy if exists ad_hoc_overrides_dsp_read on public.ad_hoc_constraint_overrides;
create policy ad_hoc_overrides_dsp_read on public.ad_hoc_constraint_overrides
  for select using (
    exists (
      select 1 from public.ad_hoc_constraints c
       where c.id = ad_hoc_constraint_overrides.constraint_id
         and c.dsp_id = private.current_dsp_id()
    )
  );


-- ── 4. RPC · create_ad_hoc_constraint ─────────────────────────────
create or replace function public.create_ad_hoc_constraint(
  p_name           text,
  p_kind           text,
  p_payload        jsonb,
  p_hardness       text,
  p_description    text default null,
  p_weight         numeric default null,
  p_scope          jsonb default '{}'::jsonb,
  p_effective_from date default null,
  p_effective_until date default null,
  p_state          text default 'draft',
  p_notes          text default null
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
  if p_hardness not in ('hard','soft') then
    raise exception 'invalid hardness: %', p_hardness;
  end if;
  if p_hardness = 'soft' and p_weight is null then
    raise exception 'soft constraints require a weight';
  end if;
  if p_state not in ('draft','active','paused') then
    raise exception 'invalid initial state: %', p_state;
  end if;

  insert into public.ad_hoc_constraints (
    dsp_id, name, description, kind, payload, hardness, weight, scope,
    effective_from, effective_until, state, created_by, notes
  ) values (
    v_dsp, p_name, p_description, p_kind, p_payload, p_hardness, p_weight, p_scope,
    coalesce(p_effective_from, current_date), p_effective_until, p_state, auth.uid(), p_notes
  )
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.create_ad_hoc_constraint(
  text, text, jsonb, text, text, numeric, jsonb, date, date, text, text
) to authenticated;


-- ── 5. RPC · update_ad_hoc_constraint (creates a new version) ─────
-- Editing an active rule creates a new version row and archives the
-- prior one, so past solves remain explainable by their version.
create or replace function public.update_ad_hoc_constraint(
  p_id             uuid,
  p_name           text default null,
  p_payload        jsonb default null,
  p_hardness       text default null,
  p_description    text default null,
  p_weight         numeric default null,
  p_scope          jsonb default null,
  p_effective_from date default null,
  p_effective_until date default null,
  p_state          text default null,
  p_notes          text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_old public.ad_hoc_constraints;
  v_new uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_old from public.ad_hoc_constraints
   where id = p_id and dsp_id = v_dsp
   for update;
  if v_old.id is null then raise exception 'constraint_not_found'; end if;

  -- Archive the prior version.
  update public.ad_hoc_constraints
     set state = 'archived', updated_at = now()
   where id = p_id;

  -- Insert the new version.
  insert into public.ad_hoc_constraints (
    dsp_id, name, description, kind, payload, hardness, weight, scope,
    effective_from, effective_until, state, created_by, notes,
    version, prior_version_id
  ) values (
    v_dsp,
    coalesce(p_name, v_old.name),
    coalesce(p_description, v_old.description),
    v_old.kind,
    coalesce(p_payload, v_old.payload),
    coalesce(p_hardness, v_old.hardness),
    coalesce(p_weight, v_old.weight),
    coalesce(p_scope, v_old.scope),
    coalesce(p_effective_from, v_old.effective_from),
    coalesce(p_effective_until, v_old.effective_until),
    coalesce(p_state, v_old.state),
    auth.uid(),
    coalesce(p_notes, v_old.notes),
    v_old.version + 1,
    v_old.id
  )
  returning id into v_new;
  return v_new;
end;
$$;
grant execute on function public.update_ad_hoc_constraint(
  uuid, text, jsonb, text, text, numeric, jsonb, date, date, text, text
) to authenticated;


-- ── 6. RPC · set_ad_hoc_constraint_state ──────────────────────────
-- Convenience: flip state without going through full update.
create or replace function public.set_ad_hoc_constraint_state(
  p_id    uuid,
  p_state text
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
  if p_state not in ('draft','active','paused','expired','archived') then
    raise exception 'invalid state: %', p_state;
  end if;
  update public.ad_hoc_constraints
     set state = p_state, updated_at = now()
   where id = p_id and dsp_id = v_dsp;
end;
$$;
grant execute on function public.set_ad_hoc_constraint_state(uuid, text) to authenticated;


-- ── 7. RPC · mute_ad_hoc_constraint_for_week ──────────────────────
create or replace function public.mute_ad_hoc_constraint_for_week(
  p_constraint_id uuid,
  p_week_start    date,
  p_reason        text
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
  if not exists (select 1 from public.ad_hoc_constraints
                  where id = p_constraint_id and dsp_id = v_dsp) then
    raise exception 'constraint_not_found';
  end if;
  insert into public.ad_hoc_constraint_overrides (
    constraint_id, week_start, muted_by, reason
  ) values (p_constraint_id, p_week_start, auth.uid(), p_reason)
  on conflict (constraint_id, week_start) do update
    set reason = excluded.reason,
        muted_by = auth.uid(),
        created_at = now()
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.mute_ad_hoc_constraint_for_week(uuid, date, text) to authenticated;


-- ── 8. View · current_ad_hoc_constraints ──────────────────────────
-- Convenience for the UI list: every constraint for the current DSP
-- that the operator can act on (not archived). RLS-scoped via
-- private.current_dsp_id().
create or replace view public.current_ad_hoc_constraints as
  select c.*, u.full_name as created_by_name
    from public.ad_hoc_constraints c
    left join public.app_users u on u.id = c.created_by
   where c.dsp_id = private.current_dsp_id()
     and c.state <> 'archived'
   order by c.state, c.created_at desc;
grant select on public.current_ad_hoc_constraints to authenticated;


notify pgrst, 'reload schema';
