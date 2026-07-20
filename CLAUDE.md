# RouteReady — Claude operating notes

## Active task: Multi-station toggle (branch claude/multi-station-toggle-2pljie)

Many DSPs run >1 Amazon delivery station (DCA1, DBO5, …). Goal: a MASTER
station lens every page reads — pick a station for a blank-slate view of
that station's schedule/roster/bans/etc., or "All stations" to see
everything together. Operator confirmed **drivers may FLOAT between
stations** (not fixed to one home), so roster/bans scoping will eventually
need a `driver_stations` many-to-many; the SCHEDULE is already correct
either way since it scopes by `shift.station_id` (NOT NULL), not the
driver's home.

Data model already supports it (no schema rewrite): `stations` table
(dsp_id-scoped, 0001), `drivers.station_id` (nullable FK), `shifts.
station_id` (NOT NULL), `driver_channels.station_id`. Global context is
`window.RR.dsp`; the lens sits alongside as `window.RR`-adjacent state.

**Plan (phased):** P1 plumbing (state+control+persistence, inert) → P2
read-view scoping via one helper (schedule/roster/bans/drivers/onboarding/
broadcast) → P3 optional `p_station_id` server param on the aggregate RPCs
(okami/targets/forecast/generate_shifts/roster counts; null = all =
byte-identical to today, same backward-safe pattern as XL/helper) → P4
All-mode per-station breakdowns on decision numbers (never a blind sum).
Realtime channel stays dsp_id-filtered (Wave F) — narrow at query/render,
NOT on the subscription, or All-mode loses cross-station updates.

**SHIPPED — Phase 1 (plumbing, inert for data):**
- `dashboard/live.js` (~after `_paintWorkspaceChip()`): owns
  `_rrStationScope` ("all" | station_id) + `_rrStationList`. Public read
  API on `window`: `rrStationScope()` → `{id, all}` (id null ⇒ all),
  `rrStationScopeId()`, `rrStationScopeIsAll()`, and
  `rrApplyStationFilter(query, col="station_id")` (appends `.eq(col,id)`
  unless All — wrap PostgREST builders unconditionally). Changing scope
  persists (localStorage `rr-station-scope:<dsp>:<user>`, per-user+per-DSP),
  repaints, fires `rr:station-changed` (detail = scope), and calls
  `refreshActiveView()`. Boot does its OWN stations query (NOT
  `getDriverStationsCached()` — its backing `let` is in the temporal dead
  zone that early in boot; calling it there throws) and reveals the control
  ONLY when ≥2 active stations exist.
- `dashboard/index.html`: `#rr-station-switch` markup lives in the SIDEBAR
  (right after `.brand`), NOT the topbar — the topbar tool cluster is
  physically relocated into the sidebar foot at boot (dockTools, ~line
  680), so it can't host a global always-visible control. ids:
  `rr-station-btn` / `rr-station-label` / `rr-station-menu`.
- `dashboard/inline-styles.css`: `.rr-station*` — trigger adopts the
  dark-sidebar nav language; flyout `.rr-station-menu` renders on a light
  `--surface` and reuses `.rr-qat-opt`/`.rr-qat-opt-lbl` rows. Collapsed
  rail = icon-only pin (label+chev hidden), flyout still opens. Token-only
  (design-lint ratchet holds). The menu must NOT carry the `.popover`
  class — that class is `display:none` until `.open`, which this control
  doesn't use (cost an hour of QA the first time).
- Browser-QA'd (Playwright, stubbed 2-station DSP): reveal, menu, select,
  event, persistence across reload, All-mode no-op filter, custom column,
  AND single-station DSP keeps it hidden while the API stays callable.
  Nothing scopes data yet — that's P2.

**SHIPPED — Phase 2 (schedule grid, the reference impl):**
- `renderScheduleWeek` (live.js ~70884): after the `schedule_grid` RPC +
  drivers load, when scoped to one station it filters `grid.shifts` AND
  `grid.coverage` by `station_id`, then filters the driver rows to those
  homed at the station OR floated onto one of its shifts this week.
  KEY FACT: both `okami_grid` demand rows and shift rows already carry
  `station_id` (okami_demand is keyed `(dsp_id, station_id, date)`), and
  the client aggregates coverage by date across stations — so filtering
  both arrays keeps coverage %, open-shift, and target math consistently
  scoped. All-mode (null) = byte-identical to before. Floating handled by
  scoping the SCHEDULE via `shift.station_id`, not driver home.
