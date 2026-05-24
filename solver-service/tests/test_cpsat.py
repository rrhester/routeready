"""Smoke tests for the CP-SAT model. Exercise the hard constraints +
verify the coverage objective drives the result."""

from __future__ import annotations

import pytest

from rr_solver.cpsat_model import solve
from rr_solver.models import SolveRequest


def _req(**overrides):
    base = {
        "schedule_week_start": "2026-06-01",
        "max_days": 4,
        "weekly_hour_cap": 40,
        "rules": {},
        "drivers": [],
        "shifts": [],
        "vans": [],
        "van_pairings": [],
        "pto": [],
        "solver_seed": 0,
        "time_budget_ms": 2000,
    }
    base.update(overrides)
    return SolveRequest(**base)


def test_assigns_all_shifts_when_feasible():
    r = _req(
        drivers=[
            {"id": "d1", "available_dows": [1, 2, 3, 4, 5]},
            {"id": "d2", "available_dows": [1, 2, 3, 4, 5]},
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard"},
            {"id": "s2", "date": "2026-06-02", "route_type": "standard"},
            {"id": "s3", "date": "2026-06-03", "route_type": "standard"},
        ],
    )
    result = solve(r)
    assert result.status == "ok"
    assert len(result.assigned_shifts) == 3
    assert len(result.uncovered_shifts) == 0
    assert result.solver_version == "rr-solver-cpsat-v1"


def test_respects_max_days_cap():
    # One driver, 3 shifts on 3 different days, cap=2 → one must be open.
    r = _req(
        max_days=2,
        drivers=[{"id": "d1", "available_dows": [1, 2, 3, 4, 5]}],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard"},
            {"id": "s2", "date": "2026-06-02", "route_type": "standard"},
            {"id": "s3", "date": "2026-06-03", "route_type": "standard"},
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 2
    assert len(result.uncovered_shifts) == 1


def test_no_double_book_per_day():
    # Two shifts same day, one driver. Only one of them can take her.
    r = _req(
        drivers=[{"id": "d1", "available_dows": [0, 1, 2, 3, 4, 5, 6]}],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard"},
            {"id": "s2", "date": "2026-06-01", "route_type": "standard"},
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 1
    assert len(result.uncovered_shifts) == 1


def test_availability_gate_blocks_assignment():
    # Driver only available Mon/Tue; the only shift is on Thursday.
    r = _req(
        drivers=[{"id": "d1", "available_dows": [1, 2]}],
        shifts=[
            {"id": "s1", "date": "2026-06-04", "route_type": "standard"},  # Thu
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 0
    assert len(result.uncovered_shifts) == 1


def test_cert_match_required_for_edv():
    # Two drivers, one EDV-certified. Two EDV shifts on different days.
    r = _req(
        drivers=[
            {"id": "d1", "available_dows": [1, 2], "edv_certified": True},
            {"id": "d2", "available_dows": [1, 2], "edv_certified": False},
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "edv"},
            {"id": "s2", "date": "2026-06-02", "route_type": "edv"},
        ],
    )
    result = solve(r)
    # Only d1 is eligible; she takes both.
    assert len(result.assigned_shifts) == 2
    assert all(a.driver_id == "d1" for a in result.assigned_shifts)
    # d2 ends up unscheduled (eligible nowhere given the cert gate).
    d2 = next((u for u in result.unscheduled_drivers if u.driver_id == "d2"), None)
    assert d2 is not None
    assert d2.eligible_somewhere is False


def test_expired_license_blocks_assignment():
    r = _req(
        drivers=[{"id": "d1", "available_dows": [1], "dl_expires_on": "2026-01-01"}],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 0
    assert len(result.uncovered_shifts) == 1


def test_pto_blocks_date():
    r = _req(
        drivers=[{"id": "d1", "available_dows": [1, 2]}],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard"},
            {"id": "s2", "date": "2026-06-02", "route_type": "standard"},
        ],
        pto=[{"driver_id": "d1", "date": "2026-06-01"}],
    )
    result = solve(r)
    # s1 uncovered (PTO), s2 assigned.
    assigned_ids = {a.shift_id for a in result.assigned_shifts}
    uncovered_ids = {u.shift_id for u in result.uncovered_shifts}
    assert "s1" in uncovered_ids
    assert "s2" in assigned_ids


def test_locked_rows_preserved():
    r = _req(
        drivers=[
            {"id": "d1", "available_dows": [1, 2]},
            {"id": "d2", "available_dows": [1, 2]},
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard",
             "is_locked": True, "assigned_driver_id": "d1"},
            {"id": "s2", "date": "2026-06-02", "route_type": "standard"},
        ],
    )
    result = solve(r)
    # Locked row keeps d1; open shift goes to someone eligible.
    locked = [a for a in result.assigned_shifts if a.source == "locked"]
    assert len(locked) == 1
    assert locked[0].driver_id == "d1"
    assert locked[0].shift_id == "s1"


def test_woc_max_consecutive_days_caps_run_length():
    # 5 shifts in a row, one driver, WOC cap = 3 → max 3 assigned.
    r = _req(
        max_days=7,
        rules={"woc": True, "woc_max_consecutive_days": 3},
        drivers=[{"id": "d1", "available_dows": [0, 1, 2, 3, 4, 5, 6]}],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard"},
            {"id": "s2", "date": "2026-06-02", "route_type": "standard"},
            {"id": "s3", "date": "2026-06-03", "route_type": "standard"},
            {"id": "s4", "date": "2026-06-04", "route_type": "standard"},
            {"id": "s5", "date": "2026-06-05", "route_type": "standard"},
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 3
    assert len(result.uncovered_shifts) == 2


def test_van_pinning_via_pairing():
    r = _req(
        drivers=[{"id": "d1", "available_dows": [1]}],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],
        vans=[{"id": "v1", "code": "VAN-1", "status": "active",
               "vehicle_type": "standard"}],
        van_pairings=[{"driver_id": "d1", "van_id": "v1", "kind": "primary"}],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 1
    assert result.assigned_shifts[0].van_id == "v1"
