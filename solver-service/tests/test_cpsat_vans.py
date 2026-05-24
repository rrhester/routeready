"""Van-decision-variable tests (Step 5c). Verifies vans are now
first-class CP-SAT decisions, not heuristic post-pass picks."""

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
        "ad_hoc_constraints": [],
        "solver_seed": 0,
        "time_budget_ms": 3000,
    }
    base.update(overrides)
    return SolveRequest(**base)


def test_paired_van_assigned_when_driver_takes_shift():
    """One driver, one paired van, one shift. Solver should assign
    both; the continuity bonus makes this strictly preferred."""
    r = _req(
        drivers=[{"id": "d1", "available_dows": [1]}],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],
        vans=[{"id": "v1", "code": "VAN-1", "status": "active",
               "vehicle_type": "standard"}],
        van_pairings=[{"driver_id": "d1", "van_id": "v1", "kind": "primary"}],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 1
    assert result.assigned_shifts[0].driver_id == "d1"
    assert result.assigned_shifts[0].van_id == "v1"


def test_van_no_double_book_per_date():
    """Two shifts on the same date, two drivers, ONE van. The van
    can only go to one of them — the other shift is van-less."""
    r = _req(
        drivers=[
            {"id": "d1", "available_dows": [1]},
            {"id": "d2", "available_dows": [1]},
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard"},
            {"id": "s2", "date": "2026-06-01", "route_type": "standard"},
        ],
        vans=[{"id": "v1", "code": "VAN-1", "status": "active",
               "vehicle_type": "standard"}],
    )
    result = solve(r)
    # Both shifts assigned (different drivers), only one has a van.
    assert len(result.assigned_shifts) == 2
    with_van = sum(1 for a in result.assigned_shifts if a.van_id)
    assert with_van == 1


def test_van_type_compatibility_blocks_assignment():
    """EDV shift, one driver EDV-certified, one EDV van + one
    standard van. The standard van must NOT be assigned to the
    EDV shift; only v_edv goes."""
    r = _req(
        drivers=[{"id": "d1", "available_dows": [1], "edv_certified": True}],
        shifts=[{"id": "s_edv", "date": "2026-06-01", "route_type": "edv"}],
        vans=[
            {"id": "v_std", "code": "STD", "status": "active",
             "vehicle_type": "standard"},
            {"id": "v_edv", "code": "EDV", "status": "active",
             "vehicle_type": "edv"},
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 1
    assert result.assigned_shifts[0].van_id == "v_edv"


def test_inactive_van_excluded():
    """Repair-status van isn't available; shift goes van-less."""
    r = _req(
        drivers=[{"id": "d1", "available_dows": [1]}],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],
        vans=[{"id": "v1", "code": "VAN-1", "status": "repair",
               "vehicle_type": "standard"}],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 1
    assert result.assigned_shifts[0].van_id is None


def test_continuity_bonus_prefers_paired_van_over_unpaired():
    """Two type-compatible vans available. Driver paired with v1.
    Solver should prefer v1 (continuity bonus); v2 stays unassigned."""
    r = _req(
        drivers=[{"id": "d1", "available_dows": [1]}],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],
        vans=[
            {"id": "v1", "code": "VAN-1", "status": "active",
             "vehicle_type": "standard"},
            {"id": "v2", "code": "VAN-2", "status": "active",
             "vehicle_type": "standard"},
        ],
        van_pairings=[{"driver_id": "d1", "van_id": "v1", "kind": "primary"}],
    )
    result = solve(r)
    assert result.assigned_shifts[0].van_id == "v1"


def test_locked_shift_van_pinning_preserved():
    """Locked rows still get van pinned via the heuristic. The CP-SAT
    decision space for the OPEN shift must exclude that (van, date)."""
    r = _req(
        drivers=[
            {"id": "d_locked", "available_dows": [1]},
            {"id": "d_open",   "available_dows": [1]},
        ],
        shifts=[
            {"id": "L1", "date": "2026-06-01", "route_type": "standard",
             "is_locked": True, "assigned_driver_id": "d_locked"},
            {"id": "open1", "date": "2026-06-01", "route_type": "standard"},
        ],
        vans=[
            {"id": "v1", "code": "VAN-1", "status": "active",
             "vehicle_type": "standard"},
        ],
        van_pairings=[
            {"driver_id": "d_locked", "van_id": "v1", "kind": "primary"},
        ],
    )
    result = solve(r)
    # Locked row gets v1.
    locked = next(a for a in result.assigned_shifts if a.shift_id == "L1")
    assert locked.van_id == "v1"
    # Open shift on the same date can't reuse v1.
    op = next(a for a in result.assigned_shifts if a.shift_id == "open1")
    assert op.van_id is None
