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


def test_fifth_day_optin_does_not_exceed_max_days():
    # A 5th-day opt-in expands availability but must NOT raise the hard
    # max_days cap. One opted-in driver, available all week, 6 single-day
    # shifts, cap=5 → at most 5 assigned to her (one left open), never 6.
    r = _req(
        max_days=5,
        rules={"use_fifth_day_optin": True},
        drivers=[{
            "id": "d1",
            "available_dows": [0, 1, 2, 3, 4, 5, 6],
            "fifth_day_ok": True,
        }],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard"},
            {"id": "s2", "date": "2026-06-02", "route_type": "standard"},
            {"id": "s3", "date": "2026-06-03", "route_type": "standard"},
            {"id": "s4", "date": "2026-06-04", "route_type": "standard"},
            {"id": "s5", "date": "2026-06-05", "route_type": "standard"},
            {"id": "s6", "date": "2026-06-06", "route_type": "standard"},
        ],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 5
    assert len(result.uncovered_shifts) == 1


def test_pto_counts_toward_weekly_cap():
    # 40h cap, hard-enforced, with PTO counting toward the cap at 10h/day.
    # One driver available all week has 2 approved PTO days (Mon, Tue) = 20h,
    # leaving only 20h = 2 ten-hour shifts of work. There are 5 open shifts on
    # the 3 non-PTO days + extras; the driver may take at most 2, the rest open.
    r = _req(
        weekly_hour_cap=40,
        rules={
            "weekly_hour_cap_enforcement": True,
            "pto_counts_toward_cap": True,
            "pto_hours_per_day": 10,
        },
        drivers=[{"id": "d1", "available_dows": [0, 1, 2, 3, 4, 5, 6]}],
        # 10h shifts (10:00→20:00) on five distinct non-PTO days.
        shifts=[
            {"id": "s3", "date": "2026-06-03", "starts_at": "2026-06-03T10:00:00Z", "ends_at": "2026-06-03T20:00:00Z"},
            {"id": "s4", "date": "2026-06-04", "starts_at": "2026-06-04T10:00:00Z", "ends_at": "2026-06-04T20:00:00Z"},
            {"id": "s5", "date": "2026-06-05", "starts_at": "2026-06-05T10:00:00Z", "ends_at": "2026-06-05T20:00:00Z"},
            {"id": "s6", "date": "2026-06-06", "starts_at": "2026-06-06T10:00:00Z", "ends_at": "2026-06-06T20:00:00Z"},
            {"id": "s7", "date": "2026-06-07", "starts_at": "2026-06-07T10:00:00Z", "ends_at": "2026-06-07T20:00:00Z"},
        ],
        pto=[
            {"driver_id": "d1", "date": "2026-06-01"},
            {"driver_id": "d1", "date": "2026-06-02"},
        ],
    )
    result = solve(r)
    # 20h PTO against a 40h cap leaves room for exactly 2 of the 10h shifts.
    assert len(result.assigned_shifts) == 2
    assert len(result.uncovered_shifts) == 3


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
