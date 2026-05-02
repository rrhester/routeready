-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510270000 · AI features (Smart Drop + Build-Your-Own-Tool)
-- Phase 8. Schema for the LLM-powered features. Edge Functions
-- (smart-drop-extract, generate-coaching-sms, generate-dispute-letter,
-- run-tool, build-tool) call Anthropic API; this migration just stores
-- the inputs/outputs.
--
-- DESIGN NOTE: AI features are explicitly "earned" — defer to Phase 8
-- because they each carry research-project risk (per the audit). The
-- schema is here so the work can be done by a small team in parallel
-- without blocking ops/finance/etc.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── Smart Drop ─────────────────────────────────────────────────────────
-- A user uploads any messy file (CSV, Excel, PDF). The Edge Function
-- calls Claude to extract structured data + classify which RouteReady
-- tool the data feeds. Results stored here for audit + re-run.

create type public.smart_drop_status as enum (
  'uploaded',          -- file in Storage, not yet processed
  'processing',        -- Edge Function is running
  'extracted',         -- structured data ready, awaiting routing
  'routed',            -- data has been written to target table(s)
  'failed',            -- extraction failed; see error
  'rejected'           -- user rejected the routing suggestion
);

create table public.smart_drop_uploads (
  id              uuid                   primary key default gen_random_uuid(),
  dsp_id          uuid                   not null references public.dsps(id) on delete cascade,
  filename        text                   not null,
  storage_path    text                   not null,
  mime_type       text,
  byte_size       bigint,
  uploaded_by     uuid                   references public.app_users(id),
  status          public.smart_drop_status not null default 'uploaded',
  detected_kind   text,                                          -- 'payroll','scorecard','attendance','vehicles','other'
  extracted_rows  jsonb,                                         -- normalized rows ready to insert
  routing_target  text,                                          -- 'attendance_events','drivers',etc.
  error_message   text,
  ai_model        text,                                          -- which Anthropic model handled this
  ai_tokens_used  int,
  created_at      timestamptz            not null default now(),
  processed_at    timestamptz,
  routed_at       timestamptz
);

create index smart_drop_dsp_status_idx
  on public.smart_drop_uploads (dsp_id, status, created_at desc);

comment on table public.smart_drop_uploads is
  'Files dropped via Smart Drop. Edge Function smart-drop-extract calls ' ||
  'Claude API to detect kind + extract rows. Routing happens via a ' ||
  'separate route_smart_drop RPC after user confirms the suggestion.';

alter table public.smart_drop_uploads enable row level security;

create policy "smart_drop_tenant_select"
  on public.smart_drop_uploads for select
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

create policy "smart_drop_ops_write"
  on public.smart_drop_uploads for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update, delete on public.smart_drop_uploads to authenticated;

-- ─── Build Your Own Tool (custom AI-generated tools) ────────────────────

create table public.ai_tools (
  id           uuid        primary key default gen_random_uuid(),
  dsp_id       uuid        not null references public.dsps(id) on delete cascade,
  name         text        not null,
  description  text,
  prompt       text        not null,                            -- the original user prompt
  definition   jsonb       not null,                            -- AI-generated structure
                           -- { metrics: [...], rules: [...], dashboard_cards: [...], schema_map: {...} }
  source_data  text,                                            -- description of what data this runs against
  enabled      boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid        references public.app_users(id)
);

create index ai_tools_dsp_enabled_idx
  on public.ai_tools (dsp_id) where enabled = true;

create trigger trg_ai_tools_updated_at
  before update on public.ai_tools
  for each row execute function moddatetime(updated_at);

comment on table public.ai_tools is
  'Saved AI-generated custom tools. The user describes a problem ' ||
  '(e.g. "Time Theft Analyzer"); Claude generates the metrics + rules + ' ||
  'dashboard. Saved here for re-run with fresh data.';

alter table public.ai_tools enable row level security;

create policy "ai_tools_tenant_select"
  on public.ai_tools for select
  using (dsp_id = private.current_dsp_id());

create policy "ai_tools_ops_write"
  on public.ai_tools for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update, delete on public.ai_tools to authenticated;

-- ─── Tool runs (history of executions) ─────────────────────────────────

create table public.ai_tool_runs (
  id              uuid        primary key default gen_random_uuid(),
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  tool_id         uuid        not null references public.ai_tools(id) on delete cascade,
  input_data      jsonb,                                         -- what data was fed in
  output_results  jsonb,                                         -- computed metrics + rule outcomes
  flagged_count   int,                                           -- how many rule-hits were flagged
  notes           text,
  triggered_by    uuid        references public.app_users(id),
  created_at      timestamptz not null default now()
);

create index ai_tool_runs_dsp_tool_idx
  on public.ai_tool_runs (dsp_id, tool_id, created_at desc);

alter table public.ai_tool_runs enable row level security;

create policy "ai_tool_runs_tenant_select"
  on public.ai_tool_runs for select
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

create policy "ai_tool_runs_ops_insert"
  on public.ai_tool_runs for insert
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert on public.ai_tool_runs to authenticated;

-- ─── AI usage log (cost tracking + rate limiting) ─────────────────────

create table public.ai_usage_log (
  id              uuid        primary key default gen_random_uuid(),
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  function_name   text        not null,                          -- 'smart-drop-extract','generate-coaching-sms',etc.
  model           text        not null,                          -- 'claude-opus-4-7','claude-sonnet-4-6',etc.
  input_tokens    int         not null default 0,
  output_tokens   int         not null default 0,
  cost_cents      int,                                           -- approximate
  related_kind    text,                                          -- 'tool_run','smart_drop','coaching','dispute'
  related_id      uuid,
  triggered_by    uuid        references public.app_users(id),
  created_at      timestamptz not null default now()
);

create index ai_usage_log_dsp_idx
  on public.ai_usage_log (dsp_id, created_at desc);
create index ai_usage_log_function_idx
  on public.ai_usage_log (dsp_id, function_name, created_at desc);

alter table public.ai_usage_log enable row level security;

create policy "ai_usage_log_owner_select"
  on public.ai_usage_log for select
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'owner'));

revoke all on public.ai_usage_log from public, anon, authenticated;
grant select on public.ai_usage_log to authenticated;
