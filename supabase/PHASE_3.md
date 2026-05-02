# Phase 3 — Schedule + OKAMI

Closes the operational loop. After Phase 2 (attendance + HR file), the
last missing piece for a DSP to run end-to-end was **the schedule
itself** — assigning drivers to routes, handling swaps, approving time
off, and the OKAMI capacity plan that drives shift counts. This phase
ships all of that.

This is the phase where **the flywheel closes** at the database layer:

```
   suspension (Phase 2) → cascades → future shifts open (Phase 3)
   open shifts (Phase 3) → surface in dispatcher view → backfill needed
   OKAMI demand (Phase 3) → drives daily target × cushion → shifts to schedule
```

Still no external integrations — Twilio / Indeed / Cal.com remain
deferred to Phase 4.

---

## Files added

```
supabase/
  migrations/
    20260510090000_schedule.sql                # routes + shifts + status enum + RLS
    20260510100000_swaps_and_timeoff.sql       # swap_requests + time_off_requests
    20260510110000_okami.sql                   # okami_weeks + cushion math + recommendation
    20260510120000_phase3_rpcs.sql             # assign / unassign / publish / swap / timeoff / okami / release_future_shifts
    20260510130000_phase3_audit_and_cascade.sql # audit triggers + hr_events → shifts cascade
  tests/rls/
    schedule.test.sql                          # 15 assertions: assign / suspend cascade / publish
    swap_timeoff_okami.test.sql                # 15 assertions: swap workflow + time-off + OKAMI math
  seed.sql                                     # extended with 6 routes, 1 week of shifts, OKAMI W19
  PHASE_3.md                                   # this file
```

---

## What ships

### Schedule (`shifts`)
- `shift_status` enum: `scheduled / open / swap_pending / vto / timeoff / off`
- One row per (driver, date) — exclusion constraint prevents double-booking
- `published` flag for Draft → Posted lifecycle
- `assign_shift(driver, route, date)` RPC — dispatcher+
- `unassign_shift(shift)` RPC — flips driver_id to NULL and status to `'open'`
- `publish_week(week_start)` RPC — ops+, marks all shifts that week as published

### Swap requests
- Directed (Driver A → Driver B) **or** open marketplace (`to_driver_id IS NULL`)
- `request_swap` (driver self / staff on driver's behalf) — flips shift to `swap_pending`
- `decide_swap(swap_id, approve, notes)` — ops+, approve flips driver_id, deny restores
- One pending swap per shift (unique partial index)
- Drivers can only update *their own* requests, only to `'cancelled'` (column-level guard)

### Time-off requests
- Categories: `pto / sick / jury / bereavement / fmla / workplace_injury / unpaid / other`
- `request_time_off` (driver self / ops+)
- `decide_time_off(request_id, approve, notes)` — ops+
- On approve:
  - All matching shifts in the date range flip to `status='timeoff'`
  - All matching attendance events in the date range get auto-exempted with the appropriate category (PTO → Approved PTO, FMLA → FMLA, etc.)

### OKAMI capacity (`okami_weeks`)
- One row per (DSP, optional station, ISO week)
- `daily_targets` JSONB: `{mon, tue, wed, thu, fri, sat, sun}` route counts
- Cushion: `percent` mode (e.g. 10%) or `count` mode (e.g. +5/day)
- `dpr` (drivers per route), `adw` (average days/week), `ot_hours`
- `is_hve` and `is_peak` flags
- `set_okami_week(...)` RPC — upserts on (dsp, station, year, week)
- `okami_shifts_needed(routes, mode, value)` pure compute function
- `okami_recommend_cushion(dsp_id)` — reads attendance signal, returns
  `{percent, absences, vtos, note}` mirroring the mockup's recommendation
  engine. Push UP from callouts/no-shows; push DOWN from high VTO rate.
- `weekly_demand_vs_supply` view — drives the Pipeline Coverage panel and
  the Schedule banner

### The Phase 2 → Phase 3 cascade
**This is the single most important Phase 3 deliverable.** When a driver
is suspended (Phase 2 `process_suspension`), the new
`cascade_suspension_to_shifts` trigger automatically:

1. Finds all that driver's future shifts where status ∈ `(scheduled,
   swap_pending, vto)` and `shift_date >= effective_date`
2. Flips them to `status='open'`, clears `driver_id`, clears any swap
3. Appends `'Released after suspension'` to the shift notes

Reinstatement does **not** auto-reassign — that's a manual dispatcher
decision (would be surprising otherwise).

### Audit triggers
All five new tables (`routes`, `shifts`, `swap_requests`,
`time_off_requests`, `okami_weeks`) get audit triggers feeding the
existing `audit_log` table from Phase 1.

---

## Run it locally

```bash
supabase db reset
supabase test db
```

Expected:

```
Seed loaded: 2 DSPs, 3 staff, 8 drivers, 11 att, 1 HR, 1 coach,
             6 routes, 30+ shifts, 1 OKAMI weeks

# multi_tenant.test.sql:        15 of 15 passing
# hr_immutability.test.sql:     20 of 20 passing
# attendance.test.sql:          12 of 12 passing
# schedule.test.sql:            15 of 15 passing
# swap_timeoff_okami.test.sql:  15 of 15 passing
# Total:                        77 of 77 passing
```

---

## Try it from the SQL editor

```sql
-- as ops@cardinal.test:

-- Cushion recommendation from current attendance signal
select public.okami_recommend_cushion('11111111-1111-1111-1111-111111111111');
-- Returns: { percent: 8, absences: 6, vtos: 3, total_scheduled: 154,
--            note: '6 callout/no-show + 3 VTO event(s) (1.9%) within healthy band' }

-- Set the next week's OKAMI plan
select public.set_okami_week(
  extract(isoyear from current_date)::int,
  extract(week    from current_date)::int + 1,
  date_trunc('week', current_date + 7)::date,
  40,
  '{"mon":38,"tue":40,"wed":40,"thu":42,"fri":42,"sat":30,"sun":20}'::jsonb,
  'percent', 10
);

-- Assign a shift
select public.assign_shift(
  'dddd0001-0000-0000-0000-000000000005'::uuid,    -- Devon
  'rrrr0001-0000-0000-0000-000000000005'::uuid,    -- KMO3-04D
  current_date + 7
);

-- Suspend Marcus and watch the cascade
select public.process_suspension(
  'dddd0001-0000-0000-0000-000000000001'::uuid,
  current_date, current_date + 5, false, 'attendance',
  'Marcus crossed attendance threshold this cycle.'
);

-- Verify all his future shifts are open
select shift_date, status, driver_id
  from public.shifts
 where dsp_id = '11111111-1111-1111-1111-111111111111'
   and shift_date >= current_date
 order by shift_date;
-- Should show his prior shifts now status=open, driver_id=null
```

---

## Combined test count

| Phase | File | Assertions |
|---|---|---|
| 1 | `multi_tenant.test.sql` | 15 |
| 2 | `hr_immutability.test.sql` | 20 |
| 2 | `attendance.test.sql` | 12 |
| 3 | `schedule.test.sql` | 15 |
| 3 | `swap_timeoff_okami.test.sql` | 15 |
| **Total** | | **77** |

CI runs all 77 on every migration. If any fail, don't merge.

---

## What's intentionally NOT in Phase 3

- **No real-time updates.** Shift edits don't push to other dispatcher
  tabs yet. Supabase Realtime config + frontend subscription is part of
  the frontend wiring work, not the schema.
- **No AI auto-fill week.** The mockup's "Auto-fill week" button is V2.
  Constraint solver is its own project.
- **No OT / cushion abuse audit.** A DSP could set 50% cushion to game
  VTO — guardrail caps and audit dashboards land in V2.
- **No frontend wiring.** The mockup still renders mock data. Wiring
  the schedule grid to query `shifts` happens during/after Phase 3.
- **No Twilio for swap notifications.** When a swap is approved, no
  SMS goes out. That's Phase 4.

---

## Pre-Phase-4 checklist

- [ ] All 77 pgTAP green in CI
- [ ] Migrations applied to `routeready-staging`
- [ ] Manual: suspend a driver, verify all future shifts flip to open
- [ ] Manual: open marketplace swap → ops sets to_driver_id, approves,
      shift reassigns
- [ ] Manual: approve a time-off request that overlaps a callout — verify
      the callout was auto-exempted with the matching category
- [ ] Frontend Schedule week view wired to `shifts` rows + `assign_shift`
- [ ] Frontend OKAMI page wired to `okami_weeks` + `set_okami_week` +
      `okami_recommend_cushion`
- [ ] **TCPA review starts now.** Phase 4 sends SMS at scale — counsel
      and Twilio A2P registration must be in flight before Phase 4 work
      begins.

---

## Open issues to resolve in Phase 3 review

1. **Daily targets vs aggregate.** `okami_weeks.daily_targets` is JSONB
   with `mon..sun` keys. The dashboard currently treats `routes_max` as
   the maximum of these days. There's no enforcement — you can set
   `routes_max = 50` with daily targets summing to 100. Consider a
   trigger that recomputes `routes_max = max(daily values)`.

2. **VTO event creation on shift status change.** When a shift flips to
   `status='vto'` (driver accepted offer), should the system also create
   an `attendance_events` row of `event_type='vto'`? Currently both
   coexist — the check-in flow creates the attendance event, but a swap
   marking the shift VTO doesn't. Decide: keep them coupled (trigger) or
   require both calls.

3. **Open-shift claim flow.** Drivers should be able to claim an open
   shift. Currently `request_swap` only handles driver A → driver B.
   Add `claim_open_shift(shift_id)` RPC — driver self-service. Skipped
   for V1 because it overlaps with swap approval workflow.

4. **`exclude` constraint on shifts.** The exclusion constraint prevents
   double-booking but only for `(scheduled, swap_pending, vto)` statuses.
   `timeoff` and `off` are excluded. Verify this matches the desired UX —
   a driver on PTO who's also (incorrectly) marked as on a shift would
   slip through.

5. **Cascade for `pending_termination`.** The trigger releases shifts on
   `suspension`, `pending_termination`, and `termination`. But
   `pending_termination` doesn't currently flip `drivers.status` to
   `terminated` — it flips to `'suspended'`. Verify the UX matches
   intent: pending term holds the seat (driver may come back) but
   releases the shifts (driver isn't running routes during review).
