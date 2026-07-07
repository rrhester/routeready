-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0433 · Global audit log (audit_events)
--
-- RouteReady already had per-domain trails (applicant_status_changes,
-- shift_swaps_audit, compliance_audit_events) but no general
-- "who changed this, and when?" record for the highest-stakes,
-- HR-sensitive tables. A DSP owner in a termination dispute or a
-- compliance review cannot currently answer "who flipped this driver to
-- terminated?" — this migration makes that answerable.
--
-- It adds one append-only, tamper-resistant audit stream and wires
-- change-data-capture triggers onto:
--   • drivers           (insert/update/delete)  — hires, edits, terminations
--   • app_users         (insert/update/delete)  — role grants/changes, deactivation
--   • driver_documents  (insert/update/delete)  — license/medical/DOT docs
--   • shifts            (update/delete)          — manual schedule edits + removals
--                                                  (inserts skipped — bulk schedule
--                                                   generation would be pure noise)
--
-- Design decisions:
--   • Rows are written ONLY by private.log_audit_event() (SECURITY DEFINER),
--     which bypasses RLS. `authenticated` is granted SELECT only — no
--     insert/update/delete — so a user can neither forge nor erase an audit
--     row. That non-repudiation is what makes the log trustworthy in a dispute.
--   • Reads are gated to ops+ (ops, owner). Dispatchers and drivers cannot read
--     it, because it captures role changes, terminations, and raw before/after
--     PII snapshots. The dashboard reads it through public.audit_feed().
--   • The set_updated_at BEFORE trigger bumps updated_at on every write, so the
--     capture fn excludes updated_at/created_at when deciding whether an UPDATE
--     actually changed anything — no-op / touch-only writes don't spam the log.
--   • The capture fn is fail-OPEN: if auditing itself errors, it RAISE WARNINGs
--     and returns, so a bug in the audit path can never roll back a real
--     driver/shift/document write. Auditing must never break operations.
--
-- Idempotent: safe to run more than once (create-if-not-exists,
-- create-or-replace, drop-if-exists before every trigger/policy).
-- ─────────────────────────────────────────────────────────────────────────


-- ─── table ───────────────────────────────────────────────────────────────

create table if not exists public.audit_events (
  id              uuid            primary key default gen_random_uuid(),
  dsp_id          uuid            not null references public.dsps(id) on delete cascade,
  occurred_at     timestamptz     not null default now(),

  actor_type      text            not null default 'user',   -- user | system
  actor_id        uuid            references public.app_users(id) on delete set null,
  actor_email     text,                                       -- snapshot; survives user deletion
  actor_role      public.app_role,                            -- snapshot of role at action time

  action          text            not null,                   -- insert | update | delete
  object_type     text            not null,                   -- source table, e.g. 'drivers'
  object_id       uuid,                                       -- affected row id

  summary         text,                                       -- human one-liner
  changed_fields  text[],                                     -- columns that changed (update only)
  before          jsonb,                                      -- row snapshot pre-change (update/delete)
  after           jsonb,                                      -- row snapshot post-change (insert/update)

  created_at      timestamptz     not null default now(),

  constraint audit_events_action_check check (action in ('insert','update','delete'))
);

comment on table public.audit_events is
  'Append-only global audit trail. Written only by private.log_audit_event() '
  '(SECURITY DEFINER); authenticated has SELECT only, so rows cannot be forged '
  'or deleted by clients. Reads gated to ops+ via RLS and public.audit_feed().';

create index if not exists audit_events_dsp_at_idx
  on public.audit_events (dsp_id, occurred_at desc);
create index if not exists audit_events_object_idx
  on public.audit_events (dsp_id, object_type, object_id, occurred_at desc);
create index if not exists audit_events_actor_idx
  on public.audit_events (dsp_id, actor_id, occurred_at desc);


-- ─── RLS ─────────────────────────────────────────────────────────────────

alter table public.audit_events enable row level security;

-- Read: ops and owners of the caller's own tenant only. There is deliberately
-- NO insert/update/delete policy and only SELECT is granted, so the table is
-- append-only + tamper-resistant from every client's perspective. The capture
-- trigger writes as definer and bypasses RLS.
drop policy if exists "audit_events_ops_select" on public.audit_events;
create policy "audit_events_ops_select"
  on public.audit_events for select
  to authenticated
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select on public.audit_events to authenticated;
-- (No insert/update/delete grant — all writes flow through the trigger below.)


-- ─── capture function ────────────────────────────────────────────────────

