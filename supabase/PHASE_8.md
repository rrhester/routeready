# Phase 8 — AI features

The earned features that ship after the operational core proves stable.
Smart Drop ingestion, Build-Your-Own-Tool, AI-drafted coaching SMS,
and the AI usage log for cost monitoring. **All AI Edge Functions
require `ANTHROPIC_API_KEY` set as a Supabase secret.**

This phase completes the 8-phase build-out spec.

## Files

```
migrations/
  20260510270000_ai_features.sql            # smart_drop_uploads + ai_tools + ai_tool_runs + ai_usage_log
  20260510280000_phase8_rpcs_audit.sql      # route_smart_drop / save_ai_tool / log_ai_tool_run / log_ai_usage + audit
functions/
  generate-coaching-sms/index.ts            # Claude API draft → returns text only (frontend reviews + sends)
  smart-drop-extract/index.ts               # Reads file, calls Claude, fills extracted_rows
tests/rls/
  ai_features.test.sql                      # 10 assertions
PHASE_8.md
```

## What ships

### Smart Drop ingestion
- **`smart_drop_uploads`** table tracks every file dropped — status flow: `uploaded → processing → extracted → routed` (or `failed`/`rejected`)
- **`smart-drop-extract`** Edge Function downloads from Storage, calls Claude API to detect kind + extract normalized rows, updates the row
- **`route_smart_drop(upload, target, rows)`** RPC commits the extracted rows to the target table (attendance_events / drivers / vehicles), writes via the existing bulk-import RPCs
- Detected kinds: `payroll`, `scorecard`, `attendance`, `drivers`, `vehicles`, `delivery_records`, `other`

### Build-Your-Own-Tool
- **`ai_tools`** stores tool definitions: original prompt + AI-generated `definition` JSONB ({metrics, rules, dashboard_cards, schema_map})
- **`ai_tool_runs`** stores execution history with input + output + flagged_count
- **`save_ai_tool(...)`** + **`log_ai_tool_run(...)`** RPCs

### AI coaching
- **`generate-coaching-sms`** Edge Function pulls driver context (score, recent attendance, history) and asks Claude to draft a coaching SMS in the requested tone (firm / supportive / final-warning)
- Returns text only — frontend dispatcher reviews and edits before calling `enqueue_sms` separately
- Tone-aware system prompt; under 320 chars (2 SMS segments)

### AI usage tracking
- **`ai_usage_log`** records every Anthropic call: function_name, model, tokens, cost_cents, related_kind/id
- **`log_ai_usage(...)`** RPC called from every Edge Function after the API roundtrip
- Owner-only RLS visibility (cost data is sensitive)

## Total: 147 pgTAP assertions across 11 test files (Phases 1–8). Backend spec is **complete**.

## What's NOT in Phase 8

- **No `generate-dispute-letter` Edge Function yet.** Phase 7's `disputes.drafted_letter` is still set manually. Adding that is a 1-hour follow-up — same pattern as `generate-coaching-sms`. Stub for it is implied.
- **No automated reconciliation cron.** A nightly job that compares Amazon invoice line items against own delivery records using the configured `reconciliation_rules` is a Phase 8.5 add-on.
- **No tool execution sandbox.** Saved tools currently store the definition; running them against fresh data uses the frontend rendering layer. A server-side tool runner (deterministic, sandboxed) is the V2 architecture but not needed for the mockup parity.
- **No prompt template library.** Each Edge Function has hand-tuned prompts inline. A library of reusable prompts per coaching scenario / dispute category is a future polish.

## Backend build-out totals (all 8 phases)

| Phase | Scope | Files | Lines |
|---|---|---|---|
| 1 | Foundation | 9 | 1,547 |
| 2 | Operations Core | 8 | 1,767 |
| 3 | Schedule + OKAMI | 9 | 2,539 |
| 4 | Hiring + SMS | 17 | 2,103 |
| 5 | Compliance | 8 | 1,298 |
| 6 | Fleet | 5 | 745 |
| 7 | Finance | 4 | 714 |
| 8 | AI features | 6 | ~900 |
| **Total** | | **66 files** | **~11,600** |

| | Count |
|---|---|
| Migrations | 27 |
| Edge Functions | 4 (send-driver-sms, run-license-reminders, webhook-twilio, generate-coaching-sms, smart-drop-extract) |
| pgTAP test files | 11 |
| pgTAP assertions | **147** |

## Pre-deployment master checklist

After Phase 8 merges, before any of this runs against a real Supabase project:

- [ ] All 147 pgTAP green in CI on every migration
- [ ] Read all 8 PHASE_*.md docs end-to-end + the open issues lists
- [ ] Provision a **fresh** `routeready-dev` Supabase project
- [ ] Apply all 27 migrations to dev (`supabase db push --linked`)
- [ ] Run `supabase test db` against dev — verify 147/147 pass
- [ ] Seed the dev project + verify the sanity-output tally
- [ ] Deploy all 5 Edge Functions to dev
- [ ] Set secrets: `ANTHROPIC_API_KEY`, `TWILIO_*`
- [ ] **TCPA legal review** before any DSP gets `sms_enabled=true`
- [ ] Twilio A2P brand + campaign registration approved
- [ ] Smoke-test each Edge Function end-to-end
- [ ] Wire frontend mockup to dev backend (replace hardcoded mock data with Supabase queries)
- [ ] Decide whether to migrate the existing project or treat dev as the new home
- [ ] Promote to staging when smoke tests pass
- [ ] Promote to production when staging is verified
