# RouteReady — Customer-Readiness Audit

**Verdict: NOT READY FOR A CUSTOMER.** RouteReady has a genuinely strong
operational core — the scheduling engine, Smart Fill explanations, forecast math,
and table-level tenant isolation are real and well-tested — but it currently ships
with a cross-tenant exposure of driver government-ID images, no proven backup, and a
hand-applied database process that has already skipped migrations in production. Any
one of those is an automatic no-go; together they mean a paying customer must not be
given access yet.

*Audit date: 2026-07-21 · Repo HEAD: `9562b84` · Branch: `claude/routeready-launch-audit-px2s8a`*

---

## 1. How this audit was performed (and its limits)

I audited the actual source, database migrations (570 of them), edge functions, CI
pipeline, and production configuration; ran the full automated test suite and linters
myself; booted the operator dashboard locally in a browser to confirm it renders and
navigates; and verified the most serious findings by reading the exact policy/code at
the cited file and line.

**One important constraint, stated plainly:** this audit environment's network policy
**blocks all outbound connections to the live Supabase project** (the egress proxy
returns a hard "403 policy denial" for `doiwrhkirgblcvuskhno.supabase.co`). That means
I could **not** send live API requests to prove server behavior against the running
production database. Where a finding depends on the *live* database state, I say
"Unverified" and explain what an operator must run to confirm it. The database
**migrations are the authoritative source of what the schema should be**, so
policy-level findings (like the storage exposure) are proven from the migration SQL —
but whether the live project matches the repo is exactly the risk described in Blocker
B-3 below.

**What I could and did prove firsthand:**
- `npm test` → **25/25 suites pass**; `npx eslint .` → **clean, exit 0**.
- Repo-wide secret scan → **no committed private keys**; `config.js` ships the
  *publishable* anon key (safe by design), not a service key.
- `npm audit --omit=dev` → **0 production vulnerabilities** (the 1 critical + 1 high
  are in `@capacitor/cli`, dev-only build tooling).
- Forecast math verified by hand against the documented examples.
- The dashboard **boots and renders** in a real browser (Chromium) with a stubbed
  backend; the sidebar navigation enumerates and no fatal JavaScript errors occur.
- The three storage-bucket `anon` SELECT policies were read directly in the migration
  files.
- CI on `main` is **green** across all workflows (verified via GitHub).

---

## 2. Scores

**Overall readiness score: 47% (47.0 / 99 applicable points).**
Pass = 1, Partial = 0.5, Fail/Unverified = 0. One item (billing) is N/A and excluded.

The percentage is deliberately **not** the headline. Per the audit's own rule, a high
completion number cannot override a serious security, privacy, data-loss, or
core-workflow failure — and there are several.

| Category | Score | Read |
|---|---|---|
| Product completeness | **60%** | Core is built; edges (support, legal text, dead surfaces) unfinished |
| Core workforce workflows | **63%** | Strongest area; gaps at the server-enforcement seams |
| Data correctness | **70%** | Forecast + exports sound; validation and dedup thin |
| User experience | **40%** | Design system real but responsive/a11y/large-data unproven |
| Security & tenant isolation | **48%** | Tables isolated; **storage is not**; MFA not server-enforced |
| Performance & reliability | **25%** | No backups verified, no alerting, no pagination, no load test |
| Onboarding & support | **44%** | Real first-run wizard; **support channel is fake** |
| Final validation | **15%** | No clean-room rehearsal, no UAT, blockers open |

---

## 3. The ten most serious risks

1. **Cross-tenant leak of driver government-ID images (BLOCKER).** Three storage
   buckets holding driver's-license scans, face photos, and chat attachments grant the
   public `anon` role bucket-wide read with no tenant boundary. The anon key ships in
   the browser and driver app, so in principle anyone can enumerate and download other
   DSPs' driver PII. *(0079, 0446, 0072)*
2. **No proven backup/restore (BLOCKER).** Point-in-Time Recovery is documented as the
   "last hard gate" and there is no evidence it is enabled or that a restore has ever
   been tested. You would be custodian of another business's I-9s with no recovery
   proof. *(CUSTOMER-1-READINESS.md §2.3)*
3. **Hand-applied migrations that have already been missed in production (BLOCKER).**
   Migrations are pasted into the SQL editor by hand; two (`0432`, `0484`) were
   demonstrably never applied and had to be re-shipped, and ~15 recent ones are flagged
   "MANUAL — not yet confirmed applied." The client's drift detector expects version
   504 while the repo is at 534, and it only shows on the calendar page. A drifted
   tenant runs code against a schema it doesn't have.
4. **MFA is enabled in the UI but not enforced on the API (HIGH).** Two-factor exists
   client-side, but no database policy requires it. A stolen password logs straight
   into the data API without ever being challenged for a code, so the security control
   the login screen advertises does not protect the data.
5. **Nothing alerts a human when something breaks (HIGH).** Error logs, cron health,
   and push failures are all passive tables no one is paged on; there is no
   error-monitoring service, and the uptime monitor is an unchecked manual to-do. You'd
   learn of an outage from the customer.
6. **The in-app help and support center is fake (HIGH).** Every item in the Help menu —
   including "Contact support" — only pops a placeholder message. A customer who hits
   trouble finds no working way to reach you from inside the product.
7. **Schedules are live to drivers the instant they're written — no draft/publish gate
   (HIGH).** The driver schedule feed returns every assigned shift with no "published"
   filter; a half-built or mistaken Smart Fill result is immediately visible and
   push-notified to drivers.
8. **A whole certification rule is enforced everywhere except the server (HIGH).** EDV
   route certification is checked by the solver and preview engine but by none of the
   database compliance gates, so a manual assignment, self-pickup, or swap can put an
   uncertified driver on an EDV route. The server compliance gates also have **zero
   automated tests**, which is how this drift shipped silently.
