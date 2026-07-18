# RouteReady — Claude operating notes

## Active task: Staffing model — XL-route demand (branch claude/staffing-driver-requirements-1tw30l)

Operator's staffing model (2026-07-18): standard route = 2 drivers ×
(1 + DSP cushion); **XL route = 4 drivers × (1 + cushion) = 2 XL-certified
+ 2 helpers** (helpers need no cert; every XL route needs a helper
scheduled). On a dispatch day an XL route runs 2 people on the road, one
of whom is XL-certified (it's `xl_certified`, NOT DOT — the operator
misspoke on DOT). Pad stays DSP-configurable (default 10%, no change).

**SHIPPED — demand math is now XL-aware:**
- `forecast-core.js`: new `driversNeededMix({standard, xl}, opts)` →
  `{total, xlCertified, xlHelpers, ...}`. Standard routes cost
  `driversPerRoute` (2), XL routes cost `XL_DRIVERS_PER_ROUTE` (4) of which
  `XL_CERTIFIED_PER_ROUTE` (2) must be certified. `total` is byte-identical
  to the old `driversNeeded()` when xl==0 (no change for non-XL DSPs).
  `assessPlan` threads a per-week `routesMix` through `demandOverride` so
  the Risk-forecast sandbox keeps XL at 4/route. Tests in
  test-labor-forecast.mjs (32 pass).
- `live.js` (renderOkamiLive + `_okamiRecomputeFromCache`): builds a
  per-day XL route map (`xlByDate`, `service_type_code === "XL"`), picks the
  peak **demand** day (std×2 + xl×4, not peak routes) via `_rrOkamiWeekMix`,
  computes Needed via `rrDriversNeededMix`. modelWeeks now carry
  `routesMix` / `xlCertifiedNeeded` / `xlRoutes`; Needed tooltip shows the
  XL breakdown. Untagged routes fall through as standard (SP default).
- Applicants-needed (gap ÷ conversion) and the termination-trend attrition
  already existed and now consume the XL-aware gap automatically.

**DEFERRED (needs solver/browser QA — do NOT blind-ship):** the DISPATCH-
side enforcement. Today `r004_certification.ts` / `eligibility.py` /
`scheduling-engine.js` require `xl_certified` for EVERY driver on an XL
shift — the operator's model wants only 1 of the 2 certified + 1 helper
(uncertified), and a helper auto-scheduled per dispatched XL route. That's
a real solver-eligibility change (cardinality "≥1 certified per XL route"
+ helper seat) needing test coverage on the CP-SAT model. Also the
availability-popover demand (live.js ~64921) is still a flat ×2 (no per-
type split in that path). Neither is in this change.

## DONE: Calendar 100-list (Onboarding → Calendar improvements)

A 100-item improvement list for the interview calendar
(`dashboard/live.js` `_ivcal*` family, `dashboard/booking.html`,
`dashboard/rsvp.html`) — COMPLETE (100/100) as of 2026-07-17, shipped
across PRs #3932–#3941 in 11 waves. Item #42 (hover peek card) was
initially skipped (hover preview was removed earlier at the operator's
request) then built on their say-so as a strict OPT-IN — Settings →
"Event hover preview", default OFF (`rr_ivcal_hoverpeek`).

