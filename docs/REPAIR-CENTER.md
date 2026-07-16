# Repair Center — architecture & phased plan

The Repair Center manages the full lifecycle of vans that need outside
repair: report → collect evidence → request quotes from shops →
receive/extract/compare quotes → authorize → track the van at the shop →
reconcile the invoice → return to service → measure cost, downtime, and
shop performance.

This document is the Phase 1 audit + architecture record (2026-07-14)
and stays the reference as later phases land. Phase 2 (the repair-case
foundation) shipped with this document — see §10.

---

## 1 · What already exists (audit summary)

RouteReady already has a **repair spine** — the Repair Center extends
it and must never fork it:

| System | Where | Reuse |
|---|---|---|
| `repair_orders` | 0227/0228 · `ro_status` enum, `_next_ro_code()` ('RO-2026-NNNN'), vendor_id, eta_at, cost_cents; drives the Amazon 2 BD / 14 BD compliance clocks and the Fleet roster "Repair status" column | Stays the shop work-order ledger; cases link via `repair_cases.repair_order_id` |
| `vendors` | 0227/0313 · shops with contacts jsonb, address, accountability_score, on_time_pct | **Is** the shop directory; 0486 adds classification + service flags |
| `vehicle_issues` | 0213 · defect log (Fleet → Issues tab), driver-reported via concern forms/DVIC | Upstream of cases; 0486 adds `repair_case_id`; `repair_case_from_issue()` converts |
| `vehicles.operational_status` + `vehicle_grounding_events` | 0227/0228/0229/0231/0308 · THE availability axis; trigger-maintained event ledger; single mutation path `vehicle_set_operational_status()` | Repair Center writes availability **only** through that RPC |
| `vehicle_service_logs`, `vehicle_mileage_log`, `vehicle_inspections` | 0213/0223/0242 | History, odometer updates, DVIC source linkage |
| Tenancy/RLS | `dsp_id` everywhere; `private.current_dsp_id()`, `private.is_staff(dsp,'dispatcher')`; the 0445/0468 four-policy template; SECURITY DEFINER RPCs carry their own `is_staff` guard (0453 lesson) | Copied verbatim on every new table/RPC |
| Outbound email | `email_messages` queue → pg_net trigger (0007) + 1-min pg_cron drain → `send-email` (Resend), per-DSP branded From (`dsps.slug`), `message_templates` + `private.render_template()` | Quote requests/reminders = insert a queued row. **Gap:** no bounce/open webhook exists yet |
| Inbound email | `webhook-email-inbound` (Svix-verified) routes by recipient local-part → DSP; attachments stream into the `document-intake` bucket + `document_intake` rows; auto-classified | Shop replies already land + classify. **Gap:** `+tag` is stripped before routing — per-request routing tokens need a small webhook change |
| Document AI | `document-classify` (Claude, forced-tool JSON, retry envelope, field confidence); taxonomy already includes invoice/receipt; `filed_to_table/filed_to_id` designed-but-unused filing hook; receipts pipeline (0435-0437) is the reconciliation precedent | Extraction pipeline = extend, not build. No Google Document AI exists (despite folklore) — Anthropic only |
| No-login external access | `document-verify` signing-token pattern; `driver_sessions` 32-byte hex bearer tokens + `private.driver_validate_token()`; screening/booking anon-RPC capability tokens; `/s/:token` short links (302 on Cloudflare Pages — 200 rewrites drop the token) | Shop links clone the driver-session shape: hashed token table + anon-granted `security definer` RPCs + separate static page (SPA requires auth at boot) |
| Jobs | pg_net fire-and-forget from triggers + pg_cron sweeps (`private.app_settings` holds function URL + service key); idempotent webhooks via unique (provider, provider_message_id) | Reminders/expiry = one pg_cron sweep; no new queue framework needed |
| Notifications | `push-fanout` trigger, staff push (0470), delivery receipts (0475), SMS w/ quiet hours | Alerts ride existing rails |
| Files | Private buckets, `<dsp_id>/…` prefix RLS (0447), signed URLs; `_flSignPhotos` batch helper | `repair-attachments` bucket follows exactly |
| UI | Frag views + `goto()` dispatch; Schedule/Fleet chrome (`.rr-viewseg`, `.rr-ab`, `.table-wrap`, `.status-pill`, `.rr-skel`); module escape hatch `window.RRParts` (parts-ui.js); design-lint ratchet (tokens only) | Repair Center = `view-repair.frag` + `dashboard/repair/` module (`window.RRRepair`) |
| Testing/CI | `scripts/test-*.mjs` node suites; `supabase/tests/*.sql` run in migration-check against a from-zero DB; per-feature path-triggered workflows; visual regression; smoke AST check | `test-repair-engine.mjs` + `repair-tests.yml`; SQL suite lands with the quote phase |
| Workbook | Bidirectional ledger projection (receipt ledger 0436, GUC loop guard) | Model for a later "Repair Invoice Ledger" |

