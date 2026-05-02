-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510250000 · Finance — invoices + line items + disputes
-- Phase 7. Variable invoice ingestion + per-line-item reconciliation
-- against own delivery records + dispute drafting.
--
-- Design note: reconciliation rules live as JSONB on each line item
-- (rule_check) rather than as a separate rules table. This keeps the
-- audit history per line. Rules themselves are configured per DSP
-- (which checks to run) — see reconciliation_rules table below.
-- ─────────────────────────────────────────────────────────────────────────

create type public.invoice_source as enum (
  'amazon_variable',     -- Amazon DSP Variable invoice (the big one)
  'amazon_fmp',          -- Fixed Monthly Payment
  'insurance',           -- Per-vehicle insurance
  'rental_3p',           -- 3rd-party van rental
  'fuel',                -- Fleet fuel card statement
  'tolls',
  'maintenance',
  'other'
);

create type public.invoice_status as enum (
  'imported','reviewed','disputed','closed'
);

create type public.dispute_resolution as enum (
  'won','partial','lost','withdrawn','pending'
);

-- ─── Invoices ────────────────────────────────────────────────────────────

create table public.invoices (
  id                     uuid                  primary key default gen_random_uuid(),
  dsp_id                 uuid                  not null references public.dsps(id) on delete cascade,
  source                 public.invoice_source not null,
  vendor_name            text,
  period_start           date                  not null,
  period_end             date                  not null,
  invoice_number         text,
  amount_billed_cents    int                   not null,
  amount_disputed_cents  int                   not null default 0,
  amount_recovered_cents int                   not null default 0,
  status                 public.invoice_status not null default 'imported',
  attached_file          text,                                              -- Storage path (PDF/CSV)
  raw_data               jsonb,                                             -- parsed line items / metadata
  notes                  text,
  imported_at            timestamptz           not null default now(),
  imported_by            uuid                  references public.app_users(id),
  reviewed_at            timestamptz,
  reviewed_by            uuid                  references public.app_users(id),

  constraint invoices_period_valid check (period_end >= period_start),
  constraint invoices_invoice_number_unique unique (dsp_id, source, invoice_number)
);

create index invoices_dsp_period_idx
  on public.invoices (dsp_id, period_end desc);
create index invoices_status_idx
  on public.invoices (dsp_id, status) where status in ('imported','disputed');
create index invoices_recovery_idx
  on public.invoices (dsp_id, amount_recovered_cents)
  where amount_recovered_cents > 0;

create trigger trg_invoices_imported_at
  before update on public.invoices
  for each row execute function moddatetime(reviewed_at);

comment on table public.invoices is
  'Vendor invoices. amount_disputed = sum of disputes for this invoice; ' ||
  'amount_recovered = sum of resolution=won|partial recoveries.';

alter table public.invoices enable row level security;

create policy "invoices_owner_select"
  on public.invoices for select
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'ops')
  );

create policy "invoices_ops_write"
  on public.invoices for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update, delete on public.invoices to authenticated;

-- ─── Line items (one row per billed line on the invoice) ────────────────

create table public.invoice_line_items (
  id              uuid        primary key default gen_random_uuid(),
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  invoice_id      uuid        not null references public.invoices(id) on delete cascade,
  line_number     int,                            -- order on the invoice
  description     text        not null,
  category        text,                           -- 'damages','late_returns','scan_compliance','dcr','rental','other'
  amount_cents    int         not null,
  quantity        numeric(10,3),
  rule_check      jsonb,
                  -- Reconciliation result: { rule, expected, actual, match: bool, evidence }
  flagged         boolean     not null default false,    -- worth disputing
  disputed        boolean     not null default false,    -- already in disputes
  notes           text,
  created_at      timestamptz not null default now()
);

create index invoice_line_items_invoice_idx
  on public.invoice_line_items (invoice_id, line_number);
create index invoice_line_items_flagged_idx
  on public.invoice_line_items (dsp_id, flagged) where flagged = true and not disputed;

alter table public.invoice_line_items enable row level security;

create policy "invoice_lines_ops_select"
  on public.invoice_line_items for select
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

create policy "invoice_lines_ops_write"
  on public.invoice_line_items for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update, delete on public.invoice_line_items to authenticated;

-- ─── Disputes ────────────────────────────────────────────────────────────

create table public.disputes (
  id                  uuid                       primary key default gen_random_uuid(),
  dsp_id              uuid                       not null references public.dsps(id) on delete cascade,
  invoice_id          uuid                       references public.invoices(id) on delete set null,
  line_item_id        uuid                       references public.invoice_line_items(id) on delete set null,
  amount_cents        int                        not null,
  drafted_letter      text,                                              -- AI-generated dispute text
  evidence_refs       jsonb,                                              -- attendance / shift / form_submission ids
  attached_files      text[],                                              -- Storage paths to dashcam, telematics, etc.
  submitted_at        timestamptz,
  submission_method   text,                                              -- 'amazon_portal','email','letter','other'
  resolution          public.dispute_resolution  not null default 'pending',
  resolved_at         timestamptz,
  recovered_cents     int                        not null default 0,
  notes               text,
  created_at          timestamptz                not null default now(),
  created_by          uuid                       references public.app_users(id)
);

create index disputes_dsp_status_idx
  on public.disputes (dsp_id, resolution);
create index disputes_invoice_idx
  on public.disputes (invoice_id) where invoice_id is not null;
create index disputes_pending_idx
  on public.disputes (dsp_id, submitted_at) where resolution = 'pending';

comment on table public.disputes is
  'Tracks every dispute filed against an invoice/line item. recovered_cents ' ||
  'rolls up to invoices.amount_recovered_cents via trigger.';

alter table public.disputes enable row level security;

create policy "disputes_ops_select"
  on public.disputes for select
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

create policy "disputes_ops_write"
  on public.disputes for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update, delete on public.disputes to authenticated;

-- ─── Reconciliation rules (per-DSP toggles) ─────────────────────────────

create table public.reconciliation_rules (
  id            uuid        primary key default gen_random_uuid(),
  dsp_id        uuid        not null references public.dsps(id) on delete cascade,
  rule_key      text        not null,
                -- 'scan_compliance','route_count','late_return','damage_at_fault',
                -- 'dcr_tier','safety_misclassification', etc.
  enabled       boolean     not null default true,
  config        jsonb       not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint reconciliation_rules_unique unique (dsp_id, rule_key)
);

create trigger trg_reconciliation_rules_updated_at
  before update on public.reconciliation_rules
  for each row execute function moddatetime(updated_at);

alter table public.reconciliation_rules enable row level security;

create policy "recon_rules_tenant_select"
  on public.reconciliation_rules for select
  using (dsp_id = private.current_dsp_id());

create policy "recon_rules_owner_write"
  on public.reconciliation_rules for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'));

grant select, insert, update, delete on public.reconciliation_rules to authenticated;
