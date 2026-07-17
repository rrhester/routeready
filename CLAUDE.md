# RouteReady — Claude operating notes

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
- **Wave E — dashboard correctness**: PR#9,10,11,12,14,15,16(start),
  17,18,19,20.
- **Wave F — perf**: PR#21,23,24,28,29,30,31,32.
- **Wave G — driver app**: PR#33–44.
- **Wave H — a11y/UX**: PR#89–96 (check #91 vs merged #3955 first).
- **Wave I — docs/DX**: PR#97–100.
- **Wave J — testing depth**: PR#82,83,86.

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
