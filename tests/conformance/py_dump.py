#!/usr/bin/env python3
"""Python-side conformance dump (plan item #4). Runs the CP-SAT
service's REAL per-pair gate (rr_solver.eligibility.first_failure_reason)
on every (driver, shift) fixture pair and prints one verdict per pair
as JSON on stdout.

Run from the repo root:  python3 tests/conformance/py_dump.py
Needs only pydantic (no OR-Tools) — eligibility.py imports models.py only.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "solver-service"))

from rr_solver.eligibility import first_failure_reason  # noqa: E402
from rr_solver.models import DriverIn, ShiftIn          # noqa: E402

with open(os.path.join(os.path.dirname(__file__), "fixtures.json")) as f:
    fx = json.load(f)

pto_by_driver = {
    d["id"]: set(d.get("pto") or []) for d in fx["drivers"]
}

verdicts = {}
for d in fx["drivers"]:
    driver = DriverIn(**{k: v for k, v in d.items() if k not in ("pto", "multi")})
    for s in fx["shifts"]:
        shift = ShiftIn(**s)
        fail = first_failure_reason(
            driver, shift, pto_by_driver, fx["eligible_driver_status"]
        )
        verdicts[f'{d["id"]}|{s["id"]}'] = {
            "eligible": fail is None,
            "code": None if fail is None else fail.code,
        }

json.dump(verdicts, sys.stdout, indent=2)
sys.stdout.write("\n")
