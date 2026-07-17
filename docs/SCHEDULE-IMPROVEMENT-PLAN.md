# Schedule Improvement Plan — 100 Recommendations, Prioritized

**Date:** 2026-07-17 · **Scope:** the Schedule surface (Week/Today/Targets/Fleet/Requests),
the Smart Fill engine (`engine/` → `dashboard/scheduling-engine.js`), the CP-SAT solver
service, the schedule data model, and the driver-app schedule experience.

This document has two parts:

1. **The full list** — 100 recommendations, grounded in the code as it exists today
   (file anchors included where they matter).
2. **The prioritized roadmap** — six waves ordered by leverage, each item tagged with
   effort, plus a traceability table mapping all 100 items to a wave or the backlog.

Effort scale: **QW** ≤2 h · **S** ≈1 day · **M** 2–5 days · **L** 1–2 weeks.

> **Migration note.** Items marked 🗄 add or change Supabase migrations. Per the repo
> convention, every new migration's full SQL must be pasted into chat when implemented
> (the operator applies migrations by hand in the SQL Editor), and migrations must be
> idempotent.

---

## Part 1 — The 100 recommendations

### Correctness & data integrity

1. **Enforce compliance on dispatcher writes.** `private.driver_can_take_shift`
   (hour cap, min rest, consecutive days, PTO overlap — `0201_driver_pickup.sql:69`)
   gates only pickup/swap/cover flows; `assign_shift`/`create_shift` rely on
   client-side warnings (`_checkAssignViolations`), so a dispatcher can hand-assign an
   illegal shift. Run the same gate server-side with an explicit override flag.
2. **Add a DB-level double-book guard** — a partial unique index or time-range
   exclusion constraint on `shifts` (respecting the `same_day_multi_shift` setting) so
   double-books are impossible, not just engine-avoided.
3. **Pass the DSP timezone into the engine.** `scheduling_settings.timezone` exists,
   but the engine is timezone-naive UTC (`engine/src/dates.ts`) — min-rest and
   day-boundary math can drift around DST.
4. **Add a TS↔Python eligibility conformance test.** Browser preview
   (`eligibility.ts`) and CP-SAT server (`eligibility.py`) are hand-synced with no
   test; they can silently disagree.
5. **Add the overlap-exclusion constraint on `time_off_requests`** (daterange) so
   overlapping approved requests can't coexist.
6. **Surface same-day double-books as a blocking error, not a diagnostic.** The engine
   can emit them and the write path silently drops the second one — only Smart Fill
   diagnostics (live.js ~57926) mention it.
7. **Add a server-side expiry sweeper** (pg_cron) for offers, swaps, and
   confirmations — today they expire lazily only when a driver polls, so dispatchers
   see stale "pending" rows.
8. **Fix the duplicate `sched-sub-templates` DOM id** in `view-schedule.frag`
   (lines 2144 and 2558).
9. **Extend audit triggers to `time_off_requests`** — shift changes are fully audited
   (`0200_shift_changes_audit.sql`), time-off decisions aren't.
10. **Add one-click Smart Fill undo.** There's per-assign undo but a full rebuild has
    none; snapshot the week per `optimization_run` and add a
    `revert_optimization_run(run_id)`.

### Smart Fill & engine quality

11. **Wire `attendance_score` in the dashboard adapter** — it's always `null`
    (`adapters/dashboard.ts`, mapDriver), so attendance-weighted scheduling and the
    `attendance_priority` method are silently inert on the live path.
12. **Wire `employment_type`** — the adapter hardcodes `"full_time"`, making the
    `full_time_priority` method a no-op.
13. **Implement or hide performance scoring** — `computeScore` hardcodes
    `performance: 0` while a `performance_scheduling` setting exists in the UI.
14. **Deepen the optimizer.** The hill-climb caps at 3 iterations / min-improvement 5;
    offer a "deep optimize" mode or route big weeks to the CP-SAT solver automatically.
15. **Make the lunch deduction configurable** (`LUNCH_HOURS = 0.5` is hardcoded into
    the weekly-cap math).
16. **Honor `pto_default_hours` in the adapter** — it pins PTO at 10 h/day
    (`PTO_HOURS_PER_DAY`) regardless of the setting.
17. **Surface drivers with missing hire dates** — they get a `2999-12-31` sentinel and
    silently sort least-senior under the seniority method.
18. **Show "why this driver" on every chip.** The engine already produces
    per-assignment explanations (step 10); expose them on hover/click.
19. **Add a "why not" explorer for uncovered routes** — list each candidate and the
    exact rule (R002–R022) that blocked them.
