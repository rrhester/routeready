# Schedule → Targets page — 50 improvements (2026-07-18)

Improvement list for the Schedule → Targets sub-view: the 13-week route
planner (`dashboard/views/view-okami.frag` table moved into
`#rr-sched-targets-13week-host`), the Block / Cushion / Report-time KPI
strip + Wave-times / Service-types dropdowns
(`dashboard/views/view-schedule.frag:1599`), the Forecast Gap card, and
Save Plan. Rendering/logic lives in `dashboard/live.js` (`_renderOkamiLiveImpl`,
`_rrRefreshTargetsGapCard`, `_rrMoveOkami13WeekToTargets` family).
Reference items as `TG#NN` to avoid clashing with the workbook `#NN`,
calendar, and project-review `PR#NN` lists.

Anchors are approximate, verified against the code 2026-07-18. Impact
tags: **[high]** = planning decisions come out wrong or data is at risk,
**[med]** = worth scheduling, **[low]** = polish.

Context worth knowing: the Strategy / Hire-by / Status columns and the
mockup week tags are hidden *by operator request* (`live.js:51930–51938`)
— items below suggest re-surfacing that information in less noisy homes
(tooltips, row expand), not restoring the columns.

---

## A. Make the numbers truthful (1–10)

1. **Stop rendering unplanned weeks as healthy surplus** — W37–W40 have
   routes=0, so needed=0 and the gap shows a green `+65`
   (`_renderOkamiLiveImpl`, `live.js:52668`). An operator scanning colors
   reads "covered through October" when those weeks simply have no plan.
   Render routes=0 weeks as a neutral "No plan yet" state and exclude
   them from the gap card / "Staffed through the plan" verdict (with a
   "4 weeks unplanned" note). [high]

2. **Project Available per week instead of a flat snapshot** — every row
   shows the same `_okamiActiveCount` (one head-count query,
   `live.js:52616`). Thirteen weeks out, that number is fiction: approved
   time-off, pending terminations, and historical attrition (the
   forecast-rates loader already has an attrition rate) all erode it,
   and onboarding classes add to it. The Risk-Forecast Simulate already
   folds PTO — bake a per-week projection into the base table so the
   default view is honest, not just the post-Simulate one. [high]

3. **Split "Available" into active vs onboarding** — the count includes
   `status in (active, onboarding)` (`live.js:52619`), but onboarding
   drivers can't run routes yet. Show `65` with a breakdown tooltip/sub
   ("58 active + 7 in onboarding") and let the gap math use a
   route-ready count. [high]

4. **Put the per-week hire-by date back somewhere quiet** — the table
   computes `hireBy` per row (`live.js:52684`) but the column is hidden
   on this surface, so the only deadline visible is the single worst-week
   one on the gap card. A tooltip on the gap pill or a line in the row
   expand ("hire by Aug 9 to cover this week") keeps the noise down but
   restores the per-week deadline. [med]

5. **Show average-day context next to peak-day need** — needed =
   `ceil(peak × dpr × (1+pad))` uses only the busiest day
   (`live.js:52675–52682`), so one spike day staffs the whole week. Show
   avg/day (or needed-at-avg) as secondary text so operators can tell a
   flat 38-route week from a 20-routes-plus-one-70-route-day week. [med]

6. **Per-service-type staffing ratios** — okami_grid returns per-type
   targets (used in the daily panel, `live.js:53092`), but the weekly
   drivers-needed math flattens all types through one `driversPerRoute`.
   XL / HUB routes staff differently than SP; fold per-type ratios in
   (or at least show the type mix in the row expand). [med]

7. **Show plan vs actual for the current / elapsed week** — W28 is
   half-over in the screenshot but renders identically to W40. Overlay
   actual routes run so far (shifts data already loaded elsewhere in
   Schedule) so the anchor row answers "are we tracking to plan?" [med]

8. **Name the worst week on the Forecast Gap card** — "-104 Drivers"
   doesn't say *when*. `A.worstWeek` is already in hand
   (`live.js:54132`); append "worst: W36 · Sep 6–12". [med]

9. **Explain the math where it's used** — an ⓘ popover on the "Drivers
   needed" header showing the live formula ("peak 38 routes × 2.0
   drivers/route × 1.10 pad = 84") with links to where dpr/pad are set.
   Today the formula, its inputs, and their homes (hiring settings, Plan
   Pad, cushion) are scattered and invisible from this page. [med]

10. **Disambiguate Cushion vs Plan Pad** — the toolbar's Cushion (20%)
    feeds shift generation; the staffing math uses the OKAMI Plan Pad
    ("totally separate", `live.js:52637`). Two percent-buffers with
    different meanings and different homes is a trap — label them
    in-place ("Cushion — extra shifts" / "Pad — extra hires") or unify.
    [med]

## B. Editing the plan (11–20)

