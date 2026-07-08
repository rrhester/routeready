# RouteReady Launch-Readiness Audit — 2026-07-08

Full-product audit against one standard: **"Would a serious DSP owner trust
RouteReady with tomorrow morning's operation?"** Grounded in the actual code
(file:line evidence), not generic SaaS advice. Six deep module reviews +
cross-checks; every claim below was verified against the source before it was
written down. Corrections to reviewer findings are marked ✎.

---

## A. Executive diagnosis

**What RouteReady is becoming.** A genuine DSP operating system, not a
dashboard. The spine is real: schedule → risk engine → Smart Fill →
attendance → hiring → fleet, all tenant-scoped on Supabase with an
append-only audit layer and a driver PWA that actually round-trips
(check-in, forms, receipts, messages, celebrations).

**Strongest part.** The scheduling core. Callout Exposure (cushion vs
at-risk drivers, `live.js` ~57000) is exactly the intelligence a DSP owner
pays for; Smart Fill enforces real constraints (availability, PTO, license
windows, DOT/XL/EDV, consecutive days, hour caps, min-rest), explains every
assignment, records every run to `optimization_runs`, and never overwrites
pinned/locked/manual work. The interview-scheduling stack (booking engine,
Google Calendar 2-way sync, no-show rebook) is the most mature module in the
product. Fleet↔schedule integration is real: grounded vans are blocked from
route assignment with a clear message.

**Weakest part.** Delivered capacity *prescription*. The forecast math is
real and explainable, but the gap card renders a bare "−N drivers" with no
"hire N by DATE" action — while the best prescriptive engine in the repo
(`flex-capacity.js`: tiers, `recommendedFtHires`, coaching text, unit-tested)
ships in the service-worker precache and is imported by **nothing**.

**Most world-class.** The engineering discipline around the schedule: the
engine is a typed, tested TS package with a deterministic build; migrations
are validated from zero in CI; a design-lint ratchet stops UI drift; audit
events are append-only and tamper-resistant.

**Most unfinished.** Receipts admin (capture is 9/10, the manager-side inbox
RPCs exist but no UI calls them), the 4 unwired Intelligence tiles, and the
email inbound sync.

**Most launch risk.** Two storage buckets holding PII are world-readable
(`driver-photos`, `message-attachments`) and, until migration 0445, any
`driver`-role account could delete every shift in its DSP.

**Protect:** Smart Fill explanations + audit trail; Callout Exposure;
separation review flow; the design ratchet; the driver-app token auth model.
**Simplify:** risk vocabulary (4 parallel scales → 2); the schedule side
panel owns too many jobs. **Hide for now:** the 4 unwired intel tiles (done —
now disabled), reports categories marked "Soon" (already disabled properly).

**The single most important product principle going forward:** *Nothing on
screen may claim more than the system actually knows or does.* Every fake
number, dead button, or "Live" label that isn't live spends trust the
product's real intelligence has earned.

---

## B. Product map