20. **Show a diff preview before applying Smart Fill.** What-if mode already runs
    without writing; render side-by-side changes with an apply/cancel step.
21. **Add a fairness panel** — hours/days distribution and variance across drivers per
    week, so `fair_rotation` results are verifiable at a glance.
22. **Batch the Smart Fill write path.** `autoAssignDriversForWeek` writes
    shift-by-shift; a set-based apply (like `apply_optimization_run`) would be faster
    and atomic.
23. **Build a golden-week regression harness** replaying fixed inputs across engine
    versions (you already compute `inputs_hash` for determinism).
24. **Expose solver weights in plain language** — fairness/OT/affinity weights
    (`W_FAIR`, etc. in `cpsat_model.py`) are real knobs with no UI.
25. **Flag affinity cold-start** — when history is thinner than half the window,
    affinity is neutral 0.5; tell the operator patterns aren't driving picks yet.

### Week view UX

26. **Virtualize the week grid** — every row paints for large rosters; windowing would
    keep big fleets smooth.
27. **Add keyboard shortcuts** (←/→ weeks, T for today, F finalize, / to filter) plus
    a shortcut cheat sheet.
28. **Multi-select cells** for bulk assign/unassign/call-off.
29. **Copy day → paste day, and copy week → next week** directly, without the
    Templates detour.
30. **Right-click context menu on chips** — assign van, set route classification,
    call off, message driver.
31. **Live violation badges on chips** (OT risk, rest conflict) as you edit, not just
    in the finalize dialog.
32. **Quick text filter for driver rows** (pinned-only exists; add name/route search).
33. **Deep-linkable state** — encode subview + week offset in the URL hash so a week
    can be bookmarked/shared and back-button works.
34. **Bind Ctrl+Z to the existing undo stack** (`_rrPushUndo`) and show undo depth.
35. **Week-over-week diff view** — "what changed since I finalized."
36. **Per-day header deltas** — scheduled vs target vs cushion as explicit +/- chips
    on each day column.
37. **Per-driver row summaries** — hours vs cap, day count, OT projection inline at
    row end.
38. **Visually mark today's column and weekend boundaries** in the grid.
39. **Drag onto an occupied cell offers a swap** between the two drivers instead of
    blocking.
40. **Ghost preview during drag** showing whether the drop would violate rules before
    release.

### Today view & dispatch

41. **Live attendance overlay** — `driver_checkins` is already in the realtime
    publication; paint green/amber/red per driver as report times pass.
42. **One-click callout workflow** — marking a shift `called_off` should immediately
    surface ranked cover candidates (`cover_shift_candidates` exists) in the same
    dialog.
43. **Grow the auto-rescue banner into a rescue planner** — choose which routes
    collapse and who absorbs them.
44. **"Message all of today's drivers"** bulk action from the Today view.
45. **Countdown chips to wave report times** on today's headers.
46. **No-show auto-escalation** — if no check-in by X minutes past report, prompt a
    cover offer automatically (`optimization_recalc_queue` already detects it; close
    the loop).

### Requests, PTO & availability

47. **Time-of-day availability windows** — availability is only mon–sun booleans
    today (`drivers.metadata.availability`).
48. **Date-specific availability exceptions** ("can't work July 30") separate from
    blanket weekday rules.
49. **Partial-day / hourly time off** — requests are date-range only.
50. **PTO balances and accrual** — `is_pto` is a flag with no hours bank; enforce
    balance at approval time.
51. **Coverage context on the approval card** — "approving leaves Tuesday 2 short"
    with a one-click chained cover offer (`dispatch_time_off_coverage` already
    computes this).
52. **A blackout-dates manager UI** — `availability_blackouts` exists in the schema
    with little surface.
53. **Approval conflict handling** — approving PTO that overlaps assigned shifts
    should auto-unassign and offer cover in one step.
54. **Request SLA aging** — badge requests pending >48 h and nudge the dispatcher.
55. **Driver-visible request timeline** — submitted → seen → decided, so drivers stop
    asking in chat.

### Swaps, offers & open shifts

56. **Replace the mock "Pending swaps" panel with the real queue.** The backend
    (`shift_swap_requests`, audit table, compliance re-check in `0422`) is fully
    built; the dashboard subview (`sched-sub-swaps`, frag line 2105) still shows
    hardcoded fake cards.
57. **Notify the dispatcher on offer/swap responses** — today only drivers get push;
    dispatchers learn by polling.
58. **Driver "drop my shift" request** — release a shift to the open pool with
    dispatcher approval (`vto` status exists but has no flow).
59. **Optional bidding window for open shifts** — award by seniority/rank after N
    hours as an alternative to first-come-first-served pickup.