create or replace function private.log_audit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before   jsonb;
  v_after    jsonb;
  v_dsp      uuid;
  v_obj      uuid;
  v_actor    uuid := auth.uid();
  v_email    text;
  v_role     public.app_role;
  v_changed  text[] := '{}';
  v_key      text;
  v_summary  text;
  v_ignore   constant text[] := array['updated_at', 'created_at'];
begin
  if tg_op = 'DELETE' then
    v_before := to_jsonb(old);
    v_after  := null;
  elsif tg_op = 'INSERT' then
    v_before := null;
    v_after  := to_jsonb(new);
  else -- UPDATE
    v_before := to_jsonb(old);
    v_after  := to_jsonb(new);
  end if;

  v_dsp := coalesce(v_after->>'dsp_id', v_before->>'dsp_id')::uuid;
  v_obj := coalesce(v_after->>'id',     v_before->>'id')::uuid;

  -- For updates, compute the real changed set (ignoring bookkeeping cols).
  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_after) loop
      if not (v_key = any(v_ignore))
         and (v_after -> v_key) is distinct from (v_before -> v_key) then
        v_changed := array_append(v_changed, v_key);
      end if;
    end loop;
    -- Nothing meaningful changed (e.g. updated_at-only touch) → don't log.
    if array_length(v_changed, 1) is null then
      return null;
    end if;
  end if;

  -- Resolve actor identity. A NULL uid ⇒ service-role / system write.
  if v_actor is not null then
    select email, role into v_email, v_role
    from public.app_users
    where id = v_actor;
  end if;

  -- Concise human summary; call out status transitions explicitly since those
  -- are the ones an owner asks about (active → terminated, etc.).
  if tg_op = 'UPDATE' and ('status' = any(v_changed)) then
    v_summary := 'status: ' || coalesce(v_before->>'status', '∅')
                 || ' → ' || coalesce(v_after->>'status', '∅');
  elsif tg_op = 'INSERT' then
    v_summary := 'created';
  elsif tg_op = 'DELETE' then
    v_summary := 'deleted';
  else
    v_summary := 'updated ' || array_to_string(v_changed, ', ');
  end if;

  insert into public.audit_events (
    dsp_id, actor_type, actor_id, actor_email, actor_role,
    action, object_type, object_id, summary, changed_fields, before, after
  ) values (
    v_dsp,
    case when v_actor is null then 'system' else 'user' end,
    v_actor, v_email, v_role,
    lower(tg_op), tg_table_name, v_obj, v_summary,
    case when tg_op = 'UPDATE' then v_changed else null end,
    v_before, v_after
  );

  return null;  -- AFTER trigger: return value is ignored

exception
  -- Fail OPEN: auditing must never roll back the underlying operation.
  when others then
    raise warning 'audit_events capture failed for % on %: %',
      tg_op, tg_table_name, sqlerrm;
    return null;
end;
$$;


-- ─── triggers ────────────────────────────────────────────────────────────

drop trigger if exists trg_audit_drivers on public.drivers;
create trigger trg_audit_drivers
  after insert or update or delete on public.drivers
  for each row execute function private.log_audit_event();

drop trigger if exists trg_audit_app_users on public.app_users;
create trigger trg_audit_app_users
  after insert or update or delete on public.app_users
  for each row execute function private.log_audit_event();

drop trigger if exists trg_audit_driver_documents on public.driver_documents;
create trigger trg_audit_driver_documents
  after insert or update or delete on public.driver_documents
  for each row execute function private.log_audit_event();

-- shifts: only manual edits + removals. Bulk schedule generation inserts
-- dozens of rows at a time and would drown the trail, so INSERT is omitted.
drop trigger if exists trg_audit_shifts on public.shifts;
create trigger trg_audit_shifts
  after update or delete on public.shifts
  for each row execute function private.log_audit_event();


-- ─── read RPC ────────────────────────────────────────────────────────────
-- Tenant-scoped, ops-gated feed for the dashboard. Optional filters let the
-- driver drawer / schedule cell pull a per-record timeline. SECURITY DEFINER
-- so it can read the RLS-protected table, but it re-imposes the tenant + role
-- checks itself, so a dispatcher/driver gets an empty set rather than data.

create or replace function public.audit_feed(
  p_object_type text default null,
  p_object_id   uuid default null,
  p_limit       int  default 100
)
returns setof public.audit_events
language sql
stable
security definer
set search_path = ''
as $$
  select *
  from public.audit_events a
  where a.dsp_id = private.current_dsp_id()
    and private.is_staff(private.current_dsp_id(), 'ops')
    and (p_object_type is null or a.object_type = p_object_type)
    and (p_object_id   is null or a.object_id   = p_object_id)
  order by a.occurred_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

grant execute on function public.audit_feed(text, uuid, int) to authenticated;