- `_rrSetStationScope` re-render is view-aware: on view-schedule it calls
  `loadScheduleView()` (→ renderScheduleWeek), on view-okami
  `loadOkamiView()`, else `refreshActiveView()` (the generic path doesn't
  drive the schedule/targets loaders — a focus listener mirrors this).
- Browser-QA'd (Playwright, 2-station DSP + a floating driver): All=3
  drivers/3 chips; scope Boston=2/2 (home-B driver + the A-homed floater on
  a B shift, A-only driver hidden); scope Chantilly=2/1 (both A-homed show,
  the floater's B shift correctly filtered out → blank row); back to All =
  3/3. No errors.

**SHIPPED — Phase 2 cont. (rest of the schedule family):**
- **Staff week grid** (`_rrRenderStaffInWeekGrid` ~52602): when scoped,
  filters staff shifts by `station_id` and shows only staff working that
  station (staff_schedule_grid shifts carry station_id). Scope-aware empty
  state ("No staff scheduled at this station… Switch to All stations").
  Inspection-verified (same proven filter pattern; syntax/lint/ratchet
  green) — not browser-driven (staff mode is a deep toggle).
- **Today's Plan command center** (`loadTodayPlan` ~20148): scoped the
  roster + live attendance by station — `rosterData` filtered by
  `station_id`, `attData.rows` by `station_code` (mapped from the scoped
  station id via `_rrStationList`). Roster-derived KPI counts scope along
  with them. Drives BOTH the dashboard Today's Plan page AND the schedule
  Today sub-view (shared shell). Browser-QA'd on the dashboard: All = 3
  roster rows → scope Boston = 2 (the two DBO5 drivers) → back to All = 3.
  RESIDUAL (→ P3): the fleet-readiness + hiring-pipeline tiles and the
  coverage rail (fleet_execution_summary / pipeline_counts / today_plan)
  stay DSP-wide — those RPCs aggregate across stations and need an optional
  p_station_id for a consistent per-station version.
- Re-render on scope change: `_rrSetStationScope` covers the schedule WEEK
  grid (loadScheduleView), targets (loadOkamiView), and everything else via
  refreshActiveView (→ view-dashboard → loadTodayPlan). The schedule
  Today/Roster/staff SUB-views re-render on their next trigger (tab switch)
  rather than instantly — the filters run on every render so data is always
  correct, only the live auto-refresh of those sub-views is deferred.

**SHIPPED — Phase 2 cont. (roster + floating-driver join):**
- **Migration 0525** `driver_stations` — many-to-many membership so a driver
  can belong to >1 station (drivers.station_id stays the PRIMARY/home).
  Backfills one is_primary row per driver's existing station_id. RLS: tenant
  select, `is_staff(dsp,'dispatcher')` write. Idempotent. **MANUAL — paste in
  chat** (client degrades gracefully until applied).
- **Roster** (`loadDriversRoster` ~7534): scopes by driver_stations MEMBERSHIP
  via `_rrDriverIdsAtStation(stationId)` (returns a Set, or null pre-migration
  → falls back to primary `drivers.station_id`, floaters not captured but the
  lens still narrows). Added `station_id` to the roster select for the
  fallback. Re-renders via refreshActiveView → view-drivers → loadDriversRoster.
- Browser-QA'd BOTH paths (Playwright, 2-station DSP + a floater who is a
  member of B though homed at A): join-table mode → scope Boston = {Bob(home
  B), Carol(floater)}, scope Chantilly = {Alice, Carol}; pre-migration 404
  fallback → scope Boston = {Bob} only (primary home), graceful. All-mode
  unchanged both ways. No errors.

**SHIPPED — Settings → Stations manager (the unblock):**
- CRITICAL GAP found answering "where are the toggles?": stations were only
  ever created by seed migrations (0005/seed_demo) — NO UI/RPC to add one, so
  the ≥2-station switcher was unreachable for real operators. Fixed:
  `view-settings.frag` gains an owner-only "Stations" form-row (list + add
  code/name + activate/deactivate); `dashboard/live.js` `_rrLoadStationsManager`
  (list render, class-only rows so the ratchet holds) + delegated add/toggle
  handlers writing `public.stations` directly (owner RLS). On add/toggle it
  nulls `_driverStationsCache` and re-runs `_rrInitStationScope()` so the
  sidebar switcher reveals the instant a DSP crosses to 2+ active stations —
  no reload. Hooked into `_prefillWeatherInputs` (runs on Settings nav). CSS
  `.rr-stn-*` in inline-styles.css, token-only.