| Module | Primary user | Job-to-be-done | Data deps | Risk surfaced | Action enabled | Maturity | Launch-ready | Biggest concern | Next step |
|---|---|---|---|---|---|---|---|---|---|
| Schedule (week/today) | Dispatcher/Owner | Cover tomorrow's routes | shifts, drivers, PTO, certs, vans | Callout exposure, conflicts | Assign/Smart Fill/finalize | 7/10 | Yes | No concurrency control (last-write-wins) | Realtime or version-check on `assign_shift` |
| Smart Fill | Dispatcher | Fill legally + fairly | + optimization_runs, solver svc | Uncovered shifts + why | Run/what-if/accept | 7/10 (engine 9) | Yes | Fly.io hard dependency (deliberate: no-fallback is operator choice; fails safe) | Surface solver status pre-run |
| Roster | Owner/HR | Who can work | drivers, coachings, shifts | Corrective-action risk | Add/edit/separate | 7/10 | Yes | 500-row cap, client-side filter | Server paging later |
| Attendance | Owner | Who's reliable | attendance_decisions, policy | Points→ladder | Excuse/coach | 6/10 | Yes | 4 parallel risk vocabularies | Unify to points + Watch/At-Risk |
| Driver record | Owner/HR | One driver's truth | 8+ tables | Eligibility gaps | Coach/document/PTO | 8/10 | Yes | Messages not linked into record | Add thread link |
| Separation | Owner | Terminate safely | coachings, attendance, PDF | Wrongful-term exposure | Certified separation packet | 8/10 | Yes | — | Protect as-is |
| Forecast/Targets (OKAMI) | Owner | Staff for demand | okami_grid, drivers, PTO | Future gap, hire-by | Simulate 13 weeks | 5/10 | Partial | Gap has no prescription; flex-capacity engine dark | Wire `recommendedFtHires` into gap card |
| ATS/Pipeline | Owner/HR | Hire ahead of need | applicants, bookings, gcal | Stuck applicants (SLA) | Advance/book/message | 7/10 | Yes | No native job-board API (webhook/CSV only) | Fine for launch |
| Interview day/booking | HR | Run interview days | capacity sessions, gcal | No-shows | Book/rebook/outcome | 8/10 | Yes | — | Protect |
| Onboarding ops | HR | New hire → road-ready | drivers(status), I-9, docs | Blocked steps | Checklist, activate | 6/10 | Yes | (Stub buttons removed in this PR) | — |
| Fleet | Ops | Vans ready | vehicles, issues, FEM/VORR | Grounded/OOS vs routes | Ground/assign/service | 8/10 | Yes | — | Protect |
| Messaging (driver chat) | Dispatcher | Reach drivers | driver_messages, realtime | Unread/unacked | Send/ack/priority | 8/10 | Yes | In-app only (no SMS driver chat) | Fine; templates cover SMS |
| Email | Ops | Ops inbox | email_messages, intake | — | Read/file | 5/10 | Feature-gate | Inbound sync unproven | Verify sync or hide per-DSP |
| Checklists | Ops | Recurring op tasks | checklist_* RPCs | Overdue/flagged | Assign/complete | 6/10 | Yes | (Fake header counts removed in this PR) | — |
| Forms | Ops/Driver | Structured intake (DVIC…) | forms RPCs, validation parity tests | Failed/flagged submissions | Review | 8/10 | Yes | — | Protect |
| Reports | Owner | Export truth | reports.js (3 live sources) | — | CSV/print/workbook | 7/10 | Yes | 4 categories "Soon" (honestly disabled) | Add fleet source next |
| Workbook | Owner/Ops | Spreadsheet on live data | workbook_* tables, engine/ | — | Load People/Vans/Schedule | 8/10 | Yes | "Live" chip overstated (fixed → "Synced") | RR formulas later |
| Receipts | Driver+Owner | Capture → reconcile | receipt_uploads, ledger | Duplicates | Scan/submit/ledger | 7/10 (capture 9, admin 4) | Partial | Admin RPCs (`receipts_list/summary/set_status`) unused by any UI | Build receipts inbox |
| Driver app | Driver | Execute the day | token RPCs | Missed check-in | Check-in/forms/receipts | 8/10 | Yes | `prompt()` in missed-day flow | Swap to sheet UI |
| Recognition | Owner | Retention moments | driver_recognitions | — | Send/schedule celebration | 7/10 ✎ | Yes | ✎ Reviewer said undelivered — wrong; app consumes via `#/welcome` on open (stale comment fixed) | — |
| Documents/e-sign | HR | Sealed paperwork | envelopes, ECDSA/RFC-3161 | Unsigned docs | Send/seal | 8/10 | Yes | — | Protect |
| Platform admin | Platform | Per-DSP control | dsp_entitlements, signals | — | Page/feature toggles | 7/10 | Yes | UI-level only (by design, documented) | — |

---

## C. Launch blockers (ranked)

