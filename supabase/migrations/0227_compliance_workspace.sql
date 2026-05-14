-- Migration 0227 · Compliance workspace · operational risk + cure
--                   infrastructure for the new Compliance page.
--
-- Models the operational objects the Compliance workspace treats as
-- shared state across panes:
--
--   · vendors                       — repair vendors with accountability score
--   · repair_orders                 — RO ledger linked to vehicle + vendor
--   · vehicle_grounding_events      — append-only ground/unground log so we
--                                     can compute days-grounded against the
--                                     Amazon 2 BD / 14 BD thresholds
--   · compliance_cures              — corrective action plans (Amazon, FMCSA,
--                                     internal) with a deadline + owner
--   · compliance_cure_steps         — evidence / action checklist per cure
--   · compliance_cure_links         — generic FK from a cure to any
--                                     operational object (vehicle, vendor,
--                                     RO, driver, document)
--   · compliance_audit_events       — hash-chained immutable timeline
--   · fmcsa_records                 — USDOT + MCS-150 + SAFER state per DSP
--   · compliance_documents          — evidence library, generic attachments
--   · compliance_monitors           — the rules engine's monitor registry
--
-- One RPC, compliance_workspace_bundle(p_dsp_id), returns the entire
-- workspace as a single JSON blob so the page renders from one call.
--
-- Idempotent: re-running after a partial apply is safe.

-- ───────────────────────── enums ─────────────────────────
do $$ begin
  create type compliance_severity as enum ('low','medium','high','critical');
exception when duplicate_object then null; end $$;

do $$ begin
  create type compliance_status as enum ('open','acknowledged','in_remediation','escalation_likely','mitigated','resolved');
exception when duplicate_object then null; end $$;