- Browser-QA'd (Playwright, stateful stations stub): single-station DSP =
  switcher hidden + settings lists DCA1 → add "dbo5"/"Boston" = uppercased to
  DBO5, list [DCA1,DBO5], "Added DBO5.", switcher REVEALS w/o reload, menu =
  All/DCA1/DBO5 → invalid code "x" rejected with a helpful message. No errors.

**MERGED — PR #4037** (squash 1e71350): Phase 1 lens + Settings Stations
manager + schedule/staff/today/roster scoping + migration 0525. This is LIVE
on main. Branch reset from main for follow-ups (new PR each time).

**SHIPPED — Drivers sub-views + toggle-freshness (post-merge, new branch):**
- No dedicated "bans" surface exists (searched: ban/DNR/blocklist/ineligible
  are scheduling states, not a page; broadcast already has its own station:<id>
  audience pills). Don't build a phantom bans page.
- **Drivers page sub-views** now scope like the roster (same page → must be
  consistent): `loadDriverLicensesView` (added station_id to select, membership
  filter via `_rrDriverIdsAtStation` + station_id fallback) and
  `loadDriverWorkAuthView` (i9_list rows carry driver_id + station_code →
  membership filter by driver_id, station_code fallback). refreshActiveView
  already routes view-drivers → the active sub, so they refresh on toggle.
- **Toggle now re-renders ALL of the CURRENTLY-VISIBLE surface** (operator
  report: "all pages need to be fresh when you toggle"). `_rrSetStationScope`
  → new `_rrRerenderForScope()`: on view-schedule it re-runs loadScheduleView
  (week grid) AND `window.schedSub(_rrCurSchedSub)` for the active NON-week sub
  (Today/Targets/Monthly/… — schedSub only toggles week visibility, doesn't
  re-fetch it, so drive the loader for week directly); view-okami →
  loadOkamiView; else refreshActiveView (covers dashboard/drivers+subs/
  onboarding/pipeline/fleet). Non-active pages re-fetch on next visit (loaders
  always re-query). Browser-QA'd: toggling WHILE ON the schedule Today sub now
  re-renders it fresh (scope B = Bob, toggle to A = Alice); week grid 2→1 chips;
  no errors.

**SHIPPED — Targets/forecast follows the master lens (Phase 3, client-side):**
- The Targets 13-week page ALREADY had its own per-station scoping
  (`_rrOkamiStationFilter` + a local `#rr-tgt-station-sel` dropdown, from the
  Targets 50-list): `okami_grid` returns per-(date,station) rows, and the
  render filters demand `cells` by station (Available deliberately stays
  fleet-wide — drivers float). Unified it to the master lens: in
  `_renderOkamiLiveImpl` `_rrOkamiStationFilter = rrStationScopeId()` (global
  wins), and `_rrOkamiRenderStationFilter` now RETIRES the per-page dropdown
  when `window.rrStationScope` exists (always post-boot) — one control, not two.
- Browser-QA'd (Playwright, 2-station okami_grid stub, A=2 routes/day, B=3):
  All = 11 Needed → scope Boston = 7 → scope Chantilly = 5; local dropdown
  absent; re-renders on toggle (schedSub('targets')→renderOkamiLive and
  view-okami→loadOkamiView both covered by `_rrRerenderForScope`). No errors.
- NOTE the "Available fleet-wide under a station scope" is intentional (float
  model) — don't "fix" it to per-station roster.

**SHIPPED — Attendance report** (`loadAttendanceLive` ~16236): scopes its
driver list by driver_stations membership (`_rrDriverIdsAtStation` + station_id
fallback); added station_id to the select. Same proven pattern; inspection-
verified (syntax/lint/ratchet/tests green).

**SHIPPED — Onboarding funnel follows the lens (chosen default):** scoping the
hiring funnel would hide not-yet-placed applicants, so the default is "this
station's applicants PLUS the unassigned pool" — `loadOnboardingOps` paint()
filters `x.meta.station === scopedCode || !x.meta.station`; the per-page
`#rr-ob-station` dropdown is retired when the global switcher exists.