| # | Issue | Location | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|---|
| 1 | **Public PII buckets** — `driver-photos` (face photos), `message-attachments`, `vehicle-photos` world-readable by URL, cross-tenant, forever | migrations 0023:41, 0064:25, 0213:119 | **Critical** | `public=true`, no read policy | Flip private + tenant SELECT policies + signed URLs. **Blocked on coordination:** driver app has no Supabase session (needs an RPC/edge-function URL-signing path) and template attachments embed public URLs into sent SMS/email. Needs its own PR with both surfaces + link-rewrite handled together | **Documented; next PR** |
| 2 | **No intra-tenant role gates** on drivers/shifts/time_off — `driver`-role accounts can delete every shift | 0013:75-82, 0025:103-108,165-170 | **Critical** | `for all using (dsp_id=…)` + `grant delete to authenticated` | Split policies, writes require `is_staff(dsp,'dispatcher')` | **Fixed — migration 0445 (this PR)** |
| 3 | Fake data shipped as real: checklists "14 active · 4 due now", schedule mock grid (6 fake drivers, fake coverage), boot-time fake staffing paint | view-checklists.frag:8-30, view-schedule.frag:1916-2015, index.html:5086 | **High** | hardcoded literals, no updater | Remove/neutralize | **Fixed (this PR)** |
| 4 | "At risk" roster chip filters on never-computed `drivers.score` → always empty while the Risk column shows real flags | live.js:6048, 12237-12239 | **High** | `drivers.score` has no writer (only `applicants.score` is computed, 0003) | Chip now filters on the real corrective-action signal; dead Score filter/column removed | **Fixed (this PR)** |
| 5 | Local engine throws on EDV routes → what-if/drill-down dry-runs fail for EDV DSPs | scheduling-engine.js:361 (engine/src/normalize.ts) | **High** | `Unknown route_type: edv`; CP-SAT handles EDV (eligibility.py:126) | EDV added to engine types/normalize/R004 + test; bundle rebuilt | **Fixed (this PR)** |
| 6 | Schedule concurrency: two managers editing = silent last-write-wins; shifts not in realtime publication | live.js:51711, 39921, 16120 | **High** | no version check on `assign_shift` | Add `updated_at` guard or realtime channel | Next PR (needs design) |
| 7 | Dead-end controls: 5 stub "Rules" buttons; 4 intel tiles open a blank pane that hides the schedule | view-onboarding-ops.frag ×5; live.js:2991 | **Medium** | no handlers / no renderers | Stubs removed; tiles disabled with "coming soon" | **Fixed (this PR)** |
| 8 | Unwired `open_onboarding` CTA on hired cards (silent reload) | live.js:719 vs handleAction | **Medium** | no case in dispatch | Handled → routes to onboarding | **Fixed (this PR)** |
| 9 | `client_errors` INSERT `with check (true)` — spoofable dsp_id/user_id | 0385:31-36 | **Medium** | policy text | Bound to caller in 0445 | **Fixed (this PR)** |
| 10 | Receipts invisible to managers outside the ledger workbook | 0437 RPCs unused | **Medium** | zero `live.js` refs | Receipts inbox UI | Next PR |
| 11 | Email inbound sync unproven; folder shows "once email sync is wired up…" | view-email.frag:82 | **Medium** | copy admits it | Verify or disable page per-DSP via entitlements | Owner decision |
| 12 | Mock-wiring.js still ships 275KB of mockup-era globals | index.html:5081 | **Medium** | loaded on boot | Continue purge #3 (boot invocations removed this PR) | Ongoing |

✎ Two reviewer findings were **downgraded on verification**: (a) recognition
celebrations *are* delivered (route `#/welcome`, `checkAndShowPendingRecognition`);
(b) the Smart Fill drill-down `planScheduleWeek` calls were already inside
try/catch — the real fix was EDV parity, which landed.

✎ The disabled heuristic fallback when CP-SAT is down is a **deliberate,
documented operator preference** (live.js:54134-54141) and fails safe
(schedule untouched, audit row written, clear toast). Recorded as accepted
availability risk, not a defect.

---

## D. World-class gap analysis

