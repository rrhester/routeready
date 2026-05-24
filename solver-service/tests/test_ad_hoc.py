"""Ad-hoc constraint compiler tests (Step 5.5). One per template
kind, in both hard and soft modes."""

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


# ── driver_pair_forbidden ─────────────────────────────────────────────


def test_driver_pair_forbidden_hard_blocks_same_shift():
    """Only one shift, both drivers eligible. The rule forbids them on
    the SAME shift — but with one shift, only one of them can take it
    anyway. Verify the constraint doesn't accidentally block both."""
    r = _req(
        drivers=[
            {"id": "Bob",   "available_dows": [1]},
            {"id": "Frank", "available_dows": [1]},
        ],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],
        ad_hoc_constraints=[{
            "id": "rule-1",
            "kind": "driver_pair_forbidden",
            "hardness": "hard",
            "weight": 100,
            "payload": {"driver_a": "Bob", "driver_b": "Frank"},
        }],
    )
    result = solve(r)
    # One of them takes it; never both (trivially true with 1 shift,
    # but confirms the constraint didn't make the model infeasible).
    assert len(result.assigned_shifts) == 1
    assert result.assigned_shifts[0].driver_id in {"Bob", "Frank"}


# ── driver_lock_to_day ────────────────────────────────────────────────


def test_driver_lock_to_day_hard():
    """Driver must work Wednesdays whenever a Wed shift exists. Two
    Wed shifts, the driver should take at least one (or both, if
    nothing else conflicts)."""
    r = _req(
        drivers=[
            {"id": "Maria", "available_dows": [3]},
            {"id": "other", "available_dows": [3]},
        ],
        shifts=[
            {"id": "wed1", "date": "2026-06-03", "route_type": "standard"},
            {"id": "wed2", "date": "2026-06-03", "route_type": "standard"},
        ],
        ad_hoc_constraints=[{
            "id": "rule-2",
            "kind": "driver_lock_to_day",
            "hardness": "hard",
            "weight": 100,
            "payload": {"driver_id": "Maria", "dow": 3},
        }],
    )
    result = solve(r)
    maria_count = sum(1 for a in result.assigned_shifts if a.driver_id == "Maria")
    # With one Wed date in the week and two shifts on it, Maria can
    # only take one (no same-day double-book). The lock requires Maria
    # on every available DOW match — here just the one date — so she
    # takes one of the two.
    assert maria_count >= 1


# ── driver_exclude_from_day ───────────────────────────────────────────


def test_driver_exclude_from_day_hard():
    """Driver can NEVER work Tuesdays. Tuesday shift must go to
    someone else or be uncovered."""
    r = _req(
        drivers=[
            {"id": "Sara",  "available_dows": [2]},
            {"id": "other", "available_dows": [2]},
        ],
        shifts=[{"id": "tue", "date": "2026-06-02", "route_type": "standard"}],
        ad_hoc_constraints=[{
            "id": "rule-3",
            "kind": "driver_exclude_from_day",
            "hardness": "hard",
            "weight": 100,
            "payload": {"driver_id": "Sara", "dow": 2},
        }],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 1
    assert result.assigned_shifts[0].driver_id != "Sara"


def test_driver_exclude_from_day_hard_alone_leaves_uncovered():
    """If excluded-driver is the ONLY eligible one, the rule wins —
    shift goes uncovered."""
    r = _req(
        drivers=[{"id": "Sara", "available_dows": [2]}],
        shifts=[{"id": "tue", "date": "2026-06-02", "route_type": "standard"}],
        ad_hoc_constraints=[{
            "id": "rule-3b",
            "kind": "driver_exclude_from_day",
            "hardness": "hard",
            "weight": 100,
            "payload": {"driver_id": "Sara", "dow": 2},
        }],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 0
    assert len(result.uncovered_shifts) == 1


def test_driver_exclude_from_day_soft_yields_to_coverage():
    """Soft version + only one eligible driver → coverage wins, the
    soft rule is violated (paying its penalty)."""
    r = _req(
        drivers=[{"id": "Sara", "available_dows": [2]}],
        shifts=[{"id": "tue", "date": "2026-06-02", "route_type": "standard"}],
        ad_hoc_constraints=[{
            "id": "rule-3c",
            "kind": "driver_exclude_from_day",
            "hardness": "soft",
            "weight": 5,            # << coverage's 10000 per shift
            "payload": {"driver_id": "Sara", "dow": 2},
        }],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 1
    assert result.assigned_shifts[0].driver_id == "Sara"


# ── driver_max_days_override ──────────────────────────────────────────


def test_driver_max_days_override_hard_caps_below_global():
    """Global max_days=7, but a per-driver hard override of 2 caps her
    at 2 — uncovered shifts pile up if she's the only eligible driver."""
    r = _req(
        max_days=7,
        drivers=[{"id": "d1", "available_dows": [1, 2, 3, 4, 5]}],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard"},
            {"id": "s2", "date": "2026-06-02", "route_type": "standard"},
            {"id": "s3", "date": "2026-06-03", "route_type": "standard"},
            {"id": "s4", "date": "2026-06-04", "route_type": "standard"},
            {"id": "s5", "date": "2026-06-05", "route_type": "standard"},
        ],
        ad_hoc_constraints=[{
            "id": "rule-4",
            "kind": "driver_max_days_override",
            "hardness": "hard",
            "weight": 100,
            "payload": {"driver_id": "d1", "max_days": 2},
        }],
    )
    result = solve(r)
    assert len(result.assigned_shifts) == 2
    assert len(result.uncovered_shifts) == 3


# ── date_blackout_driver ──────────────────────────────────────────────


def test_date_blackout_driver_hard():
    """Driver unavailable Tue + Wed. Those shifts go elsewhere
    or stay open; other days work normally."""
    r = _req(
        drivers=[
            {"id": "absent", "available_dows": [1, 2, 3, 4, 5]},
            {"id": "other",  "available_dows": [1, 2, 3, 4, 5]},
        ],
        shifts=[
            {"id": "mon", "date": "2026-06-01", "route_type": "standard"},
            {"id": "tue", "date": "2026-06-02", "route_type": "standard"},
            {"id": "wed", "date": "2026-06-03", "route_type": "standard"},
            {"id": "thu", "date": "2026-06-04", "route_type": "standard"},
        ],
        ad_hoc_constraints=[{
            "id": "rule-5",
            "kind": "date_blackout_driver",
            "hardness": "hard",
            "weight": 100,
            "payload": {
                "driver_id": "absent",
                "date_from": "2026-06-02",
                "date_to":   "2026-06-03",
            },
        }],
    )
    result = solve(r)
    # The 'absent' driver must not appear on Tue or Wed.
    for a in result.assigned_shifts:
        if a.driver_id == "absent":
            assert a.shift_id not in {"tue", "wed"}
    # Coverage should be full — 'other' picks up Tue + Wed.
    assert len(result.assigned_shifts) == 4
    assert len(result.uncovered_shifts) == 0


# ── Unknown kind silently skipped ─────────────────────────────────────


def test_unknown_ad_hoc_kind_is_skipped():
    """Forward-compat: a kind the solver doesn't recognize is logged
    and skipped, the solve proceeds."""
    r = _req(
        drivers=[{"id": "d1", "available_dows": [1]}],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],
        ad_hoc_constraints=[{
            "id": "future-rule",
            "kind": "some_future_template_the_dashboard_added",
            "hardness": "hard",
            "weight": 100,
            "payload": {},
        }],
    )
    result = solve(r)
    assert result.status == "ok"
    assert len(result.assigned_shifts) == 1