do $$ begin
  create type cure_source as enum ('amazon','fmcsa','internal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type cure_status as enum ('open','in_remediation','submitted','closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ro_status as enum ('draft','scheduled','in_progress','awaiting_parts','completed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type monitor_state as enum ('healthy','watching','alerting','crit','paused');
exception when duplicate_object then null; end $$;


-- ───────────────────────── vendors ─────────────────────────
create table if not exists public.vendors (
  id                       uuid primary key default gen_random_uuid(),
  dsp_id                   uuid not null references public.dsps(id) on delete cascade,
  name                     text not null,
  kind                     text default 'repair',           -- repair | mobile | tow | parts | other
  contact_name             text,
  contact_phone            text,
  contact_email            text,
  city                     text,
  distance_mi              numeric(6,1),
  accountability_score     int default 80,                  -- 0-100
  open_ros                 int default 0,                   -- denormalized
  on_time_pct              int,                             -- 0-100
  avg_eta_confirm_days     numeric(4,1),
  last_message_at          timestamptz,
  reassignment_threshold   int default 60,
  paused                   boolean default false,
  notes                    text,
  metadata                 jsonb default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists vendors_dsp_idx on public.vendors (dsp_id, paused, accountability_score);
create index if not exists vendors_dsp_name_idx on public.vendors (dsp_id, name);

alter table public.vendors enable row level security;
drop policy if exists "vendors_rw" on public.vendors;
create policy "vendors_rw" on public.vendors
  for all to authenticated
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.vendors to authenticated;


-- ───────────────────────── repair_orders ─────────────────────────
create table if not exists public.repair_orders (
  id                  uuid primary key default gen_random_uuid(),
  dsp_id              uuid not null references public.dsps(id) on delete cascade,
  vehicle_id          uuid references public.vehicles(id) on delete set null,
  vendor_id           uuid references public.vendors(id) on delete set null,
  code                text,                                  -- human RO code (RO-2026-118)
  summary             text not null,
  status              ro_status not null default 'draft',
  opened_at           timestamptz not null default now(),
  scheduled_at        timestamptz,                            -- when vendor scheduled work
  eta_at              timestamptz,                            -- vendor-confirmed ETA
  completed_at        timestamptz,                            -- repair complete
  cost_cents          int,
  invoice_doc_id      uuid,                                   -- soft FK to compliance_documents
  metadata            jsonb default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id) on delete set null
);
create index if not exists repair_orders_dsp_open_idx on public.repair_orders (dsp_id, status) where status not in ('completed','cancelled');
create index if not exists repair_orders_vehicle_idx on public.repair_orders (vehicle_id, opened_at desc);
create index if not exists repair_orders_vendor_idx on public.repair_orders (vendor_id, status);

alter table public.repair_orders enable row level security;
drop policy if exists "repair_orders_rw" on public.repair_orders;
create policy "repair_orders_rw" on public.repair_orders
  for all to authenticated
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.repair_orders to authenticated;


-- ───────────────────────── vehicle_grounding_events ─────────────────────────
-- Append-only log of every ground / unground transition.  The latest row
-- where ungrounded_at is null gives the current "grounded_since" timestamp
-- for the vehicle and lets us compute days-grounded against Amazon's
-- 2 BD scheduling / 14 BD completion thresholds.
create table if not exists public.vehicle_grounding_events (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  vehicle_id      uuid not null references public.vehicles(id) on delete cascade,
  grounded_at     timestamptz not null default now(),
  ungrounded_at   timestamptz,
  reason          text,
  grounded_by     uuid references auth.users(id) on delete set null,
  ungrounded_by   uuid references auth.users(id) on delete set null,
  ro_id           uuid references public.repair_orders(id) on delete set null,
  metadata        jsonb default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists vehicle_grounding_open_idx on public.vehicle_grounding_events (dsp_id, vehicle_id) where ungrounded_at is null;
create index if not exists vehicle_grounding_dsp_idx on public.vehicle_grounding_events (dsp_id, grounded_at desc);

alter table public.vehicle_grounding_events enable row level security;
drop policy if exists "vehicle_grounding_events_rw" on public.vehicle_grounding_events;
create policy "vehicle_grounding_events_rw" on public.vehicle_grounding_events
  for all to authenticated
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.vehicle_grounding_events to authenticated;


-- ───────────────────────── compliance_cures ─────────────────────────
create table if not exists public.compliance_cures (
  id                  uuid primary key default gen_random_uuid(),
  dsp_id              uuid not null references public.dsps(id) on delete cascade,
  code                text,                                  -- CURE-2026-014
  source              cure_source not null default 'amazon',
  title               text not null,
  description         text,
  status              cure_status not null default 'open',
  deadline_at         timestamptz,
  opened_at           timestamptz not null default now(),
  submitted_at        timestamptz,
  closed_at           timestamptz,
  owner_id            uuid references auth.users(id) on delete set null,
  acknowledged_at     timestamptz,
  metadata            jsonb default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists compliance_cures_open_idx on public.compliance_cures (dsp_id, status, deadline_at) where status <> 'closed';
create index if not exists compliance_cures_dsp_idx on public.compliance_cures (dsp_id, opened_at desc);

alter table public.compliance_cures enable row level security;
drop policy if exists "compliance_cures_rw" on public.compliance_cures;
create policy "compliance_cures_rw" on public.compliance_cures
  for all to authenticated
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.compliance_cures to authenticated;


-- ───────────────────────── compliance_cure_steps ─────────────────────────
create table if not exists public.compliance_cure_steps (
  id            uuid primary key default gen_random_uuid(),
  cure_id       uuid not null references public.compliance_cures(id) on delete cascade,
  ord           int not null default 0,
  title         text not null,
  sub           text,
  done_at       timestamptz,
  done_by       uuid references auth.users(id) on delete set null,
  metadata      jsonb default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists compliance_cure_steps_cure_idx on public.compliance_cure_steps (cure_id, ord);

alter table public.compliance_cure_steps enable row level security;
drop policy if exists "compliance_cure_steps_rw" on public.compliance_cure_steps;
create policy "compliance_cure_steps_rw" on public.compliance_cure_steps
  for all to authenticated
  using (
    exists (
      select 1 from public.compliance_cures c
      where c.id = cure_id and c.dsp_id = private.current_dsp_id()
    )
  )
  with check (
    exists (
      select 1 from public.compliance_cures c
      where c.id = cure_id and c.dsp_id = private.current_dsp_id()
    )
  );
grant select, insert, update, delete on public.compliance_cure_steps to authenticated;


-- ───────────────────────── compliance_cure_links ─────────────────────────
-- Generic many-to-many from a cure to any operational object.
create table if not exists public.compliance_cure_links (
  cure_id       uuid not null references public.compliance_cures(id) on delete cascade,
  object_type   text not null,   -- vehicle | vendor | repair_order | driver | document | risk
  object_id     uuid not null,
  label         text,
  created_at    timestamptz not null default now(),
  primary key (cure_id, object_type, object_id)
);
create index if not exists compliance_cure_links_obj_idx on public.compliance_cure_links (object_type, object_id);

alter table public.compliance_cure_links enable row level security;
drop policy if exists "compliance_cure_links_rw" on public.compliance_cure_links;
create policy "compliance_cure_links_rw" on public.compliance_cure_links
  for all to authenticated
  using (
    exists (select 1 from public.compliance_cures c where c.id = cure_id and c.dsp_id = private.current_dsp_id())
  )
  with check (
    exists (select 1 from public.compliance_cures c where c.id = cure_id and c.dsp_id = private.current_dsp_id())
  );
grant select, insert, update, delete on public.compliance_cure_links to authenticated;


-- ───────────────────────── compliance_audit_events ─────────────────────────
-- Append-only, hash-chained per-DSP.  Each insert sets prev_hash to the
-- previous row's hash and computes hash = sha256(prev_hash || payload).
create table if not exists public.compliance_audit_events (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  occurred_at     timestamptz not null default now(),
  actor_type      text not null default 'user',     -- user | system | vendor
  actor_id        uuid,
  actor_label     text,                              -- display label (e.g. "Quick-Fix Auto")
  kind            text not null,                     -- citation | acknowledge | ro_uploaded | reassignment | sla_breach | …
  summary         text not null,
  sub             text,
  object_type     text,                              -- vehicle | cure | repair_order | vendor | filing
  object_id       uuid,
  payload         jsonb default '{}'::jsonb,
  prev_hash       text,
  hash            text,
  created_at      timestamptz not null default now()
);
create index if not exists compliance_audit_dsp_idx on public.compliance_audit_events (dsp_id, occurred_at desc);
create index if not exists compliance_audit_obj_idx on public.compliance_audit_events (object_type, object_id);

alter table public.compliance_audit_events enable row level security;
drop policy if exists "compliance_audit_select" on public.compliance_audit_events;
create policy "compliance_audit_select" on public.compliance_audit_events
  for select to authenticated
  using (dsp_id = private.current_dsp_id());
drop policy if exists "compliance_audit_insert" on public.compliance_audit_events;
create policy "compliance_audit_insert" on public.compliance_audit_events
  for insert to authenticated
  with check (dsp_id = private.current_dsp_id());
grant select, insert on public.compliance_audit_events to authenticated;
-- Updates / deletes intentionally not granted: audit log is append-only.


-- ───────────────────────── fmcsa_records ─────────────────────────
create table if not exists public.fmcsa_records (
  dsp_id                          uuid primary key references public.dsps(id) on delete cascade,
  usdot                           text,
  mc_number                       text,
  operating_authority_status      text default 'active',
  oos_order                       boolean default false,
  insurance_bipd_on_file          boolean default false,
  insurance_bipd_cents            bigint,
  insurance_effective_at          date,
  mcs150_filed_at                 date,
  mcs150_next_due_at              date,
  mcs150_cmv_declared             int default 0,
  cure_required                   boolean default false,
  cure_deadline_at                date,
  safer_last_sync_at              timestamptz,
  notes                           text,
  metadata                        jsonb default '{}'::jsonb,
  updated_at                      timestamptz not null default now()
);

alter table public.fmcsa_records enable row level security;
drop policy if exists "fmcsa_records_rw" on public.fmcsa_records;
create policy "fmcsa_records_rw" on public.fmcsa_records
  for all to authenticated
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.fmcsa_records to authenticated;


-- ───────────────────────── compliance_documents ─────────────────────────
create table if not exists public.compliance_documents (
  id                  uuid primary key default gen_random_uuid(),
  dsp_id              uuid not null references public.dsps(id) on delete cascade,
  kind                text not null default 'document',  -- ro | invoice | photo | citation | fmcsa | safer | cure_packet | other
  name                text not null,
  file_path           text,
  size_bytes          bigint,
  attached_object_type text,
  attached_object_id   uuid,
  uploaded_at         timestamptz not null default now(),
  uploaded_by         uuid references auth.users(id) on delete set null,
  verified            boolean default false,
  verified_at         timestamptz,
  metadata            jsonb default '{}'::jsonb
);
create index if not exists compliance_documents_dsp_idx on public.compliance_documents (dsp_id, uploaded_at desc);
create index if not exists compliance_documents_obj_idx on public.compliance_documents (attached_object_type, attached_object_id);

alter table public.compliance_documents enable row level security;
drop policy if exists "compliance_documents_rw" on public.compliance_documents;
create policy "compliance_documents_rw" on public.compliance_documents
  for all to authenticated
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.compliance_documents to authenticated;


-- ───────────────────────── compliance_monitors ─────────────────────────
-- Registry of every monitor the rules engine evaluates for this DSP.
-- Per-DSP rows so a DSP owner can pause / configure their own monitors.
create table if not exists public.compliance_monitors (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  code            text not null,
  name            text not null,
  description     text,
  category        text not null default 'fleet',     -- fleet | fmcsa | vendor | driver | cap
  state           monitor_state not null default 'healthy',
  severity_reach  int not null default 2,             -- 1..4 (low..crit)
  data_source     text,
  rule_expr       text,
  automation      text default 'review',              -- auto | review | escalate | readonly
  escalation      text,
  last_check_at   timestamptz,
  paused          boolean default false,
  metadata        jsonb default '{}'::jsonb,
  unique (dsp_id, code)
);
create index if not exists compliance_monitors_dsp_idx on public.compliance_monitors (dsp_id, category, state);

alter table public.compliance_monitors enable row level security;
drop policy if exists "compliance_monitors_rw" on public.compliance_monitors;
create policy "compliance_monitors_rw" on public.compliance_monitors
  for all to authenticated
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());
grant select, insert, update, delete on public.compliance_monitors to authenticated;


-- ───────────────────────── helpers ─────────────────────────
-- Days-grounded for a given vehicle (most recent open grounding event).
create or replace function public.vehicle_days_grounded(p_vehicle_id uuid)
returns numeric
language sql
stable
as $$
  select extract(epoch from (now() - max(grounded_at))) / 86400.0
  from public.vehicle_grounding_events
  where vehicle_id = p_vehicle_id
    and ungrounded_at is null
$$;


-- ───────────────────────── compliance_workspace_bundle ─────────────────────────
-- Returns the entire workspace as one JSON blob so the page renders
-- from a single call.  Read-only.
create or replace function public.compliance_workspace_bundle(p_dsp_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_dsp_id uuid := coalesce(p_dsp_id, private.current_dsp_id());
  v_posture jsonb;
  v_grounded jsonb;
  v_vendors jsonb;
  v_cures jsonb;
  v_fmcsa jsonb;
  v_docs jsonb;
  v_audit jsonb;
  v_monitors jsonb;
  v_fleet jsonb;
  v_risks jsonb;
  v_g_count int;
  v_over_amazon int;
  v_open_cures int;
  v_repair_overdue int;
  v_vendor_stalls int;
  v_total_v int;
  v_op_v int;
begin
  if v_dsp_id is null then
    return jsonb_build_object('error','no_dsp');
  end if;

  -- Tenant gate (don't trust caller-supplied dsp_id when it doesn't match
  -- the auth context).
  if v_dsp_id <> private.current_dsp_id() then
    return jsonb_build_object('error','forbidden');
  end if;

  -- ── Grounded vehicles ──
  with g as (
    select
      v.id,
      coalesce(v.nickname, v.name) as label,
      v.vin,
      v.operational_status,
      ge.grounded_at,
      ge.reason,
      ro.id           as ro_id,
      ro.code         as ro_code,
      ro.status       as ro_status,
      ro.eta_at       as ro_eta_at,
      ro.scheduled_at as ro_scheduled_at,
      ven.id          as vendor_id,
      ven.name        as vendor_name,
      ven.accountability_score as vendor_score,
      ven.last_message_at      as vendor_last_msg,
      extract(epoch from (v_now - ge.grounded_at)) / 86400.0 as days_grounded
    from public.vehicles v
    join lateral (
      select * from public.vehicle_grounding_events
      where vehicle_id = v.id and ungrounded_at is null
      order by grounded_at desc limit 1
    ) ge on true
    left join lateral (
      select * from public.repair_orders
      where vehicle_id = v.id and status not in ('completed','cancelled')
      order by opened_at desc limit 1
    ) ro on true
    left join public.vendors ven on ven.id = ro.vendor_id
    where v.dsp_id = v_dsp_id
  )
  select
    jsonb_agg(jsonb_build_object(
      'vehicle_id',       id,
      'label',            label,
      'vin',              vin,
      'grounded_at',      grounded_at,
      'days_grounded',    round(days_grounded, 1),
      'reason',           reason,
      'ro_id',            ro_id,
      'ro_code',          ro_code,
      'ro_status',        ro_status,
      'ro_eta_at',        ro_eta_at,
      'ro_scheduled_at',  ro_scheduled_at,
      'vendor_id',        vendor_id,
      'vendor_name',      vendor_name,
      'vendor_score',     vendor_score,
      'vendor_last_msg',  vendor_last_msg,
      'over_amazon_threshold', days_grounded > 14,
      'in_amazon_warn',        days_grounded > 7
    ) order by days_grounded desc) ,
    count(*),
    count(*) filter (where days_grounded > 14)
  into v_grounded, v_g_count, v_over_amazon
  from g;
  v_grounded := coalesce(v_grounded, '[]'::jsonb);

  -- ── Vendors (scorecards) ──
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',                    v.id,
    'name',                  v.name,
    'kind',                  v.kind,
    'accountability_score',  v.accountability_score,
    'open_ros',              coalesce(r.open_ros, 0),
    'on_time_pct',           v.on_time_pct,
    'avg_eta_confirm_days',  v.avg_eta_confirm_days,
    'last_message_at',       v.last_message_at,
    'reassignment_threshold', v.reassignment_threshold,
    'paused',                v.paused,
    'distance_mi',           v.distance_mi
  ) order by v.accountability_score asc), '[]'::jsonb)
  into v_vendors
  from public.vendors v
  left join (
    select vendor_id, count(*) as open_ros
    from public.repair_orders
    where dsp_id = v_dsp_id and status not in ('completed','cancelled')
    group by vendor_id
  ) r on r.vendor_id = v.id
  where v.dsp_id = v_dsp_id;

  select count(*) into v_vendor_stalls
  from public.vendors
  where dsp_id = v_dsp_id and accountability_score < reassignment_threshold;

  -- ── Cures ──
  with c as (
    select
      cu.id, cu.code, cu.source, cu.title, cu.description, cu.status,
      cu.deadline_at, cu.opened_at, cu.submitted_at, cu.closed_at,
      extract(epoch from (cu.deadline_at - v_now)) / 86400.0 as days_to_deadline,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', s.id, 'ord', s.ord, 'title', s.title, 'sub', s.sub,
          'done', s.done_at is not null,
          'done_at', s.done_at
        ) order by s.ord), '[]'::jsonb)
        from public.compliance_cure_steps s where s.cure_id = cu.id
      ) as steps,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'object_type', l.object_type, 'object_id', l.object_id, 'label', l.label
        )), '[]'::jsonb)
        from public.compliance_cure_links l where l.cure_id = cu.id
      ) as links,
      (
        select au.full_name from public.app_users au where au.id = cu.owner_id
      ) as owner_name,
      (
        select count(*) from public.compliance_cure_steps s
        where s.cure_id = cu.id
      ) as step_total,
      (
        select count(*) from public.compliance_cure_steps s
        where s.cure_id = cu.id and s.done_at is not null
      ) as step_done
    from public.compliance_cures cu
    where cu.dsp_id = v_dsp_id
      and cu.status <> 'closed'
    order by cu.deadline_at nulls last
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',               c.id,
    'code',             c.code,
    'source',           c.source,
    'title',            c.title,
    'description',      c.description,
    'status',           c.status,
    'deadline_at',      c.deadline_at,
    'days_to_deadline', round(c.days_to_deadline, 1),
    'opened_at',        c.opened_at,
    'owner_name',       c.owner_name,
    'steps',            c.steps,
    'links',            c.links,
    'step_total',       c.step_total,
    'step_done',        c.step_done
  )), '[]'::jsonb)
  into v_cures
  from c;

  select count(*) into v_open_cures
  from public.compliance_cures
  where dsp_id = v_dsp_id and status <> 'closed';

  -- ── FMCSA ──
  select to_jsonb(f.*) into v_fmcsa
  from public.fmcsa_records f
  where f.dsp_id = v_dsp_id;

  -- ── Documents (recent 24) ──
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'kind', d.kind, 'name', d.name,
    'attached_object_type', d.attached_object_type,
    'attached_object_id',   d.attached_object_id,
    'uploaded_at', d.uploaded_at,
    'uploaded_by_name', (select full_name from public.app_users where id = d.uploaded_by),
    'verified', d.verified,
    'size_bytes', d.size_bytes
  ) order by d.uploaded_at desc), '[]'::jsonb)
  into v_docs
  from (
    select * from public.compliance_documents
    where dsp_id = v_dsp_id
    order by uploaded_at desc limit 24
  ) d;

  -- ── Audit (recent 40) ──
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'occurred_at', e.occurred_at,
    'actor_type', e.actor_type,
    'actor_label', e.actor_label,
    'kind', e.kind,
    'summary', e.summary,
    'sub', e.sub,
    'object_type', e.object_type,
    'object_id', e.object_id
  ) order by e.occurred_at desc), '[]'::jsonb)
  into v_audit
  from (
    select * from public.compliance_audit_events
    where dsp_id = v_dsp_id
    order by occurred_at desc limit 40
  ) e;

  -- ── Monitors ──
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'code', m.code, 'name', m.name,
    'description', m.description, 'category', m.category,
    'state', m.state, 'severity_reach', m.severity_reach,
    'data_source', m.data_source, 'rule_expr', m.rule_expr,
    'automation', m.automation, 'escalation', m.escalation,
    'last_check_at', m.last_check_at, 'paused', m.paused
  ) order by m.severity_reach desc, m.name), '[]'::jsonb)
  into v_monitors
  from public.compliance_monitors m
  where m.dsp_id = v_dsp_id;

  -- ── Fleet posture ──
  select
    count(*),
    count(*) filter (where operational_status = 'operational')
  into v_total_v, v_op_v
  from public.vehicles where dsp_id = v_dsp_id;

  -- Vehicles in repair (open RO, vehicle not flagged grounded)
  select jsonb_build_object(
    'total',       v_total_v,
    'operational', v_op_v,
    'grounded',    v_g_count,
    'in_repair',   greatest(0, (
      select count(distinct ro.vehicle_id)
      from public.repair_orders ro
      where ro.dsp_id = v_dsp_id
        and ro.status not in ('completed','cancelled')
        and ro.vehicle_id is not null
        and not exists (
          select 1 from public.vehicle_grounding_events ge
          where ge.vehicle_id = ro.vehicle_id and ge.ungrounded_at is null
        )
    ))
  ) into v_fleet;

  -- ── Repairs overdue (open ROs where days_grounded > 14 OR (>7 AND no_ro)) ──
  v_repair_overdue := 0;
  select count(*) into v_repair_overdue
  from (
    select g->>'vehicle_id' as vid, (g->>'days_grounded')::numeric as dg,
           g->>'ro_id' as ro
    from jsonb_array_elements(v_grounded) g
  ) x
  where x.dg > 14 or (x.dg > 7 and x.ro is null);

  -- ── Active risks (synthesized) ──
  -- We don't store a compliance_risks table; risks are derived from the
  -- live state of the underlying objects.  The aggregator emits a row
  -- for each grounded VIN over threshold, each open cure approaching
  -- deadline, each vendor below the reassignment threshold, etc.
  v_risks := '[]'::jsonb;

  -- Grounded vehicle risks
  v_risks := v_risks || coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind',     'grounded_vehicle',
      'severity', case when (g->>'days_grounded')::numeric > 14 then 'critical'
                       when (g->>'days_grounded')::numeric > 7  then 'critical'
                       else 'medium' end,
      'cite',     'amazon',
      'title',    case when (g->>'ro_id') is null
                       then 'Vehicle grounded ' || round((g->>'days_grounded')::numeric)::text || ' days · no active RO'
                       else 'Vehicle grounded ' || round((g->>'days_grounded')::numeric)::text || ' days · RO open' end,
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','VIN', 'val', coalesce(g->>'vin', '—')),
        jsonb_build_object('lbl','UNIT','val', coalesce(g->>'label','—'))
      ),
      'meta', jsonb_build_object(
        'days_grounded', (g->>'days_grounded')::numeric,
        'vendor',        g->>'vendor_name',
        'vendor_score',  g->>'vendor_score',
        'ro_code',       g->>'ro_code',
        'ro_id',         g->>'ro_id'
      ),
      'object_type', 'vehicle',
      'object_id',   g->>'vehicle_id'
    ))
    from jsonb_array_elements(v_grounded) g
  ), '[]'::jsonb);

  -- Cure approaching-deadline risks
  v_risks := v_risks || coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind',     'cure_deadline',
      'severity', case when (c->>'days_to_deadline')::numeric < 3 then 'critical'
                       when (c->>'days_to_deadline')::numeric < 14 then 'high'
                       else 'medium' end,
      'cite',     c->>'source',
      'title',    'Cure deadline · ' || coalesce(c->>'title','(no title)'),
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','CURE','val', coalesce(c->>'code',''))
      ),
      'meta', jsonb_build_object(
        'days_to_deadline', (c->>'days_to_deadline')::numeric,
        'deadline_at',      c->>'deadline_at',
        'step_done',        (c->>'step_done')::int,
        'step_total',       (c->>'step_total')::int
      ),
      'object_type','cure',
      'object_id',  c->>'id'
    ))
    from jsonb_array_elements(v_cures) c
  ), '[]'::jsonb);

  -- Vendor stall risks
  v_risks := v_risks || coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind',     'vendor_stall',
      'severity', case when (v->>'accountability_score')::int < 60 then 'high'
                       else 'medium' end,
      'cite',     'internal',
      'title',    'Vendor accountability below reassignment threshold · ' || (v->>'name'),
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','VENDOR','val', v->>'name'),
        jsonb_build_object('lbl','OPEN ROs','val', coalesce(v->>'open_ros','0'))
      ),
      'meta', jsonb_build_object(
        'score',      (v->>'accountability_score')::int,
        'threshold',  (v->>'reassignment_threshold')::int,
        'open_ros',   (v->>'open_ros')::int
      ),
      'object_type','vendor',
      'object_id',  v->>'id'
    ))
    from jsonb_array_elements(v_vendors) v
    where (v->>'accountability_score')::int < (v->>'reassignment_threshold')::int
  ), '[]'::jsonb);

  -- FMCSA / MCS-150 risk
  if v_fmcsa is not null and (v_fmcsa->>'cure_required')::boolean then
    v_risks := v_risks || jsonb_build_array(jsonb_build_object(
      'kind',     'fmcsa_mcs150',
      'severity', 'high',
      'cite',     'fmcsa',
      'title',    'MCS-150 cure required · CMV reclassification + proof of submission',
      'subjects', jsonb_build_array(
        jsonb_build_object('lbl','USDOT','val', coalesce(v_fmcsa->>'usdot','—'))
      ),
      'meta', jsonb_build_object(
        'cure_deadline_at',    v_fmcsa->>'cure_deadline_at',
        'mcs150_cmv_declared', v_fmcsa->>'mcs150_cmv_declared'
      ),
      'object_type','fmcsa',
      'object_id',  v_dsp_id
    ));
  end if;

  -- ── Posture ──
  v_posture := jsonb_build_object(
    'readiness_score', greatest(0, least(100, 100
                            - coalesce(v_over_amazon,0)*15
                            - coalesce(v_open_cures,0)*8
                            - greatest(0, coalesce(v_vendor_stalls,0))*6
                            - greatest(0, coalesce(v_g_count,0))*3)),
    'grounded_count', coalesce(v_g_count, 0),
    'over_amazon_threshold', coalesce(v_over_amazon, 0),
    'repairs_overdue', coalesce(v_repair_overdue, 0),
    'vendor_stalls',   coalesce(v_vendor_stalls, 0),
    'open_cures',      coalesce(v_open_cures, 0),
    'last_sweep_at',   v_now,
    'fleet',           v_fleet
  );

  return jsonb_build_object(
    'posture',           v_posture,
    'risks',             v_risks,
    'cures',             v_cures,
    'grounded_vehicles', v_grounded,
    'vendors',           v_vendors,
    'fmcsa',             v_fmcsa,
    'documents',         v_docs,
    'audit_events',      v_audit,
    'monitors',          v_monitors,
    'fleet',             v_fleet,
    'generated_at',      v_now
  );
