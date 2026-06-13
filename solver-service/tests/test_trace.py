"""
Smart Fill Diagnostic Trace Mode.

Proves the trace (a) is opt-in and never alters the schedule, (b) answers
the six questions the spec is built around, and (c) classifies every
zero-shift driver and every unfilled shift with a definitive reason.
"""

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


def _by_driver(trace):
    return {d["driver_id"]: d for d in trace["driver_trace"]}


def _by_shift(trace):
    return {s["shift_id"]: s for s in trace["shift_trace"]}


# ── Opt-in + no behavior change ────────────────────────────────────────────


def test_trace_absent_by_default():
    r = _req(
        drivers=[{"id": "d1", "available_dows": [1]}],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],
    )
    resp = solve(r)
    assert resp.trace is None


def test_trace_present_and_well_formed_when_requested():
    r = _req(
        trace=True,
        drivers=[{"id": "d1", "available_dows": [1]}],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],
    )
    resp = solve(r)
    assert resp.trace is not None
    assert "error" not in resp.trace, resp.trace.get("error")
    for section in (
        "run_summary", "driver_trace", "shift_trace", "eligibility_trace",
        "solver_input", "solver_output", "zero_shift_report",
        "unfilled_shift_report", "report",
    ):
        assert section in resp.trace, f"missing section: {section}"
    assert isinstance(resp.trace["report"], str)
    assert "SMART FILL DIAGNOSTIC TRACE" in resp.trace["report"]


def test_trace_does_not_change_the_schedule():
    # Asymmetric availability → a UNIQUE optimum, so a stable cross-call
    # comparison is valid (the CP-SAT search is otherwise free to return any
    # equally-optimal assignment). Proves the trace pass is inert.
    payload = dict(
        max_days=4,
        drivers=[
            {"id": "d1", "available_dows": [1]},  # Mon only
            {"id": "d2", "available_dows": [2]},  # Tue only
            {"id": "d3", "available_dows": [3]},  # Wed only
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard"},  # Mon
            {"id": "s2", "date": "2026-06-02", "route_type": "standard"},  # Tue
            {"id": "s3", "date": "2026-06-03", "route_type": "standard"},  # Wed
        ],
    )
    plain = solve(_req(**payload))
    traced = solve(_req(trace=True, **payload))
    # Same assignments, same uncovered set — diagnostics are inert.
    assert (
        sorted((a.shift_id, a.driver_id) for a in plain.assigned_shifts)
        == sorted((a.shift_id, a.driver_id) for a in traced.assigned_shifts)
    )
    assert (
        sorted(u.shift_id for u in plain.uncovered_shifts)
        == sorted(u.shift_id for u in traced.uncovered_shifts)
    )
    # Counts are invariant regardless of which optimum the solver lands on.
    assert len(plain.assigned_shifts) == len(traced.assigned_shifts)


# ── Q3/Q4 — excluded before solver vs considered ───────────────────────────


def test_zero_shift_excluded_no_availability():
    r = _req(
        trace=True,
        drivers=[{"id": "d1", "available_dows": []}],  # none on file
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],
    )
    d = _by_driver(solve(r).trace)["d1"]
    assert d["considered_by_solver"] is False
    assert d["pool_entry"] == "excluded"
    assert d["disposition"] == "excluded_before_solver"
    assert d["cause"] == "eligibility"
    assert "availability" in d["why"].lower()


def test_zero_shift_excluded_expired_license():
    r = _req(
        trace=True,
        drivers=[{"id": "d1", "available_dows": [1], "dl_expires_on": "2020-01-01"}],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],
    )
    d = _by_driver(solve(r).trace)["d1"]
    assert d["disposition"] == "excluded_before_solver"
    assert any(x["code"] == "LICENSE_FAIL" for x in d["exclusion_reasons"])
    assert "license" in d["why"].lower()


def test_zero_shift_excluded_missing_cert():
    # XL shift, driver lacks XL cert → eligible for 0 shifts.
    r = _req(
        trace=True,
        drivers=[{"id": "d1", "available_dows": [1], "xl_certified": False}],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "xl"}],
    )
    t = solve(r).trace
    d = _by_driver(t)["d1"]
    assert d["disposition"] == "excluded_before_solver"
    assert any(x["code"] == "XL_FAIL" for x in d["exclusion_reasons"])
    # And it lands in the dedicated zero-shift report.
    zsr = {z["driver_id"]: z for z in t["zero_shift_report"]}
    assert "d1" in zsr and "xl" in zsr["d1"]["reason"].lower()