Known hazards found in audit:

- `vehicles_roster()` has been redefined by ≥8 migrations and **0345
  (latest) dropped fields added by 0239/0297/0301/0308**. Any future
  redefinition must start from the 0308 body + `van_type`.
- Migration ordinals collide historically; both migration runners key
  on full filename. Never use `supabase db push`.
- Edge functions deploy from hardcoded lists in
  `deploy-migrations.yml` — new functions must be added there.
- The `receipts` bucket's bucket-wide anon-read policy must NOT be
  copied for repair files (shop pricing would leak); signed-URLs only.

## 2 · Domain model

`repair_cases` is the lifecycle spine (created by migration 0486):

- **Stage** (one controlled field, text + CHECK): `reported → review →
  quoting → quotes_in → awaiting_approval → approved → scheduled →
  at_shop → ready_for_pickup → quality_check → returned → closed`,
  plus `cancelled`. Transition map lives in SQL
  (`_repair_stage_next_allowed()`) and JS (`STAGE_TRANSITIONS`),
  pinned to the shared fixture `tests/fixtures/repair/stage-transitions.json`.
  Emergency tow-ins may skip quoting (`reported → at_shop`); QC
  failures loop (`quality_check → at_shop`).
- **Availability** is a separate dimension. Fleet stays the source of
  truth for grounded; the case's `availability` field adds nuance
  (`limited`, `at_shop`, `ready_for_pickup`) and is only written by
  RPCs. Grounding/ungrounding always goes through
  `vehicle_set_operational_status()`.
- **Shop-visit status** (`repair_shop_visits.shop_status`) is a third
  dimension, only meaningful while a visit is open: awaiting_dropoff,
  checked_in, diagnosing, awaiting_authorization, parts_hold,
  in_repair, delayed, ready, picked_up.
- **Derived, never stored:** overdue state (promised/revised vs now),
  days down, timers. Raw timestamps only.
- **Money:** integer cents, computed deterministically (`repair-engine.js`
  + SQL). AI never computes or authorizes money.

Child tables: `repair_case_issues` (multi-defect cases, links back to
`vehicle_issues`), `repair_case_events` (ONE unified timeline; every
subsystem appends; `visible_to_shop` gates the future shop view),
`repair_case_attachments` (private `repair-attachments` bucket,
`<dsp_id>/<case_id>/…` paths), `repair_shop_visits`.

Planned for later phases (designed, not yet created):
`repair_quote_requests`, `repair_quotes` (+ versioning + source enum),
`repair_quote_line_items`, `repair_authorizations` (versioned,
full/lines/diagnostics-only/NTE), `repair_invoices` (+ line items),
`repair_document_extractions` (field-level confidence + source refs),
`secure_external_links` (sha256 token hash only), `shop_contacts`.

## 3 · Secure shop links (Phase 3/4 design)

- 32 random bytes, base64url, single quote-request scope; DB stores
  only the sha256. Expiry (default 7d), revocation, regeneration,
  access log, rate limiting.
- Shop page is a **separate static document** (like booking.html) —
  the SPA requires an authenticated session at boot. Short link
  `/q/:token` needs BOTH a netlify.toml 200 rewrite and a `_redirects`
  302 line (Cloudflare drops tokens on 200 rewrites).
