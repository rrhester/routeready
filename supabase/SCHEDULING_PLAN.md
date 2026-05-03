# Schedule + OKAMI live-wiring plan

Saved 2026-05-03. Schema (migration 0025) and RPCs are deployed. The
mockup HTML for OKAMI + Schedule must stay untouched — earlier
attempt to replace structure was reverted. Wiring goes INTO the
existing mockup elements.

Build in three focused PRs (in this order — each ships independently):

## PR A — Schedule weekly view (Schedule → Week)
Highest daily-operator value. Populate the existing driver × day grid.

**Selectors / elements that already exist in the mockup:**
- `#sched-sub-week` — container
- Driver rows + day cells — currently mockup data; preserve layout
- Day-column headers (shifts count, ø avg)
- Bottom coverage row (filled / needed per day)
- Driver pool sidebar (Available · Off / Time off)
- "Auto-fill week" + "Today" buttons + week nav arrows

**Data sources:**
- `public.drivers` (active + onboarding)
- `public.shifts` for the displayed week
- `public.okami_grid(week_start, 1)` for per-day target/needed
- `public.time_off_requests` overlapping the week
- `public.coachings` last 30d for "score" sort in driver pool

**Save paths:**
- Drag from sidebar → cell: `assign_shift(shift_id, driver_id)` (or `create_shift` then assign)
- Click unassigned cell at bottom: `create_shift(payload)` → opens existing assign modal
- Auto-fill week button: bulk `create_shift` for OKAMI routes not yet covered

**Estimated effort:** 60–90 min careful work.

## PR B — OKAMI 13-week list (OKAMI view, default mode)
Wire each of the 13 visible week rows.

**Per-row elements that exist:**
- `<input class="plan-route-input" data-w="N">` — routes max input
- `.plan-calc` cells — drivers needed / available / hire by
- `.plan-gap` — gap (color class warn/bad/ok)
- `.plan-status-pill` — Critical / Tight / On track / HVE absorbed
- Strategy pills (`.strategy-pill`) — Hire / ADW / +8h OT toggles

**Computation:**
- `routes_max` = max of daily targets in that week (from `okami_grid`)
- `drivers_needed` = `routes_max × DPR` (DPR from knob `#okami-dpr`)
- `available` = active driver count for that DSP
- `gap` = available − needed
- `hire_by` = current_date + lead-time backed off from week start
- `status` = thresholded by gap

**Save:**
- On `.plan-route-input` change: split new max evenly across the
  week's 7 days, call `okami_set_target` per day. Or store weekly
  total and pro-rate at read time — to discuss.

**Estimated effort:** 45–60 min.

## PR C — OKAMI per-week daily breakdown panel (image 1)
Drill-down rendered inside `#okami-detail-N` when row is expanded.

**Render:**
- 7 day inputs (Mon–Sun) for `routes_planned`
- "Shifts to schedule" row computed (`routes × (1 + cushion%)`)
- OVER-PLAN CUSHION sidebar with Percent / Headcount toggle, current
  value (`dsps.metadata.scheduling.cushion_pct`), recommended % from
  callout history (`shifts.status='called_off'` + `'no_show'` over 30d
  divided by total scheduled), Apply button.
- Week total + peak day labels at the bottom of the cushion panel.

**Save paths:**
- Per-day input: `okami_set_target(date, station_id, target)`
- Cushion: `okami_set_cushion(pct)`

**Estimated effort:** 45 min.

---

## Notes for whoever picks this up next

- Don't replace innerHTML on `#sched-sub-week`, `#okami-tbody`, or any
  `.dr-subview`. Always target specific child elements and update
  their text / values.
- Stations are in `public.stations`. Demo DSP has only DCA1 today;
  multi-station OKAMI needs station-aware grouping.
- Realtime publication already covers `okami_demand`, `shifts`,
  `time_off_requests` (migration 0024 + 0025) — re-renders happen
  via the existing dashboard refresh cycle.
- Save-back debounce pattern from the message editor (350ms) is a
  good reference.
