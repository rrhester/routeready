"""Soft-objective tests (Step 6). Hard constraints are covered in
test_cpsat.py; these verify the solver makes the *quality* trade-offs
the design says it should when multiple feasible assignments exist."""

from __future__ import annotations

import pytest

from rr_solver.cpsat_model import solve
from rr_solver.models import SolveRequest


def _req(**overrides):
    base = {
        "schedule_week_start": "2026-06-01",
        "max_days": 7,
        "weekly_hour_cap": 40,
        "rules": {},
        "drivers": [],
        "shifts": [],
        "vans": [],
        "van_pairings": [],
        "pto": [],
        "solver_seed": 0,
        "time_budget_ms": 3000,
    }
    base.update(overrides)
    return SolveRequest(**base)


def test_affinity_breaks_ties_toward_high_affinity_driver():
    """Two drivers both eligible for the same Wednesday shift; one has
    high Wed affinity, the other has high Friday affinity. Solver should
    prefer the Wed-affinity driver for the Wed shift."""
    r = _req(
        drivers=[
            # Sun=0, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6
            {"id": "d_wed", "available_dows": [3], "weekday_affinity": [0,0,0,90,0,0,0]},
            {"id": "d_fri", "available_dows": [3], "weekday_affinity": [0,0,0,10,0,90,0]},
        ],
        shifts=[
            {"id": "s_wed", "date": "2026-06-03", "route_type": "standard", "duration_hours": 10},
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 1
    assert result.assigned_shifts[0].driver_id == "d_wed"


def test_fairness_spreads_hours_across_drivers():
    """Two equal-eligibility drivers, four shifts on four different days.
    Without fairness, the solver could load one driver and starve the
    other. Fairness pressure (minimize max-hours) should produce a
    roughly even 2-and-2 split."""
    r = _req(
        max_days=7,
        drivers=[
            {"id": "d1", "available_dows": [1, 2, 3, 4, 5]},
            {"id": "d2", "available_dows": [1, 2, 3, 4, 5]},
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard", "duration_hours": 10},
            {"id": "s2", "date": "2026-06-02", "route_type": "standard", "duration_hours": 10},
            {"id": "s3", "date": "2026-06-03", "route_type": "standard", "duration_hours": 10},
            {"id": "s4", "date": "2026-06-04", "route_type": "standard", "duration_hours": 10},
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 4
    counts = {"d1": 0, "d2": 0}
    for a in result.assigned_shifts:
        counts[a.driver_id] += 1
    # Roughly even — fairness pressure forces ≤3-to-1 even though both
    # drivers are equally eligible everywhere.
    assert abs(counts["d1"] - counts["d2"]) <= 2
    # And neither should be totally idle when the other is eligible.
    assert counts["d1"] > 0 and counts["d2"] > 0


def test_ot_penalty_prefers_under_cap_driver_when_a_choice_exists():
    """Two drivers both eligible Friday. Driver A already has 40
    locked hours (would push them over cap with one more shift).
    Driver B has 0 locked hours. Solver should pick B."""
    r = _req(
        weekly_hour_cap=40,
        max_days=7,
        drivers=[
            {"id": "d_loaded", "available_dows": [5]},
            {"id": "d_fresh",  "available_dows": [5]},
        ],
        shifts=[
            # 4 locked rows for d_loaded → 40h pre-baked
            {"id": "L1", "date": "2026-06-01", "route_type": "standard",
             "duration_hours": 10, "is_locked": True, "assigned_driver_id": "d_loaded"},
            {"id": "L2", "date": "2026-06-02", "route_type": "standard",
             "duration_hours": 10, "is_locked": True, "assigned_driver_id": "d_loaded"},
            {"id": "L3", "date": "2026-06-03", "route_type": "standard",
             "duration_hours": 10, "is_locked": True, "assigned_driver_id": "d_loaded"},
            {"id": "L4", "date": "2026-06-04", "route_type": "standard",
             "duration_hours": 10, "is_locked": True, "assigned_driver_id": "d_loaded"},
            # Open Friday shift — both are eligible.
            {"id": "open_fri", "date": "2026-06-05", "route_type": "standard",
             "duration_hours": 10},
        ],
    )
    result = solve(r)
    # Find the assignment for open_fri.
    fri = next(a for a in result.assigned_shifts if a.shift_id == "open_fri")
    assert fri.driver_id == "d_fresh"


def test_attendance_penalty_prefers_clean_driver():
    """Two equally-eligible drivers; one has a final corrective action.
    Solver should pick the clean driver when there's a choice."""
    r = _req(
        drivers=[
            {"id": "d_risky", "available_dows": [1], "final_corrective_action": True},
            {"id": "d_clean", "available_dows": [1], "final_corrective_action": False},
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard", "duration_hours": 10},
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 1
    assert result.assigned_shifts[0].driver_id == "d_clean"


def test_coverage_still_dominates_when_only_choice_is_risky():
    """Same setup, but only the risky driver is eligible. Coverage
    is the dominant term — solver must still take her instead of
    leaving the shift uncovered."""
    r = _req(
        drivers=[
            {"id": "d_risky", "available_dows": [1], "final_corrective_action": True},
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard", "duration_hours": 10},
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 1
    assert len(result.uncovered_shifts) == 0
    assert result.assigned_shifts[0].driver_id == "d_risky"


def test_coverage_still_dominates_when_ot_is_the_only_option():
    """Coverage must beat OT avoidance — a 40h-locked driver still
    takes the open shift if she's the only eligible driver."""
    r = _req(
        weekly_hour_cap=40,
        max_days=7,
        drivers=[{"id": "d1", "available_dows": [1, 2, 3, 4, 5]}],
        shifts=[
            {"id": "L1", "date": "2026-06-01", "route_type": "standard",
             "duration_hours": 10, "is_locked": True, "assigned_driver_id": "d1"},
            {"id": "L2", "date": "2026-06-02", "route_type": "standard",
             "duration_hours": 10, "is_locked": True, "assigned_driver_id": "d1"},
            {"id": "L3", "date": "2026-06-03", "route_type": "standard",
             "duration_hours": 10, "is_locked": True, "assigned_driver_id": "d1"},
            {"id": "L4", "date": "2026-06-04", "route_type": "standard",
             "duration_hours": 10, "is_locked": True, "assigned_driver_id": "d1"},
            {"id": "open_fri", "date": "2026-06-05", "route_type": "standard",
             "duration_hours": 10},
        ],
    )
    result = solve(r)
    fri = next((a for a in result.assigned_shifts if a.shift_id == "open_fri"), None)
    assert fri is not None
    assert fri.driver_id == "d1"
