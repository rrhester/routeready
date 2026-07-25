# RouteReady — Customer-Readiness Launch-Gate Audit

**Final verdict: CONDITIONAL GO for a founder-assisted paid pilot — after three operator gates are closed and verified in production.**

The engineering core of RouteReady is genuinely strong and, in several places, better than most seed-stage products: table-level tenant isolation is CI-proven on every migration, the scheduling solver and Smart Fill fail safe, the forecast math is correct and tested, document sealing is real cryptography, and the new email system is a real single-provider product with a sound XSS model. The blockers are **operational, not architectural** — and the product's own launch documentation already says "NOT READY" until they close. This audit independently verified that the code-level remediations from the prior audit shipped, found that **three of them are only partially effective**, and confirmed the three operator gates (storage close-out, backups, monitoring) remain open.

The honest answer for the target readiness level — a **founder-assisted paid pilot** — is: you can get to GO in roughly a few days of operator work plus a short remediation pass, but you are **NOT ready today**, and one automatic no-go condition (cross-tenant storage) is still open in production.

*Audit date: 2026-07-25 · Repo HEAD: `635f2d0` · Branch: `claude/routeready-launch-gate-audit-ofzpbv`*

---

## 1. Executive launch verdict

**Do not give a paying customer access yet.** The single automatic no-go is the cross-tenant driver-PII storage exposure (P0-1): the *code* fix is shipped and correct, but the migration that actually closes it (`0562`) is a hand-applied, device-QA-gated migration that the launch checklist shows **unchecked**, and this audit environment cannot reach the live database to prove it was applied. Until `0562` + `0567` are applied and verified in production, any holder of the public anon key can enumerate and sign every tenant's driver-license images.

Beyond that, two operator gates the repo itself blocks on — a tested backup/restore (P1-1) and live alerting (P1-2) — are open, and this audit found that the publish gate, the EDV/license enforcement, and MFA server-enforcement all shipped with **real gaps** (P2-1…P2-4) that the in-repo audit recorded as "fixed."

There are **no findings of cross-tenant data *read* through the database layer** (RLS is proven), no committed secrets, no production dependency vulnerabilities, and every automated test suite passes. This is a product that is close — the gap is finishing the operator safety net and closing three partial security fixes, not rebuilding anything.

---

## 2. Verdict for each of the four readiness levels

| Readiness level | Verdict | Why |
|---|---|---|
| **1 · Internal demonstration** | **GO** | Boots cleanly, all major views render with proper empty states, zero page errors in a stubbed run, `seed_demo.sql` exists. Safe to demo today. |
| **2 · Founder-assisted paid pilot** (immediate target) | **CONDITIONAL GO** | Ready *after*: (a) apply + verify `0562`/`0567` and prove no cross-tenant file access with the anon key; (b) enable PITR + run one restore drill; (c) wire one uptime/alerting path. Plus a short pass on the partial fixes (publish gate, cover-offer cert, 0539 re-gate, H-5 wire-up). All are days, not weeks. |
| **3 · Unsupervised production use** | **NO-GO** | Requires everything in level 2 **plus**: complete the publish gate across all driver surfaces, close the H-1/H-2 residuals, add pagination, add a rollback/staging story, an IR/breach runbook, and outbound send caps. The absence of alerting alone disqualifies unsupervised use. |
| **4 · General availability (multi-DSP)** | **NO-GO** | Requires level 3 **plus**: server-enforced entitlements (today CSS-only), a staging environment, load-tested scale (30–200 drivers × 50+ tenants), server-side send quotas on the shared email/SMS domains, and a repeatable clean-room onboarding + independent UAT. |

---

## 3. Overall confidence level and audit limitations

**Confidence: High on code/config/tests; Medium on live production state.**

**What I proved firsthand this session (commands + results recorded in §15):**
- `npm test` → **27/27 suites pass**; `eslint .` → clean (exit 0); `npm run smoke` → parity + parse gates pass; design/a11y ratchet held; migration-ordinal + banner-sync gate passes (`_RR_SCHEMA_EXPECTED = 570` in sync with the latest migration).
- **Solver** `pytest` → **97 passed**; **engine** `node:test` → **90 pass / 0 fail**.
- Playwright e2e: **login (3), email (4), booking (2), driver-app (9)** — all pass against stubbed Supabase.
- `npm audit --omit=dev` → **0 vulnerabilities**; repo secret scan clean; `config.js` ships the *publishable* anon key by design.
- **Booted the dashboard in a real browser (Chromium)** with a stubbed backend and walked dashboard, schedule, drivers, fleet, repair, workbooks, notebooks, messages, email, onboarding, settings: every view renders, correct empty states, **zero page errors**; no horizontal overflow at 1440px or at 390px mobile width.
- CI on `main` is **green** across all workflows (verified via GitHub API — last 30 runs all `success`).
- Read the actual SQL for every blocker/high remediation (`0560`–`0567`) and independently confirmed the gaps below at file:line.

**Hard limitation (unchanged from the prior audit and stated plainly):** the environment's network policy **blocks all outbound connections to the live Supabase project**. I could not send live API requests to prove server behavior against the running production database. **Migrations are the authoritative source of what the schema *should* be**, so policy-level findings are proven from migration SQL — but *whether the live project matches the repo, and whether the manual migrations `0560`–`0567` are actually applied, cannot be verified from here.* That is itself the core of Blocker B-3. Every finding that depends on live state is marked **Not Verified** with the exact operator check that would resolve it.

**Also not verified (needs a device/live env):** real-device driver file loading through `driver-file-sign`, live email send/receipt, transactional-email rendering, cross-device responsive regression, load behavior at 100+ drivers.

---

## 4. System and architecture map

