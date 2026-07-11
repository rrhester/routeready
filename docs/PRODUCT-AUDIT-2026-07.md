# RouteReady — World-Class Product Audit
**Date:** 2026-07-10 · **Reviewed at:** HEAD (`67abdcd`, PR #3656) · **Standard:** *Does this feel like software built over ten years by 300 world-class engineers and designers?*

This audit was produced by crawling the entire codebase — 21 dashboard views, the driver PWA, 447 numbered migrations (472 files), 38 edge functions, a TypeScript scheduling engine, a Python CP-SAT solver, an Electron desktop agent, and a from-scratch spreadsheet engine — across eight parallel deep-dive reviews, every claim tied to `file:line` evidence. It builds on the team's own honest `docs/LAUNCH-AUDIT-2026-07-08.md` rather than repeating it, and **credits the fixes that landed since** (public buckets, role gates, schedule concurrency).

The one-line verdict: **RouteReady is a genuinely differentiated, well-engineered vertical product with a real operating spine — held back from "premium/enterprise" by an unbundled 86k-line monolith, a security perimeter with several open holes, and information architecture that has outgrown its navigation.** It is roughly **1–2 hardening quarters** from clearing an enterprise bar, and a handful of the highest-leverage fixes are days, not months.

---

## 1. Executive summary

**What it is.** A DSP (Amazon Delivery Service Partner) operating system: hire → onboard → schedule → dispatch → attendance → fleet → separate, tenant-scoped on Supabase, with an append-only audit layer, cryptographically sealed documents, a driver PWA that round-trips real work (check-in, forms, receipts, chat, push), and an Electron agent that drives the Amazon Logistics portal. It replaces 5–6 tools for its niche.

**What's world-class already.** The scheduling core is the crown jewel: a typed, unit-tested TypeScript rules engine (`/engine`, 83 tests + idempotency regression) compiled deterministically into the browser with a **CI bundle-drift gate**, backed by a real OR-Tools **CP-SAT** model with sound minimax fairness and explainable, audited assignments. The database is exemplary multi-tenancy — uniform `dsp_id`-scoped RLS, a clean `private` helper layer, near-perfect `security definer … set search_path=''` hygiene, and a CI job that **rebuilds the entire schema from zero on every migration PR** (real, provable disaster recovery). The document-sealing service (ECDSA P-256 + RFC-3161 timestamp + hash-chained audit + public verification page) is genuinely enterprise-grade. And the team's engineering *discipline* — design-lint ratchet, "no fake numbers on screen" rule, an unusually candid internal launch audit — is rare at any size.

**What holds it back.**
- **A 4.6 MB / 85,953-line single ES module (`live.js`)** with no bundler, no code-splitting, no data-access layer (~900 hand-rolled Supabase calls), 979 `innerHTML` sinks, 56 divergent escape helpers, and **zero CI coverage** (its only guard is a bypassable pre-push hook).
- **A porous API edge.** Several functions are effectively public: `send-email`/`send-sms` (unauthenticated queue-drain + a double-send race), `ai-proxy` and `dvic-ai-review` (unmetered Anthropic-key drain, the latter with an IDOR), `cal-availability` (any tenant can rewrite global interview availability). None of these were in the prior audit.
- **No enforcing CSP** on a PII dashboard that renders server data through template-string `innerHTML` (blocked by 241 inline `onclick=` handlers), **no MFA/SSO/SAML/SCIM**, **no staging environment** (every merge auto-deploys to the single production tenant), and **no product-analytics or uptime/alerting**.
- **Design entropy:** six overlapping token generations, 400+ distinct hex colors, 3,605 `!important`, 85 border-radius values, three parallel button/modal systems, and effectively no dark mode. The applicant-facing funnel (screening/booking/RSVP) is a visual generation behind and nearly ARIA-free.
- **Information architecture sprawl:** a 20-subview Schedule mega-hub, three document homes (Drive/Documents/Vault), a four-way Workspaces/Workflows/Forms/Checklists tangle with mismatched titles, an orphaned home screen, a `fleet2` naming vestige, no URL routing, and a "command palette" that only searches message threads.

**The trajectory matters.** Since the 2026-07-08 self-audit, the team closed its own #1 Critical (public PII buckets → private + signed URLs, `0445`/`0446`/`0447`), added intra-tenant role gates (`0445`), and shipped optimistic schedule concurrency (`0446`). This is a product being hardened deliberately, not one drifting. The remaining work is well-scoped.

### Scorecard

| Dimension | Score | One-line rationale |
|---|---:|---|
| **Overall product** | **62 / 100** | Real, differentiated spine; launch-blocking API/security gaps and enterprise holes keep it out of "premium." |
| Design maturity | 58 / 100 | Strong governance intent (tokens, KPI contract, ratchet) buried under 6 token generations, 400+ hex, 3.6k `!important`, no dark mode. |
| Engineering maturity | 60 / 100 | Excellent engine/solver/CI/DB discipline; undermined by an unbundled 86k-line untested monolith and no data layer. |
| UX maturity | 63 / 100 | Thoughtful flows, honest empty/loading states; sabotaged by IA sprawl, no global search, no URL routing, no mobile operator shell. |
| Enterprise readiness | 45 / 100 | Audit log + sealed docs + tenant isolation are enterprise-grade; no SSO/SAML/SCIM/MFA, no staging, UI-only entitlements, manual GDPR. |
| Scalability | 55 / 100 | Great DB indexing/tenancy + CP-SAT; capped by client-side filtering, 500-row/20k-row pulls, no virtualization, single prod env. |
| Accessibility (WCAG) | 50 / 100 | Good ARIA/semantics/reduced-motion in the apps; no modal focus trap, `user-scalable=no`, unlabeled applicant forms, no skip links. |
| Performance | 52 / 100 | ~2.3 MB gzip JS + 0.35 MB gzip CSS render-blocking upfront, no splitting/virtualization; good SW versioning and lazy heavy libs. |

**Competitive ranking:** Best-in-class *for the DSP vertical* — nothing generic (Asana/Monday/ClickUp) understands callout exposure, Smart Fill fairness, or DSP scorecard mechanics the way this does. Against the *craft bar* of Linear / Stripe / Notion / Figma, it currently sits in the **mid-tier (5–6/10)**: the intelligence is top-decile, the shell (perf, IA, consistency, a11y, security perimeter) is not yet.

---

## 2. Competitive benchmarking (per surface, 1–10)

Scored against the relevant best-in-class product for each surface. "Craft" = polish/consistency/interaction quality; "Capability" = does the underlying job well.

| Surface | Benchmark | Capability | Craft | Why |
|---|---|---:|---:|---|
| Schedule / Smart Fill | Linear board + Assemble/When-I-Work | **8** | 6 | Explainable, constraint-correct, audited Smart Fill beats every generic scheduler; the surface owns 20 subviews and 4 risk vocabularies. |
| Forecast / OKAMI (13-week) | Anaplan / QuickBooks forecasting | 6 | 6 | Math is real and explainable; the gap card states the deficit but prescribes no action while `flex-capacity.js` (the prescriptive engine) ships dark. |
| Hiring pipeline / interview day | Greenhouse / Ashby | **8** | 7 | Calendar 2-way sync, no-show rebook, SLA chips are excellent; duplicated across Pipeline and Onboarding, and Pipeline is de-navigated. |
| Fleet | Fleetio | **8** | 7 | FEM/VORR strips + grounded-van→route gate are launch-grade; `fleet2` naming vestige leaks to users. |
| Driver PWA | Amazon Flex / Onfleet driver app | **8** | 6 | Offline replay queues, encrypted push, haptics, on-device OCR are real field-app engineering; no maps/turn-by-turn, `user-scalable=no`, single reused icon. |
| Messaging / chat | Slack / Intercom | 7 | 6 | Realtime presence/typing, full-history search; in-app only (no SMS driver chat), thin live-region announcements. |
| Workbook (spreadsheet) | Excel / Google Sheets / Airtable | 7 | 6 | 358 formula functions, pivots, charts, native `.xlsx` — technically impressive; a 20k-LoC from-scratch Excel clone is a maintenance liability disproportionate to DSP need. |
| Documents / e-sign / verify | DocuSign / Dropbox Sign | **8** | 7 | ECDSA+RFC-3161 sealing + public verification is a genuine differentiator; split across three IA homes (Drive/Documents/Vault). |
| Reports / analytics | Stripe Dashboard / Metabase | 5 | 6 | 3 honest live CSV sources; no consolidated analytics hub, split across Workbooks/Build/ops-health. |
| Settings / admin / RBAC | Stripe / Google Workspace admin | 5 | 5 | Per-DSP entitlements exist but are platform-admin-only and UI-level (not an enforcement boundary); settings fragmented across feature views. |
| Navigation / IA / search | Linear / Notion / VS Code | 4 | 5 | No global command palette (⌘K only jumps message threads), no URL routing/deep links, orphaned home, runtime chrome docking. |
| Visual design system | Figma / Apple HIG | 4 | 4 | Governance exists but 6 token generations, 400+ hex, 3.6k `!important`, no dark mode; applicant funnel a generation behind. |
| Onboarding / first-run | Notion / Stripe onboarding | 5 | 5 | Setup wizard + first-run checklist exist but hand off into an *unreachable* home view; no guided sequence. |
| Auth / account security | Okta / Stripe | 3 | 6 | Magic-link is clean but no MFA, no SSO/SAML/SCIM, no session timeout; 4–6-digit driver PIN. |

---

## 3. Launch blockers (must fix before an enterprise launch)

Ranked. Items the team already fixed since 2026-07-08 are marked ✅ and excluded from the blocker count.

| # | Blocker | Evidence | Fix | Effort |
|---|---|---|---|---|
| **B1** | **Unauthenticated notification endpoints + double-send race.** `send-email`/`send-sms` are `--no-verify-jwt` with no in-function auth (the purpose-built `requireServiceKey()` in `_shared/supabase.ts:65` is dead code), and both flip `queued→sending` with `.update().eq("id",…)` — **no `status='queued'` guard / row lock**. The `0007` AFTER-INSERT trigger and the 1-min cron drainer can grab the same row → duplicate SMS (Twilio cost + **TCPA exposure**) and anyone on the internet can force sends. | `send-email/index.ts:82-90,153`; `send-sms/index.ts:32-39,101`; `_shared/supabase.ts:65`; `0007_immediate_send_triggers.sql:49-56` | Wire `requireServiceKey()`; add `.eq("status","queued")` atomic claim or `FOR UPDATE SKIP LOCKED`. | 1 day |
| **B2** | **Unmetered / unauthenticated AI key drain.** `ai-proxy` forwards any path+body to Anthropic on the central key, gated only by `sb.auth.getUser` (any valid user, not even an `app_users` member) — no rate limit, quota, or model allow-list. `dvic-ai-review` has **zero auth** and loads a client-supplied `inspection_id` with **no tenant check** (IDOR: overwrite any DSP's inspection + burn the key by enumerating UUIDs). | `ai-proxy/index.ts:47-77`; `dvic-ai-review/index.ts:130-153` | Add `app_users` membership + role/tenant gate, per-tenant rate limit + spend cap; `dvic-ai-review` must `requireServiceKey()`. | 2 days |
| **B3** | **No enforcing CSP** on a PII dashboard that renders server data via `innerHTML` (979 sinks, 56 divergent escapers). Blocked by **241 inline `onclick=`** in `index.html`. One XSS = full session/PII compromise. | `_headers:17`; `dashboard/index.html` (241 `onclick=`); `live.js` (979 `innerHTML`, `escapeHtml` divergence at `:2314`/`:28946`/`:79721`) | Refactor inline handlers → delegated listeners; ship nonce/hash CSP; collapse to one audited `escapeHtml` + tagged-template `html`. | 1–2 wk |
| **B4** | **Core app has zero CI validation.** `smoke-check-live.mjs` (the only guard against orphan code reverting the dashboard to a static mock — a failure that "has bitten us repeatedly") runs **only in the bypassable `.githooks/pre-push` hook**, in no CI workflow. The 4.6 MB `live.js` has no lint/test in CI beyond pixel diffs. | `.githooks/pre-push`; `.github/workflows/*` (no smoke job); `scripts/smoke-check-live.mjs` | Add smoke-check + a JS lint (no-undef, no-unused) as a required PR gate. | 0.5 day |
| **B5** | **No staging environment; auto-deploy-on-merge to the single prod tenant.** One bad migration/edge-fn hits every customer at once; `migration-check.yml` is the only gate. Hand-applied migrations (23 duplicate-numbered filename collisions, four of them three-way) leave **no ledger** — omission = silent schema drift. | `migration-check.yml` header; `scripts/apply-migrations.sh:20,41-43`; 23 duplicate numbers (0433/0436/0439/0445 ×3) | Stand up a staging Supabase + preview deploy; rename duplicates to unique numbers; make one ledger authoritative + CI assert every file recorded. | 1 wk |
| **B6** | **No MFA/2FA and no session timeout** on the operator dashboard holding HR/termination/PII data; **no SSO/SAML/SCIM**. Enterprise IT security review fails on day one (no IdP-managed identity, no automated deprovisioning). | `dashboard/login.html:54-55,110` (magic-link, `persistSession`, auto-refresh); zero mfa/totp/saml/scim hits repo-wide | Add MFA (TOTP), idle timeout; roadmap SSO/SAML + SCIM for enterprise tier. | 2–4 wk |
| **B7** | **Intra-tenant write gates still missing on ~92 policies.** `0445` role-gated only drivers/shifts/time_off; the pre-`0445` `for all using (dsp_id=current_dsp_id())` pattern (no `is_staff`) remains on **`i9_records`, compliance, `hiring_targets`, `route_forecasts`, interview scheduling**, etc. Any authenticated tenant member (default role `driver`) can write I-9/compliance data. | `0163`, `0227`, `0240`, `0136`, `0137`, `0369/0371/0400`; pattern flagged by `0445` itself | Finish the `0445` split across the remaining ~92 policies (writes require `is_staff(dsp,'dispatcher')`). | 3–5 days |
| ✅ | Public PII buckets (driver face photos, message attachments, vehicle photos) world-readable by URL | **Fixed** `0445`/`0446`/`0447` — private + signed URLs. Residual: anon storage policies are bucket-scoped by path, not tenant-path-enforced (defense-in-depth follow-up). | — | — |
| ✅ | Schedule last-write-wins concurrency | **Fixed** `0446_schedule_concurrency` — realtime publication + optimistic `assign_shift` with `shift_conflict`. | — | — |
| ✅ | `client_errors` spoofable insert; fake data shipped as real | **Fixed** `0445`; mock grids/counts neutralized (2026-07-08 PR). | — | — |

---

## 4. Technical-debt assessment

**Magnitude (hard numbers).**

| Metric | Value | Source |
|---|---|---|
| `dashboard/live.js` | 4.6 MB · 85,953 lines · 2,243 fns + 4,634 arrows · **1 file** | measured |
| Upfront JS (uncompressed / gzip) | ~6.1 MB / **~2.3 MB gzip** | `live.js`+`workbook.js`+`mock-wiring.js`+engine/reports |
| `inline-styles.css` | 1.8 MB · 31,002 lines · **1,387 `!important`** · 772 raw hex | measured |
| `innerHTML` sinks | **979** (live.js) + 169 (app.js) + 104 (workbook) | XSS surface |
| Supabase calls scattered inline | **516 `sb.rpc` + 383 `sb.from`** with no shared wrapper | no data layer |
| `escapeHtml` implementations | **56** local bindings, ≥3 divergent (one omits `"`/`'`) | attribute-escape hazard |
| Design tokens defined vs raw-hex bypasses | ~438 defs / **743 raw-hex, 3,605 `!important`** (lint baseline) | committed debt |
| Duplicate-numbered migrations | **23 collisions** across 19 numbers (4 three-way) | omission risk |
| CDN imports without SRI | supabase-js, pdf-lib, pdfjs, mammoth, xlsx | supply-chain |
| Committed binary junk | `ChatGPT Image…png` (922 KB, **byte-identical** to `header-bg.png`), `header-bg.png.png` | repo hygiene |

**Debt themes, ranked by leverage.**
1. **No build system.** Introducing a bundler (esbuild is already a devDep in `/engine`) unlocks code-splitting, tree-shaking, minification, source maps, and SRI in one move — the single highest-leverage change. Today the DOM *is* the state; ~200 `window.*` globals are reassigned repeatedly (`window.goto` ×17, `_rrLoadSfRules` ×22) forcing "poll-until-defined" glue.
2. **Monolith decomposition.** Split `live.js` by domain and lazy-load each view's JS with its `.frag`; stop pulling `workbook.js` (1.1 MB) on every load for users who never open a sheet.
3. **No data-access layer.** ~900 call sites each hand-build error/loading/toast handling (889 `try` vs 927 `catch`, many swallow silently). One wrapper collapses this into a testable surface.
4. **Cross-language rule drift.** Eligibility is reimplemented in TS (`eligibility.ts`) and Python (`eligibility.py`), synced by hand + comments, with **no conformance test** — in-browser preview can silently disagree with the server solve. (Note: `scheduling-engine.js` is *not* debt — it's a CI-verified generated bundle.)
5. **Mockup-era code still shipping.** `mock-wiring.js` (275 KB, 241 `var` globals) decorates live DOM; `index.html:5170` documents functions that must be *deliberately not* invoked because they paint fake numbers.
6. **Duplicated primitives across the two monoliths.** `app/app.js` (612 KB) re-implements its own `escapeHtml`, modal, date-format, and 169 `innerHTML` — the same anti-patterns copy-pasted.
7. **Desktop supply-chain.** Unsigned/un-notarized installers + checksum-only auto-update + `asar:false` (Win/Linux) + plaintext secret fallback on keyring-less boxes.

---

## 5. Missing capabilities

### Missing enterprise capabilities
- **SSO/SAML, SCIM provisioning, MFA/2FA, session timeout** — none present; hard blockers for IT-governed buyers.
- **Owner-facing RBAC & self-serve plan/entitlement management** — roles and entitlements are platform-admin-only; customers can't edit their own permission matrix or plan. Custom roles / per-permission granularity absent (4 fixed roles).
- **Automated data retention + self-service GDPR/CCPA erasure & export** — legal framing exists (`privacy.html`, `terms.html`); DSR handling is manual-by-email; only whole-tenant delete exists.
- **Uptime monitoring, alerting, status page, real SLAs** — none; terms explicitly disclaim uptime. Only a Fly.io `/healthz`.
- **Product analytics / usage telemetry** — only error telemetry (`client_errors`, capped at 5/load). No funnel/adoption/retention instrumentation.
- **Staging + preview environments, reproducible builds** — single prod; `package-lock.json` gitignored (non-reproducible builds).
- **i18n/l10n** — zero framework; hardcoded English throughout.
- **Metered/enforced billing** — entitlements are UI-only packaging; no metering, no in-app checkout enforcement.
- **Audit-log completeness** — triggers cover only drivers/app_users/driver_documents/shifts; time_off/receipts/coachings unaudited.

### Missing UX capabilities
- **Global search / real command palette** spanning drivers, vehicles, shifts, docs, threads (today ⌘K only jumps message threads).
- **URL routing / deep links / shareable state / breadcrumbs / working browser back-button** — `goto()` toggles CSS classes; nothing is bookmarkable.
- **A reachable home/overview** — the "default home" view has no nav entry; the app boots to Schedule and the first-run checklist is stranded there.
- **Unified notification center** — the bell is physically relocated between sidebar foot and schedule action bar with retry-polling; no notification list.
- **Responsive operator experience** — dashboard `index.html` has **0** media queries and no mobile nav; a dispatcher on a phone gets a shrunk desktop DOM.
- **Consolidated analytics/reporting hub**; **surfaced Compliance** as a first-class module (its nav item was deleted though the view lives on) — compliance is core to the DSP scorecard.
- **IA consolidation** of Workspaces/Workflows/Forms/Checklists and Drive/Documents/Vault into single, correctly-titled destinations.

### Missing engineering capabilities
- **Bundler, code-splitting, tree-shaking, source maps, SRI** on CDN deps.
- **A data-access layer** and **one shared UI primitive library** (modal, drawer, focus-trap, toast, escaper, date/tz formatter) consumed by both apps.
- **List virtualization** (0 `IntersectionObserver`) for roster/schedule/email; server-side pagination/aggregation (roster 500-row cap, ≤20k-shift client pulls).
- **CI coverage of `live.js`**; a **cross-engine eligibility conformance test** (TS ↔ Python); **RLS/RPC test coverage** (only 2 SQL test files for ~158 tables / ~1,000 functions).
- **Central error taxonomy + CORS middleware + auth middleware** across edge functions (6+ auth schemes today; error shapes vary wildly).
- **Observability**: Sentry-class error tracking with source maps; per-tenant AI spend metering; feature-flag targeting/kill-switch infra.
- **A theming hook** (`data-theme` / tokenized surfaces) so dark mode is possible (today: one dead media query).

---

## 6. Top 100 highest-impact improvements

Priority: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Nice-to-have. Effort: QW ≤2h · S ≈1d · M 2–5d · L 1–2wk · XL 1mo+.

**Security & API perimeter**
1. 🔴 S — Wire `requireServiceKey()` into `send-email`/`send-sms`; they're currently public. (B1)
2. 🔴 S — Add atomic `status='queued'` claim / `FOR UPDATE SKIP LOCKED` to stop duplicate SMS/email. (B1)
3. 🔴 M — Auth + tenant gate + spend cap on `ai-proxy`; today any user drains the Anthropic key. (B2)
4. 🔴 S — Add `requireServiceKey()` + tenant check to `dvic-ai-review` (zero-auth IDOR today). (B2)
5. 🔴 M — Role/tenant gate `cal-availability`; any user can rewrite global interview availability.
6. 🔴 L — Ship a nonce/hash CSP; refactor 241 inline `onclick=` to delegated listeners. (B3)
7. 🔴 M — Finish `0445` role-gating on the ~92 remaining `for all` policies (I-9/compliance/forecasts). (B7)
8. 🟠 M — Add TOTP MFA + idle session timeout to the operator dashboard. (B6)
9. 🟠 S — Add SRI hashes to all 5 CDN `import()`s (supabase-js, pdf-lib, pdfjs, mammoth, xlsx).
10. 🟠 S — Enforce tenant/path scoping on the anon storage SELECT policies (not just bucket).
11. 🟠 QW — Make `webhook-apply` fail-closed (require `APPLY_SHARED_SECRET`).
12. 🟠 S — Move `app.service_role_key` GUC into Supabase Vault (readable via `current_setting` today).
13. 🟡 S — Constant-time compare for all webhook HMACs / shared secrets (`===`/`!==` today).
14. 🟡 QW — Role-gate integration connect/disconnect (Finch/ADP, Google Cal/Drive) beyond mere membership.
15. 🟡 S — Add `app_users` role gate to `finch-*`/`google-oauth-start` (membership-only today).
16. 🟡 QW — Stop leaking raw PostgREST error `message/code/hint` from public `driver-document-fetch`.
17. 🟡 QW — Reconcile `verify_jwt` across `config.toml` + 2 CI loops; 5 functions are deployed by neither.
18. 🟡 S — Unify SMS opt-out: exact-keyword match + persisted flag (substring `%stop%` over-suppresses).
19. 🟢 S — Standard error envelope (`type`/`code`/`message`) across all 38 functions.
20. 🟢 QW — Add `.env*` to `.gitignore`; commit a `package-lock.json` for reproducible builds.

**Frontend architecture & performance**
21. 🔴 S — Add `smoke-check-live.mjs` + JS lint as a required CI gate (pre-push-only today). (B4)
22. 🔴 XL — Introduce a bundler (esbuild) for the dashboard: splitting, minify, source maps, SRI.
23. 🟠 L — Decompose `live.js` by domain; lazy-load each view's JS with its `.frag`.
24. 🟠 M — Stop static-importing `workbook.js` (1.1 MB) on every load; dynamic-import on Workbook open.
25. 🟠 M — Build one data-access module wrapping `sb.rpc`/`sb.from` (uniform error/loading/retry).
26. 🟠 M — Collapse 56 `escapeHtml` variants into one audited helper + tagged-template `html`.
27. 🟠 M — Virtualize roster/schedule/email lists (windowing + `IntersectionObserver`); 0 today.
28. 🟠 M — Server-side pagination/aggregation for roster (500-row cap) and attendance (≤20k-row pulls).
29. 🟡 M — Token-migrate and split `inline-styles.css` (1.8 MB render-blocking) per view.
30. 🟡 M — Purge `mock-wiring.js` (275 KB) from boot; remove fake-number painters entirely.
31. 🟡 S — Add a Sentry-class error tracker with source maps (22 `console.error` in 86k lines today).
32. 🟡 S — Extract shared UI primitives (modal/drawer/focus-trap/toast/date-tz) consumed by both apps.
33. 🟡 QW — Auto-generate the `bust-cache.mjs` `FILES` list (hand-maintained → silent stale-ship risk).
34. 🟡 S — Add a central date/timezone formatter (215 scattered `toLocaleDateString` + one-off `fmt*`).
35. 🟢 S — Give the dashboard SW a minimal offline fallback page (caches nothing today).
36. 🟢 QW — Delete committed binary junk (`ChatGPT Image…png`, `header-bg.png.png`).
37. 🟢 M — Reduce ~200 mutable `window.*` globals; remove "poll-until-defined" boot glue.
38. 🟢 M — Guard the 20-parallel-frag boot fan-out (any single 404 → full boot failure).

**Design system & consistency**
39. 🔴 L — Collapse 6 token generations to one: promote `app/rr-system.css`, delete duplicate `:root` sets.
40. 🟠 M — Reduce 400+ hex to the `--rr-blue/gray` ramps + a fixed semantic set; one success/danger pair.
41. 🟠 M — Force the applicant funnel (screening/booking/rsvp) onto the token system (Material palette today).
42. 🟠 S — One type scale: delete the numeric `--fs-9…21` half-pixel scale; drive 126 literals to tokens.
43. 🟠 S — Radius scale (85 values → ~6 tokens); shadow scale (234 → ~5); z-index scale (65 raw → named).
44. 🟠 M — One button, one modal, one toast, one empty-state; retire `.btn`/`.oc-btn`/`.rrx-btn` split.
45. 🟠 S — One shared `.skeleton` replacing 8 per-feature shimmer keyframes.
46. 🟡 M — Add a real theming hook (`data-theme`) and ship dark mode (1 dead media query today).
47. 🟡 S — Resolve `--surface-secondary` (5 definitions, 3 values) and `--accent-glow` value drift.
48. 🟡 S — Reconcile 194 `outline:none` vs 145 `:focus-visible` — every unpaired `outline:none` is an a11y regression.
49. 🟡 S — One typeface token everywhere (3 literal Inter stacks + stray serif today); one mono token.
50. 🟢 S — Extend the design-lint ratchet to inline `style=""` (2,366 in live.js unmeasured) + radii/z-index.

**Accessibility**
51. 🔴 M — Add focus trap to the 35 dashboard `role="dialog"` modals (none trap Tab today).
52. 🔴 QW — Remove `user-scalable=no`/`maximum-scale` from `app/index.html` and `screening.html` (WCAG 1.4.4).
53. 🟠 QW — Add `<label>`/`aria-label` to the applicant screening form (placeholder-only today, WCAG 1.3.1).
54. 🟠 QW — Add skip-to-content links to both apps (none today).
55. 🟡 QW — Add `alt` to the 7 `<img>` missing it in `app.js`.
56. 🟡 S — Expand `aria-live` coverage for async updates (offline replay, chat) — 4–5 regions today.
57. 🟡 QW — Bring applicant pages (0 ARIA) to dashboard-level ARIA coverage.
58. 🟢 S — Audit `--text-subtle` (gray-500) sub-label contrast against WCAG AA; bump the tab-label 10px font.

**Information architecture & navigation**
59. 🔴 L — Build a real global command palette (⌘K over drivers/vans/shifts/docs/threads); today message-only.
60. 🟠 L — Add URL routing / deep links / working back-button (class-toggle `goto()` today).
61. 🟠 M — Give the home/overview view a nav entry; land the setup wizard + first-run checklist there.
62. 🟠 M — Consolidate Drive/Documents/Vault into one "Documents" destination.
63. 🟠 M — Untangle Workspaces/Workflows/Forms/Checklists (mismatched titles, circular links, no nav home).
64. 🟠 S — Merge Pipeline into Onboarding (duplicated funnel/interview) or re-navigate it deliberately.
65. 🟡 S — Consolidate the three Roster homes (standalone + Schedule + Onboarding) to one canonical source.
66. 🟡 S — Restore Compliance as a first-class nav module (nav item deleted; view still live).
67. 🟡 QW — Rename `fleet2` → `fleet` everywhere (view id, entitlement key, data-view).
68. 🟡 M — Give topbar/launcher a stable layout; remove runtime `dockTools()`/`placeLauncher()` docking.
69. 🟡 M — Split Schedule's 20 subviews; move Roster/Attendance/Requests to their own destinations.
70. 🟢 S — Expand the entitlement catalog to cover all ~17 views (7 gateable today).

**Data model & backend**
71. 🔴 S — Rename 23 duplicate-numbered migrations to unique numbers; add a CI "every file recorded" check. (B5)
72. 🟠 M — Reconcile the migration ledger; make one authority (Supabase `schema_migrations` has drifted).
73. 🟠 S — Add `shifts (driver_id, date)` unique index (DB-level double-book guard; engine-only today).
74. 🟠 S — Extend audit triggers to time_off/receipts/coachings (unaudited today).
75. 🟡 S — Add overlap-exclusion constraint on `time_off_requests` (daterange) after dedupe.
76. 🟡 S — Unique-where-active indexes on driver email/phone (duplicate-person risk today).
77. 🟡 S — Add explicit `ON DELETE` to the ~22 FKs defaulting to `NO ACTION`.
78. 🟡 S — Convert the 79 bare `timestamp` columns to `timestamptz` (per-DSP timezone product).
79. 🟡 QW — Add RLS backstop to `public.cal_event_reminders` (safe only by absence of grant today).
80. 🟢 S — Replace `phone_normalized` text PK with a surrogate key (brittle mutable natural key).
81. 🟢 M — Expand SQL test coverage beyond the 2 files (RLS policies + hot RPCs).

**Product intelligence & workflow completeness**
82. 🟠 M — Wire `flex-capacity.js` into the OKAMI gap card: "Hire N by DATE" prescription (engine ships dark).
83. 🟠 M — Build the receipts manager inbox (RPCs exist, only 4 UI refs — capture 9/10, admin 4/10).
84. 🟠 M — Unify the 4 parallel risk vocabularies to one scale: neutral → Watch (amber) → At Risk (red).
85. 🟡 M — Add a cross-engine eligibility conformance test (TS ↔ Python CP-SAT).
86. 🟡 S — Fix `isDotRoute()` XL-phase semantics (XL fills in the DOT phase; dedicated XL phase is dead).
87. 🟡 S — Return 5xx (not HTTP 200 `status:"error"`) from the solver on solve failure; surface pre-run status.
88. 🟡 QW — Set solver `min_machines_running=1` (cold-start timeout risk against 8s budget).
89. 🟡 QW — Update solver README (still says "stub v1 / CP-SAT next"; CP-SAT is already default).
90. 🟢 M — Link driver message threads into the driver record; add odometer capture to DVIC.
91. 🟢 QW — Replace `prompt()` in the driver missed-day flow with a sheet UI.

**Driver PWA & mobile**
92. 🟠 M — Add a mobile navigation shell to the dashboard (hamburger/drawer) or a "best on desktop" gate.
93. 🟡 S — Add `beforeinstallprompt` + an A2HS guidance page for the driver PWA (none today).
94. 🟡 S — Ship a true multi-resolution + maskable icon set (single reused `Icon.png` today).
95. 🟡 S — Adopt Background Sync API for offline queues (foreground-only flush today).
96. 🟢 M — Add barcode/VIN scanning (`BarcodeDetector`) + EXIF/geo-stamped photo capture.
97. 🟢 M — Allow landscape (portrait-locked manifest) for signature capture.

**Desktop agent**
98. 🔴 M — Add macOS notarization + Windows Authenticode signing; enable `asar` on all platforms. (unsigned + checksum-only auto-update = silent-install RCE risk)
99. 🟠 S — Fail closed (warn operator) instead of writing `.plain` cleartext secrets when keyring is unavailable.
100. 🟡 S — Add a per-action allowlist / confirmation to the autonomous portal LLM agent (prompt-injection surface).

---

## 7. Implementation roadmap

Grouped by size, with difficulty/risk/impact. The ordering front-loads trust and safety (cheap, high-impact) before the expensive structural work.

### Quick Wins (≤2h each) — do this week
`#52` remove `user-scalable=no` · `#53` label the screening form · `#54` skip links · `#11` fail-closed `webhook-apply` · `#17` reconcile `verify_jwt` · `#36` delete binary junk · `#20`/`#79` gitignore `.env` + RLS backstop · `#89` solver README · `#88` warm solver · `#67` rename `fleet2`.
**Impact:** high (closes two WCAG violations, one fail-open endpoint, misleading docs) · **Risk:** near-zero · **Effort:** ~1 engineer-day total.

### Small Projects (≈1 day each) — next 2 weeks
`#1`/`#2` fix send-email/SMS auth + double-send (**B1**) · `#4` dvic-ai-review auth (**B2**) · `#21` smoke-check in CI (**B4**) · `#9` SRI · `#71` de-duplicate migration numbers (**B5**) · `#73` shifts unique index · `#42`/`#43`/`#45` type/radius/skeleton scales.
**Impact:** critical — clears B1, most of B2/B4, starts B5 · **Risk:** low (well-scoped, testable) · **Effort:** ~2 engineer-weeks.

### Medium Projects (2–5 days each) — this quarter
`#3` ai-proxy metering (**B2**) · `#5` cal-availability gate · `#7` finish role gates (**B7**) · `#8` MFA + timeout (start **B6**) · `#25` data-access layer · `#26` unified escaper · `#27`/`#28` virtualization + server paging · `#40`/`#41`/`#44` color/component consolidation · `#51` modal focus trap · `#82`/`#83`/`#84` flex-capacity + receipts inbox + risk vocabulary · `#98` desktop signing.
**Impact:** high — clears B7, most of B2/B6, meaningful perf + a11y + consistency gains · **Risk:** medium (touches auth, RLS, hot render paths — needs staging, which is why B5 comes first) · **Effort:** ~6–8 engineer-weeks.

### Large Features (1–2 weeks each) — this half
`#6` CSP + inline-handler refactor (**B3**) · `#23` decompose `live.js` · `#39` collapse token generations · `#59` global command palette · `#60` URL routing.
**Impact:** transformational for craft/perf/security · **Risk:** medium-high (broad blast radius) · **Effort:** ~8–10 engineer-weeks; do after the bundler lands.

### Major Initiatives (1 month+) — roadmap
`#22` bundler + build system (**enables 23/29/50 and unblocks the Large tier**) · `#5`/`#6` SSO/SAML + SCIM (enterprise tier, part of **B6**) · staging + preview environments (**B5**) · product-analytics + observability platform · dark mode + theming (`#46`) · i18n framework · replace/narrow the 20k-LoC workbook Excel clone.
**Impact:** unlocks enterprise procurement and long-term velocity · **Risk:** high (architectural) · **ROI:** highest long-term, lowest short-term — sequence after the launch blockers.

**Dependency spine:** Bundler (`#22`) → unlocks splitting/CSP/token work (`#6`, `#23`, `#29`). Staging (`#5`/**B5**) → de-risks the auth/RLS/render Medium tier. MFA (`#8`) → precedes SSO/SAML. Do trust/safety Quick Wins + Small Projects **before** any structural refactor.

---

## 8. If we only did 20 things before launch

The 20 that most dramatically raise quality and trust, in order. This is the launch checklist.

1. **Authenticate `send-email`/`send-sms` + kill the double-send race** (`#1`,`#2`) — stops open sends and TCPA-exposing duplicate SMS.
2. **Lock down `ai-proxy` + `dvic-ai-review`** (`#3`,`#4`) — closes an unmetered key drain and an IDOR.
3. **Gate `cal-availability`** (`#5`) — any tenant can currently rewrite everyone's interview availability.
4. **Finish intra-tenant role gates** (`#7`) — I-9/compliance data must not be writable by a `driver` role.
5. **Add smoke-check + JS lint to CI** (`#21`) — the core app currently ships with no CI guard.
6. **Stand up a staging environment** (`#5`/B5) — stop auto-deploying unverified migrations to the one prod tenant.
7. **De-duplicate the 23 colliding migration numbers + one authoritative ledger** (`#71`) — remove silent-drift risk.
8. **Add TOTP MFA + session timeout** (`#8`) — table-stakes for a system holding HR/PII.
9. **Ship a CSP + refactor the 241 inline handlers** (`#6`) — bound the XSS blast radius on a PII surface.
10. **Consolidate to one audited `escapeHtml`** (`#26`) — remove the wrong-escaper-in-attribute-context hazard.
11. **Add SRI to the 5 CDN imports** (`#9`) — close the supply-chain/MITM vector.
12. **Add focus trap to dashboard modals** (`#51`) + **remove `user-scalable=no`** (`#52`) + **label the applicant form** (`#53`) — three concrete WCAG failures, all cheap.
13. **Sign + notarize the desktop app; stop plaintext secret fallback** (`#98`,`#99`) — it holds Amazon corporate portal cookies.
14. **Wire `flex-capacity` into the OKAMI gap card** (`#82`) — turn the forecast from diagnosis into a "hire N by DATE" prescription (the #1 owner-value gap).
15. **Build the receipts manager inbox** (`#83`) — capture is 9/10 with no admin surface; it closes no books today.
16. **Unify the four risk vocabularies to one scale** (`#84`) — so the scheduling intelligence reads as one system.
17. **Give the home/overview a nav entry and land onboarding there** (`#61`) — the setup wizard currently hands off into an unreachable view.
18. **Consolidate Drive/Documents/Vault + untangle Workspaces/Workflows/Forms/Checklists** (`#62`,`#63`) — the two worst IA knots.
19. **Add an error tracker with source maps** (`#31`) — you cannot safely operate a single-prod deploy blind.
20. **Add a mobile nav shell or an explicit "best on desktop" gate** (`#92`) — today a dispatcher on a phone gets a broken shrunk desktop.

Everything here is scoped to fit inside the 1–2 hardening quarters the product is from an enterprise bar — and items 1–7 are days, not weeks. The intelligence that makes RouteReady worth paying for already exists; this list is about making the shell around it as trustworthy as the engine inside it.

---

*Prepared from eight parallel codebase deep-dives (product/IA, frontend architecture, design system, database/migrations, edge functions/API, driver PWA/accessibility, scheduling/solver/desktop, security/enterprise), reconciled against `docs/LAUNCH-AUDIT-2026-07-08.md` and verified at HEAD `67abdcd`.*
