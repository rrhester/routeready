# RouteReady — Claude operating notes

## DONE: Calendar 100-list (Onboarding → Calendar improvements)

A 100-item improvement list for the interview calendar
(`dashboard/live.js` `_ivcal*` family, `dashboard/booking.html`,
`dashboard/rsvp.html`) — COMPLETE as of 2026-07-17, shipped across PRs
#3932–#3941 in 11 waves. Item #42 (hover peek card) deliberately skipped
(hover preview was removed earlier at the operator's request).

Migrations **0492–0499 APPLIED by the user 2026-07-17** (after two paste
gotchas, both fixed: 0496 originally assumed 0432's `last_pulled_at`
column — their DB skipped 0432, 0496 now re-asserts it; and large
migrations must be pasted as ONE block or `$$` bodies split). Post-
migration driver pass green (banner suppressed at v498, migrated RPC
shapes render). Notes that remain true:
- Edge fns to (re)deploy as wanted: `google-calendar-sync`,
  `google-calendar-events`, `send-staff-push` (changed); `microsoft-*`
  (4, need MS_CLIENT_ID/MS_CLIENT_SECRET/MS_OAUTH_REDIRECT_URI),
  `booking-captcha` (needs TURNSTILE_SECRET_KEY + `turnstile_site_key`
  in private.integration_settings), `google-calendar-reconcile` (new).
- Their DB never applied 0432 (gcal two-way pull) — pull cron inactive,
  "pulled Xm ago" stays blank until they do.

New extracted modules with test suites in `npm test`: `cal-tz.mjs`
(DST math — fixed a real single-pass offset bug), `ivcal-layout.js`
(overlap columns), plus property tests in `test-ivcal-slots.mjs` and a
Playwright booking e2e (`tests/booking-e2e/`, own workflow). The
calendar shows a schema-version banner (`calendar_schema_version()`,
expects 498) until migrations are applied.

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