9. **The privacy policy and terms name the wrong data processors (HIGH).** They list
   Airtable and Cal.com (no longer used) and never name Supabase — where 100% of
   customer HR/PII actually lives. For an HR-data product this is a legal-accuracy and
   trust exposure.
10. **No pagination, no load test, and fetch-everything queries (MEDIUM→HIGH at scale).**
    Big lists pull up to 10,000–20,000 rows client-side with no paging or
    virtualization; the roster falls back to a 20k-row fetch every 30 seconds on an
    unmigrated tenant. It works in a demo and degrades badly as a real DSP's history
    grows.

---

## 4. Every Blocker and High finding

### Blockers (a customer must not receive access while any is open)

| ID | Finding | Evidence | Fix effort |
|---|---|---|---|
| **B-1** | **Cross-tenant driver-PII disclosure via Storage.** `driver-documents`, `driver-photos`, and `driver-chat-attachments` each have a storage policy `for select to anon using (bucket_id = '<bucket>')` — no tenant/path predicate. Two also allow `to anon ... insert`. The buckets are private, but a bucket-wide anon SELECT authorizes the Storage *list* and *signed-URL* APIs, so any client with the public anon key can enumerate `<dsp_id>/<driver_id>/…` paths and download license images across all tenants. | `supabase/migrations/0079_driver_self_serve.sql:33-45`; `0446_private_driver_photos.sql:55-67`; `0072_driver_chat_attachments.sql:110-121`; anon key public in `dashboard/config.js:12` | 1 day |
| **B-2** | **No verified backup / restore.** PITR is documented as a hard blocker "only you can do"; no config or restore-test evidence exists anywhere in the repo. | `docs/CUSTOMER-1-READINESS.md:61-66,140` | 2–3 days (incl. real restore drill) |
| **B-3** | **Manual migrations with a proven miss history + stale drift detection.** Auto-apply is disabled (`SUPABASE_DB_URL` unset); `0432` never applied and `0484` skipped in prod; ~15 recent migrations flagged MANUAL/unconfirmed; client expects `_RR_SCHEMA_EXPECTED = 504` while HEAD is `0534`, and the banner renders only inside the calendar view. | `scripts/apply-migrations.sh:22-26`; `dashboard/live.js:27497,27515`; `CLAUDE.md` MANUAL flags | 1 day (reconcile + global banner); ongoing process |
| **B-4 (gate)** | **Blockers/Highs unresolved and no documented go/no-go.** Items 98 and 100 cannot pass while B-1…B-3 and the Highs are open. | this report | n/a |

### High findings (must be resolved before a normal customer launch)

| ID | Finding | Evidence | Fix effort |
|---|---|---|---|
| **H-1** | **MFA not enforced server-side.** aal2 flow is client-only; **0** `aal2` references in any migration/RLS policy. Password compromise → direct API access at aal1. | `dashboard/config.js:24`; `dashboard/live.js:457-554`; grep of `supabase/migrations` | 1 day |
| **H-2** | **~500 pre-0504 `SECURITY DEFINER` RPCs remain anon/authenticated-executable**, gated only by in-body checks; the 0504 revoke is prospective ("future functions"). Any RPC that gates on tenant (`current_dsp_id`) but not role (`is_staff`) is callable by a low-privilege `driver`-role user. | `0504_reliability_and_hardening.sql:380-388`; class documented in `0445:5-20` | 2–3 days (audit sweep) |
| **H-3** | **No draft/publish gate on driver visibility.** `driver_my_schedule` filters only by driver_id + date, no `finalized` flag; "Publish" only sends a notification; `autoFillScheduleWeek` writes straight to the DB. | `0288_driver_my_schedule_station_coords.sql:54-71`; `0421_publish_notifies_drivers.sql`; `dashboard/live.js:67740+` | 1 day |
| **H-4** | **EDV certification enforced in solver + engine but in none of the SQL gates**, and the SQL compliance gates have no automated tests. | `eligibility.py:154-158`; `engine/src/rules/r004_certification.ts:34`; missing in `0500`/`0201`/`0423`/`0520`; no SQL/pgTAP tests exist | 1 day (gate) + 2–3 days (gate test harness) |
| **H-5** | **License-expiry protection window is client/engine-only.** Server gates block only once a license is already expired on the shift date. | `engine/src/rules/r003_license.ts`; `0500:110-113`, `0520:72`, `0201:196` | 1 day |
| **H-6** | **Nothing alerts a human.** `client_errors`, `rr_cron_health()`, `push_delivery_failures` are passive tables never read by the app; no APM; `/health` monitor is an unverified manual step; `rr_cron_health` is itself already stale. | `0504:234-262`; grep (no APM/Sentry); `CUSTOMER-1-READINESS.md:68` | 1 day (wire alerts) |
| **H-7** | **In-app Help/Support is entirely non-functional.** All five Help-menu items, including "Contact support," only fire placeholder toasts; no customer-facing docs exist. | `dashboard/index.html:4501-4517` (verified); `docs/` are dev-facing | 1 day |
| **H-8** | **Privacy policy & terms name wrong sub-processors and omit Supabase.** | `privacy.html:155-156,187`; `terms.html:166` (verified) | 1–4 hours |

---

## 5. The 100-point audit table

Severity applies to non-passing items. Effort: `<1h`, `1–4h`, `1d`, `2–3d`, `longer`.

### Product definition and completeness

