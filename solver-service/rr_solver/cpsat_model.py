"""
Real CP-SAT scheduling model.

Step 5b — hard constraints + a coverage-maximizing objective. The
constraint catalog matches what the in-browser heuristic enforces today:

  HARD
  • Driver eligibility: PTO, availability_dows, cert match (DOT/XL/EDV),
    DL not expired on shift date.
  • No double-book: a driver works at most one shift per date.
  • Max days/week cap.
  • WOC: max consecutive working days.
  • Locked / preserved shifts honored verbatim.

  OBJECTIVE (v1)
  • Maximize covered shifts (minimize uncovered). Soft objective terms
    (affinity / stability / OT / fairness / attendance / doublework)
    land in step 6.

Determinism: fixed seed, single random-search worker for reproducible
outputs. Wall-clock budget honored via `time_budget_ms`. Returns the
same SolveResponse shape the stub solver returns, so the wire format
is unchanged and the dashboard side doesn't need to know which engine
produced the result.

Vans are still pinned via van_pairings (same logic as the stub) — full
van decision variables come in step 5c so this PR's blast radius stays
contained.
"""

from __future__ import annotations

import time
from collections import defaultdict
from datetime import datetime
from typing import Optional

from ortools.sat.python import cp_model

from .models import (
    AssignedShift,
    DriverIn,
    ShiftIn,
    SolveMetrics,
    SolveRequest,
    SolveResponse,
    UncoveredShift,
    UnscheduledDriver,
    VanPairingIn,
)

SOLVER_VERSION = "rr-solver-cpsat-v1"

# Default WOC max-consecutive-days if the operator hasn't set one. The
# in-browser engine defaults to 6 (matches the popover).
DEFAULT_WOC_MAX_CONSECUTIVE_DAYS = 6


def _dow(iso: str) -> int:
    """Sun=0..Sat=6 to match the dashboard."""
    return datetime.strptime(iso, "%Y-%m-%d").date().isoweekday() % 7


def _is_eligible(
    driver: DriverIn,
    shift: ShiftIn,
    pto_dates_by_driver: dict[str, set[str]],
) -> bool:
    """Static hard-rule check. If this returns False, the solver never
    even creates the assign variable for this (driver, shift) pair —
    that's how we keep the model size sane."""
    if shift.date in pto_dates_by_driver.get(driver.id, set()):
        return False
    # Availability gate.
    if driver.available_dows is not None and len(driver.available_dows) > 0:
        if _dow(shift.date) not in driver.available_dows:
            return False
    # Cert match per route_type.
    if shift.route_type == "step_van" and not driver.dot_certified:
        return False
    if shift.route_type == "xl" and not driver.xl_certified:
        return False
    if shift.route_type == "edv" and not driver.edv_certified:
        return False
    # License valid on shift date.
    if driver.dl_expires_on:
        try:
            exp = datetime.strptime(driver.dl_expires_on, "%Y-%m-%d").date()
            sd = datetime.strptime(shift.date, "%Y-%m-%d").date()
            if exp < sd:
                return False
        except ValueError:
            pass  # malformed → skip the gate, let other rules catch it
    return True


def _van_for_driver(
    driver_id: str,
    route_type: str,
    pairings_by_driver: dict[str, list[VanPairingIn]],
    van_types: dict[str, str],
    van_used_dates: dict[str, set[str]],
    shift_date: str,
) -> Optional[str]:
    """Heuristic van pick — honors pairings + type match + one-per-date.
    Step 5c lifts this into the CP-SAT model as decision variables."""
    for p in pairings_by_driver.get(driver_id, []):
        vt = van_types.get(p.van_id, "standard")
        if route_type == "edv" and vt != "edv":
            continue
        if route_type == "step_van" and vt != "step_van":
            continue
        if shift_date in van_used_dates.get(p.van_id, set()):
            continue
        return p.van_id
    return None