60. **Broadcast cover offers to several candidates at once,** first-accept-wins (one
    pending offer per shift today).
61. **Offer expiry escalation** — auto-offer the next ranked candidate when one
    expires.
62. **A swap marketplace for drivers** — browse all swappable shifts rather than
    proposing against one specific target.
63. **Pre-check swap compliance before the request is sent** so drivers don't get
    rejected after their counterpart already accepted.

### Templates & recurring schedules

64. **Multi-week rotation templates** (A/B week patterns) — templates are single-week
    snapshots (`0204_schedule_templates.sql`).
65. **Auto-apply a default template to new weeks** with per-week confirmation, so
    recurring schedules build themselves.
66. **Template diff preview before pasting** into a target week.
67. **Replace the `window.prompt` template capture with a proper modal** (name, notes,
    scope).
68. **Template outcome analytics** — which template was applied where and what
    coverage resulted.

### Targets, forecast & intelligence

69. **Wire `flex-capacity.js` into the forecast gap card** — turn "you're short" into
    "hire N by DATE" (the audit's #1 owner-value gap; the engine ships dark).
70. **Unify the four risk vocabularies into one scale** so the schedule intelligence
    reads as one system.
71. **Show labor cost on the week grid** — `schedule_forecast` already computes cost
    and OT; surface per-day/week cost while editing.
72. **Weather-aware cushion suggestions** — `weather_callout_model` exists; suggest
    bumping cushion on high-callout-risk days.
73. **Track forecast accuracy** — predicted vs actual coverage and callouts per week.
74. **An overtime heat map for the week** — `hours_until_ot` per driver exists
    (Overtime Intelligence, `0279`–`0285`); paint it across the grid.
75. **Per-day dynamic cushion** sized by callout risk instead of one flat
    `cushion_pct`.

### Driver experience

76. **Replace the 20-second swap-inbox polling with realtime pushes** on the existing
    `rr-driver-live` channel.
77. **"Add to calendar" / ICS feed** for a driver's shifts.
78. **Pre-shift reminder push** ("your shift starts in 1 hour") — publish/offer events
    push today, reminders don't exist.
79. **Show a "schedule expected by" status** so drivers know when the next week
    typically publishes instead of seeing an empty state.
80. **Highlight what changed since last viewed** after a re-publish.
81. **Read receipts on published schedules** — drivers acknowledge; the dashboard
    shows who hasn't seen it.
82. **Request time off directly from the schedule screen** (tap a day → request off).
83. **A weekly hours/OT tracker widget** in the driver app (hours so far vs cap).

### Publish & finalize

84. **Delta notifications on re-publish** — notify only drivers whose shifts changed,
    instead of one blast at first publish (`0421_publish_notifies_drivers.sql`) and
    silence after edits.
85. **Scheduled auto-publish** (e.g., Fridays 5 pm) gated on a validation checklist.
86. **Make pre-publish validation optionally blocking** — the violations and
    callout-exposure dialogs are advisory-only today.
87. **Day-level locking** — finalize/lock individual days instead of only the whole
    week.
88. **A driver-visible post-publish change log** ("your Friday shift moved to 10:20").

### Multi-dispatcher & concurrency

89. **Presence indicators** — show who else is viewing/editing this week (realtime
    infra already in place).
90. **Live grid repaint from the `shifts` realtime publication** — the table is
    already published (`0446`); subscribing the grid would show co-editors' changes
    without a conflict-triggered refresh.
91. **Extend optimistic concurrency beyond driver reassignment** —
    `p_expected_driver_id` guards only the driver field; time/route/status edits are
    still last-write-wins.

### Performance & architecture

92. **Split the 20-subview mega-hub** — move Roster, Attendance, and Requests to their
    own destinations (product audit #69).
93. **Lazy-load subviews and extract the fragment's inline scripts** — the 247 KB frag
    carries density/color/palette scripts inline.
94. **Shareable per-subview URLs** (pairs with #33) so "look at Targets for next week"
    is a link.
95. **Cache week payloads and delta-refresh** instead of refetching `schedule_grid` on
    every navigation.

### Staff schedule

96. **Bring `staff_shifts` toward parity** — it's bare CRUD with no notifications,
    time-off, swaps, or audit.
97. **Show staff coverage on Today** — which dispatcher/fleet/HR staff are on duty
    alongside the driver plan.

### Reporting, export & print

98. **XLSX export with real formatting** (per-driver tabs, colors) — CSV-only today,
    while the repo ships an in-house spreadsheet engine that could do this.
99. **A payroll-grade hours export** — per driver per day with OT split and PTO hours,
    extending `dispatch_pto_report` beyond day counts.
100. **Print variants** — individual per-driver printable schedules and a
     station-posted daily sheet, alongside the current whole-week grid.

---

## Part 2 — Prioritized roadmap

Ordering principle: **trust before convenience, wiring before building.** Wave 2 makes
it impossible to publish an illegal schedule; Wave 3 turns on features whose backends
already exist (highest value-to-effort in the whole list); the UX and structural waves
come after, when their foundations can be trusted.

### Wave 1 — Quick wins (~2 days total)

Small, independent, zero-risk. Ship as one PR or ride along with other work.

| # | Item | Effort | Notes |
|---|---|---|---|
| 8 | Fix duplicate `sched-sub-templates` id | QW | `view-schedule.frag:2144` vs `:2558` |
| 16 | Honor `pto_default_hours` in adapter | QW | engine rebuild (`cd engine && npm run build:dashboard`) |
| 12 | Wire `employment_type` in adapter | QW | unblocks `full_time_priority`; engine rebuild |
| 13 | Hide (or implement) performance scoring toggle | QW | stop advertising a stub |
| 17 | Surface missing hire dates in Smart Fill diagnostics | QW | sentinel `2999-12-31` today |
| 25 | Cold-start affinity notice in diagnostics | QW | engine already knows `weeksWithData` |
| 34 | Ctrl+Z bound to existing undo stack | S | `_rrPushUndo` already exists |
| 38 | Today-column / weekend styling in week grid | QW | CSS only |
| 67 | Template capture modal (replace `window.prompt`) | S | |

### Wave 2 — Correctness & trust (~2–3 weeks) 🗄

The "never publish an illegal schedule" wave. Mostly migrations + engine work.
Do this before investing in UX: every later feature builds on these guarantees.

| # | Item | Effort | Notes |
|---|---|---|---|
| 1 | Server-side compliance gate on `assign_shift`/`create_shift` | M 🗄 | reuse `driver_can_take_shift`; add override flag + audit the override |
| 2 | DB double-book guard on `shifts` | S 🗄 | dedupe existing data first; respect `same_day_multi_shift` |
| 5 | Overlap-exclusion on `time_off_requests` | S 🗄 | dedupe first (audit #75) |
| 9 | Audit triggers on `time_off_requests` | S 🗄 | same diff-trigger pattern as `0200` |
| 7 | pg_cron expiry sweeper for offers/swaps/confirmations | S 🗄 | pattern exists in `flush_scheduled_messages` (`0484`) |
| 6 | Block same-day double-books at write time | S | client + engine diagnostic → hard error (mostly covered by #2) |
| 10 | Smart Fill run snapshot + `revert_optimization_run` | M 🗄 | audit spine (`0324`) already keys runs |
| 3 | Timezone into the engine | M | engine + adapter + tests; DST edge cases |
| 4 | TS↔Python conformance test in CI | M | golden fixtures both engines must agree on; pairs with #23 later |

### Wave 3 — Wire what's already built (~2 weeks)

Backends exist; only UI/wiring is missing. Best value-to-effort in the plan.

| # | Item | Effort | Notes |
|---|---|---|---|
| 56 | Real swaps queue replacing the mock panel | M | `shift_swap_requests` + `schedule_activity` feed exist |
| 57 | Dispatcher notification on offer/swap responses | S 🗄 | AFTER-UPDATE trigger, mirror of `0425` |
| 11 | Wire `attendance_score` into the adapter | S | attendance data exists (`0065`/`0066`); engine rebuild |
| 51 | Coverage context inline on time-off approval cards | S | `dispatch_time_off_coverage` exists |
| 52 | Blackout-dates manager UI | S | `availability_blackouts` table exists |
| 69 | `flex-capacity.js` → forecast gap card prescription | M | audit item #82; engine ships dark today |
| 71 | Labor cost on the week grid | S | `schedule_forecast` computes it |
| 74 | OT heat map across the week | S | `hours_until_ot` exists |

### Wave 4 — Dispatcher flow acceleration (~3 weeks)

The daily-driver UX for whoever builds and runs the week.

| # | Item | Effort | Notes |
|---|---|---|---|
| 20 | Smart Fill diff preview before apply | M | what-if mode already dry-runs |
| 18 | "Why this driver" chip explanations | M | engine step-10 explanations exist |
| 19 | "Why not" explorer for uncovered routes | M | shares plumbing with #18 |
| 31 | Live violation badges while editing | M | client-side rule evals exist (`_checkAssignViolations`) |
| 42 | One-click callout → ranked cover candidates | M | `cover_shift_candidates` exists |
| 41 | Live attendance overlay on Today | M | `driver_checkins` already in realtime pub |
| 46 | No-show auto-escalation prompt | M | recalc queue already detects |
| 29 | Copy day / copy week | S | |
| 32 | Quick driver text filter | S | |
| 27 | Keyboard shortcuts + cheat sheet | S | |
| 90 | Live grid repaint from `shifts` publication | M | replaces refresh-on-conflict |
| 89 | Presence indicators for co-editing | S | realtime channels exist |

### Wave 5 — Driver trust loop (~2 weeks)

Close the loop with the people receiving the schedule.

| # | Item | Effort | Notes |
|---|---|---|---|
| 84 | Delta notifications on re-publish | M 🗄 | diff against `shift_changes` since last publish |
| 78 | Pre-shift reminder push (cron) | M 🗄 | pg_cron + `send-driver-push` pipeline exists |
| 76 | Realtime swap inbox (drop 20 s polling) | S | `rr-driver-live` channel exists |
| 81 | Schedule read receipts | M 🗄 | |
| 77 | ICS / add-to-calendar | S | |
| 83 | Weekly hours/OT widget in driver app | S | |
| 63 | Pre-check swap compliance before sending | S | `driver_can_take_shift_after_swap` exists |

### Wave 6 — Structural bets (quarter-scale)

Bigger schema/architecture changes. Sequence after the trust waves; each is
independently valuable.

| # | Item | Effort | Notes |
|---|---|---|---|
| 47/48 | Availability windows + date exceptions | L 🗄 | typed table replacing `metadata.availability`; engine R006 update |
| 50 | PTO accrual & balances | L 🗄 | policy + bank + enforcement at approval |
| 64/65 | Multi-week rotations + auto-apply templates | L 🗄 | |
| 59/60 | Open-shift bidding + broadcast offers | M–L 🗄 | policy toggle per DSP |
| 26 | Week-grid virtualization | M | pairs with audit #27 |
| 92/93 | Split the mega-hub + lazy-load subviews | L | audit #69 |
| 33/94 | URL routing / deep links for schedule | M | can precede the app-wide routing effort |
| 14 | Deep-optimize mode / auto-route to CP-SAT | M | solver + threshold heuristics |

### Backlog (sequenced later, not rejected)

Grouped; several small items here should ride along when a wave touches the same code.

- **Engine polish:** 15 (configurable lunch), 21 (fairness panel), 22 (batch write),
  23 (golden-week harness — natural follow-on to #4), 24 (solver weight UI).
- **Grid interactions:** 28 (multi-select), 30 (context menu), 35 (week diff view),
  36/37 (day/row summaries — ride along with #31), 39 (drag-to-swap), 40 (drag ghost
  preview — ride along with #31).
- **Today view:** 43 (rescue planner), 44 (message-all), 45 (wave countdowns — ride
  along with #41).
- **Requests:** 49 (hourly PTO), 53 (approval conflict handling — follow-on to #51),
  54 (SLA aging), 55 (request timeline).
- **Marketplace:** 58 (drop-shift flow), 61 (offer escalation — follow-on to #7),
  62 (swap marketplace).
- **Templates/forecast:** 66 (template diff), 68 (template analytics), 70 (risk
  vocabulary unification — audit #84), 72 (weather cushion), 73 (forecast accuracy),
  75 (dynamic cushion).
- **Driver app:** 79 (expected-publish status), 80 (changed-since-last-view),
  82 (tap-day time-off).
- **Publish:** 85 (auto-publish), 86 (blocking validation), 87 (day-level locks),
  88 (driver change log — follow-on to #84).
- **Concurrency/perf:** 91 (optimistic guard on all fields), 95 (payload caching).
- **Staff:** 96 (staff_shifts parity), 97 (staff on Today).
- **Reporting:** 98 (XLSX export), 99 (payroll hours export), 100 (print variants).

### Dependency spine

- **#2 (double-book guard)** before **#1's** rollout — the constraint catches what the
  RPC gate misses during migration.
- **#4 (conformance test)** before **#14 (CP-SAT auto-routing)** — don't route more
  traffic to the solver until both engines provably agree.
- **#10 (run snapshot/revert)** before **#20 (diff preview)** — apply/cancel needs a
  safe revert underneath it.
- **#84 (delta notifications)** before **#88 (driver change log)** — same diff
  machinery.
- **#33 (hash routing)** before **#94 (shareable URLs)** and ideally before
  **#92 (mega-hub split)** — routing decisions shape the split.
- Waves 2–3 unblock everything: every UX wave assumes the server can't be talked into
  an illegal schedule and that dead engine inputs are live.