- All shop reads/writes go through anon-granted `security definer`
  RPCs (screening_load/submit pattern) or a service-role edge function
  (document-verify pattern); the projection exposes only shop-visible
  fields. Shops never see other shops, competing quotes, or internal
  notes.

## 4 · Email routing (Phase 3/7 design)

- Outbound: insert into `email_messages` with a new `repair_case_id`
  discriminator column (the applicant_id/folder_id pattern);
  `repair.quote_request` etc. as `message_templates` keys. Wire the
  Resend bounce/delivered webhook (net-new) so a bounced quote request
  is a visible failure with a retry path.
- Inbound: mint a per-request routing token; extend
  `webhook-email-inbound` to preserve the currently-discarded `+tag`
  local-part and match it before the applicant matcher; matched mail +
  attachments attach to the case and enter the extraction pipeline.
  Shop-address matching must be exact/citext against vendors (the
  ilike applicant matcher runs first today and could shadow it).

## 5 · Document intelligence (Phase 7 design)

Extend `document-classify` (or a sibling `repair-quote-extract`
function following its retry/coercion pattern) with a quote/invoice
tool schema: line items, totals by bucket, dates, WO/RO numbers, parts
status. Deterministic normalization first (R&R, RH/LH, reman, sublet…);
totals validated by SQL/JS math with mismatches flagged, never silently
corrected. Every field stores raw value, normalized value, confidence,
and source reference in `repair_document_extractions`. Draft-only:
extraction creates drafts a human confirms; reviewed data is never
overwritten by re-extraction.

## 6 · Permissions

Existing roles only (`driver < dispatcher < ops < owner`): all Repair
Center writes gate at `dispatcher` (the repo-wide staff floor); reads
are tenant-wide per the 0445 template. Financial-field gating for
sub-dispatcher visibility is a later, dedicated pass. External shops
are never `app_users` (one-DSP-per-user constraint) — capability
tokens only.

## 7 · UI information architecture

Top-level nav item **Repair Center** (`#view-repair`,
`views/view-repair.frag`), behavior in `dashboard/repair/repair-ui.js`
(`window.RRRepair`, the parts-ui module pattern), pure logic in
`dashboard/repair/repair-engine.js` (node-tested). Tabs grow by phase:

1. **Overview** — summary pills, needs-attention, activity (Phase 2 ✓)
2. **Repair Queue** — filterable case table (Phase 2 ✓) + board layout
3. **In Shop** — visit tracker table/board (Phase 6)
4. **Quote Requests** — outbound request tracking (Phase 3–5)
5. **Shop Directory** — vendors + performance (Phase 3)
6. **Reports** — cost/downtime/shop metrics (Phase 9)

Fleet integration: vehicle drawer gains a Repairs tab; Issues rows get
"Open repair case" (wired to `repair_case_from_issue`); the roster's
existing RO column keeps working because cases link to ROs.

Design: Schedule/Fleet chrome, compact tables, soft-tint status pills,
tokens only (design-lint ratchet). **Red is earned**: grounded, missed
promise, exceeded authorization, inconsistent quote math, failed shop
communication, blocked shop — never for normal workflow states.
Coded previews for all 20 screens (overview, queue, board, new case,
case detail, shop selection, shop-facing page, quote form, extraction
review, comparison, authorization, in-shop, timeline, directory,
performance, invoice reconciliation, vehicle history, mobile, empty,
error states) exist as a published design artifact.

## 8 · Phases