| Category | Score | Working | Weak | First fix |
|---|---|---|---|---|
| Product clarity | 7 | Modules map to real DSP jobs | Risk vocabulary ×4 | Unify risk labels |
| Information architecture | 7 | Sidebar pruned deliberately | Schedule sub-view sprawl (20 subviews) | Audit reachability (3 dead ones removed this PR) |
| Navigation | 7 | Entitlement-gated nav | Some flows only reachable via schedule tabs | Document canonical paths |
| Visual design maturity | 7 | Token ratchet, KPI contract live | 910 raw hex, 3.6k `!important` remain | Continue ratchet batches |
| Workflow completeness | 7 | Hire→onboard→schedule→separate all real | Receipts admin, forecast→hiring gap | Receipts inbox |
| Operational intelligence | 7 | Callout Exposure, SLA stuck-chips, weather risk | Prescriptions missing (hire-by CTA) | Wire flex-capacity |
| Data trust | 6→8 | RPC-backed views, real empty states | Was: fake counts/mock grid (removed) | Keep "no fake numbers" rule in review checklist |
| Error handling | 8 | Toasts + recovery, solver fails safe, client_errors viewer | Some raw error text | Copy pass |
| Empty states | 8 | Purpose-built per stage | — | — |
| Loading states | 8 | Skeletons everywhere | — | — |
| Permissions | 5→7 | Tenant isolation solid, driver tokens | Was: no in-tenant write gates (0445 fixes) | Bucket privacy PR |
| Security | 6 | No secrets in client, append-only audit | Public PII buckets | Bucket privacy PR |
| Performance | 6 | SW cache, stale-while-revalidate | 85k-line live.js, client-side filtering, 20k-row attendance pulls | Measure at 100+ drivers |
| Mobile readiness | 7 | Driver PWA strong | `prompt()` in missed-day | Swap to sheet |
| Launch readiness | 7 | CI gates real | Items C1, C6 | Bucket + concurrency PRs |
| Enterprise credibility | 7 | Audit log viewer, sealed docs | Risk labels drift | Vocabulary pass |
| Owner value | 8 | Morning answers exist (Today's Plan, Ops Health) | Forecast prescription | flex-capacity wire-up |
| Daily usefulness | 8 | Check-in, exposure, chat | — | — |
| Differentiation | 8 | DSP-specific everywhere | Under-sold in-product | — |
| Pricing justification | 7 | See §O | Receipts/email maturity | Finish or hide |

---

## E. Moat map

| Moat | Present? | Real? | Obvious to user? | Defensible? | Priority | Next step |
|---|---|---|---|---|---|---|
| Attendance-risk-aware scheduling | Yes | Yes — solver `attendance_weight`, corrective-action gating | Partly | High (data + policy engine) | 1 | Unify risk labels so it reads as one system |
| Cushion/callout-exposure visibility | Yes | Yes (+weather model) | Yes | High | 1 | Protect; add to owner morning summary |
| Smart Fill w/ explanations + audit | Yes | Yes (dual engine) | Yes | **Highest** — explainability is rare | 1 | Keep engine parity (EDV done) |
| Forecast→staffing gap | Yes | Math real | Gap yes, prescription no | Medium | 2 | Wire `flex-capacity.js` into gap card |
| Hiring pipeline tied to demand | Partial | ATS real; not linked to forecast | No | Medium | 2 | "Hire N by DATE" → prefill hiring goal |
| Driver records w/ separation packets | Yes | Yes | Yes | High (compliance gravity) | 1 | Protect |
| Receipt/document intake | Capture yes | OCR on-device, dedupe server-side | Driver yes, owner no | Medium | 3 | Receipts inbox |
| Workbook on live data | Yes | Yes (snapshot semantics, now honest) | Yes | Medium-high | 3 | RR formula functions later |
| Driver app execution layer | Yes | Yes end-to-end | Yes | High | 1 | Protect |
| Fleet readiness → coverage | Yes | Yes (grounded-van gate) | Yes | Medium | 2 | Protect |

---

## F. Page-by-page (condensed; full findings in §C/§D tables)

- **Schedule week**: keep the Ops Health rail exactly where it is; the
  finalize gate with exposure warning is the right pattern. Don't add color.
  The mock grid removal (this PR) makes first paint honest (skeleton).
- **Roster**: Risk column + points are the truth — the score remnants
  contradicting them are gone (this PR). Termination flow: do not touch.
- **Targets/OKAMI**: the 13-week table is good; the gap card needs the
  prescription line. Simulate's headcount-only nature is labeled in code but
  should be labeled in UI copy ("headcount projection — does not check
  certs/waves").
- **Pipeline**: SLA chips + Action-needed tab are quietly excellent. The
  static demo cards in the frag are overwritten on load but should be
  replaced with skeletons like the schedule (follow-up, same pattern as this
  PR's schedule fix).
- **Fleet**: FEM/VORR strips + grounded-gate are launch-grade.
- **Workbook**: "Synced" chip (this PR) sets honest expectations. Receipt
  Ledger is a real differentiator.
- **Driver app**: first screen (check-in card + Up next) is right. Replace
  the `prompt()` missed-day input; add odometer capture to DVIC (both small
  follow-ups).

## G. Design system

Already codified in `docs/DESIGN-SYSTEM.md` + `dashboard/KPI-CONTRACT.md`
with CI enforcement — this audit adds only: (1) risk-severity mapping must be
one scale product-wide: **neutral → Watch (amber) → At Risk (red)**, with
"exposed/uncovered" red reserved for coverage math; (2) disabled-not-hidden
is the standard for built-but-unwired controls (pattern shipped this PR on
intel tiles); (3) no static sample data in view fragments — skeletons only
(pattern shipped this PR).

## H. Action intelligence — top 10 to build (all data already exists)

| Recommendation | Trigger | Where | Primary action |
|---|---|---|---|
| "Hire N by {date}" | worst-week gap < 0 (OKAMI) | Targets gap card + owner summary | Set hiring goal |
| "Cushion doesn't cover risk Thu" | exposure > 0 on a finalized day | Schedule day header + Ops Health (exists) → add **Message backups** CTA | Open low-risk backup list (engine already computes it, live.js:57064) |
| "3 applicants stuck in screening" | SLA breach (exists as chips) | Owner summary | Open Action-needed tab |
| "Driver hit Watch threshold" | points cross rung | Roster + driver record | Create coaching note (flow exists) |
| "License expires in 14 days" | reminder table (exists) | Schedule + roster | Open driver record |
| "Van due for service is assigned Tue" | maintenance booking × assignment | Fleet + schedule | Reassign van |
| "Receipt needs review" | `receipts_summary` pending > 0 | New receipts inbox | Reconcile |
| "Checklist overdue" | due reminder (0438, exists) | Checklists + owner summary | Nudge assignee |
| "New hire road-ready" | onboarding steps complete | Onboarding | Add to schedule |
| "Solver unreachable" | dispatch failure | Smart Fill button state | Retry/status link |

## I. Data architecture

| Entity | Concern | Risk | Improvement | Priority |
|---|---|---|---|---|
| shifts | No `(driver_id, date)` unique constraint | Double-booking possible at DB level (engine prevents, DB doesn't) | Partial unique index where driver_id not null; needs data-cleanup preflight | High, own PR |
| time_off_requests | No overlap guard | Overlapping approved PTO | Exclusion constraint (daterange) after dedupe | Medium |
| drivers | email/phone not unique; no status history table (metadata JSON + audit_events only) | Duplicate people; weak history queries | Unique-where-active indexes; keep audit_events as history | Medium |
| certifications | Document-based only (no first-class table) | Expiry logic scattered | Fine for launch; consolidate later | Low |
| audit coverage | Triggers only on drivers/app_users/driver_documents/shifts | time_off/receipts/coachings changes unaudited | Extend `log_audit_event` triggers | Medium |
| `drivers.score` | Dead column with no writer | UI built on it misleads (fixed) | Drop column or ship a computer; don't re-expose UI until then | Done (UI) |

## J. Security & permissions

| Risk | Severity | Blocker? | Status |
|---|---|---|---|
| Public PII buckets (photos/attachments) | Critical | **Yes** | Next PR (coordinated dashboard + driver-app + link strategy; plan in §C1) |
| In-tenant write gates missing | Critical | Yes | **0445 this PR** — includes preflight query for `driver`-role operators |
| client_errors spoofable insert | Medium | No | **0445 this PR** |
| Entitlements are UI-only | Accepted | No | By design (documented in 0442) — data stays RLS-gated |
| Secrets hygiene | — | — | Clean (anon key only; verified) |
| Tenant isolation | — | — | Solid: server-derived `current_dsp_id()`, no `USING(true)` reads found |

## K. Performance & reliability

| Risk | Location | Threshold | Fix | Priority |
|---|---|---|---|---|
| Roster 500-row cap + full-DOM render | live.js:5931, 6372 | ~500 drivers | Server paging/virtualize | Low now |
| Attendance pulls ≤20k shifts client-side | live.js:5944 | ~1-2 yrs history × 100 drivers | RPC aggregation | Medium |
| Schedule concurrency (last-write-wins) | live.js:51711 | 2 concurrent editors | Version guard / realtime | **High** |
| Solver outage = no Smart Fill | live.js:54134 | any Fly.io incident | Accepted (operator choice); fails safe | Documented |
| live.js size (85k lines, one file) | — | dev velocity, not runtime | Continue extracting (engine/ pattern) | Ongoing |

## L. Copy

Fixed this PR: "Live" → "Synced" (workbook), stale recognition comment,
at-risk chip tooltip now describes the real signal, intel tiles say "coming
soon", empty-state "score below 70" → "open corrective action". Remaining
pass (follow-up): raw `error.message` in ~toasts; Simulate's headcount-only
caveat in UI.

## M. First-paid-DSP onboarding (minimum path)

1. Platform admin creates DSP + owner (pending_owners) → 2. Add drivers
(bulk import exists) → 3. Certs/availability per driver → 4. Vans →
5. OKAMI route targets → 6. Schedule rules (waves, cushion) → 7. Run Smart
Fill on a past week as rehearsal → 8. Invite dispatchers (**role
dispatcher+**, see 0445 preflight) → 9. Driver app activation codes →
10. Attendance policy → 11. Apply link + screening → 12. Review Today's
Plan next morning. Estimated 2–4 hours with the existing importers.
Biggest gap: no guided sequence — the pieces all exist but an owner needs
the list above. A settings checklist page is the cheapest fix.

## N. Launch scope

- **Launch Core (works today):** Schedule, Smart Fill, Roster, Attendance,
  Driver record/Separation, Pipeline+Interview day, Fleet, Driver app,
  Messaging, Forms, Documents, Checklists, Reports (3 sources), Workbook,
  Recognition, Platform admin.
- **Near-term (build before/soon after first paid):** Receipts inbox,
  bucket privacy, schedule concurrency guard, forecast prescription.
- **Feature-flag per-DSP (entitlements exist — use them):** Email inbox
  (until sync proven), intel tiles (now disabled globally).
- **Future moat:** flex-capacity engine, RR workbook formulas, receipt
  intelligence, Smart-Fill-from-sheet.
- **Experimental (don't ship):** parts-pricing crawler, speed alerts.

## O. Pricing justification ($800–1,200/mo)

**Five strongest reasons to pay:** (1) Callout-exposure math before the
morning breaks — one saved missed route ≈ one month's fee; (2) explainable
Smart Fill with an audit trail (defensible fairness); (3) separation packets
(one avoided wrongful-term dispute pays for years); (4) hiring engine with
calendar sync + SLA chips (replaces a VA); (5) one system replacing
5–6 tools (scheduler, ATS, forms, fleet board, spreadsheets, recognition).

**Five hesitations:** (1) single-tenant trust — public buckets story must be
closed; (2) no SMS driver chat (in-app only); (3) forecast tells the gap,
not the plan; (4) receipts capture without admin closes no books; (5) no
native Indeed API (webhook/CSV is fine but sales must position it).

## P. Implementation plan

- **This PR (done):** trust purge + role gates + EDV parity + small wires
  (§Q below).
- **Next PR (before first paid DSP):** bucket privacy (coordinated:
  private buckets + tenant SELECT policies + dashboard signed URLs + driver
  RPC/edge signing + template-attachment link strategy).
- **Then:** schedule concurrency guard; receipts inbox (RPCs exist);
  forecast prescription line (flex-capacity); pipeline frag skeleton purge;
  audit triggers on time_off/coachings/receipts.
- **Ongoing:** design ratchet batches; mock-wiring purge #3; copy pass.

## Q. Work completed in this PR

See PR description for the file-by-file summary, verification results, and
the 0445 migration SQL (also pasted in the session chat per operating
notes).
