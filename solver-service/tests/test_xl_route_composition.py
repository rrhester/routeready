"""XL route composition (operator staffing model).

A dispatched XL route runs TWO people on the road: one XL-certified driver
plus one helper who needs no certification. In the shift model that route is
two shift rows sharing a route_code — a regular XL seat (route_type "xl",
cert-gated) and a helper seat (route_type "xl", shift_kind "helper", not
gated). These tests lock in that the solver fills such a pair correctly.
"""

from __future__ import annotations

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


def _xl_route(route_code="R1", date="2026-06-01"):
    """A single XL route = one cert-gated driver seat + one helper seat."""
    return [
        {"id": f"{route_code}-drv", "date": date, "route_type": "xl",
         "route_code": route_code, "duration_hours": 10},
        {"id": f"{route_code}-help", "date": date, "route_type": "xl",
         "shift_kind": "helper", "route_code": route_code, "duration_hours": 10},
    ]


def test_xl_route_filled_by_one_certified_plus_one_helper():
    r = _req(
        drivers=[
            {"id": "cert", "available_dows": [1], "xl_certified": True},
            {"id": "plain", "available_dows": [1], "xl_certified": False},
        ],
        shifts=_xl_route(),
    )
    result = solve(r)
    by_shift = {a.shift_id: a.driver_id for a in result.assigned_shifts}
    # Both seats covered...
    assert set(by_shift) == {"R1-drv", "R1-help"}
    # ...and the only feasible split: the certified driver takes the driver
    # seat (only they can), the uncertified driver rides as the helper.
    assert by_shift["R1-drv"] == "cert"
    assert by_shift["R1-help"] == "plain"


def test_xl_driver_seat_uncovered_when_no_certified_driver():
    # Only an uncertified driver available: the helper seat fills, the
    # cert-gated driver seat stays uncovered (the gate still bites).
    r = _req(
        drivers=[
            {"id": "plain", "available_dows": [1], "xl_certified": False},
        ],
        shifts=_xl_route(),
    )
    result = solve(r)
    by_shift = {a.shift_id: a.driver_id for a in result.assigned_shifts}
    assert "R1-help" in by_shift          # helper seat filled by the plain driver
    assert by_shift.get("R1-drv") is None  # driver seat cannot be filled
