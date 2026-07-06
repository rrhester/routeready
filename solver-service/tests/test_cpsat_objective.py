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


def test_fca_schedule_last_beats_the_target_days_wall():
    """attendance_penalty=True ("Schedule Final-corrective drivers last")
    escalates the FCA penalty above the target-days wall: the clean
    driver absorbs BOTH days — going past her soft target — and the
    final-corrective driver gets nothing. Under the legacy soft penalty
    (checkbox untouched) the solver would split 1-and-1 instead, because
    an FCA shift (-100) is cheaper than an over-target day (-10k)."""
    base = dict(
        drivers=[
            {"id": "d_risky", "available_dows": [1, 2], "final_corrective_action": True},
            {"id": "d_clean", "available_dows": [1, 2]},
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard", "duration_hours": 10},
            {"id": "s2", "date": "2026-06-02", "route_type": "standard", "duration_hours": 10},
        ],
    )
    # Legacy (key absent): target wall wins — each driver takes one day.
    legacy = solve(_req(rules={"target_days_per_week": 1}, **base))
    legacy_counts = {}
    for a in legacy.assigned_shifts:
        legacy_counts[a.driver_id] = legacy_counts.get(a.driver_id, 0) + 1
    assert legacy_counts == {"d_risky": 1, "d_clean": 1}
    # Schedule-last: the clean driver takes both; the FCA driver sits.
    hard = solve(_req(
        rules={"attendance_penalty": True, "target_days_per_week": 1}, **base,
    ))
    assert len(hard.assigned_shifts) == 2
    assert all(a.driver_id == "d_clean" for a in hard.assigned_shifts)


def test_fca_schedule_last_never_sacrifices_xl_coverage():
    """XL routes are protected at all costs: when the final-corrective
    driver is the only XL-certified one, she still runs the XL route
    even in schedule-last mode — and the clean driver keeps the
    standard route."""
    r = _req(
        rules={"attendance_penalty": True},
        drivers=[
            {"id": "d_risky_xl", "available_dows": [1], "xl_certified": True,
             "final_corrective_action": True},
            {"id": "d_clean", "available_dows": [1]},
        ],
        shifts=[
            {"id": "s_xl", "date": "2026-06-01", "route_type": "xl", "duration_hours": 10},
            {"id": "s_std", "date": "2026-06-01", "route_type": "standard", "duration_hours": 10},
        ],
    )
    result = solve(r)
    assert len(result.uncovered_shifts) == 0
    by_shift = {a.shift_id: a.driver_id for a in result.assigned_shifts}
    assert by_shift["s_xl"] == "d_risky_xl"
    assert by_shift["s_std"] == "d_clean"


def test_fca_penalty_off_when_checkbox_explicitly_false():
    """attendance_penalty=False disables the FCA preference entirely —
    a final-corrective driver with strong Monday affinity beats a clean
    driver with none (the legacy soft penalty would have outweighed the
    affinity edge and flipped the pick)."""
    r = _req(
        rules={"attendance_penalty": False},
        drivers=[
            {"id": "d_risky", "available_dows": [1], "final_corrective_action": True,
             "weekday_affinity": [0, 90, 0, 0, 0, 0, 0]},
            {"id": "d_clean", "available_dows": [1]},
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard", "duration_hours": 10},
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 1
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


def test_target_days_caps_drivers_at_soft_target():
    """target_days_per_week=4: with two equally-eligible drivers and 8
    shifts across 5 weekdays, the solver should split work so neither
    driver exceeds 4 days. Without the soft cap one driver might take
    all 5 days while the other gets 3."""
    r = _req(
        max_days=7,
        rules={"target_days_per_week": 4},
        drivers=[
            {"id": "d1", "available_dows": [1, 2, 3, 4, 5]},
            {"id": "d2", "available_dows": [1, 2, 3, 4, 5]},
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard", "duration_hours": 10},
            {"id": "s2", "date": "2026-06-02", "route_type": "standard", "duration_hours": 10},
            {"id": "s3", "date": "2026-06-03", "route_type": "standard", "duration_hours": 10},
            {"id": "s4", "date": "2026-06-04", "route_type": "standard", "duration_hours": 10},
            {"id": "s5", "date": "2026-06-05", "route_type": "standard", "duration_hours": 10},
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 5
    days_by_driver = {"d1": set(), "d2": set()}
    for a in result.assigned_shifts:
        # find the shift's date
        for s in r.shifts:
            if s.id == a.shift_id:
                days_by_driver[a.driver_id].add(s.date)
                break
    # Neither driver exceeds the target of 4 days.
    assert len(days_by_driver["d1"]) <= 4
    assert len(days_by_driver["d2"]) <= 4


def test_target_days_coverage_wins_when_no_alternative():
    """Single driver, 6 shifts across 6 weekdays, target=4. The soft
    cap penalizes days 5 and 6, but coverage need wins — every shift
    gets filled even though the driver goes 2 days over target."""
    r = _req(
        max_days=7,
        rules={"target_days_per_week": 4},
        drivers=[{"id": "d1", "available_dows": [1, 2, 3, 4, 5, 6]}],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard", "duration_hours": 10},
            {"id": "s2", "date": "2026-06-02", "route_type": "standard", "duration_hours": 10},
            {"id": "s3", "date": "2026-06-03", "route_type": "standard", "duration_hours": 10},
            {"id": "s4", "date": "2026-06-04", "route_type": "standard", "duration_hours": 10},
            {"id": "s5", "date": "2026-06-05", "route_type": "standard", "duration_hours": 10},
            {"id": "s6", "date": "2026-06-06", "route_type": "standard", "duration_hours": 10},
        ],
    )
    result = solve(r)
    # All 6 fill — coverage need overrides the soft cap.
    assert len(result.assigned_shifts) == 6


def test_target_days_zero_disables_cap():
    """target_days_per_week=0 disables the soft cap entirely; the
    solver's other components (fairness, etc.) drive distribution."""
    r = _req(
        max_days=7,
        rules={"target_days_per_week": 0},
        drivers=[{"id": "d1", "available_dows": [1, 2, 3, 4, 5]}],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard", "duration_hours": 10},
            {"id": "s2", "date": "2026-06-02", "route_type": "standard", "duration_hours": 10},
            {"id": "s3", "date": "2026-06-03", "route_type": "standard", "duration_hours": 10},
            {"id": "s4", "date": "2026-06-04", "route_type": "standard", "duration_hours": 10},
            {"id": "s5", "date": "2026-06-05", "route_type": "standard", "duration_hours": 10},
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 5