1. **Audit & design** — this document + mockups ✓
2. **Repair-case foundation** ✓ (see §10)
3. **Shop directory & quote requests** ✓ (see §11) — vendors UI,
   repair_quote_requests, outbound email, secure links. Still open:
   the Resend bounce/delivered webhook (bounces currently look like
   silence — lands with Phase 7's inbound-email work)
4. **Shop-facing quote portal** ✓ (see §11) — static no-login page,
   structured quote form, doc upload, decline, questions, drafts
5. **Quote comparison & authorization** — quotes/line-items schema,
   normalization, scope-difference warnings, full/lines/diag-only/NTE
   authorization + shop acknowledgement
6. **In-Shop Tracker** — visits UI, drop-off/check-in, WO numbers,
   parts delays, promise clocks, overdue alerts, board
7. **Email & document intelligence** — inbound routing tokens,
   classification, quote/invoice extraction, human review screen
8. **Invoice reconciliation & return to service** — line-item diff vs
   authorization, variance tolerance, quality check, closure
9. **Reporting & shop performance** — downtime/cost/variance metrics,
   Workbook ledger projection

## 9 · MVP boundaries

No shop accounts, no parts-price crawling, no payments, no public shop
discovery, no direct shop-software integrations in the MVP. The
architecture leaves room for all of them (tokens → optional accounts;
parts intelligence already exists as a sibling feature).

## 10 · Phase 2 — what shipped

- `supabase/migrations/0486_repair_center_foundation.sql` — tables
  `repair_cases`, `repair_case_issues`, `repair_case_events`,
  `repair_case_attachments`, `repair_shop_visits`; vendors
  classification columns; `vehicle_issues.repair_case_id`; private
  `repair-attachments` bucket + storage policies; case-number
  generator; stage-transition function; RPCs `repair_case_create`,
  `repair_cases_list`, `repair_case_get`, `repair_case_set_stage`,
  `repair_case_update`, `repair_case_log_event`,
  `repair_case_attachment_add`, `repair_case_link_ro`,
  `repair_case_return_to_service`, `repair_case_from_issue`,
  `repair_center_summary`; realtime publication; 4-policy RLS on
  every table; audit events. Idempotent; applied manually in the SQL
  Editor per CLAUDE.md.
- `dashboard/repair/repair-engine.js` — pure stage/timer/money/queue
  logic; `dashboard/repair/repair-ui.js` — the view module;
  `dashboard/views/view-repair.frag` — chrome; nav/goto/title wiring;
  token-only CSS in `inline-styles.css` (ratchet holds).
- `scripts/test-repair-engine.mjs` (27 tests) + fixtures incl. the
  JS↔SQL transition contract; `.github/workflows/repair-tests.yml`;
  `npm test` chain + `test:repair` alias.
- Verified end-to-end with the local Playwright harness (stubbed
  Supabase): nav → overview pills → queue → case drawer (timeline,
  attachments, stage actions) → new-case modal. Visual-regression and
  design-lint suites pass.

Deliberate Phase 2 limits (planned follow-ups, not oversights): no
board layout yet; Fleet Issues row button and vehicle-drawer Repairs
tab land with Phase 3; attachments upload via the dashboard only; no
station column on cases beyond the vehicle's; `estimate_total_cents` /
`approved_total_cents` are written by later quote/authorization phases.

## 11 · Phases 3+4 — what shipped

- `supabase/migrations/0487_repair_center_quotes.sql` —
  `secure_external_links` (sha-256 hash only; expiry, revocation, use
  counting, abuse ceiling), `repair_quote_requests` (one active per
  case × shop), `repair_quotes` (+ versioning, supersede,
  server-recomputed totals, `totals_mismatch` flag),
  `repair_quote_line_items`; staff RPCs (`repair_vendor_save`,
  `repair_vendors_list`, `repair_quote_requests_send`,
  `repair_quote_request_action` remind/revoke/regenerate,
  `repair_case_quotes`, `repair_quote_manual_add`,
  `repair_case_attachment_set_visibility`); portal RPCs granted to
  service_role only (`repair_portal_load/save_quote/decline/question/
  upload_target/register_upload`). Emails ride `email_messages` with
  the Fleet Bridge Sent folder, per-DSP `repair.quote_request`
  template override supported. Stage automation: send →
  `quoting`, first quote → `quotes_in`.
- `supabase/functions/repair-shop-portal` — the no-login shop API
  (document-verify pattern): token-hash validation in SQL, signed
  attachment URLs, base64 uploads (15 MB, MIME allowlist), per-IP
  rate limiting; registered in config.toml + the deploy list.
- `dashboard/shop.html` — mobile-first portal (view request, photos,
  structured quote with live math preview, upload, decline,
  question, draft/revise); `/q/:token` short links in `_redirects`
  (302 — Cloudflare requirement) and `netlify.toml` (200).
- Dashboard: Shop Directory tab (directory table with live activity
  counts, add/edit shop modal, classification incl. blocked-with-
  reason), case-drawer Quotes section (request statuses with
  remind/copy-link/revoke, quotes with expandable line items,
  totals-differ badge), request-quotes modal (shop picker that
  disables blocked/no-email shops, respond-by, expiry, VIN masking,
  photo sharing, per-shop send results with copy-link), phone-quote
  modal.
- Verified: migration applied twice + full lifecycle exercise on a
  local Postgres 16 (send → open → draft with mismatch flag → submit
  → supersede → decline/revoke/regenerate → manual quote → non-staff
  refusal → raw token never stored); dashboard and portal driven
  end-to-end in the Playwright harness with zero console errors;
  design-lint/smoke/unit suites green.

Phase 3+4 limits: reminders regenerate the link (hash-only storage
makes the original irrecoverable — by design); no bounce tracking
until the Resend webhook lands; vendor contacts jsonb (0313) is the
contact store — no separate shop_contacts table (deliberate reuse).

## 12 · Phase 5 — what shipped

- `supabase/migrations/0488_repair_center_authorizations.sql` —
  `repair_authorizations` (versioned; full / selected_lines /
  diagnostics_only / not_to_exceed; one CURRENT per case enforced by a
  partial unique index; supersede chain never rewrites history) +
  `repair_authorization_lines` (immutable snapshot of the quote's
  lines with per-line approved/declined decisions taken at issue
  time). Every authorized amount is computed in SQL from stored data
  (quote grand total, sum of approved snapshot lines, or the explicit
  cap) — never client math, never AI. Staff RPCs:
  `repair_authorization_issue` (also flips quote statuses —
  accepted / optional decline-others — updates the case rollup +
  vendor, moves pre-approval stages to `approved`, writes audit +
  timeline events, queues the authorization email with a freshly
  rotated portal link) and `repair_authorization_action`
  (revoke / mark_acknowledged / resend). `repair_case_quotes` and
  `repair_portal_load` replaced to carry authorizations (the portal
  sees only ITS shop's current authorization). New portal RPC
  `repair_portal_acknowledge` (service_role only, idempotent).
  Per-DSP `repair.authorization` template override supported.
- Engine (`repair-engine.js`) — `parseMoney` (string-math dollars →
  integer cents, $1M fat-finger ceiling), `buildComparison`
  (conservative normalized-description line matching, cheapest-first
  ordering with deltas, plain-word scope-difference warnings —
  flagged, never merged), authorization/quote-status vocabularies
  (no red: an unacknowledged authorization is a working state).
  41 node tests incl. the comparison matrix and money parsing.
- Dashboard — side-by-side compare modal (columns per quote, Lowest
  pill, gap cells, scope-warning callout, per-column Authorize),
  authorize modal (type picker, per-line checkboxes with live
  display-only sum, NTE/diagnostic cap with parseMoney validation,
  PO, note to shop, email toggle, decline-others), authorization
  card in the drawer (status pill, line decisions, resend /
  mark-acknowledged / revoke, version history).
- Portal (`shop.html` + `repair-shop-portal` action `acknowledge`) —
  authorization card with scope wording per type, approved lines with
  amounts, struck-through declined lines, cap/total, acknowledge
  button with optional name.
- Verified: 0486→0488 applied from scratch + 0488 double-applied on
  local Postgres 16; 0487 exercise re-run against the replaced
  functions; new 0488 exercise (selected-lines math, supersede chain,
  portal ack incl. cross-vendor refusal and idempotency, revoke
  clearing the rollup, decline-others, fee-TBD diagnostics, guard
  rails, audit trail); dashboard + portal driven in the Playwright
  harness with zero console errors.

Phase 5 limits: acknowledgement rides the quote-request link channel —
a shop that was only ever phone-quoted gets the email record but
acknowledges by phone (staff records it via mark_acknowledged); shop
acknowledgement is a courtesy signal, not a legal e-signature.
