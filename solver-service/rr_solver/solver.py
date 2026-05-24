"""
Solver core.

v1 (current): stub that produces a heuristic-shaped result so the wire
format end-to-end is validated. Every locked shift keeps its driver;
every open shift gets one of the eligible drivers (greedy least-loaded,
just like the in-browser engine). Vans pinned via van_pairings; the
rest left null.

v2 (step 5b): real CP-SAT model with hard constraints (license, cert,
PTO, double-book, WOC, max_days). Same response shape.

v3 (step 6): adds the objective function term-by-term (affinity,
preferred, stability, OT, fairness, attendance, doublework).
"""

from __future__ import annotations

import time
from collections import defaultdict
from datetime import datetime, date as date_cls
from typing import Optional

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

SOLVER_VERSION = "rr-solver-stub-v1"


def _dow(iso: str) -> int:
    """Sun=0..Sat=6 to match the dashboard."""
    return datetime.strptime(iso, "%Y-%m-%d").date().weekday() + 1 if False else \
        (datetime.strptime(iso, "%Y-%m-%d").date().isoweekday() % 7)


def _is_eligible(driver: DriverIn, shift: ShiftIn, pto_dates_by_driver: dict[str, set[str]]) -> bool:
    """Minimum hard-rule check the stub honors. The full catalog lands in
    v2; this is enough to make the stub's results non-nonsense."""
    if shift.id in pto_dates_by_driver.get(driver.id, set()):
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
    return True


def _van_for_driver(driver_id: str, route_type: str,
                    pairings_by_driver: dict[str, list[VanPairingIn]],
                    van_types: dict[str, str],
                    van_used_dates: dict[str, set[str]],
                    shift_date: str) -> Optional[str]:
    """Pick a van for this (driver, shift) honoring pairings + cert-match."""
    candidates = pairings_by_driver.get(driver_id, [])
    for p in candidates:
        # Type compatibility.
        vt = van_types.get(p.van_id, "standard")
        if route_type == "edv" and vt != "edv":
            continue
        if route_type == "xl" and vt not in ("xl", "standard"):
            continue
        if route_type == "step_van" and vt != "step_van":
            continue
        # One van per date.
        if shift_date in van_used_dates.get(p.van_id, set()):
            continue
        return p.van_id
    return None


def solve(req: SolveRequest) -> SolveResponse:
    """Stub solver. Returns a heuristic-shaped SolveResponse so the wire
    format end-to-end is validated. Real CP-SAT model replaces this in
    step 5b without changing the response shape."""
    started_at = time.perf_counter()

    pto_dates_by_driver: dict[str, set[str]] = defaultdict(set)
    for p in req.pto:
        pto_dates_by_driver[p.driver_id].add(p.date)

    van_types: dict[str, str] = {v.id: v.vehicle_type for v in req.vans if v.status == "active"}
    pairings_by_driver: dict[str, list[VanPairingIn]] = defaultdict(list)
    for vp in req.van_pairings:
        if vp.van_id in van_types:
            pairings_by_driver[vp.driver_id].append(vp)

    # Eligible (driver, shift) edges + per-driver shift count for greedy fairness.
    driver_by_id = {d.id: d for d in req.drivers}
    eligible: dict[str, list[str]] = defaultdict(list)  # shift_id → [driver_id]
    for s in req.shifts:
        if s.is_locked:
            continue
        for d in req.drivers:
            if _is_eligible(d, s, pto_dates_by_driver):
                eligible[s.id].append(d.id)

    # Greedy assignment: least-loaded eligible driver, deterministic
    # tie-break on driver id.
    driver_shifts: dict[str, list[str]] = defaultdict(list)
    driver_dates: dict[str, set[str]] = defaultdict(set)
    van_used_dates: dict[str, set[str]] = defaultdict(set)
    assigned: list[AssignedShift] = []
    uncovered: list[UncoveredShift] = []

    # Locked / preserved rows come through unchanged.
    for s in req.shifts:
        if not s.is_locked or not s.assigned_driver_id:
            continue
        van_id = _van_for_driver(s.assigned_driver_id, s.route_type,
                                 pairings_by_driver, van_types,
                                 van_used_dates, s.date)
        if van_id:
            van_used_dates[van_id].add(s.date)
        driver_shifts[s.assigned_driver_id].append(s.id)
        driver_dates[s.assigned_driver_id].add(s.date)
        assigned.append(AssignedShift(
            shift_id=s.id,
            driver_id=s.assigned_driver_id,
            van_id=van_id,
            source="locked",
            summary=f"Locked / preserved row for {s.assigned_driver_id}.",
        ))

    # Greedy fill of the rest, sorted by date then by id for determinism.
    sorted_shifts = sorted(
        [s for s in req.shifts if not s.is_locked],
        key=lambda s: (s.date, s.id),
    )
    for s in sorted_shifts:
        cands = [
            (len(driver_shifts[did]), did)
            for did in eligible.get(s.id, [])
            if s.date not in driver_dates[did]              # no double-book per day
            and len(driver_dates[did]) < req.max_days       # cap days
        ]
        if not cands:
            uncovered.append(UncoveredShift(
                shift_id=s.id,
                summary=f"No eligible driver under current constraints for shift {s.id}.",
            ))
            continue
        cands.sort()  # least-loaded first; deterministic tie-break on id
        _, picked = cands[0]
        van_id = _van_for_driver(picked, s.route_type,
                                 pairings_by_driver, van_types,
                                 van_used_dates, s.date)
        if van_id:
            van_used_dates[van_id].add(s.date)
        driver_shifts[picked].append(s.id)
        driver_dates[picked].add(s.date)
        assigned.append(AssignedShift(
            shift_id=s.id,
            driver_id=picked,
            van_id=van_id,
            source="auto_fill",
        ))

    # Unscheduled-driver report.
    unscheduled: list[UnscheduledDriver] = []
    for d in req.drivers:
        if d.id in driver_shifts:
            continue
        eligible_anywhere = any(d.id in eligible.get(s.id, []) for s in req.shifts)
        unscheduled.append(UnscheduledDriver(
            driver_id=d.id,
            eligible_somewhere=eligible_anywhere,
        ))

    fresh_assigned = sum(1 for a in assigned if a.source != "locked")
    locked_count = sum(1 for a in assigned if a.source == "locked")
    total_shifts = len(req.shifts)
    open_shifts = total_shifts - locked_count
    coverage = round((locked_count + fresh_assigned) / total_shifts * 10000) / 100 if total_shifts else None

    elapsed_ms = int((time.perf_counter() - started_at) * 1000)
    return SolveResponse(
        status="ok",
        solver_version=SOLVER_VERSION,
        assigned_shifts=assigned,
        uncovered_shifts=uncovered,
        unscheduled_drivers=unscheduled,
        metrics=SolveMetrics(
            coverage_pct=coverage,
            total_shifts=total_shifts,
            open_shifts=open_shifts,
            assigned=fresh_assigned,
            uncovered=len(uncovered),
            unscheduled_drivers=len(unscheduled),
            solver_wall_ms=elapsed_ms,
            solver_status="STUB_OK",
        ),
    )
