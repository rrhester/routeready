#!/usr/bin/env python3
"""Stress-test the live solver with a realistic 100-driver week.

Usage:
  cd ~/routeready/solver-service
  python3 stress_test.py
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
import urllib.request

SOLVER_URL = os.environ.get("RR_SOLVER_URL", "https://rr-solve-ready.fly.dev")
SOLVER_TOKEN = os.environ.get(
    "RR_SOLVER_TOKEN",
    "e7e08851cdc4a26cb5d032437949eb3515c39584aff07943dbff388ed7968167",
)
WEEK_START = "2026-06-01"
DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

random.seed(42)


def build_payload(num_drivers: int = 100, shifts_per_day: int = 70):
    drivers = []
    for i in range(num_drivers):
        is_ft = i < int(num_drivers * 0.7)
        avail = sorted(random.sample(range(1, 7), 6 if is_ft else 4))
        pref = sorted(random.sample(avail, min(2, len(avail))))
        drivers.append({
            "id": f"d{i:03d}",
            "full_name": f"Driver {i:03d}",
            "available_dows": avail,
            "preferred_dows": pref,
            "edv_certified": random.random() < 0.45,
            "dot_certified": True,
            "xl_certified":  random.random() < 0.7,
        })

    shifts = []
    for day_offset in range(7):
        date = f"2026-06-{1 + day_offset:02d}"
        for j in range(shifts_per_day):
            route = "edv" if random.random() < 0.20 else "standard"
            shifts.append({
                "id": f"s_{day_offset}_{j}",
                "date": date,
                "route_type": route,
            })

    pto = []
    for d in random.sample(drivers, 6):
        start = random.choice([0, 2, 4])
        pto.append({
            "driver_id": d["id"],
            "start_date": f"2026-06-{1 + start:02d}",
            "end_date":   f"2026-06-{1 + start + 1:02d}",
            "kind": "pto",
        })

    return {
        "schedule_week_start": WEEK_START,
        "max_days": 5,
        "weekly_hour_cap": 40,
        "time_budget_ms": 20000,
        "solver_seed": 0,
        "rules": {
            "weights": {
                "coverage": 10000,
                "fairness": 2,
                "ot_risk": 5,
                "affinity": 1,
                "van_continuity": 10,
                "preferred_days": 5,
                "attendance": 100,
            },
            "use_pto": True,
            "use_affinity": True,
            "use_van_pairings": True,
            "use_attendance": True,
            "use_fifth_day_optin": True,
            "use_ad_hoc_rules": True,
        },
        "drivers": drivers,
        "shifts": shifts,
        "vans": [],
        "van_pairings": [],
        "pto": pto,
        "ad_hoc_constraints": [],
    }


def post(payload: dict) -> dict:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{SOLVER_URL.rstrip('/')}/solve",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SOLVER_TOKEN}",
        },
    )
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode())
    return result, (time.perf_counter() - started) * 1000


def summarize(payload: dict, result: dict, wall_ms: float) -> None:
    drivers = payload["drivers"]
    shifts  = payload["shifts"]
    assigned = result.get("assigned_shifts", [])
    uncovered = result.get("uncovered_shifts", [])

    by_driver: dict[str, int] = {}
    for a in assigned:
        by_driver[a["driver_id"]] = by_driver.get(a["driver_id"], 0) + 1

    edv_shifts = [s for s in shifts if s["route_type"] == "edv"]
    edv_assigned = [a for a in assigned if any(
        s["id"] == a["shift_id"] and s["route_type"] == "edv" for s in shifts
    )]

    coverage_pct = 100.0 * len(assigned) / len(shifts) if shifts else 0
    drivers_used = len(by_driver)
    avg_per_used = sum(by_driver.values()) / drivers_used if drivers_used else 0
    max_per = max(by_driver.values()) if by_driver else 0
    min_per = min(by_driver.values()) if by_driver else 0

    print("=" * 70)
    print(f"  100-driver stress test  ·  week of {payload['schedule_week_start']}")
    print("=" * 70)
    print(f"  Input        :  {len(drivers)} drivers, {len(shifts)} shifts, "
          f"{len(payload['pto'])} PTO blocks")
    print(f"  Solver time  :  {result.get('elapsed_ms', '?'):>6} ms  (wall {wall_ms:.0f} ms)")
    print(f"  Status       :  {result.get('status')}  ·  engine "
          f"{result.get('solver_version', '?')}")
    print()
    print(f"  Coverage     :  {len(assigned)}/{len(shifts)}  ({coverage_pct:.1f}%)")
    print(f"  Uncovered    :  {len(uncovered)}")
    print(f"  EDV routes   :  {len(edv_assigned)}/{len(edv_shifts)} filled")
    print()
    print(f"  Drivers used :  {drivers_used}/{len(drivers)}")
    print(f"  Shifts/driver:  min {min_per}  ·  avg {avg_per_used:.2f}  ·  max {max_per}")

    metrics = result.get("metrics") or {}
    if metrics:
        print()
        print("  Engine metrics:")
        for k, v in metrics.items():
            print(f"     {k:20s} {v}")

    print("=" * 70)


def main() -> int:
    payload = build_payload()
    print(f"Posting {len(payload['drivers'])} drivers, {len(payload['shifts'])} shifts "
          f"to {SOLVER_URL}/solve  ...")
    try:
        result, wall_ms = post(payload)
    except Exception as e:
        print(f"REQUEST FAILED: {e}", file=sys.stderr)
        return 1
    summarize(payload, result, wall_ms)
    return 0


if __name__ == "__main__":
    sys.exit(main())