| # | Requirement | Result | Sev | Evidence / How tested | Customer impact | Fix | Effort |
|---|---|---|---|---|---|---|---|
| 1 | Define first customer type/model/problem | PASS | — | `docs/CUSTOMER-1-READINESS.md`, `LAUNCH-AUDIT §A` define Amazon DSP ICP + JTBD | Clear target | Keep | — |
| 2 | Identify 5–10 must-complete workflows | PASS | — | `LAUNCH-AUDIT §M` 12-step path; `§N` scope | Scope known | Keep | — |
| 3 | Written launch scope (required vs post-launch) | PASS | — | `LAUNCH-AUDIT §N` | Expectations set | Keep | — |
| 4 | Hide/disable unfinished features | PARTIAL | MED | Intel tiles disabled, reports "Soon" disabled, BUT orphaned Recognition/Compliance/`view-build` still bundled; ADP Sync labeled "Mock UI only" (`index.html:527`) | Customer may hit a mock/dead surface | Remove orphaned views; gate ADP behind entitlement | 1d |
| 5 | Remove broken links/dead buttons/routes | PARTIAL | MED | Help-menu items + `view-build.frag:288` are toast-only stubs | Buttons that do nothing erode trust | Wire or remove dead controls | 1d |
| 6 | Remove mock/placeholder/dev notes/test records | PARTIAL | MED | Static fake data purged to skeletons (good); `mock-wiring.js` (277 KB) still in boot path; "migration NNNN" toasts | No fake *data* reaches customers, but dead code + jargon linger | Retire mock-wiring; scrub jargon toasts | 2–3d |
| 7 | Name/logo/domain/contact/version consistent | PARTIAL | LOW | RouteReady + `gorouteready.com` consistent; OKAMI + migration jargon in UI | Minor terminology confusion | Rename OKAMI in UI; hide ops jargon | 1–4h |
| 8 | Proofread customer-facing text | PARTIAL | MED | Clean overall; "check the console", "apply migration 0527", OKAMI leak into user text (`live.js:25795`,`27520`) | Reads unfinished/internal | Copy pass on toasts/banners | 1d |
| 9 | Document supported browsers/OS/devices | FAIL | MED | No browser/device matrix anywhere; `download.html` covers only the desktop sync app | Customer can't know what's supported | Publish a support matrix | 1–4h |
| 10 | Clean production-like demo tenant (synthetic) | PARTIAL | LOW | `supabase/seeds/seed_demo.sql` exists but is a manual seed, no maintained demo tenant | Demos ad-hoc | Stand up + document a demo tenant | 1d |

### Identity, access, and tenant separation

| # | Requirement | Result | Sev | Evidence / How tested | Customer impact | Fix | Effort |
|---|---|---|---|---|---|---|---|
| 11 | Sign-in valid/reject invalid | PARTIAL | MED | `login.html` password+magic+reset; `tests/login-e2e` (stubbed); live rejection = Supabase built-in, not live-tested here | Likely works; unproven live | Live smoke of good/bad creds | 1–4h |
| 12 | Admin invite + activation | PARTIAL | MED | `invite-team-member` + `admin_create_dsp` + pending_owner bind; unthrottled; not live-tested | Onboarding path unproven end-to-end | Live rehearse invite→activate | 1d |
| 13 | Email confirm + reset (expired/reused links) | UNVERIFIED | MED | `resetPasswordForEmail` present; expiry/reuse = Supabase default, not tested | Recovery unproven | Test expired + reused reset link | 1–4h |
| 14 | Logout/expiry/remember-me/revoked session | PARTIAL | MED | Idle-timeout 30 min (`config.js:17`); localStorage session; revoked-session not tested | Session hygiene mostly present | Test forced revocation | 1–4h |
| 15 | Permission matrix per role tested | PARTIAL | HIGH | `role_gate_compliance_test.sql`, `role_gate_planning_test.sql` exist; not a full role×action matrix | Some roles/actions unproven | Complete role matrix tests | 2–3d |
| 16 | Every protected API enforces authz independent of UI | PARTIAL | HIGH | RLS solid at tables; ~500 RPCs anon-executable via in-body gates (H-2); MFA not server-enforced (H-1) | Possible role bypass | See H-1, H-2 | 2–3d |
| 17 | One company can't see another's records via normal nav | PASS | — | `cross_tenant_isolation_test.sql` proves R/W isolation, wired into CI; `current_dsp_id()` server-derived | Table data isolated | Keep + keep test in CI | — |
| 18 | Cross-tenant via URL/ID/param/API tampering | PARTIAL | MED | Tables resist (RLS); `intake_applicant` anon cross-tenant *write* by short_code; `driver_signin_with_phone` global lookup; live probes blocked by network policy | Applicant-spam into any DSP; not a data read | Throttle+captcha intake; scope phone lookup | 1d |
| 19 | RLS + storage policies for every tenant table AND bucket | FAIL | **BLOCKER** | Tables ✔; **storage buckets grant anon bucket-wide SELECT** (B-1) | Cross-tenant PII read | See B-1 | 1d |
| 20 | Suspension/role change/separation/full revocation | PARTIAL | MED | `active` flag gates; separation packets; driver tokens plaintext, no revoke-all test | Revocation likely works, unproven | Test full offboarding revocation | 1d |

### Roster, scheduling, and workforce rules