Migrations **0492–0499 APPLIED by the user 2026-07-17** (after two paste
gotchas, both fixed: 0496 originally assumed 0432's `last_pulled_at`
column — their DB skipped 0432, 0496 now re-asserts it; and large
migrations must be pasted as ONE block or `$$` bodies split). Post-
migration driver pass green (banner suppressed at v498, migrated RPC
shapes render). Notes that remain true:
- Edge functions AUTO-DEPLOY: the "Deploy Supabase" workflow
  (deploy-migrations.yml) pushes supabase/** to the live project on every
  main merge — every run 2026-07-17 succeeded, so all changed/new
  calendar functions are live. Its DB step no-ops (SUPABASE_DB_URL secret
  unset) — migrations stay MANUAL, which is why the operator applies SQL
  by hand. Only runtime SECRETS are manual: MS_CLIENT_ID/MS_CLIENT_SECRET/
  MS_OAUTH_REDIRECT_URI (Outlook), TURNSTILE_SECRET_KEY +
  `turnstile_site_key` row (CAPTCHA).
- Their DB never applied 0432 (gcal two-way pull) — pull cron inactive,
  "pulled Xm ago" stays blank until they run it (SQL pasted in chat
  2026-07-17; it is the LATEST revision of fire_gcal_sync, safe late).

New extracted modules with test suites in `npm test`: `cal-tz.mjs`
(DST math — fixed a real single-pass offset bug), `ivcal-layout.js`
(overlap columns), plus property tests in `test-ivcal-slots.mjs` and a
Playwright booking e2e (`tests/booking-e2e/`, own workflow). The
calendar shows a schema-version banner (`calendar_schema_version()`,
expects 498) until migrations are applied.

## Active task: Project-review 100-list (PR#1–PR#100)

STATUS 2026-07-17: all 10 waves A–J shipped one batch each and MERGED
(PRs #3964,3966,3968,3970,3973,3975,3976,3979,3980,3982 + workflow minis
#3965,3967,3969,3983). ~75/100 items shipped; ~25 DEFERRED with explicit
reasons. Migrations 0504+0505 pasted in chat + APPLIED by user.

**Wave K — 2026-07-18: deferred-item cleanup pass (MERGED):**
- **PR#41** rem type scale (#3988) — app font-size tokens px→rem.
- **PR#83** parallel test runner (#3990) — `npm test` → scripts/run-tests.mjs
  (globs test-*.mjs, runs concurrent, per-suite PASS/FAIL, no `&&`-chain
  masking). Low-risk form of the node:test migration.
- **PR#28** sw.js changelog trim (#3993) — dashboard/sw.js 103,887→5,589 B
  (dropped the 200+ entry deploy-nonce changelog served no-cache every nav;
  kept RECOVERY-MODE doc + all handlers byte-exact).
- **PR#93+#94** design/a11y ratchet extension (#3994 + workflow paths #3995)
  — design-lint.mjs now scans dashboard/live.js + public/shell HTML (not
  just 6 CSS + app.js); added a11y axes positiveTabindex(0) + imgNoAlt(0,
  fixed the QR-print img); comment/inline-block-comment stripping kills
  false positives; baseline rawHex 2393/important 3962/rawFontSize 883/
  inlineStyle 3850. NEW: a live.js/HTML PR that adds a raw hex/!important/
  inline style/positive tabindex/alt-less img now FAILS the ratchet — use a
  token/alt or `design-lint.mjs --update` with justification.
- **PR#31 (partial)** netlify.toml cache comment (#3996) — corrected the
  stale "~17k lines of CSS inlined" claim (CSS is external+?v= now). Shell-
  shrink main work still deferred.
- **PR#19 (partial)** checklist test de-drift (#3998) — extracted the
  completion rule to dashboard/checklist-core.mjs; live.js + test-checklist-
  completion.mjs both call it (no more hand-mirrored copy). Forecast/sim
  extraction (live.js:3661–4900) still deferred.

**STILL DEFERRED after Wave K — each needs something this headless env
can't provide (browser QA on the live monolith / a device / tooling / the
operator's design eye). NOT low-value; do NOT blind-ship on the production
dashboard:**
- Live.js/app.js monolith refactors needing browser QA: **PR#12** goto
  dispatcher, **PR#16** mock-wiring retirement, **PR#17** notebooks.frag→
  module, **PR#18** typeof-guard sweep (560 sites), **PR#19** forecast/sim
  extraction, **PR#21** lazy-load per-view (workbook/reports), **PR#23** CSS
  dedupe + unused-selector coverage pass, **PR#35** driver rpc() wrapper
  (125 sites), **PR#42** app.js split, **PR#43** offline attachments.
- Design judgment on external pages: **PR#96** public token unify — NOTE
  booking.html's palette (#202124/#5F6368/#DADCE0 + "Google Sans") is an
  INTENTIONAL Google-Calendar look, not accidental drift; unifying it to the
  dashboard neutral would change an external candidate-facing aesthetic.
- Native device test: **PR#39** Capacitor haptics/badge bridge.
- Flaky-baseline risk: **PR#86** broaden visual regression.
- Blocked by tooling (absent in this env): **PR#32** PNG quantization
  (no pngquant/oxipng/optipng/sharp).
- Convention-only (no code): **PR#20** window.RR namespace.

Per-wave A–J detail below.

Working through ALL 100 items of `docs/project-review-2026-07.md`
(whole-project review, items referenced as `PR#NN`), user said
"do all of them" (2026-07-17). Shipping in themed waves on branch
`claude/project-review-recommendations-w9lhkj` (reset from main per
chunk). Wave plan and status:

- **Wave A — CI/workflows + repo hygiene**: PR#64,68,69,71,72,73,77,78,
  79,80,81,84,85,87,88 — DONE pending CI/merge. Notable: deploy-list
  drift gate + 11 missing fns added to deploy loops; edge-fn deno-check
  workflow; flex-capacity CI (+ deleted dead dashboard/flex-capacity.js
  bundle + browser-entry.ts); solver pytest + sealing tsc gate deploys;
  lockfiles committed (.gitignore no longer ignores package-lock.json);
  ESLint no-undef gate (eslint.config.mjs — new cross-file globals must
  be added to SHARED_APP_GLOBALS); lint found + fixed 3 real bugs:
  weather_snapshots never wrote (undefined `today`), Add-applicant
  button no-op (openAddApplicantModal not window-exported), New-DM
  driver pick no-op (_ddMessageDriver not window-exported); deleted
  ~300 dead lines (recruiting footer/chooser cluster + LEGACY sched
  renderer) — kept _rrFitRulesPopover/_rrRightChromeEdge/
  _rrInstallRulesPopoverStyle which the live popovers still use.
- **Wave B — security quick wins**: PR#1,2,3,4,6,7,8,13,22,26,27 — DONE
  pending CI/merge. Enforcing CSP shipped in BOTH _headers+netlify.toml
  (identical values; scripts/check-headers-parity.mjs now part of
  `npm run smoke`); supabase-js vendored at
  dashboard/vendor/supabase-js-2.45.4.mjs (all 9 CDN import sites
  rewritten; rewritten pages use absolute /dashboard/... paths);
  immutable caching for tokened assets (NOT /app/*.js — SW-managed;
  NOT config.js/desktop-connect.js — untokened refs); login next=
  sanitized + __rrApplySession one-shot; postMessage origin checks x5 +
  booking beacon targets referrer origin; _rrNtSanitize scheme
  allowlist; verify.html checkRow escapes by default ({html} opt-in);
  dtok moved to URL #fragment (app.js generators + meet.js reader w/
  legacy ?dtok fallback + address-bar scrub) — SHELL_CACHE bumped v185;
  header-bg.png deleted, Icon.png replaced by icons/icon-192/favicon-32/
  apple-touch-icon everywhere incl. app precache; Google Fonts removed
  from index/download/installed/coaching (local Inter var); terms+
  privacy share /marketing.css?v= (was 2x ~51KB inline dup). PR#5
  (localStorage tokens): compensating controls = CSP + vendoring; a
  cookie-storage adapter deemed too risky for now. NOTE: PRs touching
  .github/workflows/** from this tooling get NO Actions runs — ship
  workflow changes in separate tiny PRs (like #3965) so code PRs keep
  full CI.
- **Wave C — edge functions**: PR#57–67 — DONE pending CI/merge.
  _shared/http.ts (corsHeaders/timingSafeEqual/fetchWithTimeout/safeJson)
  + http_test.ts (5 deno tests, run offline). webhook-apply: secret
  timing-safe if set, per-phone 24h dedupe, per-DSP hourly autosend cap.
  send-sms/send-email: fetchWithTimeout + safeJson + requeue-on-network-
  fail (stuck-'sending' fix); send-sms reads sms_optouts w/ legacy-scan
  fallback; webhook-twilio writes sms_optouts on STOP, clears on
  START/UNSTOP/YES. push-fanout: timeouts + 1 retry + failures →
  push_delivery_failures. webhook-cal: idempotency claim via
  cal_webhook_events upsert (sends anyway if table missing).
  Timing-safe compares: twilio/cal/svix x2/bearer/x-rr-sync-token x5
  (empty env token now REJECTS)/solver hmac.compare_digest/sealing
  worker. cal-availability: real statuses (404/405/502) + timeout;
  live.js reads fn error bodies via _rrFnErrBody(error.context).
  health/driver-document-fetch/box-ingest: stable error codes, detail
  to logs. analytics-ai+notebook-ai: ai_proxy_note_request daily cap
  (200) + analytics-ai conversation capped 12 turns, text-blocks-only
  (client can no longer forge tool_results). upload-applicant-video:
  max 3 uploads/applicant + metadata.video_path stored for re-signing.
  deno.json import map (14 files swept to bare specifier). NEEDS
  MIGRATION 0502 (Wave D): sms_optouts, cal_webhook_events,
  push_delivery_failures, stuck-'sending' requeue cron — all coded with
  graceful fallbacks until then. Workflow tweaks shipped separately:
  #3965, #3967.
- **Wave D — DB migrations**: PR#45–56 (+#25 RPC) — DONE pending
  CI/merge. Shipped as 0504_reliability_and_hardening.sql (renumbered
  from 0502 after other sessions took 0502/0503 — the new ordinal gate
  caught it) + 0505_gcal_two_way_reassert.sql (0432 content verbatim).
  0504: sms_optouts, cal_webhook_events, push_delivery_failures,
  sending_at stamp triggers + requeue-stuck-sends cron (+one-time legacy
  requeue), cal_event_reminders RLS, client_errors bind/clamp/retention,
  public.ai_proxy_note_request wrapper (private.* was NEVER PostgREST-
  callable — the AI cap silently never enforced!), private.rr_migrations
  ledger (UNIFIED with apply-migrations.sh's) + rr_schema_version() +
  rr_cron_health(), roster_attendance_counts RPC + index, 5 FK indexes,
  initplan policy rewrites (shifts/cal_events/driver_messages).
  apply-migrations.sh: ledger → private schema (migrates+drops public
  one), BASELINE 0373→0503, 0432 note. live.js banner generalized to
  rr_schema_version (expect 504; legacy calendar fallback kept).
  seeds/seed_demo.sql. PR#53 pivoted: the from-scratch run showed
  Supabase DEFAULT PRIVILEGES make every public function anon-executable
  (~500 staff RPCs, in-body gates only), so the frozen-allowlist test was
  unmaintainable — replaced with 0504's
  `alter default privileges in schema public revoke execute on functions
  from anon;` → NEW anon-facing RPCs (driver app/public pages) MUST now
  add an explicit `grant execute ... to anon;` in their migration or
  anon calls 401. migration-check additions merged via #3969 (its anon
  test step self-skips; pg_dump artifact step currently produces nothing
  — client/server version mismatch, fix queued). REMEMBER: paste
  0504+0505 SQL in chat for the user.
- **Wave E — dashboard correctness**: batch 1 DONE (PR#9,10,11,14,15) —
  fmtIsoDate now LOCAL not UTC (the "today = tomorrow after 7pm" bug),
  extracted to tested dashboard/rr-dates.mjs (fmtIsoDate/startOfWeek/
  addDays/isoWeek + scripts/test-rr-dates.mjs, 11 tests); isoWeekNumber
  deduped into isoWeek; startOfWeekMonday renamed (24 sites); _rrSwallow
  telemetry helper + rpcOrToast wrapper added (+ mark_applicant_email_sent
  converted as the pattern example); _rrTextToHtml esc now covers "/'
  (was an href attribute-breakout hazard) + target/rel added;
  view-notebooks.frag esc now covers '. rr-dates.mjs added to npm test,
  bust-cache implicitly (live.js ref), immutable headers both hosts.
  DEFERRED (need browser-verified standalone PRs — too risky to sweep
  blind on 92k-line live.js): PR#12 goto dispatcher (7 wrappers), PR#16
  mock-wiring retirement, PR#17 notebooks.frag→module, PR#18 typeof
  sweep (560 sites), PR#19 forecast extraction. PR#20 (RR namespace) =
  convention note only.
- **Wave F — perf**: batch 1 DONE (PR#24,25,29,30) — rr-dashboard
  realtime channel now filters every one of its 16 tables by
  dsp_id=eq.<tenant> (all verified to have dsp_id not null; other tenants'
  row-changes no longer trigger full repaints); loadDriversRoster uses
  roster_attendance_counts RPC (0504) with raw-fetch fallback pre-0504
  (was up to 20,000 shift rows every 30s); refreshActiveView early-returns
  on document.hidden; openCoachingPrintView scopes coaching_edits/
  attachments to the driver's coaching ids (was tenant-wide, no limit).
  DEFERRED (risky/big — own PRs): PR#21 lazy-load workbook/reports, PR#23
  CSS dedupe (cascade-order risk), PR#31 shell shrink, PR#32 PNG
  quantization (needs pngquant), PR#28 sw changelog (low value on the
  recovery SW).
- **Wave G — driver app**: batch 1 DONE (PR#33,34,36,38,40) — SW shell
  fetch races a 3.5s timeout then serves cached shell (stalled-cell
  launches); pushsubscriptionchange handler re-subscribes + re-registers
  (SW holds url/anon/token in IDB; added urlBase64ToUint8Array + VAPID
  fetch fallback); 4 schedule pollers skip while document.hidden;
  reg.update() + ensurePushSubscription re-assert on refreshOnFocus (iOS
  PWAs resume without 'load'); controllerchange → one-time reload (skips
  if a sheet/modal/dirty-form open); capacitor.config white chrome +
  StatusBar(DARK)/SplashScreen config, dropped dead bundledWebRuntime.
  SHELL_CACHE v185→v186. DEFERRED: PR#35 (125-site rpc() wrapper — too
  many to sweep safely), PR#39 (Capacitor haptics/badge bridge — needs
  native test), PR#41 (rem type scale — touches 141 font-sizes), PR#42
  (app.js split + lazy scanner), PR#43 (offline attachments). PR#44
  (redesign tickets) → Wave I docs.
- **Wave H — a11y/UX**: batch 1 DONE (PR#89,90,91,92,95) — modal
  openModal/closeModal now move focus into the dialog on open + restore
  to the trigger on close + set role/aria-modal (~30 dialogs); toast-stack
  gets role=status/aria-live=polite; booking.html intake questions +
  verify field get for/id + aria-required (rsvp already done in #3955);
  skip-link + role=main/id=main-content on the shell; deleted the lone
  prefers-color-scheme:dark block (one mismatched dark modal on a light
  app). DEFERRED: PR#89 full Tab-trap (focus MOVE+restore shipped, not a
  cycle trap), PR#93 ratchet→live.js/public inline CSS, PR#94 linter a11y
  axes, PR#96 public token unify, aria-current on nav (needs nav-switch
  JS).
- **Wave I — docs/DX**: DONE (PR#44,97,98,99,100) — top-level README.md
  (dir map + deploy table + conventions); scripts/gen-secrets-inventory.mjs
  scrapes Deno.env.get per function → supabase/SECRETS-INVENTORY.md (42 fns,
  60 vars; SECRETS.md's stale "all five edge functions" line fixed +
  pointer added); docs/LOCAL-DEV.md (stub-boot recipe promoted out of the
  verify skill) + docs/DEPLOY.md (workflow→surface map, manual steps, CI
  gates); CONTRIBUTING.md + .github/pull_request_template.md; PR#44 redesign
  backlog → docs/DRIVER-APP-REDESIGN-BACKLOG.md (keep/drop per item).
- **Wave J — testing depth**: batch 1 DONE (PR#82 login e2e) —
  tests/login-e2e/ Playwright suite (3 tests) against stubbed Supabase:
  guards the Wave B ?next= open-redirect fix (cross-origin next dropped to
  same-origin fallback), same-origin next honored, and the mode machine.
  login.html imports the vendored supabase-js (same-origin) so no CDN
  bundle needed. Workflow login-e2e.yml shipped separately. DEFERRED:
  PR#83 (23-script node:test migration — big mechanical diff, own PR),
  PR#86 (broaden visual regression — flaky-baseline risk, own PR).

Notes: other sessions merge to main concurrently — re-verify each item
against HEAD before implementing; rebase before each PR. Decision items
resolve minimally (PR#95: delete stray dark block; PR#44: ticket list in
docs/). Update this tracker every wave.

## DONE: Messages 100-list (message-tool improvements)

A 100-item improvement list for the Messages tool (`dashboard/live.js`
`_mc*`/`_cc*` families, `dashboard/msg-core.mjs`, `view-messages.frag`)
— COMPLETE (100/100) as of 2026-07-17, shipped on PR #3963 in 10 themed
batches (one commit each), branch `claude/message-tool-improvements-nzuo5s`.
Pure logic lives in `msg-core.mjs` (tested via `scripts/test-msg-core.mjs`
in `npm test`). New edge functions: `link-preview` (unfurls, SSRF-
constrained); `notebook-ai` gained translate/chat_suggest_replies/
chat_summarize/chat_tone actions. Migrations **0506–0511** (renumbered
twice after parallel sessions took 0503–0505): templates, replies/reactions/pins/edit-history,
thread prefs, channel upgrades (announcement-only/acks/polls/recurrence),
notifications (operator prefs/SMS fallback/auto-reply), admin (retention/
legal hold/audit/SMS bridge/email transcript/webhooks). Everything
degrades gracefully pre-migration (local fallback or "needs migration
NNNN" toast). #52 verified pre-existing (0475 delivery pills).

Hotfix PR #3974 (2026-07-18, merged 89371ec): (1) composer was hidden —
the injected extras CSS set .rr-mc-shell{position:relative}, overriding
the base position:absolute;inset:0 and collapsing the pane; NEVER re-add
that rule (comment at the site). (2) The user's live DB also skipped
0484 (scheduled_messages) — 0509 now re-asserts 0484's table/RPCs/cron
+ 0481's mentions table, so it applies on their DB. (3) Renumbered
#3962's duplicate 0503_swap_offer_dispatcher_visibility → 0512 (ordinal
gate blocked ALL PRs; also apply-migrations.sh BASELINE=0503 would have
adopted-not-run it). User still needs to paste 0509 (corrected), 0510,
0511 — and 0512 if they never ran the old 0503 swap-offer SQL.

## DONE: Targets 50-list (Schedule → Targets page)

`docs/targets-page-improvements-2026-07.md` (items `TG#NN`) — **49/50
COMPLETE** 2026-07-18, user said "do all of them except for number 11"
(TG#11 = daily drill-down for all 13 weeks — deliberately NOT built;
keep the drill-down window at 4 weeks unless they ask again). Shipped
in 7 batches on `claude/page-improvement-ideas-8t4c1m`. Key facts that
stay true:
- The 13-week table's rows are now GENERATED (`_rrOkamiEnsureRows`,
  live.js) — view-okami.frag ships only a skeleton. The 8-column
  positional DOM contract + `tr:not(.okami-detail)` order + weeks 0–3
  drill-down ids are preserved for all consumers (sim annotations,
  Plan-Pad recompute, mock pipeline, DOM-fallback readers).
- All plan edits flow through `_rrOkamiApplyWrites` (bucket writes with
  prevs → one-op Undo). `saveOkamiWeek` is gone.
- Available is a per-week projection (active_drivers_for_horizon −
  onboarding-not-ready); forecast-core consumers must be fed `availRaw`
  (payroll − time-off), NOT the table's route-ready `avail`, or
  onboarding gets double-deducted (assessPlan handles readiness).
- **Migration 0513** (okami_demand audit trigger + okami_demand_audit
  RPC) — pasted in chat 2026-07-18, graceful until applied. (Was 0512
  in-branch; renumbered after #3974's concurrent 0503→0512 swap-offer
  rename took that ordinal.)
- Hire lead time now per-DSP: `metadata.staffing.hire_lead_days`
  (default 28, ⓘ popover on the Drivers-needed header edits it).
- **Calm pass 2026-07-18** ("page is getting too busy"): the Forecast-gap
  card MOVED from the KPI strip into `.rr-tgt-13w-actions` (it overlapped
  Adjust…/Snapshots… at laptop widths — don't move it back); Seed/
  Snapshots/CSV/Print live in a `⋯` menu (`#rr-tgt-more-menu`, button ids
  unchanged); trend chart collapses (`rr_tgt_trend_collapsed`); per-row
  spark bars are row-hover-only; `_paOpenPopover` measures its anchor
  BEFORE closing the open popover (fixes Edit-history pinning to 8,6).

## Active task: Workbook 100-list (Excel-parity improvements)

Working through a 100-item list of Workbook (`dashboard/workbook.js`)
improvements in themed batches, referenced as `#NN`. Progress (2026-07-17):

- **Chunk A — MERGED (PR #3914)**: Batches 1–7, items #1–9, #12, #13–17,
  #18(existing), #19–32, #33–50, #93, #95–97, #100. Migrations 0489, 0490.
- **0492**: hotfix for 0489 (`is_staff` needs `::public.app_role` cast).
- **Chunk B — MERGED (PR #3922, 2026-07-17)**, was branch
  `claude/excel-notebook-improvements-fzm3lj`:
  Batch 8 (#10, #11 live RR.* + IMPORTWB), Batch 9 (#51,52,54,55,56 pivots).
  Follow-on work continues in other sessions (e.g. #3944 completed #86).
  Still TODO: Batch 10 charts (#57–64), Batch 11 import/export/print
  (#65–71), Batch 12 collab+history (#72–81, needs a migration), Batch 13
  automation+AI (#82–89), Batch 14 perf (#90–92), Batch 15 hardening/tests/
  a11y (#94, #98, #99). #31, #53, #58(partial), #63 verified already present.

Workflow per batch: edit → `npm test` (all green) → commit → push → the
batch rides the open chunk PR; merge the chunk when a natural breakpoint
hits and CI is green, then `git checkout -B <branch> origin/main` for the
next chunk. Any new migration: paste full SQL in chat. NOTE: workbook.js
historically carried one intentional raw NUL byte (a QUERY group-key
separator) — it's now a `\0` escape; keep it that way (don't reintroduce
raw NULs; `grep` treats the file as binary if you do).

## Shipping changes

The user has authorized me to ship my own work in this repo end-to-end,
without pausing for confirmation — push **and merge** automatically
(reaffirmed 2026-05-13). Once I've committed a unit of work, I should:

1. Push the working branch to `origin` (`git push -u origin <branch>`).
2. Open a pull request against `main` — I don't need to be asked first.
3. Wait for required CI to pass — never merge red.
4. Squash-merge it (the repo convention) — don't wait for the user.
5. Report the merge + the deploy outcome.

This is durable across sessions. It does **not** extend to:

- Force-pushing to `main`, `git reset --hard`, or other destructive git
  operations — those still need an explicit ask.
- Merging PRs I didn't open / don't have full context on.
- Bypassing branch protection or skipping required reviews — if CI is red
  or a required review is missing, leave it open and report why.
- Creating commits I wasn't asked to make — committing still follows the
  normal rule (commit when the task is clearly to make and ship a change,
  or when explicitly asked).

For auth-critical or otherwise high-blast-radius changes I can't fully
test from here (login flows, DB migrations, edge functions): still ship
them on the same PR, but call them out prominently in the PR body so the
user can review post-merge / coordinate the deploy. Merge once CI is
green like anything else — don't block on verification unless the user
has said otherwise for that specific change.

## Database migrations

The user applies Supabase migrations manually in the SQL Editor (no
Supabase CLI in their loop). **Whenever I add a migration under
`supabase/migrations/`, paste its full SQL contents into chat in a
fenced code block** so the user can copy → Supabase → Run without
hunting for raw GitHub URLs. Keep migrations idempotent (use
`create or replace`, `if not exists`, `drop ... if exists` before
`create trigger`, `do $$ begin ... exception when duplicate_object then
null; end $$` for enums and publications) so re-running a partially
applied migration doesn't fail.

This is durable across sessions (set 2026-05-13).