# ── Q1/Q6 — scoring vs eligibility vs capacity for a 0-shift driver ─────────


def test_zero_shift_lost_scoring_competition():
    # Two eligible drivers, one shift → loser is considered-but-not-selected.
    r = _req(
        trace=True,
        drivers=[
            {"id": "d1", "available_dows": [1]},
            {"id": "d2", "available_dows": [1]},
        ],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],
    )
    t = solve(r).trace
    bd = _by_driver(t)
    winners = [k for k, v in bd.items() if v["disposition"] == "assigned"]
    losers = [k for k, v in bd.items() if v["disposition"] == "considered_not_selected"]
    assert len(winners) == 1 and len(losers) == 1
    loser = bd[losers[0]]
    assert loser["considered_by_solver"] is True
    assert loser["cause"] == "scoring"
    assert "lost" in loser["why"].lower()


def test_zero_shift_capacity_capped_by_pto_hard_cap():
    # 10h hard cap, 1 PTO day @10h → effective cap 0; the only open shift is
    # on a non-PTO day the driver is eligible for, but the hard weekly cap
    # forbids it → driver considered, 0 shifts, shift left open by capacity.
    r = _req(
        trace=True,
        weekly_hour_cap=10,
        rules={
            "weekly_hour_cap_enforcement": True,
            "pto_counts_toward_cap": True,
            "pto_hours_per_day": 10,
        },
        drivers=[{"id": "d1", "available_dows": [0, 1, 2, 3, 4, 5, 6]}],
        shifts=[{"id": "s1", "date": "2026-06-02", "duration_hours": 10,
                 "route_type": "standard"}],
        pto=[{"driver_id": "d1", "date": "2026-06-01"}],
    )
    t = solve(r).trace
    d = _by_driver(t)["d1"]
    assert d["considered_by_solver"] is True
    assert d["disposition"] == "considered_not_selected"
    assert d["cause"] == "capacity"
    assert "cap" in d["why"].lower()


# ── Q2/Q5 — why a shift stays open; was it sent to the solver ───────────────


def test_unfilled_shift_no_eligible_drivers():
    r = _req(
        trace=True,
        drivers=[{"id": "d1", "available_dows": [2]}],  # Tue only
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],  # Mon
    )
    t = solve(r).trace
    sh = _by_shift(t)["s1"]
    assert sh["sent_to_solver"] is True
    assert sh["disposition"] == "uncovered_no_eligible"
    assert sh["cause"] == "eligibility"
    assert sh["eligible_driver_count"] == 0
    usr = {u["shift_id"]: u for u in t["unfilled_shift_report"]}
    assert "s1" in usr


def test_unfilled_shift_capacity_when_eligible_driver_is_capped():
    # max_days=1; d1 locked Monday → at the day cap. Open Tuesday shift only
    # d1 is eligible for → eligible>0 but capacity leaves it open.
    r = _req(
        trace=True,
        max_days=1,
        drivers=[{"id": "d1", "available_dows": [1, 2]}],
        shifts=[
            {"id": "mon", "date": "2026-06-01", "route_type": "standard",
             "is_locked": True, "assigned_driver_id": "d1"},
            {"id": "tue", "date": "2026-06-02", "route_type": "standard"},
        ],
    )
    t = solve(r).trace
    sh = _by_shift(t)["tue"]
    assert sh["disposition"] == "uncovered_capacity"
    assert sh["cause"] == "capacity"
    assert sh["eligible_driver_count"] == 1


def test_locked_shift_not_sent_to_solver():
    r = _req(
        trace=True,
        drivers=[{"id": "d1", "available_dows": [1]}],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard",
                 "is_locked": True, "assigned_driver_id": "d1"}],
    )
    sh = _by_shift(solve(r).trace)["s1"]
    assert sh["sent_to_solver"] is False
    assert sh["disposition"] == "not_sent_to_solver"
    assert sh["assigned_driver_id"] == "d1"


# ── Section 4 — eligibility trace ──────────────────────────────────────────