end;
$$;

grant execute on function public.compliance_workspace_bundle(uuid) to authenticated;


-- ───────────────────────── seed: default monitors for every DSP ─────────────────────────
-- Each DSP gets the canonical monitor set on first sweep.  Re-running
-- is safe because of (dsp_id, code) unique.
create or replace function public.compliance_seed_monitors(p_dsp_id uuid)
returns void
language plpgsql
as $$
begin
  insert into public.compliance_monitors (dsp_id, code, name, description, category, severity_reach, data_source, rule_expr, automation, escalation, state)
  values
    (p_dsp_id, 'grounded_duration_vs_amazon',
     'Vehicle grounding duration vs Amazon SLA',
     'IF grounded_days > 14 OR (grounded_days > 7 AND no_active_RO) THEN trigger escalation workflow and stage cure.',
     'fleet', 4, 'DVIC + fleet portal',
     'grounded_days > 14 OR (grounded_days > 7 AND no_active_RO)',
     'escalate', 'Escalation workflow + auto-staged cure', 'healthy'),
    (p_dsp_id, 'repair_scheduled_2bd',
     'Repair scheduled within 2 BD',
     'Tracks every grounded VIN against Amazon''s 2-business-day repair-scheduling expectation; auto-reminds the assigned vendor and dispatcher if scheduling slips.',
     'fleet', 3, 'vendor portal',
     'scheduled_at - grounded_at <= 2 business days',
     'auto', '2 BD reminder · then operator review', 'healthy'),
    (p_dsp_id, 'repair_completed_14bd',
     'Repair completed within 14 BD',
     'Tracks every open RO against Amazon''s 14-business-day completion expectation; pre-stages a cure record when the threshold is crossed without RTS.',
     'fleet', 4, 'internal RO ledger',
     'completed_at - grounded_at <= 14 business days',
     'escalate', 'Pre-stages cure record', 'healthy'),
    (p_dsp_id, 'active_ro_required',
     'Active RO required while grounded',
     'A grounded VIN without a documented RO inside 1 BD raises a critical risk and notifies the DSP owner.',
     'fleet', 4, 'RO ledger + DVIC',
     'grounded AND no_active_RO AND grounded_days >= 1',
     'auto', 'Owner alert + auto-task', 'healthy'),
    (p_dsp_id, 'vendor_sla_reassignment',
     'Vendor SLA & reassignment threshold',
     'Per-vendor accountability rolls ETA confirm, RO upload, on-time completion, message latency, and invoice timeliness into one score. Below 70 → pause new assignments; below 60 → recommend reassignment.',
     'vendor', 3, 'vendor portal + messages',
     'accountability_score < reassignment_threshold',
     'auto', 'Auto-pause · auto-recommend alternate', 'healthy'),
    (p_dsp_id, 'unground_reminder',
     'Ungrounding reminder · post-repair',
     'Once an RO is marked complete with evidence attached, the dispatcher is reminded to re-inspect and un-ground the vehicle and re-sync the operational readiness signal on the Amazon fleet portal.',
     'fleet', 2, 'RO ledger',
     'ro.completed_at IS NOT NULL AND vehicle.operational_status = ''grounded''',
     'auto', 'Auto-reminder · hourly', 'healthy'),
    (p_dsp_id, 'mcs150_cmv_reconcile',
     'MCS-150 biennial · CMV reconciliation',
     'IF cmv_count > 0 AND dsp_type = amazon_dsp THEN trigger compliance warning. Daily reconciliation of MCS-150 declaration against the live fleet roster.',
     'fmcsa', 4, 'MCS-150 · fleet roster',
     'mcs150_cmv_declared > 0 AND fleet_cmv_actual = 0',
     'review', 'Operator review · daily', 'healthy'),
    (p_dsp_id, 'safer_profile_change',
     'SAFER profile change',
     'Continuous watch on FMCSA SAFER · alerts on de-authorization, rating change, insurance gap, or OOS order. Halts schedule publish on OOS.',
     'fmcsa', 4, 'FMCSA SAFER',
     'safer.delta IN (oos, deauth, rating_change, insurance_lapse)',
     'auto', 'Immediate · halts publish on OOS', 'healthy'),
    (p_dsp_id, 'operational_readiness_portal',
     'Operational readiness · portal sync',
     '4× daily comparison of Amazon fleet portal vs internal grounded state. Surfaces any disagreement as a risk so the operator can re-sync before Amazon escalates.',
     'fleet', 3, 'Amazon fleet portal',
     'portal.operational_readiness != internal.operational_readiness',
     'review', 'Operator review · 4× daily', 'healthy'),
    (p_dsp_id, 'dvic_defect_trends',
     'DVIC defect trends',
     'Rolling 14d defect frequency per VIN and per category · 3× baseline triggers a root-cause inspection campaign.',
     'fleet', 2, 'DVIC submissions',
     'rolling_14d_defect_rate > 3 * baseline',
     'review', 'Operator review · per submission', 'healthy'),
    (p_dsp_id, 'license_expiration',
     'License expiration · hard-rule integration',
     'Tiered reminders 30d / 14d / 7d / 1d · the Schedule blocks publish on expired licenses (configurable).',
     'driver', 3, 'driver records',
     'license_expires_at <= now() + interval ''30 days''',
     'auto', '30 / 14 / 7 / 1 day reminders · schedule block at expiry', 'healthy'),
    (p_dsp_id, 'amazon_cap_precursor',
     'Amazon escalation precursor patterns',
     'Pattern matcher scored on historical Amazon CAPs · scores live operational state against signatures that historically preceded breach notifications. Pre-stages cure records on match.',
     'cap', 4, 'cross-module · v2026.5',
     'cap_precursor_score > 0.75',
     'escalate', 'Pre-staged cure', 'healthy')
  on conflict (dsp_id, code) do update set
    name        = excluded.name,
    description = excluded.description,
    category    = excluded.category,
    severity_reach = excluded.severity_reach,
    data_source = excluded.data_source,
    rule_expr   = excluded.rule_expr,
    automation  = excluded.automation,
    escalation  = excluded.escalation;
end;
$$;

grant execute on function public.compliance_seed_monitors(uuid) to authenticated;


-- ───────────────────────── back-fill: seed monitors for existing DSPs ─────────────────────────
do $$
declare r record;
begin
  for r in select id from public.dsps loop
    perform public.compliance_seed_monitors(r.id);
  end loop;
end $$;