| # | Requirement | Result | Sev | Evidence / How tested | Customer impact | Fix | Effort |
|---|---|---|---|---|---|---|---|
| 21 | Driver create/edit/import/deactivate/reactivate/archive | PARTIAL | LOW | Full CRUD + `bulk_create_drivers` per-row partial-failure handling; "archive" = status flip | Works; not live-tested | Live CRUD smoke | 1–4h |
| 22 | Required fields, duplicate drivers/IDs, incomplete records | PARTIAL | MED | Dedup **email-only**; required **name-only** (`live.js:7623`) | Duplicate/incomplete drivers inflate counts | Add phone/name dedup + field validation | 1d |
| 23 | Licenses/certs/DOT/XL/EDV compat/expiration | PARTIAL | HIGH | Enforced solver+engine; **EDV missing from server gates (H-4)**; license buffer client-only (H-5) | Uncertified driver on route via server path | See H-4, H-5 | 1d |
| 24 | Schedule create/edit/copy/move/publish/unpublish/delete | PARTIAL | HIGH | Present, but publish/unpublish = boolean flip with no visibility gate (H-3) | Draft state leaks to drivers | See H-3 | 1d |
| 25 | Published schedule = same info to managers and drivers | PARTIAL | HIGH | Both read live data, but there is no "published" concept controlling it | Drivers act on unpublished/draft shifts | Add publish gate (H-3) | 1d |
| 26 | Smart Fill: insufficient/excess/absent/conflicting quals | PASS | — | `_rrShowSfRunReport` + diagnostics report uncovered/skipped/unscheduled; solver-down fails safe (`live.js:69324`) | Honest, safe failure | Keep | — |
| 27 | Rest/consecutive/WOC/history/license buffers enforced | PARTIAL | HIGH | Server-enforced except license buffer (H-5) and WOC-off solver/server desync (silent unfilled seats) | Some gaps at the seam | See H-4/H-5; sync WOC flags | 1d |
| 28 | Approved-PTO can't be scheduled without warning/block | PASS | — | Server block `staff_assign_violations` (0500) + `assign_shift` raises `assign_blocked` + client confirm-override | Strong defense-in-depth | Keep | — |
| 29 | Availability/overlapping/open/uncovered/conflicts | PARTIAL | MED | Same-day double-book DB trigger blocks (good), but engine can emit them → 2nd write silently dropped | Seat quietly uncovered | Surface dropped-write in UI | 1d |
| 30 | Onboarding pairings/trainer eligibility/new-hire assignment | PARTIAL | MED | Trainee-inherits-trainer-van machinery exists; trainer-eligibility rules not deeply verified | Partially proven | Verify + test trainer eligibility | 1d |

### Other RouteReady workflows

| # | Requirement | Result | Sev | Evidence / How tested | Customer impact | Fix | Effort |
|---|---|---|---|---|---|---|---|
| 31 | Attendance entry/corrections/approvals/exceptions/reporting | PARTIAL | LOW | Derived-then-corrected; `attendance_decide`/`approve` RPCs; report from same RPC as screen | Functional; not live-tested | Live smoke | 1–4h |
| 32 | 13-week forecast vs independent calc | PASS | — | Verified by hand: `ceil(max(38,260/4)·1.10)=72`, `196/3.5·1.10=62`; `test-labor-forecast.mjs` asserts correctly (I ran it) | Math is trustworthy | Keep | — |
| 33 | ATS stages/movement/duplicate/rejection/hire/convert | PARTIAL | MED | Stages+movement+decline+convert exist; dedup source_ref→email, `force_new` bypass | Duplicate applicants possible | Add phone dedup; guard force_new | 1d |
| 34 | Indeed + Document AI failures/low-confidence/dup/corrections | PARTIAL | MED | webhook-apply dedupe/caps; Document AI stores confidence but **no hard low-confidence → manual-review gate** | Bad parse silently accepted | Add confidence threshold to review | 1d |
| 35 | Calendar one-time/recurring/timezone/DST | PASS | — | `cal-tz.mjs` DST-tested (spring/fall/Phoenix/southern); native booking server-side overlap + advisory lock | Robust | Keep | — |
| 36 | Message create/target/deliver/fail/retry/bounce/notify | PARTIAL | MED | Opt-out durable, dedupe, delivery status; hard-fail no proactive alert; retry only transient | Undelivered publish text unnoticed | Alert on hard-failed sends | 1d |
| 37 | Vehicle create/VIN/assign/status/maintenance/duplicate | PARTIAL | MED | VIN format validated; day-assignment unique; **no VIN uniqueness** → duplicate vans | Fleet counts corrupt | Add unique VIN constraint | 1–4h |
| 38 | Driver app: real driver role sees only their info | PASS | — | Token-scoped `driver_*` RPCs; a token cannot reach other drivers (`driver_validate_token`); no manager surface exposed | Correctly scoped (except B-1 storage) | Keep; fix B-1 | — |
| 39 | Report calcs/ranges/filters/sort/downloads vs source | PARTIAL | LOW | Exports build from same RPCs/rendered set; values not cross-checked live | Consistent by construction | Live value spot-check | 1–4h |
| 40 | Vault/Checklists/App Launcher perms/access/completion/audit | PARTIAL | LOW | Checklist completion tested; documents via service-role fetch (good); audit append-only | Mostly solid | Live perm smoke | 1–4h |

### Data quality and failure handling