11. **Give every week the daily drill-down** — only mockup rows 0–3 have
    an expand chevron + detail row (`view-okami.frag:77–120`); W32
    onward can't be opened at all, yet the Routes input's own tooltip
    says "Use the drill-down panel for per-day variation"
    (`live.js:52709`). Generate chevron + detail row for all 13. [high]

12. **Warn before flattening a week** — typing in the Routes cell writes
    that value to all 7 days, silently destroying per-day variation the
    operator set in the drill-down; the only notice is a title attribute
    (`live.js:52709`). If the week's days differ, ask ("This week varies
    by day — overwrite all 7?") or route the edit into the day panel.
    [high]

13. **Copy-forward** — "copy this week to next" / "fill remaining weeks"
    actions. Today a flat 13-week plan means typing 13 numbers (or 91 in
    the day panels). [med]

14. **Bulk percent adjust** — "raise W32–W36 by 10%" for peak ramps,
    instead of hand-editing each row. [med]

15. **Paste a column from a spreadsheet** — operators get route
    projections from Amazon as spreadsheets; pasting 13 numbers into the
    Routes column (one per row) should just work. [med]

16. **Spreadsheet keyboard flow** — ↑/↓ moves between Routes inputs,
    Enter commits + advances, Esc reverts the cell. The inputs are plain
    `<input>`s with no navigation today. [low]

17. **Undo for plan edits** — edits auto-save (debounced) with no
    history; a typo rewrites 7 days permanently. Even a single-level
    "Undo" toast after each save (the Unassign-week pattern already does
    this elsewhere in Schedule) would cover most accidents. [med]

18. **Show save status on Targets** — the "Saving… / Saved" element
    (`#rr-okami-save-status`) lives in the OKAMI page header, which this
    surface never shows. Move/mirror it next to Save Plan so typing
    feedback exists here. [med]

19. **Validate route inputs** — no bounds: negative numbers, `1e6`, or
    clearing to NaN all flow into save + math. Clamp to 0–capacity-sane
    values and flag absurd ones. [low]

20. **Seed from history** — "import last year's same-week actuals" (or
    trailing 4-week average) as a starting plan. The DSP's history is in
    the DB; the empty W37+ rows would start from evidence instead of
    zero. [med]

## C. Reading & analysis (21–30)

21. **Mark the current week** — a "you are here" accent on W28's row.
    All 13 rows render with identical chrome today. [low]

22. **7-day sparkline per row** — a tiny 7-bar strip next to Routes
    showing the week's shape (flat vs weekend-heavy vs one-day spike).
    The per-day data is already fetched for the drill-down. [med]

23. **A needed-vs-available trend chart** — 13 gap pills make the
    operator do the trend in their head. One small line/area chart above
    the table (needed line, available line, shaded gap) shows the
    Aug–Sep cliff instantly. [med]