def test_eligibility_trace_counts_and_codes():
    r = _req(
        trace=True,
        drivers=[
            {"id": "d1", "available_dows": [1, 2, 3, 4, 5]},
            {"id": "d2", "available_dows": [1, 2]},  # fails Wed
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard"},  # Mon
            {"id": "s2", "date": "2026-06-03", "route_type": "standard"},  # Wed
        ],
    )
    el = solve(r).trace["eligibility_trace"]
    # 2 drivers x 2 open shifts = 4 pairs. d2 fails Wed → 1 fail (availability).
    assert el["evaluated_pairs"] == 4
    assert el["fail_count"] == 1
    assert el["pass_count"] == 3
    assert el["fail_by_code"].get("AVAILABILITY_FAIL") == 1
    # The per-shift matrix carries the explicit FAIL with its reason.
    wed = next(b for b in el["by_shift"] if b["shift_id"] == "s2")
    assert any(f["driver_id"] == "d2" and f["code"] == "AVAILABILITY_FAIL"
               for f in wed["failed"])


# ── Section 1 — run summary, settings, cushion counts ──────────────────────


def test_run_summary_counts_and_cushion_seats():
    r = _req(
        trace=True,
        run_id="run-7",
        dsp_id="dsp-9",
        drivers=[{"id": "d1", "available_dows": [1, 2]}],
        shifts=[
            {"id": "reg", "date": "2026-06-01", "route_type": "standard"},
            {"id": "cush", "date": "2026-06-02", "route_type": "standard",
             "is_cushion": True},
            # Unfillable cushion seat (driver not available Saturday).
            {"id": "cush2", "date": "2026-06-06", "route_type": "standard",
             "is_cushion": True},
        ],
    )
    t = solve(r).trace
    rs = t["run_summary"]
    assert rs["run_id"] == "run-7"
    assert rs["dsp_id"] == "dsp-9"
    assert rs["counts"]["drivers_received"] == 1
    assert rs["counts"]["shifts_received"] == 3
    # One regular + one cushion fill (d1 avail Mon/Tue), one cushion open.
    assert rs["counts"]["cushion_seats_assigned"] == 1
    assert rs["counts"]["cushion_seats_unfilled"] == 1
    assert rs["settings_used"]["max_days"] == 4
    # solver_input echoes the cushion split.
    assert t["solver_input"]["cushion_open_shift_count"] == 2


# ── Section 6 — solver output dispositions + warnings ──────────────────────


def test_solver_output_dispositions_and_status_warning():
    # `good` is the unique eligible driver for the Monday shift; `gone` is
    # only available Tuesday, so the winner is deterministic. `gone` also
    # carries a non-schedulable status that should surface as a warning.
    r = _req(
        trace=True,
        drivers=[
            {"id": "good", "available_dows": [1]},  # Mon
            {"id": "gone", "status": "inactive", "available_dows": [2]},  # Tue
        ],
        shifts=[{"id": "s1", "date": "2026-06-01", "route_type": "standard"}],  # Mon
    )
    t = solve(r).trace
    so = t["solver_output"]
    assert so["assignments_returned"] == 1
    dd = so["driver_dispositions"]
    assert dd["assigned"] == ["good"]
    # A non-schedulable status that slipped into the payload is surfaced.
    assert any("gone" in w for w in so["warnings"])


# ── Determinism ────────────────────────────────────────────────────────────


def test_trace_is_deterministic_modulo_timestamp():
    # Unique-optimum input so the underlying solve is itself stable.
    payload = dict(
        trace=True,
        drivers=[
            {"id": "d1", "available_dows": [1]},  # Mon only
            {"id": "d2", "available_dows": [2]},  # Tue only
        ],
        shifts=[
            {"id": "s1", "date": "2026-06-01", "route_type": "standard"},  # Mon
            {"id": "s2", "date": "2026-06-02", "route_type": "standard"},  # Tue
        ],
    )
    a = solve(_req(**payload)).trace
    b = solve(_req(**payload)).trace

    def _strip(tr):
        tr = dict(tr)
        tr["run_summary"] = dict(tr["run_summary"])
        tr["run_summary"].pop("timestamp", None)
        # solver_wall_ms is wall-clock; report embeds both.
        tr["solver_output"] = dict(tr["solver_output"])
        tr["solver_output"]["diagnostics"] = dict(tr["solver_output"]["diagnostics"])
        tr["solver_output"]["diagnostics"].pop("solver_wall_ms", None)
        tr.pop("report", None)
        return tr

    assert _strip(a) == _strip(b)