**SHIPPED — Today's Plan coverage rail scopes (Phase 3 server-side, mig 0526):**
- **Migration 0526** `today_plan(p_station_id uuid default null)` (drops the old
  no-arg fn first to avoid an ambiguous overload): `open_shifts` filtered by
  `s.station_id`; `dl_expiring`/`not_dot_certified` by driver_stations
  MEMBERSHIP or primary `station_id` (floating-aware). NULL = all = byte-
  identical. **MANUAL — paste in chat.**
- `loadTodayPlan` sends `p_station_id` when scoped, with a graceful fallback to
  the no-arg call if 0526 isn't applied (arg'd overload 404s → retry no-arg →
  DSP-wide but the rail still renders). "All" sends no arg (identical to before).
- Browser-QA'd: pre-migration toggle → `[scoped:bbbb, noarg]` (fallback fires),
  no errors; post-migration sends only the scoped call.
- fleet_execution_summary + pipeline_counts stay DSP-wide ON PURPOSE (vans are
  pooled — vehicles.station_id is optional/often null; hiring is DSP-wide).

**SHIPPED — P4 All-mode per-station breakdown (Targets Needed):**
- `_renderOkamiLiveImpl`: in All-stations mode on a multi-station DSP, builds
  per-station demand maps (`_perStationDemand` from the unfiltered `cells`) and,
  per week, computes each station's OWN Needed via `_rrOkamiWeekMix` +
  `rrDriversNeededMix` (each station staffs to its own peak day). Renders a
  muted sub-line under the combined Needed (`.rr-tgt-need-stn`, token-only CSS)
  + a tooltip. Hidden when scoped/single-station.
- KEY: the per-station values match scoping to that station (QA: All=11 with
  "DBO5 7 · DCA1 5"; scope B=7, scope A=5). Sum (12) > combined (11) is the
  intended insight — a blind sum masks that a station needs its own peak
  covered. Browser-QA'd; no errors.

**DIRECTION CHANGE (operator, strong):** "literally every page should be
distinct — consider it a NEW DSP." Reverses the earlier "DSP-wide by design"
calls (fleet especially). Every page must scope, including fleet + messages +
the aggregate KPI tiles. Working through the remaining pages:

**SHIPPED — Fleet Issues + Assignments scope (operator report "not flipping to
blank"):** the roster scoped but the sub-tabs didn't. Issues (`_flApplyIssueFilters`)
now keeps only issues whose `vehicle_id` is in the already-scoped `_fleetRows`
(no-op in All mode; the roster loads before the issues tab). Assignments board
(`renderSchedVanAssignmentsBoard`): **migration 0529** adds station_id/station_code
to `vehicles_list` (returns jsonb → no drop needed, just added keys); client
filters `_wsVehicles` by the scoped station (graceful pre-migration: no station
keys → unfiltered). Both re-render on toggle via loadFleetView. QA'd Issues:
All=[i1,i2] → Boston=[i2]. Apply order: 0528 → **0529**.

**SHIPPED — Fleet page scopes (new-DSP isolation):** `_flLoadRoster` filters
`_fleetRows` by `station_code` right after the `vehicles_roster` RPC (rows carry
station_id/station_code), so the roster + tab counts + coverage card + issues
all scope at once. Local `#rr-fleet-station` dropdown retired when the switcher
exists. Vehicles with no station show only in All mode. Browser-QA'd: All=3
vans → Boston=2 → Chantilly=1, dropdown hidden, no errors. RESIDUAL: the
fleet-exec-summary KPI strip (`fleet_execution_summary` RPC, `_flLoadExecSummary`)
is server-aggregated DSP-wide → needs a `p_station_id` migration (same as the
Today fleet tile). NOTE vehicles must be ASSIGNED to stations (vehicles.station_id)
or they only appear in All mode — operator sets van station in the van editor.

**SHIPPED — Messages scopes (new-DSP isolation):** DM inbox
(`refreshDriverChatList` ~41860) filters `_msgInboxList` by driver_stations
MEMBERSHIP (dispatch_chat_threads returns driver_id); channel lists
(`refreshChannelList`/`refreshHrRoster`) filter station-tied channels by
station_id, DSP-wide (null-station) channels stay visible in every scope.
`_rrRerenderForScope` gained a view-messages branch that refreshes ONLY the DM
inbox (calling the channel refreshers too CLOBBERS the shared list host — QA
caught this: scoped DMs came back empty until I dropped them). Browser-QA'd:
DM inbox All={d1,d2}, scope Boston={d2}, scope Chantilly={d1}, no errors.

**SHIPPED — Onboarding Funnel + Interview scope (operator report "funnel and
interview still show the old station"):** these are the HIRING-PIPELINE sub-tabs
of view-onboarding-ops (obSub funnel→`loadPipeline`, interview→`loadInterviewDay`)
— NOT the readiness matrix (`loadOnboardingOps`) I'd scoped earlier. Fixed:
- **Funnel** (`loadPipeline` ~2988): applicants carry `station_id`/`station_code`
  (pipeline_list). Scopes to this station + the unassigned pool (no target
  station yet); the scoped rows feed `_rrPipelineById`. Stage-tab counts
  (pipeline_counts, DSP-wide aggregate) stay DSP-wide pending a p_station_id.
- **Interview** (`loadInterviewDay` ~25119): **migration 0528** adds
  `station_id`/`station_code` to `interview_day_roster` (appended cols, safe);
  client filters the roster by station (+ unassigned), KPIs recompute from the
  filtered rows. Graceful pre-migration (rows lack station_id → no filter).
  **MANUAL — paste in chat.**
- `_rrRerenderForScope` gained a view-onboarding-ops branch: re-runs
  loadOnboardingOps({keepTab}) AND the active sub loader (funnel→loadPipeline,
  interview→loadInterviewDay) so a toggle refreshes them (refreshActiveView only
  drove the matrix).
- Browser-QA'd Funnel: All=3 → Boston={Ben, Uma(unassigned)} → Chantilly={Ann,
  Uma}. Interview inspection-verified (same filter pattern + 0528).

**NEXT for the new-DSP push:** aggregate KPI RPCs needing `p_station_id`
migrations (fleet_execution_summary → fleet exec strip + Today fleet tile;
pipeline_counts → Today hiring tile + Funnel stage counts). Then Repair Center /
Recognition / Check-in (vehicle/driver-based, client-side). Tool pages
(Workbooks/Notebooks/Email/Drive) are DSP-level — pending operator confirm.
Apply order for the lens: 0525 → 0526 → **0528**.

**SHIPPED — Requests + Targets daily drill-down (operator report "still see
both stations"):**
- **Requests** (`renderSchedRequestStream`): had its own per-page Location
  filter (`_reqFilter.loc` on `station_code`) — unified to the master lens.
  Scopes the PTO/unpaid/availability stream by driver_stations membership
  (station_code fallback); the Location filter button is retired when the
  switcher exists. Re-renders on toggle via schedSub('requests').
- **Targets daily drill-down** (`_renderOkamiDailyPanelImpl` ~54976): fetches
  its OWN okami_grid and previously summed BOTH stations into the day totals —
  now filters cells by `rrStationScopeId()` like the 13-week table's useCells.
  (The 13-week table + P4 breakdown were already scoped; this was the one
  Targets surface that wasn't.) Note: it aggregates per (wave×type)/day, not
  per-station rows — the fix changes the day VALUES to the scoped station.

**LENS COMPLETE.** Every station-relevant surface scopes to the sidebar switcher
and refreshes live on toggle: switcher, Stations manager, schedule (week/staff/
today/**requests**), drivers (roster/licenses/work-auth), targets+forecast
(13-week + **daily drill-down** + P4 All-mode breakdown), attendance report,
onboarding funnel, Today's Plan roster + coverage rail. DSP-wide by design:
fleet-readiness + hiring-pipeline KPI tiles (vans pooled, hiring DSP-wide).
Migrations: **0525** (driver_stations) → **0526** (today_plan), both manual +
graceful-degrading. Shipped PRs #4037/4046/4049/4051/4053/4055 (+ this one).

**REVERSED — Targets "Available" now scopes per station (operator report
2026-07-20: "my second station shows my first station's driver count"):** the
earlier "Available stays fleet-wide (drivers float — deliberate)" call is
OVERRIDDEN by the new-DSP directive. `_renderOkamiLiveImpl` now resolves the
scope up front (`_okScopeId` + membership set `_okMemberIds`) and scopes the
WHOLE supply side: the active/onboarding driver-pool count queries (membership
`.in(id,…)`, primary `station_id` fallback), the per-week
`active_drivers_for_horizon` projection (**migration 0531** adds `p_station_id`
to it + `active_drivers_for_week`; graceful no-arg fallback pre-migration), AND
the onboarding not-ready subtraction (`onbList` gained `station_id`; `notReady`
+ graduation chips filter by station). `_rrOkamiStationFilter = _okScopeId`. The
"Simulate 13 wks" button scopes the same way. Browser-QA'd (2-station horizon
stub, pools all=50/DCA1=30/DBO5=20): All→50, DCA1→30, DBO5→20, back→50; arg'd
overload called; no errors. **Migration 0531 MANUAL — paste in chat.** Apply
order: 0525 → 0526 → 0528 → 0529 → 0530 → **0531**.

**SHIPPED — schedule/roster driver-count mismatch (operator report 2026-07-20
"more drivers on my schedule than my roster") → migration 0532:** NOTHING wrote
driver_stations after 0525's one-time backfill (Add-driver insert, driver-editor
station change, CSV import all write only drivers.station_id) — so every driver
hired or re-homed since 0525 had no membership row: visible on the scoped
schedule (station_id + shifts lens) but hidden from the scoped roster
(membership-only lens). Fix: `_rrDriverIdsAtStation` now returns membership
UNION primary-home ids (matches the server RPCs 0526/0531 "station_id = p OR
EXISTS membership"), fixing all ten membership-scoped surfaces at once (roster/
licenses/work-auth/attendance/messages/requests/recognition×2/Targets pool);
null only when BOTH sources fail. **Migration 0532** adds a sync trigger on
public.drivers (insert/station change → upsert is_primary row, retire the old
home's machine-written is_primary row; hand-added float rows untouched) + a
repair backfill (re-adds missing homes, deletes stale machine primaries).
Client is already correct pre-0532 thanks to the union. Browser-QA'd (stubbed
2-station DSP; Nina homed DBO5 with NO membership row): pre-fix DBO5 roster =
{Bob,Carol} vs schedule {Bob,Nina} — post-fix roster = {Bob,Carol(float),Nina},
DCA1 = {Alice,Carol}, All = 4, schedule agrees, no errors. Apply order:
0525 → 0526 → 0528 → 0529 → 0530 → 0531 → **0532**.

**SHIPPED — Recognition + Repair Center scope (new-DSP isolation):**
- **Recognition** (`_loadRecognitionUpcoming` / `_loadRecognitionHistory` ~93108):
  both `recognition_upcoming` + `recognition_list` rows carry `driver_id`, so the
  Upcoming + Sent/scheduled panes filter by driver_stations MEMBERSHIP
  (`_rrDriverIdsAtStation`); pre-0525 the set is null → no scoping (rows have no
  station column — graceful). refreshActiveView gained a view-recognition branch
  that re-runs the ACTIVE sub-pane (`window.loadRecognitionSubPane`) on toggle.
  Browser-QA'd (2-station stub + a floater): All=3, DBO5=2, DCA1=2, back to All=3.
- **Repair Center** (`dashboard/repair/repair-ui.js` — self-registered module):
  `loadView` now passes `p_station_id` to BOTH `repair_cases_list` (already
  supported since 0486) and `repair_center_summary` (**migration 0530**), so the
  queue + attention list + KPI strip all scope server-side. Summary has a graceful
  no-arg fallback (pre-0530 the arg'd overload 404s → retry → DSP-wide strip still
  paints). Per-page station dropdown retired when the switcher exists. live.js
  refreshActiveView gained a view-repair branch (→ `RRRepair.loadView(true)`) so a
  toggle re-fetches. Browser-QA'd: All queue/open=3, DBO5=1, DCA1=2, back=3,
  dropdown hidden, arg'd summary called, no errors.
- **Check-in** turned out to be DEAD (index.html line ~2193: "Today's check-in
  view removed; live data lives at Drivers → Attendance → Today"). loadCheckinView
  early-returns (no #view-checkin). The LIVE check-in surface is the Attendance
  report (loadAttendanceLive), already scoped — so "check-in" is covered.
- **Migration 0530** (repair_center_summary p_station_id) MANUAL — paste in chat.
  Apply order for the lens: 0525 → 0526 → 0528 → 0529 → **0530**.

**SHIPPED — Targets daily-save fixes (2026-07-20, PRs #4089/#4092, operator
reports "targets don't save after I key them" / "routes box = highest day"):**
- `saveOkamiDaily` is now LENS-AWARE: scoped → ONE okami_set_target to the
  scoped station (others untouched); All-mode keeps legacy first-station-full/
  rest-zero. Pre-fix it always wrote first-by-code + zeroed the rest, so keying
  while scoped to a non-first station (e.g. DCA1 vs DBO5) wrote to the WRONG
  station and ZEROED the one on screen — values "vanished" on reload.
- Scope toggle re-renders an OPEN daily drill-down (`_rrRerenderOpenOkamiDaily`
  in `_rrRerenderForScope` schedule/okami branches) — the panel fetches its own
  okami_grid, so the table re-render alone left it stale.
- After every daily save, `_rrOkamiPatchAfterDailySave` folds the write into
  `_rrOkamiBucketsByDate` + totals/xl/helper caches, then PATCHES (never
  re-renders — full render mid-typing = the historical keystroke glitch): the
  week's Routes input (operator rule: ALWAYS the week's highest single day;
  skipped if focused), model routesMax/unplanned, the drill-down footer
  (`data-rr-okami-daily-total`/`-peak`), and Needed/Gap/tfoot/KPI via
  `_okamiRecomputeFromCache` (the Plan-Pad no-refetch path). Browser-QA'd
  21 checks (stateful 2-station stub): scoped single-write + persistence
  across re-render/reload, live peak tracking, focus retention, All parity.

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

**SHIPPED — dispatch-side enforcement (XL = driver seat + helper seat):**
The authoritative CP-SAT solver models `1 shift = 1 seat = 1 driver`, so
"2 people per XL route, 1 certified + 1 helper" is a GENERATION change
(materialize the helper seat), not a cardinality constraint. What shipped:
- `shift_kind` gains a `helper` value (migration **0518**). Each XL route
  target now generates a PAIR: a regular XL driver seat (still xl_certified-
  gated) + a `shift_kind='helper'` XL seat (NOT gated). `private.
  generate_shifts` reconciles both independently (driver-seat count/prune now
  exclude helpers; a helper block mirrors the driver logic for XL types).
  `regenerate_week_shifts` calls generate_shifts (one seam → both soft
  reconcile + hard reset). `apply_cushion_to_week` base_count excludes
  helpers so cushion sizes off driver seats (helper backups deferred).
- `eligibility.py` + `engine/src/rules/r004_certification.ts`: an XL seat
  with `shift_kind == "helper"` skips the cert gate; regular XL seat still
  requires it. `ShiftIn.shift_kind` / `NormalizedShift.shift_kind` added;
  conformance fixture `xl-help-mon` + pytest `test_xl_route_composition.py`
  lock it in (a certified driver takes the driver seat, an uncertified one
  the helper). Bundle `scheduling-engine.js` rebuilt.
- `live.js`: both Smart-Fill payload builders send `shift_kind`; the week
  builder now treats `helper` as a FILLABLE kind (was regular-only), so
  helper seats get staffed instead of dropped.
- **Migration 0518 is MANUAL** (paste in chat). Nothing changes on the DB
  until applied; the solver/engine parts auto-deploy and are backward-safe
  (no shift is `helper` pre-migration). Post-apply wants a browser QA pass
  of the schedule grid + a Smart-Fill run on an XL week.

**SHIPPED — the two former follow-ups (XL follow-up pass):**
- Helper-seat cushion/backups (migration **0519**): apply_cushion_to_week
  now sizes a SECOND cushion off the helper seats (target_helper_cushion =
  round(helper_base × cushion%)), reconciled independently of driver cushion
  — so an XL route staffs ≈ the forecast's "2 certified + 2 helpers" at the
  DSP cushion %. Helper cushion seats are is_cushion + shift_kind='helper'
  (fillable, uncertified). 0519 re-asserts the 'helper' enum (safe if 0518
  ran). generate_shifts unchanged from 0518.
- Availability popover (live.js `loadScheduleInsights` ~64950): demand is now
  XL-aware — builds `xlByDate` from okami_grid `targets_by_wave`
  (service_type_code === "XL"), picks the peak-DEMAND day per DOW
  (std×dpr + xl×4), and computes Needed via `rrDriversNeededMix`. The (ⓘ)
  popover formula text + `_availMath` carry the XL breakdown. Was a flat ×2.

**SHIPPED — Helper badge on the schedule grid:** the dispatcher shift-chip
builder (live.js ~70135) now renders a `Helper` badge in the route eyebrow
+ a `shift-chip-helper` dashed-accent class when `shift_kind === 'helper'`
(CSS in schedule-rrx.css, token-only so the design-lint ratchet holds). So
an XL route's two chips read "XL" (driver seat) and "XL · Helper" (helper
seat). shift_kind already flows via the schedule_grid RPC (0269).

**SHIPPED — driver-app helper label:** app/app.js `shiftCardHtml` (schedule
row) + `_shiftMetaCells` (today spotlight) now show a `Helper` chip/cell when
`shiftKind === 'helper'` (driver_my_schedule already returns shift_kind per
0269). CSS `.sc-chip-helper` / `.sc-cell-v--helper` in app/styles.css use the
`--accent` tokens (distinct from teal training / amber road). Helper stays a
normal swappable shift (not lumped with onboarding). SHELL_CACHE auto-busts
via bust-cache.mjs — no manual bump.

**BUG FOUND VIA RUN REPORT (2026-07-19) → migration 0520:** helper-seat
assignments were solver-approved but ROLLED BACK by the DB — "server
compliance check refused N: route requires XL certification, not on file".
Three server-side gates enforced requires_xl→xl_certified with no helper
awareness: `private.staff_assign_violations` (0500, inside assign_shift),
`private.driver_can_take_shift` (0201, pickup), `driver_can_take_shift_
after_swap` (0423, swaps). **0520** re-issues all three verbatim with the
cert block skipped when `shift_kind::text = 'helper'` (text cast = safe
pre-0518). LESSON: any new shift semantics must be threaded through the
SQL compliance gates too, not just solver/engine/UI. Also shipped: the
Smart-Fill completion toast now has "View results" → `_rrShowSfRunReport`
modal (the diagnostics used to go console-only; that's how this was
found). Apply order: 0518 → 0519 → **0520**.

**Post-0520 fix pass (2026-07-19, operator-driven):**
- Drill-down day labels were Mon-first over Sunday-anchored weeks (typed
  "Thu" saved to Wed) — headers now derive from real dates; never
  reintroduce a static day-label list there.
- Helper chips painted XL + false ⚠ "missing XL cert": the late sharp-color
  CSS family ([data-rr-shift-id]) out-ranked the helper paint rule (fixed
  with matching-specificity helper family at end of schedule-rrx.css), and
  _computeWeekViolations now skips cert checks on helper seats.
- **Vans (migration 0521):** helpers ride the paired XL driver's van — never
  consume their own. _assignVansForRange + CP-SAT van model exclude
  helper-kind seats; grid decorator zips helper→driver by (date/station/
  wave/type) bucket and mirrors the van; driver_vehicle_days + today_roster
  reuse the trainee-inherits-trainer-van machinery via an extended mate
  lookup (via still reads 'trainee' — don't "fix" it, app-compatible).
- **Route counts (migration 0522):** helper seats count as DRIVERS not
  ROUTES (operator: 9 SP + 1 XL = 11 drivers, 10 routes). okami_grid
  filled excludes helper kind; grid client counter same.
- **HELPER service type (migration 0523):** the 0349-seeded HELPER type =
  SP-style paired route (driver + helper, NO certs). generate_shifts pairs
  a helper seat for requires_xl OR code='HELPER' buckets;
  driversNeededMix gains {helperRoutes} bucket (4 bodies/route, 0
  certified); Targets/availability builders read code==="HELPER" maps.
- Smart-Fill completion toast now opens a run-report modal (_rrShowSfRun-
  Report) — diagnostics were console-only; that report is how the 0520
  refusals were found.
- **Van-alert false positive (2026-07-19, operator report) → migration
  0524:** the weekly red "V" badge + Van-assignments KPI flagged every
  helper day (helpers never hold a vehicle_day_assignments row — 0521
  mirrors the paired driver's van). Client loop in renderScheduleWeek now
  skips helper kind like training/ride_along; **0524** re-issues
  compliance_workspace_bundle (0242) with helper/training/ride_along
  excluded from the driver_no_van candidates, the primary-chain
  "needs their van" check, and the free-pool count (::text cast, safe
  pre-0518). PR #4025 merged; 0524 SQL pasted in chat.
- Apply order: 0518 → 0519 → 0520 → 0521 → 0522 → 0523 → **0524**.

**Still DEFERRED:** nothing else outstanding on the XL/helper model.

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