24. **Hiring pace, not just a lump sum** — "Hire 104 by Jul 19" is
    unactionable as stated (that's tomorrow). The per-week gaps imply a
    schedule: "+27 by W29, +16 more by W30 … 104 total by W36". Render
    the cumulative pace (and per-week class sizes given the 28-day
    lead) in the gap card click-through or a row under the table. [high]

25. **Click a gap pill for its explanation** — a popover with that
    week's peak day, formula inputs, hire-by date, and what would close
    it (e.g. "+3 drivers or −7 routes"). All inputs are already in
    `window._rrOkamiModel`. [med]

26. **Don't encode gap severity in color alone** — `_rrApplyGapClass`
    maps severity to three reds + green (`live.js:54214`); colorblind
    operators lose the scale. Add a non-color signal (weight, icon, or
    an explicit "severe" word in the tooltip). [med]

27. **Sticky table header** — 13 rows plus expanded day panels scroll
    the `WEEK / ROUTES / …` header out of view inside the scrollable
    host (`inline-styles.css:21818`). Make `thead` sticky within it.
    [low]

28. **Month boundaries and known-event markers** — subtle separators at
    Aug/Sep/Oct transitions, and flags for demand-relevant dates (Labor
    Day sits in W36, the highest-gap week; Prime Day, peak season). The
    mockup had HVE/Prime tags; the live table has no event awareness.
    [med]

29. **A totals/summary row** — 13-week route total, peak week, weeks
    short vs covered. The old `okami-summary-grid` the code still
    queries (`live.js:52773`) no longer exists in the markup. [low]

30. **Responsive layout** — at laptop-half-screen widths the six
    toolbar pills + gap card + Save Plan wrap unpredictably, and the
    table has no horizontal-scroll affordance. Define a stacking order
    (rules first, gap card full-width) and let the table scroll with a
    sticky Week column. [med]

## D. Toolbar & controls (31–38)

31. **Say which week the rules apply to** — Block / Cushion / Report
    time are *per-week* settings (`scheduling_settings_for_week`,
    anchored to the schedule's visible week), but the strip sits above a
    13-week table with no week label. Operators reasonably assume
    they're editing the whole plan. Label the strip ("Rules · W28") and
    offer "apply to all remaining weeks". [high]

32. **Give Save Plan a dirty state** — it's always-orange and always
    toasts "Plan saved" success (`live.js:54224`), even when nothing
    changed or the underlying save failed. Disable/relabel when clean
    ("Saved ✓") and surface real failures. [med]

33. **Make Save Plan's scope honest** — routes auto-save as you type;
    the button only re-commits rules/waves. Either rename ("Save
    rules") or make it the explicit "build shifts from this plan"
    action (the OKAMI Save button's regenerate+cushion pipeline) with a
    confirmation of what it's about to touch. [med]

34. **Unsaved-changes guard on the Wave-times / Service-types menus** —
    they host the relocated live popover editor (`live.js:54098`);
    closing the dropdown mid-edit silently discards typed wave times.
    Prompt or auto-apply on close. [med]

35. **Make the gap card's click-through discoverable** — it becomes a
    button only when short, with no visual affordance beyond hover
    (`live.js:54183`). Add a "View analysis →" link line. [low]

36. **Stop the gap card's number-jumping** — it repaints as forecast
    rates, flex cache, and hiring-plan fetches land
    (`live.js:54128–54169`), so the operator watches "-104" gain FT/PT
    splits and app counts in stages. Show a brief loading shimmer until
    the enrichments settle. [low]

37. **Make the 28-day hire lead time a setting** — `RR_OKAMI_HIRE_LEAD_DAYS
    = 28` is hardcoded (`live.js:52503`) but drives every hire-by
    deadline and the "unreachable week" logic. DSPs with faster/slower
    onboarding should set their own in hiring settings, and the card
    tooltip should state the assumption. [med]

38. **Consistent menu behavior** — Esc-to-close, outside-click, focus
    return to the trigger, and arrow-key movement for the two toolbar
    dropdowns, matching the app's other popovers. [low]

## E. Actions & integration (39–44)

39. **Per-week "Build shifts"** — a row action running the
    regenerate_week_shifts + apply_cushion pipeline for *that* week.
    Today the pipeline only runs for the visible schedule week via
    Settings/Save, so acting on a W33 plan means navigating the
    schedule there first. [med]

40. **Wire "Hire 104" into recruiting** — the prescription already
    computes FT/PT split and applications needed
    (`live.js:54150–54170`); clicking it should open the
    hiring/Onboarding funnel with those targets prefilled, not just the
    Risk-Forecast narrative. [med]

41. **Show the onboarding pipeline under Available** — expected
    graduations per week (candidates in onboarding × historical
    completion rate) as a `+N incoming` sub-line, so the operator sees
    whether hiring already in flight closes the gap. [med]

42. **Threshold alerts** — a bell notification when a week's gap
    worsens past a threshold or a hire-by deadline is ≤7 days out.
    Today the deadline only exists while someone is looking at this
    page. [med]

43. **Export / print** — CSV export and a print stylesheet for the
    13-week table; this is the artifact operators bring to ops/AM
    meetings. [low]

44. **Plan snapshots / scenario compare** — save a named snapshot
    ("pre-peak plan") and diff against the current plan, so what-if
    edits (raise cushion, add routes) can be compared and reverted
    instead of destructively auto-saved. [med]

## F. Trust, resilience, a11y (45–50)

45. **Never show mockup numbers on RPC failure** — if `okami_grid` or
    the driver count errors, the renderer `console.warn`s and returns
    (`live.js:52622`), leaving the *mockup's hardcoded W19–W31 rows*
    (38/85/78/−7…) visible as if real. Show an in-table error state
    with a Retry button; blank the fake cells first. [high]

46. **Loading skeleton on first paint** — same flash problem while the
    grid RPC is in flight: mockup values render until live data lands.
    The daily panel already shows `rr-loading`; the table should too.
    [med]

47. **Render from the model, not the mockup DOM** — the renderer
    rewrites 13 hand-written mockup rows by positional `tdCells[N]`
    index (`live.js:52713`), and consumers read back via DOM parsing
    (`_rrReadOkamiWeeks`). `window._rrOkamiModel` already exists —
    generate rows from it and make every consumer read it. This is the
    root enabler for TG#11, TG#45, TG#46 and safe column changes. [high]

48. **Audit trail for plan edits** — auto-saved route changes leave no
    record of who changed W34 from 45→55 or when. Log plan edits (the
    admin audit plumbing from the Messages work is a ready pattern) and
    show "edited by R.H. · 2d ago" in the row expand. [med]

49. **Multi-station breakdown** — `okami_grid` returns per-station rows
    that the table sums away (`live.js:52629`). For DSPs running
    multiple stations, add a station filter or per-station sub-rows;
    a single blended gap can hide one station being badly short. [med]

50. **Row-expand accessibility** — the chevron never updates
    `aria-expanded`, focus doesn't move into the opened day panel, Esc
    doesn't close it, and the table lacks a caption/`scope` markup for
    screen readers. Fix alongside TG#11 while the expand markup is
    being regenerated. [med]