| # | Requirement | Result | Sev | Evidence / How tested | Customer impact | Fix | Effort |
|---|---|---|---|---|---|---|---|
| 41 | Forms validate required/format/range/invalid | PARTIAL | MED | driver-forms parity tests exist; roster validation thin (see #22) | Uneven validation | Strengthen form validation | 1d |
| 42 | Slow requests: loading states + no double-submit | PASS | — | ~186 disabled/aria-busy sites; skeletons throughout (inspection) | Good | Keep | — |
| 43 | Empty states for every list/table/report/search | PASS | — | ~150 empty renderers, purpose-built per stage | Good | Keep | — |
| 44 | Actionable error messages | PARTIAL | MED | Toasts + recovery, but raw `error.message` + "check the console" + migration NNNN | Confusing on failure | Copy pass on errors | 1d |
| 45 | Slow/disconnect/timeout/refresh/retry | PARTIAL | MED | SW cache + queue self-heal; solver/gcal/AI use bare fetch, no timeout | Some paths hang on outage | Add fetchWithTimeout everywhere | 1d |
| 46 | Protect unsaved work (autosave/draft/warning) | PARTIAL | MED | Composer drafts + some discard confirms; **no global beforeunload guard** | Mid-edit tab close loses input | Add unsaved-changes guard | 1d |
| 47 | Confirm successful actions | PASS | — | Toasts throughout | Good | Keep | — |
| 48 | Confirm/recovery for destructive actions | PASS | — | ~130 specific `confirm()` dialogs + snapshot-revert | Good | Keep | — |
| 49 | Imports: dup/bad columns/invalid/partial/large | PARTIAL | MED | Per-row inserted/skipped/errored; dedup email-only; large-file behavior unverified | Partial coverage | Test large + malformed imports | 1d |
| 50 | Dashboard/screens/reports/DB/exports consistent | PARTIAL | MED | Exports from same RPCs; cushion rounding bug history (0534); can't cross-check live | Mostly consistent | Live cross-check after migrate | 1d |

### Visual quality, responsiveness, accessibility

| # | Requirement | Result | Sev | Evidence / How tested | Customer impact | Fix | Effort |
|---|---|---|---|---|---|---|---|
| 51 | Styling consistent with Schedule design system | PARTIAL | LOW | design-lint ratchet enforces tokens; 910 raw hex / 3.6k !important remain (ratcheting) | Minor drift | Continue ratchet | longer |
| 52 | Consistent spacing/typography/alignment/cards/hierarchy | PARTIAL | LOW | Design system + KPI contract codified; ongoing drift | Mostly consistent | Continue | longer |
| 53 | Standardize buttons/menus/tabs/filters/labels/tables/forms | PARTIAL | LOW | Mostly standardized; residual inline styles | Minor | Continue | longer |
| 54 | Test pages at desktop/Chromebook/tablet/phone | UNVERIFIED | MED | No responsive regression pass; visual baselines desktop-only | Unknown on small screens | Responsive pass | 2–3d |
| 55 | Zoom 80–200% clipping/overlap | UNVERIFIED | LOW | No evidence | Unknown | Zoom pass | 1d |
| 56 | Keyboard-only workflows + focus indicators | PARTIAL | MED | Modal focus move+restore + skip-link shipped; no full tab-trap cycle | Partial keyboard support | Complete focus trap | 1d |
| 57 | Color contrast + not color-alone | PARTIAL | MED | a11y lint axes added; contrast not fully audited | Possible contrast fails | Contrast audit | 1d |
| 58 | Accessible names/labels/validation/heading structure | PARTIAL | MED | booking/rsvp aria added; role=main/skip-link; not comprehensive | Partial a11y | a11y sweep | 2–3d |
| 59 | Tables: 0/1/hundreds rows/long names/sort/filter/paginate | PARTIAL | MED | No pagination/virtualization; 500-row roster cap; client filter | Degrades at scale | Add paging/virtualization | 2–3d |
| 60 | Modals/dropdowns/tooltips/sticky/scroll/layering | PARTIAL | LOW | Many present; history of z-index/popover fixes; not systematically QA'd | Occasional visual defects | Layering QA pass | 1d |

### Performance, reliability, and operations

| # | Requirement | Result | Sev | Evidence / How tested | Customer impact | Fix | Effort |
|---|---|---|---|---|---|---|---|
| 61 | Measure load/transition/search/save/SmartFill/report/export | UNVERIFIED | MED | No perf metrics; 5.6 MB `live.js`, ~8 MB shell | First load heavy; unmeasured | Instrument + measure | 1d |
| 62 | Test with 100+ drivers, 13 weeks of data | UNVERIFIED | MED | `solver-service/stress_test.py` (110 drivers) exists; **no dashboard/DB load test** | Unknown UI behavior at scale | Load test the dashboard | 2–3d |
| 63 | Slow queries/missing indexes/excessive retrieval | PARTIAL | MED | FK indexes added (0504); `.limit(10000/20000)` fetch-all patterns | Heavy pulls at scale | Add server aggregation/paging | 2–3d |
| 64 | Pagination/virtualization/lazy loading | FAIL | MED | `.range(` = 0 uses; virtualization ~absent | Big lists overwhelm UI | Introduce paging | 2–3d |
| 65 | Repeated requests/N+1/leaks/dup listeners/runaway | PARTIAL | MED | Realtime tenant-filtered; some N+1 fixed; not profiled | Possible waste | Profile hot paths | 1d |
| 66 | Simultaneous edits/stale/race/conflicts | PARTIAL | MED | Per-shift optimistic lock (opt-in); no week-level lock | Two dispatchers interleave | Week-version lock | 1d |
| 67 | Timeouts/retries/idempotency/graceful degradation | PARTIAL | MED | SMS/email queues hardened; solver/gcal/AI/DocAI bare fetch no timeout | Hung upstream stalls isolate | Timeouts on all integrations | 1d |
| 68 | Structured logging/perf monitoring/uptime/alerts | FAIL | HIGH | Passive tables only; no APM; uptime manual/unverified (H-6) | Outages unseen | See H-6 | 1d |
| 69 | Real backup restoration test | FAIL | **BLOCKER** | No backup config / restore evidence (B-2) | Unrecoverable data loss | See B-2 | 2–3d |
| 70 | Health checks/deploy/migrations/feature+release rollback | PARTIAL | HIGH | `/health` exists (uncalled); forward-only migrations, no down-migrations, no staging, edge fns no version pin | Bad deploy hits sole customer instantly | Add rollback runbook + staging | 2–3d |

### Application security

| # | Requirement | Result | Sev | Evidence / How tested | Customer impact | Fix | Effort |
|---|---|---|---|---|---|---|---|
| 71 | Scan repo/config for exposed secrets | PASS | LOW | Repo scan clean (I ran it); `config.js:12` = publishable anon key. Minor: `stress_test.py:35` hardcodes a real-looking solver-token default | No committed secrets | Move token default to env-only | 1–4h |
| 72 | Dependency/vuln/outdated scans | PARTIAL | LOW | `npm audit --omit=dev` = 0; 1 crit + 1 high in dev-only `@capacitor/cli`; no Deno dep scan | Low risk | Bump capacitor CLI; scan Deno deps | 1–4h |
| 73 | SQLi/XSS/CSRF/unsafe upload/redirect/SSRF | PARTIAL | HIGH | No SQLi (RLS/params); XSS discipline good but 1122 innerHTML + CSP `unsafe-inline`; `next=` sanitized; **SSRF link-preview bypassable**; **anon storage INSERT = unsafe upload (B-1)** | Multiple latent vectors | Fix SSRF; tighten CSP; B-1 | 2–3d |
| 74 | Rate limits on login/invite/reset/messaging/upload/expensive | PARTIAL | MED | PIN lockout, AI daily cap, booking captcha; **no SMS/email volume cap**, unthrottled invites, intake unthrottled | Abuse/cost risk | Add per-DSP send caps + throttles | 1d |
| 75 | Auth errors don't reveal account existence | PARTIAL | LOW | Login message generic (good); reset/magic/phone lookup can enumerate | Minor enumeration | Neutral responses everywhere | 1–4h |
| 76 | HTTPS/secure cookies/headers/encryption at rest | PARTIAL | MED | HSTS+CSP+headers enforcing & parity-checked; tokens in localStorage (not cookies); at-rest = Supabase default (unverified) | Solid transport; XSS-reachable token | Confirm at-rest; consider cookie store | 1d |
| 77 | No secrets/PII/messages in logs or errors | PARTIAL | MED | `client_errors` size-clamped + retention; "check the console" + raw error text patterns | Possible leakage in errors | Scrub error/log surfaces | 1d |
| 78 | Privacy/retention/export/deletion/account-closure | PARTIAL | MED | `export_my_dsp_data` + file export; partial retention; **no deletion/closure flow**; wrong sub-processors (H-8) | Incomplete data-lifecycle | Add deletion/closure; fix docs | 1d |
| 79 | Email/notification consent/preference/unsubscribe | PARTIAL | MED | SMS STOP/START durable; operator prefs; email unsubscribe unverified | Partial compliance | Verify email unsubscribe | 1–4h |
| 80 | Security reporting/incident response/breach notify/rotation | FAIL | MED | No incident-response or breach-notification doc found | No plan when it breaks | Write IR + rotation runbook | 1d |

### Onboarding, support, commercial

| # | Requirement | Result | Sev | Evidence / How tested | Customer impact | Fix | Effort |
|---|---|---|---|---|---|---|---|
| 81 | First-run onboarding for a new admin | PASS | — | `view-dashboard.frag:8+` `#rr-firstrun` 4-step wizard tracking real data progress; wired `live.js:662` (verified) | Good self-serve setup | Keep | — |
| 82 | Contextual help for terms/config/complex rules | PARTIAL | MED | Some ⓘ popovers (forecast); Help center fake; OKAMI unexplained | Uneven help | Real help content | 1d |
| 83 | Document core first-week workflows | PARTIAL | MED | `LAUNCH-AUDIT §M` internal only; no customer guide | Admin lacks a guide | Write customer quickstart | 1d |
| 84 | Visible support method + hours/response expectations | FAIL | HIGH | Help "Contact support" is a fake toast; only a plan-upgrade mailto (H-7) | No working support path | See H-7 | 1d |
| 85 | Easy problem reporting w/ page/account/browser/error | PARTIAL | MED | `client_errors` captures some context; no user-facing "report a problem"; feature-request = fake toast | Hard for customer to report | Add report-a-problem widget | 1d |
| 86 | Admin setup guide + validated import templates | PARTIAL | MED | Import exists; templates partial; guide internal | Setup unclear | Publish guide + templates | 1d |
| 87 | Plans/trial/entitlements/pricing/invoicing/cancellation | N/A | — | No billing code by design — customer #1 billed manually (`CUSTOMER-1-READINESS §2.6`); entitlements UI-only | N/A for one manual customer | Server-enforce entitlements before multi-tier | — |
| 88 | Transactional emails: branding/links/sender/reply-to/copy | UNVERIFIED | MED | `send-email` exists; templates not verified live | Unknown email quality | Send + inspect each template | 1d |
| 89 | Notification defaults reviewed | PARTIAL | LOW | Operator prefs + SMS fallback + auto-reply (0511); defaults not noise-audited | Possible over/under-notify | Review defaults | 1–4h |
| 90 | Known limitations/workarounds/escalation/support docs | PARTIAL | MED | `CUSTOMER-1-READINESS §4–5` internal; no customer-facing | Internal only | Customer-facing limitations doc | 1d |

### Final customer rehearsal and release gates

| # | Requirement | Result | Sev | Evidence / How tested | Customer impact | Fix | Effort |
|---|---|---|---|---|---|---|---|
| 91 | Clean-room setup from brand-new org | UNVERIFIED | HIGH | `admin_create_dsp` + first-run support it; not rehearsed/documented | Setup unproven end-to-end | Do + document clean-room run | 1d |
| 92 | Rehearse full demo w/ script + scenario | UNVERIFIED | MED | No demo script; `seed_demo` only | Demo risk | Write + rehearse script | 1d |
| 93 | Measure time-to-first-result, no dev help | UNVERIFIED | MED | First-run claims "~20 min"; not measured | Unknown | Time a real new admin | 1d |
| 94 | Documented browser/Chromebook/tablet/mobile regression | FAIL | MED | Not done; visual regression desktop-only | Cross-device unknown | Run + document regression | 2–3d |
| 95 | Run all unit/integration/e2e/security/DB tests + record | PASS | — | I ran `npm test` → 25/25; CI green on `main`; migration-check + isolation + role-gate SQL + login/booking e2e in CI | Test discipline real | Keep; add SQL-gate tests (H-4) | — |
| 96 | Manual regression of critical workflows after deploy | UNVERIFIED | HIGH | No post-deploy manual regression evidence | Regressions could ship | Run + record regression | 1d |
| 97 | UAT by someone other than the builder | UNVERIFIED | HIGH | No evidence; single-builder project | Blind spots unfound | Independent UAT | 2–3d |
| 98 | Resolve every Blocker/High + retest in deployed env | FAIL | **BLOCKER** | B-1…B-3 + H-1…H-8 open | Gate not met | Fix + retest | longer |
| 99 | Tagged release + prod smoke w/ synthetic only | PARTIAL | MED | Only desktop app is tagged; dashboard/edge/DB "latest on main"; smoke-check is a parse gate | No release provenance | Tag releases + real prod smoke | 1d |
| 100 | Documented go/no-go; no access while blocker/high/unverified-critical remains | FAIL | **BLOCKER** | Not satisfied — this report is the input to that decision | Must gate access | Make the go/no-go call | <1h |

---

## 6. Evidence for every Pass (what was actually proven)

- **#1–3 (scope):** `docs/CUSTOMER-1-READINESS.md` and `docs/LAUNCH-AUDIT-2026-07-08.md`
  define the Amazon-DSP customer, the minimum onboarding path (§M), and the launch
  scope split (§N).
- **#17 (tenant isolation, tables):** `supabase/tests/cross_tenant_isolation_test.sql`
  stands up two tenants and proves read/insert/update/delete isolation as the real
  `authenticated` role; it runs in `migration-check.yml` CI on every migration PR.
  Isolation helpers `private.current_dsp_id()` / `is_staff()` are SECURITY DEFINER with
  empty search_path (`0001_foundation.sql:113,136`).
- **#26 (Smart Fill):** run report `_rrShowSfRunReport` (`live.js:66502`), diagnostics
  report uncovered/skipped/unscheduled seats, and the full run **fails safe** when the
  solver is down without touching the board (`live.js:69324`).
- **#28 (PTO block):** approved-PTO assignment is blocked server-side in
  `staff_assign_violations` (`0500`) and `assign_shift` raises `assign_blocked` unless
  an explicit recorded override is passed, with a client confirm-override on top.
- **#32 (forecast):** I hand-checked the formula against the documented examples
  (`ceil(max(peak, week/days) × (1+pad))`): `72` and `62` both reproduce; the test
  suite asserts the same and passes.
- **#35 (calendar/DST):** `cal-tz.mjs` + `test-cal-tz.mjs` cover spring-forward gaps,
  fall-back ambiguity, no-DST (Phoenix), and southern-hemisphere DST; native booking
  uses an advisory lock + overlap check server-side (`0370`, `0403`).
- **#38 (driver app scope):** every driver surface goes through `driver_*` RPCs
  validated by `driver_validate_token`, scoping to one driver's id/dsp; no manager
  surface is exposed. (The storage exception is B-1, tracked separately.)
- **#42, #43, #47, #48 (UX safety):** ~186 loading/disabled sites, ~150 purpose-built
  empty states, success toasts throughout, and ~130 specific destructive-action
  confirms — all present in source.
- **#71 (secrets):** full-repo scan found no committed private keys; `config.js` ships
  the publishable anon key. `npm audit --omit=dev` = 0 production vulnerabilities.
- **#81 (first-run):** `#rr-firstrun` welcome wizard with a 4-step get-started checklist
  keyed to actual data progress, dismissal persisted to `metadata.first_run_dismissed_at`
  (`view-dashboard.frag:8+`, `live.js:662`).
- **#95 (tests run + recorded):** `npm test` → 25/25 suites pass (run in this audit);
  `eslint .` clean; CI green across all workflows on `main`.

---

## 7. Prioritized remediation plan

**Phase 0 — Close the automatic no-go conditions (do first; ~1 week of focused work).**
1. **B-1 storage:** Replace the three `anon` bucket-wide policies. Use the existing
   correct pattern in the repo (`driver-document-fetch`: service-role fetch behind a
   token ownership check), or scope the policy to the object path's `dsp_id`/`driver_id`
   segment matching the calling driver token. At minimum, immediately drop the anon
   `list`/`INSERT` grants. Then **re-run the isolation test extended to Storage**.
2. **B-2 backups:** Enable Supabase PITR and **perform one real restore** to a scratch
   project. Document the restore steps and time. Do not load customer data until done.
   Step-by-step runbook: **`docs/B2-BACKUP-RESTORE-DRILL.md`**.
3. **B-3 migrations:** Reconcile the live schema against the repo (apply all pending
   MANUAL migrations, confirm via `rr_schema_version()`), bump `_RR_SCHEMA_EXPECTED` to
   the true head, and make the drift banner **global** (not calendar-only). Adopt a
   checklist so no migration ships without a confirmed apply.

**Phase 1 — Clear the Highs (before a normal launch; ~1–2 weeks).**
4. **H-1 MFA:** Add an aal2 requirement to sensitive write policies/RPCs for users who
   have a verified factor.
5. **H-2 RPC authz sweep:** Audit the ~500 SECURITY DEFINER RPCs for an explicit
   `is_staff(current_dsp_id(), <min_role>)` gate; add the missing ones.
6. **H-3 publish gate:** Add a `finalized`/`published` filter to `driver_my_schedule`
   and make Smart-Fill writes land in a draft state until published.
7. **H-4 EDV + gate tests:** Add EDV to the SQL compliance gates and build the first
   **automated tests over the SQL gates** (this is the root-cause fix that stops the
   next rule from drifting).
8. **H-5 license buffer:** Enforce the license-protection window server-side.
9. **H-6 alerting:** Point an uptime monitor at `/health`; wire `client_errors`,
   `rr_cron_health()`, and `push_delivery_failures` to a real alert (email/Slack/PagerDuty).
   Uptime-monitor runbook (the endpoint already ships): **`docs/H6-UPTIME-MONITORING.md`**.
10. **H-7 support:** Make "Contact support" actually reach you; publish a one-page
    customer quickstart.
11. **H-8 legal:** Correct the sub-processor list (add Supabase, remove Airtable/Cal.com).

**Phase 2 — Mediums that matter for a real (not demo) dataset.**
Pagination/virtualization (#59/#64), integration timeouts (#67), duplicate detection
(#22/#33/#37), low-confidence AI review gate (#34), unsaved-work guard (#46), send-rate
caps (#74), SSRF fix + CSP tightening (#73), rollback/staging (#70).

**Phase 3 — Validation gates.**
Clean-room rehearsal (#91), scripted demo (#92), time-to-first-result (#93),
cross-device regression (#94), independent UAT (#97), tagged release + prod smoke (#99),
then the documented go/no-go (#100).

---

## 8. Recommended order for fixing problems

1. **B-1** (stop the PII leak) — highest blast radius, ~1 day.
2. **B-3** (reconcile schema + fix drift banner) — everything else assumes the DB
   matches the code.
3. **B-2** (PITR + tested restore) — before any real data lands.
4. **H-1, H-2** (server-side authz/MFA) — the other half of "isolation."
5. **H-3, H-4, H-5** (schedule/cert correctness at the server) — protects operations.
6. **H-6** (alerting) — so you find the next problem before the customer does.
7. **H-7, H-8** (support + legal) — customer-facing trust.
8. Phase-2 Mediums, then Phase-3 validation, then the go/no-go.

---

## 9. Retest checklist

- [ ] **Storage:** With only the public anon key, attempt to `list` and
  `createSignedUrl` on `driver-documents`/`driver-photos`/`driver-chat-attachments`
  across two tenants → must return **zero** cross-tenant objects. Extend
  `cross_tenant_isolation_test.sql` to cover Storage and keep it in CI.
- [ ] **Backups:** Restore the live project to a scratch instance from PITR; confirm a
  known synthetic row is present; record the elapsed time.
- [ ] **Migrations:** `select rr_schema_version();` on prod equals repo head; the
  drift banner shows on every page when behind; a deliberately-behind test tenant
  triggers it.
- [ ] **MFA:** A user with a verified factor cannot read tenant data via a raw aal1
  API token.
- [ ] **RPC authz:** A `driver`-role app_user cannot call a staff RPC (spot-check 10
  representative SECURITY DEFINER functions).
- [ ] **Publish gate:** A driver's schedule feed returns nothing for an unpublished
  week; publishing reveals it.
- [ ] **EDV/license:** A manual assign, self-pickup, and swap of an uncertified driver
  onto an EDV route is refused server-side; a driver whose license lapses mid-week is
  refused within the buffer window. SQL-gate tests pass in CI.
- [ ] **Alerting:** Kill a cron / force an error → an alert reaches a human.
- [ ] **Support:** "Contact support" opens a working channel; quickstart is reachable.
- [ ] **Legal:** privacy.html/terms.html name Supabase and omit Airtable/Cal.com.
- [ ] **Scale:** With 100+ drivers and 13 weeks of data, roster/attendance/messages
  render without fetching >2k rows per view and stay responsive.
- [ ] **Clean room + UAT:** A brand-new org reaches first meaningful result, driven by
  someone other than the builder, without coaching.

---

## 10. What must happen before Ryan gives a customer access

> **The code-closeable fixes from this audit are now merged and deployed
> (PR #4123).** What remains is operator execution — tracked as a single
> ordered, checkable list in **`docs/LAUNCH-READINESS-CHECKLIST.md`** (which
> carries the correct on-`main` migration numbers, `0560–0567`). The
> non-negotiables below are unchanged.

Non-negotiable, in order:

1. **Fix the storage exposure (B-1)** and prove — with the public key, against two
   tenants — that no driver document, photo, or chat file crosses tenants.
2. **Enable PITR and complete one real restore (B-2).** A backup you've never restored
   is not a backup.
3. **Reconcile the live database to the repo and make schema-drift visible everywhere
   (B-3).** Confirm every pending MANUAL migration is applied.
4. **Enforce authorization on the server, not just the UI (H-1, H-2):** MFA gates the
   API for enrolled users, and staff RPCs check role, not just tenant.
5. **Add a draft/publish gate so drivers never see an unfinished schedule (H-3);
   close the EDV and license-buffer server gaps and put the SQL compliance gates under
   test (H-4, H-5).**
6. **Wire real alerting (H-6)** so an outage pages you, not your customer.
7. **Make support real (H-7)** and **correct the legal documents (H-8).**
8. **Run the validation gates:** clean-room setup, independent UAT, cross-device
   regression, a tagged release with production smoke — then make and **write down** the
   go/no-go decision (#91–#100).

Until at least items 1–7 are done and retested in the deployed environment, the product
meets multiple automatic no-go conditions (cross-tenant data exposure, no proven
backup, a realistic path to schema drift, and core-workflow gaps).

---

**Ryan should not give a customer access yet because:** driver government-ID images are
exposed across tenants through the storage layer (B-1); there is no proven backup or
tested restore (B-2); the hand-applied migration process has already skipped migrations
in production and the drift detector is 30 versions stale (B-3); MFA and much of the
API authorization are enforced only in the interface, not the server (H-1, H-2);
schedules go live to drivers with no publish gate and a certification rule is missing
from the server (H-3, H-4); nothing alerts a human when any of this breaks (H-6); and
the in-app support channel is non-functional (H-7). The operational core is genuinely
strong and much of this is fixable in roughly two to three focused weeks — but as it
stands today, the answer is no.