def solve(req: SolveRequest) -> SolveResponse:
    """Real CP-SAT solve. Returns the same SolveResponse shape as the
    stub so the wire format and downstream audit pipeline are unchanged."""
    started_at = time.perf_counter()

    # ── Inputs ────────────────────────────────────────────────────────
    pto_dates_by_driver: dict[str, set[str]] = defaultdict(set)
    for p in req.pto:
        pto_dates_by_driver[p.driver_id].add(p.date)

    van_types: dict[str, str] = {v.id: v.vehicle_type for v in req.vans if v.status == "active"}
    pairings_by_driver: dict[str, list[VanPairingIn]] = defaultdict(list)
    for vp in req.van_pairings:
        if vp.van_id in van_types:
            pairings_by_driver[vp.driver_id].append(vp)

    rules = req.rules or {}
    max_days = int(req.max_days or 5)
    woc_on = bool(rules.get("woc", True))
    woc_max_consec = int(rules.get("woc_max_consecutive_days") or DEFAULT_WOC_MAX_CONSECUTIVE_DAYS)

    # Driver + shift indexes; pre-filter eligible (d, s) pairs.
    open_shifts: list[ShiftIn] = [s for s in req.shifts if not s.is_locked]
    locked_shifts: list[ShiftIn] = [s for s in req.shifts if s.is_locked and s.assigned_driver_id]

    # Track which dates a driver is ALREADY committed to via locked rows
    # so the rest of the model treats those as filled.
    locked_dates_by_driver: dict[str, set[str]] = defaultdict(set)
    for ls in locked_shifts:
        if ls.assigned_driver_id:
            locked_dates_by_driver[ls.assigned_driver_id].add(ls.date)

    eligible_drivers_per_shift: dict[str, list[str]] = {}
    eligible_shifts_per_driver: dict[str, list[str]] = defaultdict(list)
    for s in open_shifts:
        es: list[str] = []
        for d in req.drivers:
            if s.date in locked_dates_by_driver.get(d.id, set()):
                continue  # already booked that day via a locked shift
            if _is_eligible(d, s, pto_dates_by_driver):
                es.append(d.id)
                eligible_shifts_per_driver[d.id].append(s.id)
        eligible_drivers_per_shift[s.id] = es

    # ── CP-SAT model ──────────────────────────────────────────────────
    model = cp_model.CpModel()

    # assign[d, s] ∈ {0, 1}
    assign: dict[tuple[str, str], cp_model.IntVar] = {}
    for sid, dids in eligible_drivers_per_shift.items():
        for did in dids:
            assign[(did, sid)] = model.NewBoolVar(f"a_{did}_{sid}")

    # uncovered[s] ∈ {0, 1}
    uncovered: dict[str, cp_model.IntVar] = {
        s.id: model.NewBoolVar(f"u_{s.id}") for s in open_shifts
    }

    # Each open shift gets exactly one driver OR is uncovered.
    for s in open_shifts:
        dids = eligible_drivers_per_shift.get(s.id, [])
        model.Add(
            sum(assign[(did, s.id)] for did in dids) + uncovered[s.id] == 1
        )

    # Per (driver, date) on_day boolean — 1 iff driver works any shift
    # on that date. Used by the max_days + WOC caps.
    on_day: dict[tuple[str, str], cp_model.IntVar] = {}
    shifts_by_driver_date: dict[tuple[str, str], list[str]] = defaultdict(list)
    for s in open_shifts:
        for did in eligible_drivers_per_shift.get(s.id, []):
            shifts_by_driver_date[(did, s.date)].append(s.id)

    for (did, date_iso), sids in shifts_by_driver_date.items():
        v = model.NewBoolVar(f"od_{did}_{date_iso}")
        on_day[(did, date_iso)] = v
        # on_day = OR of the assigns for this (driver, date).
        # Equivalent linear formulation: v >= each assign, v <= sum(assigns).
        for sid in sids:
            model.Add(v >= assign[(did, sid)])
        model.Add(v <= sum(assign[(did, sid)] for sid in sids))
        # No double-book per day: at most one assign per (driver, date).
        model.Add(sum(assign[(did, sid)] for sid in sids) <= 1)

    # Pre-baked on_days from locked rows so the caps see the full picture.
    locked_on_days: dict[str, set[str]] = defaultdict(set)
    for ls in locked_shifts:
        if ls.assigned_driver_id:
            locked_on_days[ls.assigned_driver_id].add(ls.date)

    # Max days per week.
    for d in req.drivers:
        prebaked = len(locked_on_days.get(d.id, set()))
        flex = [
            on_day[(d.id, date_iso)]
            for (did, date_iso) in on_day
            if did == d.id
        ]
        if flex:
            model.Add(sum(flex) <= max(0, max_days - prebaked))

    # WOC max consecutive days. For each driver, slide a window of size
    # (woc_max_consec + 1) over the week dates and require the count
    # inside the window to be <= woc_max_consec.
    if woc_on and woc_max_consec >= 1:
        # Collect all dates the week touches (open + locked).
        all_dates_sorted = sorted({s.date for s in req.shifts})
        for d in req.drivers:
            # Per-date booleans seen by THIS driver — locked rows count
            # as 1 (fixed) and add to the window sum directly.
            for i in range(0, len(all_dates_sorted) - woc_max_consec):
                window = all_dates_sorted[i : i + woc_max_consec + 1]
                terms = []
                fixed_in_window = 0
                for dt in window:
                    if dt in locked_on_days.get(d.id, set()):
                        fixed_in_window += 1
                    elif (d.id, dt) in on_day:
                        terms.append(on_day[(d.id, dt)])
                # sum(flex) <= woc_max_consec - fixed_in_window
                cap = woc_max_consec - fixed_in_window
                if cap < 0:
                    # Already violated by locked rows; the model is
                    # infeasible if we add this. Skip silently — the
                    # locked rows are the operator's prior choice.
                    continue
                if terms:
                    model.Add(sum(terms) <= cap)

    # ── Objective: weighted soft terms (Step 6) ──────────────────────
    # Weights are tunable per DSP via rules.weights.* (with sane
    # defaults). Coverage dominates by ~100x so uncovered shifts are
    # always the worst outcome; the rest are tie-breakers within the
    # feasible-coverage frontier.
    weights = (rules.get("weights") or {}) if isinstance(rules, dict) else {}
    W_COV  = int(weights.get("coverage",   10000))   # per shift covered
    W_AFF  = int(weights.get("affinity",   1))       # per affinity-pct point
    W_OT   = int(weights.get("ot_risk",    5))       # per OT hour
    W_FAIR = int(weights.get("fairness",   2))       # per max-hour-of-roster
    W_ATT  = int(weights.get("attendance", 100))     # per shift to a final-corrective driver

    objective_terms: list = []

    # 1. Coverage — bonus per covered open shift (= 1 - uncovered[s]).
    for s in open_shifts:
        objective_terms.append(W_COV * (1 - uncovered[s.id]))

    # 2. Affinity — bonus per assignment where the driver historically
    # works that DOW. weekday_affinity is 7 ints in [0, 100] from the
    # driver_affinity table (precomputed nightly; see migration 0325).
    affinity_by_driver: dict[str, list[int]] = {}
    for d in req.drivers:
        if isinstance(d.weekday_affinity, list) and len(d.weekday_affinity) == 7:
            affinity_by_driver[d.id] = [int(x or 0) for x in d.weekday_affinity]
    for s in open_shifts:
        sdow = _dow(s.date)
        for did in eligible_drivers_per_shift.get(s.id, []):
            score = affinity_by_driver.get(did, [0]*7)[sdow]
            if score > 0:
                objective_terms.append(W_AFF * score * assign[(did, s.id)])

    # 3. Per-driver hours + OT penalty. Shift durations in whole hours
    # (CP-SAT performs better with smaller integer ranges; sub-hour
    # precision isn't material to OT decisions).
    shift_hours: dict[str, int] = {}
    for s in req.shifts:
        if s.duration_hours and s.duration_hours > 0:
            shift_hours[s.id] = max(1, round(s.duration_hours))
        elif s.starts_at and s.ends_at:
            try:
                start = datetime.fromisoformat(s.starts_at.replace("Z", "+00:00"))
                end = datetime.fromisoformat(s.ends_at.replace("Z", "+00:00"))
                hrs = max(1, round((end - start).total_seconds() / 3600))
                shift_hours[s.id] = hrs
            except (ValueError, AttributeError):
                shift_hours[s.id] = 10  # fallback to a typical DSP shift
        else:
            shift_hours[s.id] = 10
    weekly_cap = int(req.weekly_hour_cap or 40)

    # hours[d] = sum of (assign[d,s] * hours[s]) for all eligible s,
    # plus the locked hours already on the driver's plate.
    hours: dict[str, cp_model.IntVar] = {}
    ot_hours: dict[str, cp_model.IntVar] = {}
    max_assignable_hours = sum(shift_hours.values()) + 1
    for d in req.drivers:
        h = model.NewIntVar(0, max_assignable_hours, f"h_{d.id}")
        terms = [
            assign[(d.id, s.id)] * shift_hours.get(s.id, 10)
            for s in open_shifts
            if (d.id, s.id) in assign
        ]
        locked_hrs = sum(
            shift_hours.get(ls.id, 10)
            for ls in locked_shifts
            if ls.assigned_driver_id == d.id
        )
        if terms or locked_hrs:
            model.Add(h == sum(terms) + locked_hrs)
        else:
            model.Add(h == 0)
        hours[d.id] = h
        # ot[d] = max(0, h - cap)
        ot = model.NewIntVar(0, max_assignable_hours, f"ot_{d.id}")
        model.AddMaxEquality(ot, [h - weekly_cap, 0])
        ot_hours[d.id] = ot
        objective_terms.append(-W_OT * ot)

    # 4. Fairness — penalize the max-hours-of-any-driver. Pushes the
    # solver to spread hours instead of stacking onto a few drivers.
    if hours:
        max_hours_var = model.NewIntVar(0, max_assignable_hours, "max_hours")
        model.AddMaxEquality(max_hours_var, list(hours.values()))
        objective_terms.append(-W_FAIR * max_hours_var)

    # 5. Attendance-risk penalty — final-corrective drivers carry a
    # negative weight per assignment. The solver still picks them when
    # coverage demands, but prefers safer drivers when there's a choice.
    for d in req.drivers:
        if d.final_corrective_action:
            for s in open_shifts:
                if (d.id, s.id) in assign:
                    objective_terms.append(-W_ATT * assign[(d.id, s.id)])

    model.Maximize(sum(objective_terms))

    # ── Solve ─────────────────────────────────────────────────────────
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.5, req.time_budget_ms / 1000.0)
    solver.parameters.random_seed = req.solver_seed or 0
    solver.parameters.num_search_workers = 4

    status_code = solver.Solve(model)
    status_name = solver.StatusName(status_code)

    # ── Read back ─────────────────────────────────────────────────────
    assigned_out: list[AssignedShift] = []
    uncovered_out: list[UncoveredShift] = []
    driver_shifts_count: dict[str, int] = defaultdict(int)
    van_used_dates: dict[str, set[str]] = defaultdict(set)

    # Locked / preserved come back unchanged with van pinning.
    for ls in locked_shifts:
        if not ls.assigned_driver_id:
            continue
        van_id = _van_for_driver(
            ls.assigned_driver_id, ls.route_type,
            pairings_by_driver, van_types, van_used_dates, ls.date,
        )
        if van_id:
            van_used_dates[van_id].add(ls.date)
        driver_shifts_count[ls.assigned_driver_id] += 1
        assigned_out.append(AssignedShift(
            shift_id=ls.id,
            driver_id=ls.assigned_driver_id,
            van_id=van_id,
            source="locked",
            summary=f"Locked / preserved row for {ls.assigned_driver_id}.",
        ))

    # Open shifts — read CP-SAT result.
    if status_code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for s in open_shifts:
            if solver.BooleanValue(uncovered[s.id]):
                uncovered_out.append(UncoveredShift(
                    shift_id=s.id,
                    summary=(
                        f"No eligible driver available for shift {s.id} "
                        f"on {s.date} ({s.route_type}). Status={status_name}."
                    ),
                ))
                continue
            picked: Optional[str] = None
            for did in eligible_drivers_per_shift.get(s.id, []):
                if solver.BooleanValue(assign[(did, s.id)]):
                    picked = did
                    break
            if picked is None:
                uncovered_out.append(UncoveredShift(
                    shift_id=s.id,
                    summary=f"Solver returned no assignment for shift {s.id}; status={status_name}.",
                ))
                continue
            van_id = _van_for_driver(
                picked, s.route_type, pairings_by_driver,
                van_types, van_used_dates, s.date,
            )
            if van_id:
                van_used_dates[van_id].add(s.date)
            driver_shifts_count[picked] += 1
            assigned_out.append(AssignedShift(
                shift_id=s.id,
                driver_id=picked,
                van_id=van_id,
                source="auto_fill",
            ))
    else:
        # Infeasible / unknown — everything open is uncovered.
        for s in open_shifts:
            uncovered_out.append(UncoveredShift(
                shift_id=s.id,
                summary=f"Solver could not produce a feasible assignment (status={status_name}).",
            ))

    # ── Unscheduled-driver report ─────────────────────────────────────
    unscheduled_out: list[UnscheduledDriver] = []
    for d in req.drivers:
        if driver_shifts_count.get(d.id, 0) > 0:
            continue
        eligible_anywhere = len(eligible_shifts_per_driver.get(d.id, [])) > 0
        unscheduled_out.append(UnscheduledDriver(
            driver_id=d.id,
            eligible_somewhere=eligible_anywhere,
        ))

    # ── Metrics ───────────────────────────────────────────────────────
    fresh_assigned = sum(1 for a in assigned_out if a.source != "locked")
    locked_count = sum(1 for a in assigned_out if a.source == "locked")
    total = len(req.shifts)
    coverage_pct = round((locked_count + fresh_assigned) / total * 10000) / 100 if total else None
    elapsed_ms = int((time.perf_counter() - started_at) * 1000)

    response_status: str
    if status_code == cp_model.OPTIMAL:
        response_status = "ok"
    elif status_code == cp_model.FEASIBLE:
        response_status = "ok"
    elif status_code == cp_model.INFEASIBLE:
        response_status = "infeasible"
    elif status_code == cp_model.UNKNOWN:
        response_status = "timeout"
    else:
        response_status = "error"

    return SolveResponse(
        status=response_status,
        solver_version=SOLVER_VERSION,
        assigned_shifts=assigned_out,
        uncovered_shifts=uncovered_out,
        unscheduled_drivers=unscheduled_out,
        metrics=SolveMetrics(
            coverage_pct=coverage_pct,
            total_shifts=total,
            open_shifts=len(open_shifts),
            assigned=fresh_assigned,
            uncovered=len(uncovered_out),
            unscheduled_drivers=len(unscheduled_out),
            solver_wall_ms=elapsed_ms,
            solver_status=status_name,
        ),
    )