**Clients**
- **Operator dashboard** — static site, no build step (`dashboard/`): `index.html` + `live.js` (**5.86 MB**), `workbook.js` (1.38 MB), `mock-wiring.js` (278 KB, dead-code weight still in the boot path), view fragments in `dashboard/views/*.frag`. Hard auth gate at boot (Supabase session required).
- **Driver PWA** — `app/` : `app.js` (721 KB), `sw.js` service worker, `comms-native.js`, Capacitor wrappers for iOS/Android. Anon + opaque token auth (activation link/PIN or phone+PIN), five IndexedDB offline queues, web push.
- **Desktop app** — Electron (`desktop/`): drives the Amazon DSP portal under the operator's own SSO in a bundled Chromium, encrypts the session via OS keychain (with a silent plaintext fallback), uploads parsed reports to Supabase. Tagged releases via `desktop-build.yml`.
- **Public pages** — marketing `index.html`, `download.html`, `booking.html`, `rsvp.html`, `screening.html`, `verify.html`, `privacy.html`, `terms.html`, `marketing.css`.

**Backend (single Supabase/Postgres project `doiwrhkirgblcvuskhno`)**
- **591 SQL migrations** (`supabase/migrations/`), hand-applied via the SQL Editor (the deploy workflow's DB step is a confirmed no-op — `SUPABASE_DB_URL` unset). Isolation primitives `private.current_dsp_id()` / `private.is_staff()` are SECURITY DEFINER with empty search_path.
- **~57 edge functions** (`supabase/functions/`) — auto-deployed on merge via `deploy-migrations.yml` (drift-gated function lists, pinned CLI, ×3 retry). Notable: `send-email`/`send-sms`/`send-*-push` (Resend + Twilio), `webhook-email-inbound`/`-events`/`webhook-twilio`/`webhook-apply`/`webhook-cal` (all signature/bearer-authenticated), `driver-file-sign` (B-1 signing path), `ai-proxy`/`*-ai`/`dvic-ai-review` (Anthropic), `admin-delete-dsp`, `export-tenant-files`, `invite-team-member`, `admin_create_dsp`, calendar (Google/Microsoft), `livekit-token`/`interview-room`/`meet-*` (LiveKit), `finch-*` (payroll).
- **16 pg_cron jobs**: message flush/retention, scheduled-message drain, booking nudges, event/interview/license/checklist reminders, gcal pull/reconcile, dvic sweep, recognition autofire, requeue-stuck-sends, purge client-errors/email-trash, referral invites, unconfirmed escalation. (The 1-minute email-send drain cron + its GUCs are set up via manual SQL in `SECRETS.md`, **not** a migration — an operational dependency outbound mail silently relies on.)
- **CP-SAT scheduling solver** — Python/OR-Tools on **Fly.io** (`solver-service/`, `rr-solve-ready`), pytest-gated deploy.
- **Document-sealing Worker** — **Cloudflare** (`services/document-sealing/`): ECDSA P-256 over SHA-256 + RFC 3161 trusted timestamp + append-only audit; verified in-browser via `verify.html` → `document-verify`.
- **Preview engine** — `engine/` (TypeScript, mirrors the solver's eligibility rules for client-side preview).

**Hosting/integrations:** Netlify **and** Cloudflare Pages (dual static hosting, headers maintained in both `_headers` and `netlify.toml`, parity CI-checked); Supabase (DB/auth/storage/realtime); Fly.io (solver); Cloudflare (sealing Worker + Pages); Resend (email); Twilio (SMS); Anthropic (AI); LiveKit (video); Google/Microsoft (calendar); Finch (payroll); Indeed (applicant intake). No Stripe/billing.

**Roles & tenancy:** roles `owner` / `ops` / `dispatcher` / `viewer` / `driver` in `app_users`, plus `platform_admin`. Tenant = `dsp_id`, server-derived from `auth.uid()`; drivers authenticate on anon + validated token (not `app_users`). One production project; **no staging** (the repo says so: "one bad migration hits every customer at once").

**Feature implementation status (verified):** Recruiting/ATS, interview calendar/booking, onboarding+I-9 sealing, roster/HR, scheduling+Smart Fill, availability/PTO/attendance, van assignment, fleet/PM/parts/repair, coaching/recognition, compliance/cert gates, documents/e-sign, **email (real, new)**, SMS/push, forecasting/targets, workbooks/notebooks — **all substantively implemented**. Mocked/placebo: the email reading-pane "AI" sparkle (decorative). Client-only/cosmetic: entitlement gating (CSS `display:none`). Orphaned but bundled: legacy Staffing-outlook control; `mock-wiring.js`.

---

## 5. Product-claim vs implementation matrix

| Public claim (source) | Implementation reality | Verdict |
|---|---|---|
| I-9 & signatures "sealed with cryptographic signatures and a trusted timestamp"; public verify (`index.html`) | Real ECDSA P-256 + RFC 3161 + append-only audit + `verify.html` browser check (`services/document-sealing/src/index.ts`) | **Accurate** |
| "tamper-evident hash chain" audit trail | Hash-chained compliance audit (`0227`) | **Accurate** |
| Grounded vans can't be scheduled; assignments auto-removed | Grounding machinery + `vehicle_set_operational_status` (see P2-3 caveat) | **Accurate (function has an authz regression)** |
| Amazon 2/14-day repair countdowns | Repair Center implemented | **Accurate** |
| AI damage detection "each morning… compares photos" | `dvic-ai-review` exists; the "each morning" cadence not verified from repo | **Partly verified** |
| Desktop app "saves an encrypted session" | Electron safeStorage **with a silent plaintext fallback** when OS crypto is unavailable (`desktop/agent.js`) | **Overstated (caveat)** |
| "14-day free trial · No credit card · Onboard in a week" | No trial mechanism; plan is a label; billing is manual | **Unverifiable / manual promise** |
| Terms: acceptance "by clicking 'I AGREE' during onboarding" (`terms.html`) | No such click-through exists in onboarding | **False** |
| Terms: "published rates at gorouteready.com (currently starting at $350/month)" | No pricing page exists on the site | **False** |
| Privacy: hiring SMS "commence only upon the applicant's affirmative reply" (double opt-in) | `webhook-apply` auto-sends screening SMS on intake by default; opt-**out** only (P2-7) | **False (TCPA exposure)** |
| Privacy sub-processors list | Names Supabase/Twilio/Resend/Google/Indeed; **omits Anthropic, Fly.io, Cloudflare, LiveKit, Microsoft, Finch** (P2-8) | **Incomplete** |
| Landing page restraint: "Product screens shown with demo data", "Not affiliated with Amazon" | Present and honest; no SOC2/uptime/customer-count claims | **Accurate & commendable** |
| Settings → Billing shows a live subscription + invoices + card | **Fabricated**: hardcoded "RouteReady Pro $249/mo", three fake "Paid $249.00" invoices, "VISA •••• 4242", dead buttons (`views/view-settings.frag:766-793`) | **False (fake data shown to a paying customer)** (P2-14) |
| In-app "Contact support" (Help menu) | Real mailto handler, but its only opener is inside a **duplicate** `#popover-account` that never resolves → unreachable; a working support thread does exist in Messages (P2-15) | **Partially broken** |

---

## 6. Critical-journey scorecard

Pass = proven; Partial = works with a real gap; Fail = broken/unsafe; Not Verified = couldn't test (usually live-state-blocked).

| Journey | Result | Note |
|---|---|---|
| Org creation / provisioning (`admin_create_dsp`) | **Partial** | Clean, platform-admin-gated; not rehearsed clean-room end-to-end |
| Login / logout / session / reset | **Partial** | Login e2e green (stubbed); idle timeout 30 min; live reset/expiry not tested |
| Team invite + activation | **Partial** | `invite-team-member` gated; unthrottled; not live-rehearsed |
| Roles / permissions / access removal | **Partial** | RLS + role gates real and CI-tested; MFA/authz residuals (P2-4, P2-6) |
| Data import + error correction | **Partial** | Per-row inserted/skipped/errored; dedup email-only; large-file unverified |
| Applicant → interview → hire → convert | **Partial** | Full ATS + booking e2e green; dedup thin; auto-SMS TCPA gap (P2-7) |
| Onboarding docs / signatures / audit | **Pass** | Real cryptographic sealing + append-only audit + public verify |
| Driver create/edit/status/terminate/rehire + history | **Partial** | CRUD + token auto-revoke on termination; history preserved; live smoke pending |
| Availability / PTO / attendance / corrections | **Partial** | Approved-PTO server block is strong; attendance report scoped; live smoke pending |
| Schedule create / Smart Fill / edit / publish / notify | **Partial** | Solver fails safe; **publish gate incomplete + opt-in (P2-1)** |
| Cert / availability / rest / hours / rule enforcement | **Partial** | Gates real & tested, but **cover-offer + license-buffer ungated (P2-2)** |
| Simultaneous edits / overwrite protection | **Pass** | Optimistic `assign_shift` + double-book trigger, CI-tested (`schedule_concurrency_test`) |
| Van assign / substitution / repair / return-to-service | **Partial** | Real; `vehicle_set_operational_status` authz regression (P2-3) |
| Driver check-in / offline / reconnect / duplicate | **Partial** | Strong offline queues + publish-gate empty state; dedupe gap on chat/scan/receipt (P2-13) |
| Messaging / delivery / retry / opt-out / duplicate | **Partial** | Opt-out durable, dup-send atomic; provider-error stranding (P2-12); no send cap |
| Email (send / receive / search / threads) | **Partial** | Real Resend send+inbound, good XSS model, RLS; ops gaps (P2-12) + placebo AI button |
| Performance / coaching / corrective action | **Partial** | Implemented + role-scoped; live smoke pending |
| Compliance expirations / reminders / resolution | **Partial** | Cron reminders + gates; H-5 buffer server-inert (P2-2) |
| Reporting / filters / exports / reconciliation | **Partial** | Exports build from same RPCs; forecast hand-verified; live cross-check pending |
| Settings / integrations / data export / deletion | **Partial** | Export + gated deletion work; but Settings → Billing is a fabricated page (P2-14) and the Help "Contact support" opener is dead (P2-15) |
| Empty / first-run / error / offline states | **Pass** | First-run wizard, ~150 empty states, ~130 destructive confirms, honest schema banner |
| Backup / restore / rollback | **Fail** | No proven backup, no restore drill, no rollback path (P1-1) |
| Monitoring / alerting | **Fail** | Nothing pages a human (P1-2) |
| Cross-tenant storage (driver PII) | **Not Verified (P0)** | Code fix shipped; closure migration unapplied/unverifiable (P0-1) |

---

## 7. Security and tenant-isolation assessment

**The database isolation story is genuinely good and independently re-verified.** `cross_tenant_isolation_test.sql` stands up two tenants and, dropped to the real `authenticated` role, proves A cannot read/insert/update/delete B's drivers, I-9s, applicants, coachings, or SMS — and it runs in `migration-check.yml` on every migration PR (which also replays all 591 migrations from zero, doubling as a disaster-recovery rehearsal). CI on `main` is green. Edge webhooks (`webhook-email-inbound`/`-events`) are Svix-HMAC or bearer authenticated with timing-safe compares and fail closed if the secret is unset; `admin-delete-dsp` is platform-admin-gated and refuses self/co-admin deletion. The `0504` `revoke execute … from anon` holds and every post-`0504` anon grant is a token-validated driver RPC.

**But the storage layer and several server gates are where the risk lives:**

- **P0-1 — cross-tenant driver-PII via Storage (Not Verified closed in prod).** Four buckets (`driver-documents`, `driver-photos`, `driver-chat-attachments`, `receipts`) shipped with bucket-wide `anon SELECT` policies (`0079`/`0446`/`0072`/`0435`). The anon key ships in the browser + driver app, so any holder can sign/enumerate every tenant's license images, face photos, chat files, and receipts. The remediation is real and correct — `0561` + `driver-file-sign` (ownership-checked, tenant-scoped, service-role signing) + the app switchover — and `0562`/`0567` drop the anon reads. **But `0562` is a manual, device-QA-gated migration that the launch checklist shows unchecked, and I cannot reach the live DB to confirm it.** Until applied and proven, this is a live P0.
- **P2-5 — residual anon storage INSERT.** After `0562`/`0567`, anon INSERT remains **bucket-wide** on `driver-documents`, `driver-chat-attachments`, `receipts` (no path/tenant predicate). An anon-key holder can plant arbitrary objects into any tenant's path prefix — content-planting into staff-rendered document lists and unauthenticated storage-quota abuse. No read, no overwrite (INSERT only).
- **P2-4 — MFA server-enforcement is narrow and bypassable.** `mfa_ok()` gates only 3 settings RPCs and is opt-in; and an owner at aal1 can PATCH `dsps.metadata` directly (`dsps_owner_update` RLS, `0001`) to flip `security.require_mfa` off. The exact stolen-owner-password attack MFA targets is circumventable in one request. The dashboard already PATCHes `dsps.metadata` from the client, so the path is live.
- **P2-6 — driver-role read exposure (H-2 residual).** Write-gating shipped (23 RPCs in `0564`, CI-tested), but a `role='driver'` `app_user` can still SELECT the full roster, all shifts, `compliance_workspace_bundle`, and the **entire team email inbox** (`email_messages_tenant_select`). `email_rules` writes aren't staff-gated (a driver-role user could reroute team mail). Likelihood hinges on whether driver-role dashboard logins are provisioned.
- **P2-3 — `0539` authz regression.** `vehicle_set_operational_status` is re-created in `0539` **without** the `is_staff` gate and granted to `authenticated`; `0564` adds the gate, but re-running `0539` (idempotent hand-paste) or applying it after `0564` silently un-gates it → a driver-role user can ground/unground vans. Self-inflicting on re-run; violates the repo's "re-running any migration is safe" doctrine.

Transport/headers are solid: enforced CSP (with `unsafe-inline` — the one soft spot), HSTS, `object-src 'none'`, `frame-ancestors 'self'`, parity-checked across both hosts. Tokens live in localStorage (XSS-reachable) rather than cookies — accepted given the CSP + vendored supabase-js compensating controls.

**No cross-tenant *database* read path was found.** The exposure surface is Storage (P0-1/P2-5) and intra-tenant role escalation (P2-3/P2-4/P2-6).

---

## 8. Reliability and data-integrity assessment

**Strong:** migrations replay cleanly from zero in CI (proven this run indirectly via the green gate + all suites); concurrent schedule edits are protected by an optimistic `assign_shift` + a same-day double-book trigger (CI-tested); Smart Fill **fails safe** when the solver is down (board untouched, honest run report); approved-PTO assignment is blocked server-side with a recorded-override requirement; the solver has 97 passing tests including stress (110 drivers); forecast math is hand-verified and tested; calendar/DST is tested (spring/fall/Phoenix/southern); email dup-send is atomic (conditional claim + unique index) with a stuck-send requeue cron; the driver app has five concurrency-guarded offline queues with server-idempotent form/checkin replay.

**Gaps:**
- **P1-1 — no proven backup/restore.** PITR + a restore drill are unchecked; the repo's own runbook says "treat the data as unrecoverable and do not onboard a paying customer." For a custodian of another business's I-9s, this is the single biggest risk.
- **P1-3 / B-3 — hand-applied migrations, no staging.** One prod project; `0560`–`0567` unconfirmed-applied; the drift banner is now global and synced to 570 (code fixed), but the *process* still allows a tenant to run code against a schema it lacks — and the `0539` regression shows how paste order creates silent security drift.
- **P2-12 — email provider-error handling.** Any non-OK Resend response (incl. transient 429/5xx) marks the row `failed` permanently; recovery is a manual per-message Retry (no backoff/auto-retry). Immediate-send also depends on manual GUC/cron setup outside migrations — if unconfigured, mail queues forever while the UI says "sends within a minute."
- **P2-13 — offline replay dedupe.** The chat/scan/receipt queues delete on response, not via an idempotency key, so a commit whose response is lost to a network drop can duplicate.
- Integration timeouts are inconsistent (send-* hardened; solver/gcal/AI paths use bare fetch).

---

## 9. Usability and customer-trust assessment

**Boots clean, renders clean.** In a stubbed browser run every major view (dashboard, schedule, drivers, fleet, repair, workbooks, notebooks, messages, email, onboarding, settings) rendered with purpose-built empty states and **zero page errors**; no horizontal overflow at desktop (1440px) or mobile (390px). The only console error was the (harmless, expected) realtime WebSocket failing behind the proxy. The design system is real and ratchet-enforced; ~150 empty states, ~130 destructive-action confirms, loading/disabled states throughout; a genuine 4-step first-run wizard keyed to real data progress.

**Trust wins since the prior audit:** the schema-drift banner is now **global** (every page) and **honest** (`_RR_SCHEMA_EXPECTED = 570`, tells the operator exactly which SQL to run); a real `rrContactSupport` mailto handler exists (`live.js:5364`,`5386`); and a working in-product "RouteReady Support" conversation thread renders in Messages.

**Two trust regressions this audit found that the in-repo audit recorded as fixed:**
- **P2-15 — the Help-menu "Contact support" is unreachable.** The real mailto handler's only opener lives inside a **duplicate** `<div id="popover-account">` (`index.html:4475`, the real one is `:1625`); `getElementById` always resolves to the first, so the second popover — and the only opener of `modal-help` — can never open. The obvious in-app support entry point is dead; support survives only via the Messages thread and footer emails.
- **P2-14 — Settings → Billing is a fabricated page.** A reachable Settings tab shows a hardcoded "RouteReady Pro $249/mo · next charge May 30", three fake "Paid $249.00" invoices, a "VISA •••• 4242" card, and "Manage subscription"/"Download"/"Update" buttons with **no handlers** (`views/view-settings.frag:766-793`). This directly contradicts "no fake data reaches customers" and is the single weakest customer-trust surface in the product — a paying customer would see invoices and a card that are not theirs.

**Residual polish (P3):** `mock-wiring.js` (278 KB dead-code) still loads in boot; the fully-orphaned pure-mock `view-build.frag` (fake driver names, toast-only "Auto-dispute filed with payroll") is still bundled (unreachable, so it can't show a customer fake data — but should be deleted); the launcher's "Indeed Import" opens a file picker then toasts "upload wiring coming soon"; one "OKAMI" codename in a launcher label; the email "AI" sparkle is a decorative placebo; ~50+ user-visible toasts reference internal migration ordinals ("apply migration 0539") — deliberate house style for a self-hosted operator but jargon nonetheless. **Observability gap:** best-effort error swallowing is pervasive — ~483 `catch (_) {}` + ~106 bare `catch {}` blocks in `live.js` vs only 11 `_rrSwallow`/2 `rpcOrToast` adoptions, so most silent failures never reach `client_errors` (global `window.onerror` still catches uncaught ones). Not verified: accessibility depth, zoom, screen-reader, and cross-device responsive regression (visual baselines are desktop-only).

---

## 10. Performance and scaling assessment

- **Bundle weight:** `live.js` 5.86 MB, `workbook.js` 1.38 MB, `mock-wiring.js` 278 KB — heavy first load, tokened+immutable-cached, but unmeasured for real first-paint/TTI.
- **Fetch-everything queries (P2-9):** 12 `.limit(2000–20000)` sites and only **3** `.range()` uses across `live.js`; roster falls back to a 20k-row fetch every 30 s on an unmigrated tenant. Works in a demo; degrades as a real DSP's history grows.
- **No pagination/virtualization** on the big lists; realtime is correctly tenant-filtered on all 16 subscribed tables (good — no cross-tenant repaint storms).
- **Solver** stress-tested to 110 drivers (Python side); **no dashboard/DB load test** exists at 30–200 drivers or 50+ tenants.

Separate pilot concern (bundle weight, unmeasured perf) from GA concern (pagination, load test, send quotas).

---

## 11. Operational and commercial-readiness assessment

**Deploy automation is strong; the human safety net is not.**
- **Deploy:** static hosts + edge functions + solver + sealing Worker + desktop all auto-deploy on merge with gated workflows; DB migrations are manual (confirmed no-op DB step). **No staging, no documented rollback.**
- **Monitoring (P1-2):** nothing pages a human. No APM/Sentry/uptime SDK; `/health` is a real endpoint with no consumer; `client_errors` is pull-only (admin modal); `rr_cron_health()` and `push_delivery_failures` are never read. `docs/H6-UPTIME-MONITORING.md` is a runbook, unchecked.
- **Backups (P1-1):** runbook only, unexecuted.
- **Billing:** none by design (manual invoicing for customer #1 — acceptable at this stage); entitlements are CSS-only (fine for one tenant, trivially bypassable at GA).
- **Offboarding:** data export + account deletion both work and are properly gated.
- **Support:** in-app mailto + support thread + footer emails. No ticketing/status page/published hours.
- **IR/breach (P2-11):** no incident-response or breach-notification runbook behind the privacy policy's 72h/48h promises.
- **Legal (P2-7/P2-8):** wrong/incomplete sub-processor list; a policy-stated double-opt-in the code doesn't implement; terms cite a nonexistent click-through and nonexistent pricing page.
- **Tenant support without touching private data:** partial — platform-admin tooling + the client-errors modal exist, but no per-tenant diagnostic surface.

---

## 12. All findings, ordered by severity

### P0 — Critical (automatic no-go)

**P0-1 · Cross-tenant driver-PII disclosure via Storage — not verified closed in production.**
- **Module/persona:** Storage / all tenants' drivers (license images, face photos, chat attachments, receipts).
- **Workflow:** any client with the public anon key calls Storage `list`/`createSignedUrl` on the driver buckets.
- **Expected:** a client can only access its own tenant's files. **Actual (per migration SQL):** `0079`/`0446`/`0072`/`0435` grant bucket-wide `anon SELECT`; the anon key is public (`dashboard/config.js:12`). The fix (`0561` + `driver-file-sign` + app switchover + `0562`/`0567` policy drops) is shipped in the repo, but `0562` is a **manual, device-QA-gated migration shown unchecked** in `docs/LAUNCH-READINESS-CHECKLIST.md:33`, and this environment cannot reach the live DB to confirm application.
- **Evidence:** `0079_driver_self_serve.sql:41`, `0446_private_driver_photos.sql:62`, `0072_driver_chat_attachments.sql:117`, `0435_receipt_intake.sql:178`; drops in `0562_drop_anon_storage_reads.sql:26-28` + `0567_drop_receipts_anon_read.sql:34`; `driver-file-sign/index.ts` + `0561_driver_file_ownership.sql` (verified correct).
- **Impact:** enumeration/download of every DSP's driver government-ID images. **Likelihood:** high if `0562` is not yet applied.
- **Min fix:** apply `0562` + `0567` in prod after the device-QA in `docs/B1-STORAGE-SIGNING-RUNBOOK.md`; then, with only the anon key across two tenants, confirm `list`/`createSignedUrl` returns **zero** cross-tenant objects. **Effort:** Small (apply + verify). **Validation:** the two-tenant anon probe returns nothing cross-tenant; ideally extend `cross_tenant_isolation_test.sql` to Storage.

### P1 — Launch blockers

**P1-1 · No proven backup / tested restore.** No PITR/restore evidence; repo runbook (`docs/B2-BACKUP-RESTORE-DRILL.md:99-108`) is entirely unchecked and says "do not onboard a paying customer" until done. *Impact:* unrecoverable loss of a customer's HR/I-9 data. *Fix:* enable PITR + run one non-destructive restore drill, record RTO/retention. *Effort:* Medium. *Validation:* restore a known synthetic row into a scratch target; time it.

**P1-2 · Nothing alerts a human.** No APM/uptime; `/health` unconsumed; `client_errors` pull-only; `rr_cron_health()`/`push_delivery_failures` never read (`docs/H6-UPTIME-MONITORING.md` unchecked). *Impact:* the founder learns of an outage from the customer. *Fix:* point an uptime monitor at `/health` and wire one alert channel to the error/cron tables. *Effort:* Small. *Validation:* kill a cron / force an error → an alert reaches a phone.

**P1-3 · Hand-applied migrations, unconfirmed applied, no staging (B-3 process half).** `0560`–`0567` unchecked; one prod project; the `0539` regression shows paste-order security drift. The drift banner is now global+synced (code half fixed). *Impact:* a tenant runs code against a schema it lacks. *Fix:* apply all pending migrations, confirm `rr_schema_version()` = head, adopt a confirmed-apply checklist. *Effort:* Small (reconcile) + ongoing process. *Validation:* `select rr_schema_version()` on prod equals repo head; banner clears.

### P2 — Important (workable short-term, fix before unsupervised use)

**P2-1 · Publish gate incomplete and opt-in.** Only `driver_my_schedule` respects `require_finalized_for_drivers`; `driver_open_shifts_list`/pickup, swap pool, and pending-confirmation RPCs ignore it — with the gate ON a driver can still see and pick up unpublished-week shifts. Default off → schedules are live to drivers the instant written. *Evidence:* `0563_driver_schedule_publish_gate.sql:92-100`; `0201` pickup, `0203` swap, `0322` confirmations lack the check. *Fix:* thread the finalize check through all driver-facing schedule RPCs; consider default-on. *Effort:* Medium. *Validation:* gate ON → pickup/swap/confirmation return nothing for an unpublished week.

**P2-2 · EDV/license enforcement has ungated paths.** (a) `driver_offer_respond` (cover-offer accept) assigns `shifts.driver_id` with **no** cert/license/PTO gate (`0198_cover_shifts.sql:523`, never re-issued); (b) the H-5 license-buffer is **server-inert** — `dl_protection_days` is written only to localStorage (`live.js:60386`), never to `dsps.metadata.scheduling.dl_protection_days` that `0560` reads, so the server always sees buffer=0; (c) `apply_optimization_run` + direct `shifts` PATCH bypass the gates (staff-trust). *Fix:* add the `driver_can_take_shift`-class check to `driver_offer_respond`; persist `dl_protection_days` to `dsps.metadata`. *Effort:* Medium. *Validation:* an uncertified driver cannot accept an EDV cover offer; a lapsing license is refused within the configured window on assign/pickup/swap.

**P2-3 · `0539` re-gates a privileged RPC out.** `vehicle_set_operational_status` created without `is_staff` and granted to `authenticated` (`0539_fleet_inventory_foundation.sql:181-245`); un-gated on re-run or if applied after `0564`. *Fix:* add the gate to `0539`'s body or ship a re-assert migration. *Effort:* Small. *Validation:* a driver-role user gets `42501` on ground/unground; `rpc_role_gate_test.sql` extended to cover it.

**P2-4 · MFA narrow + bypassable.** Gates 3 settings RPCs; owner at aal1 can PATCH `dsps.metadata` to disable `require_mfa` (`0001:164-167`). *Fix:* exclude `metadata.security` from ungated aal1 owner updates; broaden `mfa_ok()` to sensitive mutators. *Effort:* Medium. *Validation:* an aal1 owner cannot flip `require_mfa` or perform a gated mutation.

**P2-5 · Residual bucket-wide anon INSERT** on `driver-documents`/`driver-chat-attachments`/`receipts`. *Fix:* path/tenant-scope the INSERT `with check`, or route uploads through an edge function. *Effort:* Medium. *Validation:* anon cannot INSERT into another tenant's path prefix.

**P2-6 · Driver-role read exposure.** A `role='driver'` `app_user` can read roster/shifts/team email inbox; `email_rules` writes not staff-gated. *Fix:* add role predicates to sensitive SELECT policies; staff-gate `email_rules` writes. *Effort:* Medium. *Validation:* a driver-role session cannot SELECT the roster or team inbox.

**P2-7 · TCPA / privacy-policy mismatch.** `webhook-apply` auto-sends screening SMS on intake by default (opt-out only) while the policy claims double opt-in. *Fix:* either implement the YES-gate or correct the policy to describe prior-express-consent-on-application + opt-out. *Effort:* Small. *Validation:* policy text matches implemented consent flow.

**P2-8 · Legal sub-processors/claims incomplete.** Add Anthropic, Fly.io, Cloudflare, LiveKit, Microsoft, Finch; remove the nonexistent "I agree" click-through and the "$350/month published rates" reference (or publish pricing). *Effort:* Small. *Validation:* docs name every processor actually in the stack; no reference to nonexistent flows.

**P2-9 · No pagination/virtualization; fetch-everything queries.** *Fix:* server-side paging/aggregation for roster/attendance/messages. *Effort:* Large. *Validation:* views render at 100+ drivers × 13 weeks without pulling >2k rows.

**P2-10 · No rollback/staging; single prod project.** *Fix:* document a rollback runbook; stand up a staging project. *Effort:* Medium. *Validation:* a rehearsed rollback of a bad deploy.

**P2-11 · No IR/breach runbook** behind the policy's 72h/48h promises. *Fix:* write an IR + rotation playbook. *Effort:* Small.

**P2-12 · Email provider-error stranding + no send cap.** Transient Resend errors → permanent `failed`; no outbound quota on the shared domain; immediate-send depends on manual GUC/cron. *Fix:* backoff/auto-retry on transient errors; per-DSP send cap; move the drain cron/GUCs into a migration. *Effort:* Medium.

**P2-13 · Offline replay dedupe gap** on chat/scan/receipt queues. *Fix:* client idempotency key + server dedupe. *Effort:* Small.

**P2-14 · Settings → Billing is a fabricated page.**
- **Module/persona:** Settings / DSP owner. **Workflow:** owner opens Settings → Billing.
- **Expected:** real subscription/invoices or an honest "billed manually" notice. **Actual:** hardcoded "RouteReady Pro $249/mo · next charge May 30", three fake "Paid $249.00" invoices (Apr/Mar/Feb 2026), "VISA •••• 4242", and "Manage subscription"/"Download"/"Update" buttons with no handlers.
- **Evidence:** `dashboard/views/view-settings.frag:766-793`; grep for the button handlers returns nothing.
- **Impact:** a paying customer sees fabricated financial records and a card that isn't theirs — a direct credibility hit for a paid product; contradicts the "no fake data reaches customers" posture. **Likelihood:** high (reachable tab). *Fix:* hide the Billing tab, or replace with the honest signup-wizard copy ("billed manually / we'll connect real billing"). *Effort:* Small. *Validation:* Settings → Billing shows no fabricated invoices/card.

**P2-15 · Help-menu "Contact support" is unreachable.**
- **Module/persona:** Help / any user. **Workflow:** open the account/help menu → "Contact support".
- **Expected:** the support mailto opens. **Actual:** the only opener of `modal-help` sits inside a **duplicate** `<div id="popover-account">` (`index.html:4475`); `getElementById` resolves to the first (`:1625`), so that popover never opens. The real `rrContactSupport` handler (`live.js:5364`) is never reached from the Help menu.
- **Impact:** the obvious in-app support path is dead (support survives via the Messages "RouteReady Support" thread + footer emails, so this is degraded, not absent). **Likelihood:** high. *Fix:* remove the duplicate popover / attach the Help item to the real account popover. *Effort:* Small. *Validation:* clicking "Contact support" opens the mailto.

### P3 — Polish (do not delay the pilot)

- `mock-wiring.js` (278 KB) still in the boot path — remove or lazy-gate.
- `view-build.frag` (33 KB) fully orphaned pure-mock ("Time Theft Analyzer", fake driver names, toast-only "Auto-dispute filed") — unreachable, so no customer fake data, but delete it.
- Launcher "Indeed Import" opens a file picker then toasts "upload wiring coming soon" (a real CSV bulk-ingest exists elsewhere) — wire or remove it.
- Swallowed errors: adopt `_rrSwallow`/`rpcOrToast` in the ~589 bare `catch` blocks so best-effort failures reach `client_errors`.
- One "OKAMI" codename in a user-visible launcher label (`index.html:1914`); rename to "13-week planner."
- Email reading-pane "AI" sparkle is a decorative placebo — hide until wired.
- Desktop agent silent plaintext session fallback — warn the user when OS crypto is unavailable.
- "No front image yet" mislabel when file signing fails.
- Custom sending domain stored but not routed (label it "pending DNS verification").
- Inbound email lacks hard DMARC enforcement (spoofed senders can land in applicant threads).
- CSP `unsafe-inline` — tighten toward nonces over time.
- Schema-drift banner copy exposes migration mechanics — soften for unsupervised tenants.

---

## 13. The ten highest-priority fixes

1. **Apply + verify `0562`/`0567`** and prove no cross-tenant file access with the anon key (**P0-1**).
2. **Enable PITR + run one restore drill**, record RTO (**P1-1**).
3. **Wire one uptime monitor + one alert channel** to `/health` and the error/cron tables (**P1-2**).
4. **Reconcile the live schema** to head and confirm every `0560`–`0567` is applied (**P1-3**).
5. **Gate `driver_offer_respond`** with cert/license checks and **persist `dl_protection_days`** to `dsps.metadata` (**P2-2**).
6. **Re-assert the `is_staff` gate on `vehicle_set_operational_status`** in `0539` (**P2-3**).
7. **Complete the publish gate** across pickup/swap/confirmation RPCs (**P2-1**).
8. **Close the MFA bypass** — exclude `metadata.security` from ungated aal1 owner updates (**P2-4**).
9. **Correct the legal docs** — sub-processors, TCPA consent language, nonexistent click-through/pricing (**P2-7/P2-8**).
10. **Path-scope the residual anon storage INSERT** policies (**P2-5**).

---

## 14. Items that are already genuinely customer-ready

- **Table-level tenant isolation** — CI-proven read/write isolation across two tenants on every migration PR; migrations replay from zero.
- **Scheduling solver + Smart Fill** — 97 pytest + 90 engine tests; fails safe when the solver is down; honest run report.
- **Concurrent-edit protection** — optimistic `assign_shift` + double-book trigger, CI-tested.
- **Approved-PTO block** — server-enforced with recorded-override + client confirm.
- **Forecast math** — hand-verified against documented examples; 43+ forecast tests.
- **Calendar/DST** — tested across spring/fall/Phoenix/southern hemisphere; native booking uses advisory lock + overlap check.
- **Document sealing / e-signature** — real ECDSA P-256 + RFC 3161 timestamp + append-only audit + public in-browser verification. The headline claim is accurate.
- **Email system core** — real Resend send/inbound/events, sandboxed-iframe + CSP XSS model, tenant RLS, authenticated webhooks, atomic dup-send protection, idempotent inbound.
- **Driver PWA** — five offline queues, publish-gate empty state, push-subscription resilience, token auto-revoke on termination, no PII in logs/URLs (token only in `#fragment`).
- **First-run wizard, empty states (~150), destructive confirms (~130), honest global schema banner, working Messages support thread.**
- **Data export + gated account deletion** (`export_my_dsp_data` / `export-tenant-files` / `admin-delete-dsp`).
- **Test/CI discipline** — 27 node suites, 97 pytest, 90 engine, 4 Playwright e2e suites, 13 SQL gate tests in `migration-check`, all green.

---

## 15. Test coverage gaps and unverified assumptions

**Commands run this session (all local):**
- `npm install` → ok · `npm test` → **27/27 pass** · `eslint .` → clean · `npm run smoke` → pass · `node scripts/design-lint.mjs` → held · `node scripts/check-migration-ordinals.mjs` → pass (banner synced 570) · `npm audit --omit=dev` → **0 vulns**.
- `pytest solver-service/tests` → **97 passed** · `engine` `npm test` → **90 pass/0 fail**.
- Playwright: login **3/3**, email **4/4**, booking **2/2**, driver-app **9/9**.
- Stubbed browser journey (11 views) → all render, **0 page errors**, no overflow at 1440px/390px.
- GitHub API → `main` CI last 30 runs all `success`.

**Not verified (needs live env / device / operator):**
- Whether `0560`–`0567` (esp. `0562`/`0567`) are applied in the live DB — **the crux of P0-1/P1-3**.
- Live cross-tenant storage probe with the real anon key.
- Real backup existence and restore time.
- Live email send/receipt, transactional-email rendering, bounce handling end-to-end.
- Whether driver-role `app_user` dashboard logins are provisioned (governs P2-3/P2-4/P2-6 likelihood).
- Cross-device responsive/zoom/screen-reader accessibility.
- Dashboard/DB behavior at 100–200 drivers and 50+ tenants.
- Clean-room org creation end-to-end and independent UAT.

**Coverage gaps in the codebase:** the SQL compliance gates now have tests (`cert_gate`/`rpc_role_gate`/`mfa_gate`/`publish_gate`), but the send pipeline, both email webhooks, and the XSS render path have no automated tests; there is no dashboard load test.

---

## 16. Phased plan

**Before the first paying customer (days):**
1. Apply + verify `0562`/`0567`; two-tenant anon storage probe returns nothing cross-tenant (**P0-1**).
2. Enable PITR + one restore drill with recorded RTO (**P1-1**).
3. Uptime monitor on `/health` + one alert channel wired to error/cron tables (**P1-2**).
4. Reconcile schema to head; confirm `rr_schema_version()` = 570 (**P1-3**).
5. Re-gate `vehicle_set_operational_status` (**P2-3**); gate `driver_offer_respond` + persist `dl_protection_days` (**P2-2**); close the MFA bypass (**P2-4**).
6. Correct legal docs (sub-processors, TCPA, phantom click-through/pricing) (**P2-7/P2-8**).
7. Remove the fabricated Settings → Billing page (**P2-14**) and fix the dead Help "Contact support" opener (**P2-15**) — both Small, both direct trust hits a paying customer will see.

**During the first 30 days of a paid pilot:**
- Complete the publish gate across pickup/swap/confirmation (**P2-1**); path-scope anon storage INSERT (**P2-5**); close driver-role read exposure (**P2-6**).
- Email provider-error backoff + per-DSP send cap + move drain cron/GUCs into a migration (**P2-12**); offline replay idempotency (**P2-13**).
- IR/breach runbook (**P2-11**); document a rollback path (**P2-10**).
- Time a real clean-room onboarding; scrub the P3 polish (mock-wiring, OKAMI label, placebo AI button).

**Before unsupervised production use:**
- Pagination/virtualization + server aggregation (**P2-9**); dashboard load test at 100–200 drivers.
- Stand up a staging Supabase project; automate migration apply with confirmation.
- Cross-device responsive + accessibility regression; independent UAT.

**Before general availability (multi-DSP):**
- Server-enforced entitlements (replace CSS-only gating); server-side send quotas on shared email/SMS domains.
- Repeatable tenant provisioning + demo tenant; tagged releases with production smoke; SOC2-track controls if claimed.

---

## 17. Final answer

**CONDITIONAL GO for a founder-assisted paid pilot** — conditional on closing, and *verifying in production*, three gates the code cannot close for you: (1) apply `0562`/`0567` and prove no cross-tenant file access with the anon key (**P0-1**); (2) enable PITR and run one restore drill (**P1-1**); (3) wire live alerting (**P1-2**) — plus the short remediation pass on the partial fixes (P2-1…P2-4). Until P0-1 is verified closed in production, the strict reading is **NO-GO**, because an unclosed cross-tenant PII exposure is an automatic no-go regardless of how strong everything else is. Everything required is days of work, not a rebuild.

**RouteReady is not ready for a paying DSP customer because the cross-tenant driver-PII storage exposure has a shipped-but-unapplied fix that cannot be confirmed live, there is no proven backup or tested restore, nothing alerts a human when something breaks, and three of the security fixes the product records as "done" (the schedule publish gate, the EDV/license enforcement, and MFA server-enforcement) shipped with real gaps — but its operational core is genuinely strong, none of these are architectural, and closing the three operator gates plus a short remediation pass would make it ready.**
