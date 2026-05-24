#!/usr/bin/env python3
"""Stress-test the live solver.

Default: 8 sequential weekly solves with the same 100 drivers, mimicking
how an operator actually uses Smart Fill (one week at a time). After
each week, the engine's actual assignments roll forward as the next
week's affinity input so the second week onwards can favour stable
patterns the way it would on the live dashboard.

Reports per-week timing + coverage + EDV fill + load spread, then a
summary across all 8 weeks.

Usage:
  cd ~/routeready/solver-service
  python3 stress_test.py            # default: 100 drivers x 8 weeks
  python3 stress_test.py 50 4       # custom: 50 drivers x 4 weeks
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
import urllib.request
from datetime import date, timedelta

SOLVER_URL = os.environ.get("RR_SOLVER_URL", "https://rr-solve-ready.fly.dev")
SOLVER_TOKEN = os.environ.get(
    "RR_SOLVER_TOKEN",
    "e7e08851cdc4a26cb5d032437949eb3515c39584aff07943dbff388ed7968167",
)
FIRST_WEEK_START = date(2026, 6, 1)  # Monday
DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

random.seed(42)


def build_drivers(num_drivers: int) -> list[dict]:
    """The roster stays constant across all weeks — same drivers, same
    base availability + cert mix."""
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
    return drivers


def build_payload(
    drivers: list[dict],
    week_start: date,
    shifts_per_day: int = 70,
    affinity_by_driver: dict[str, list[int]] | None = None,
):
    shifts = []
    for day_offset in range(7):
        d = week_start + timedelta(days=day_offset)
        for j in range(shifts_per_day):
            route = "edv" if random.random() < 0.20 else "standard"
            shifts.append({
                "id": f"s_{d.isoformat()}_{j}",
                "date": d.isoformat(),
                "route_type": route,
            })

    pto = []
    for d in random.sample(drivers, max(3, len(drivers) // 16)):
        start_offset = random.choice([0, 2, 4])
        pto.append({
            "driver_id": d["id"],
            "start_date": (week_start + timedelta(days=start_offset)).isoformat(),
            "end_date":   (week_start + timedelta(days=start_offset + 1)).isoformat(),
            "kind": "pto",
        })

    # Inject rolling-forward affinity so the engine can favour stable
    # weekday patterns from prior weeks.
    drivers_with_aff = []
    for d in drivers:
        d2 = dict(d)
        if affinity_by_driver and d["id"] in affinity_by_driver:
            # 0-100 affinity score per dow (0..6, Sun..Sat).
            d2["weekday_affinity"] = affinity_by_driver[d["id"]]
        drivers_with_aff.append(d2)

    return {
        "schedule_week_start": week_start.isoformat(),
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
        "drivers": drivers_with_aff,
        "shifts": shifts,
        "vans": [],
        "van_pairings": [],
        "pto": pto,
        "ad_hoc_constraints": [],
    }


def affinity_from_assignments(
    drivers: list[dict],
    assigned_shifts: list[dict],
    shifts: list[dict],
    prior_affinity: dict[str, list[int]] | None = None,
    decay: float = 0.6,
) -> dict[str, list[int]]:
    """Build a Sun..Sat (length-7) affinity array per driver from the
    week's assignments. Each dow that the driver worked gets a bump;
    decayed previous-week values are blended in so the signal is
    cumulative, not one-week noise."""
    shift_dow = {s["id"]: date.fromisoformat(s["date"]).isoweekday() % 7
                 for s in shifts}  # Sun=0..Sat=6
    out: dict[str, list[int]] = {}
    for d in drivers:
        out[d["id"]] = [0] * 7
    for a in assigned_shifts:
        did = a["driver_id"]
        sid = a["shift_id"]
        if did in out and sid in shift_dow:
            out[did][shift_dow[sid]] += 40   # one week worked = +40 on that dow
    if prior_affinity:
        for did, prev in prior_affinity.items():
            if did in out:
                for i in range(7):
                    out[did][i] = min(100, int(out[did][i] + prev[i] * decay))
    return out


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


def week_row(week_num: int, payload: dict, result: dict, wall_ms: float) -> dict:
    """Returns a dict of per-week metrics + prints a one-line summary."""
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

    cov_pct = 100.0 * len(assigned) / len(shifts) if shifts else 0
    drivers_used = len(by_driver)
    avg_per = sum(by_driver.values()) / drivers_used if drivers_used else 0
    max_per = max(by_driver.values()) if by_driver else 0

    print(f"  Wk {week_num}  {payload['schedule_week_start']}  "
          f"|  {len(assigned):>4}/{len(shifts)} ({cov_pct:5.1f}%)  "
          f"|  EDV {len(edv_assigned):>3}/{len(edv_shifts):<3}  "
          f"|  drivers {drivers_used:>3}/{len(drivers):<3}  "
          f"|  per-drv avg {avg_per:4.2f} max {max_per}  "
          f"|  {result.get('elapsed_ms', '?'):>5} ms")

    return {
        "week": week_num,
        "week_start": payload["schedule_week_start"],
        "shifts": len(shifts),
        "assigned": len(assigned),
        "coverage_pct": cov_pct,
        "uncovered": len(uncovered),
        "edv_total": len(edv_shifts),
        "edv_assigned": len(edv_assigned),
        "drivers_used": drivers_used,
        "max_per_driver": max_per,
        "elapsed_ms": result.get("elapsed_ms"),
        "wall_ms": wall_ms,
    }


def main() -> int:
    num_drivers = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    num_weeks   = int(sys.argv[2]) if len(sys.argv) > 2 else 8

    drivers = build_drivers(num_drivers)
    print(f"Stress test  ·  {num_drivers} drivers  ·  {num_weeks} sequential weeks "
          f"·  solver {SOLVER_URL}")
    print(f"  drivers: 70% FT (6 avail dows), 30% PT (4 avail dows), "
          f"~45% EDV-cert, ~70% XL-cert")
    print()
    header = ("  Week  Start         |  Covered           "
              "|  EDV         |  Drivers used  "
              "|  Load                  |  Solve time")
    print(header)
    print("  " + "-" * (len(header) - 2))

    rows: list[dict] = []
    affinity_by_driver: dict[str, list[int]] | None = None

    for wk in range(num_weeks):
        week_start = FIRST_WEEK_START + timedelta(weeks=wk)
        payload = build_payload(drivers, week_start, affinity_by_driver=affinity_by_driver)
        try:
            result, wall_ms = post(payload)
        except Exception as e:
            print(f"  Wk {wk + 1}  REQUEST FAILED: {e}", file=sys.stderr)
            return 1
        rows.append(week_row(wk + 1, payload, result, wall_ms))
        # Roll affinity forward into next week.
        affinity_by_driver = affinity_from_assignments(
            drivers,
            result.get("assigned_shifts", []),
            payload["shifts"],
            prior_affinity=affinity_by_driver,
        )

    print()
    print("  " + "=" * 70)
    total_shifts = sum(r["shifts"] for r in rows)
    total_assigned = sum(r["assigned"] for r in rows)
    total_elapsed = sum((r["elapsed_ms"] or 0) for r in rows)
    total_wall = sum(r["wall_ms"] for r in rows)
    avg_cov = sum(r["coverage_pct"] for r in rows) / len(rows)
    print(f"  TOTAL  {len(rows)} weeks  ·  {total_assigned}/{total_shifts} "
          f"shifts staffed  ·  {avg_cov:.1f}% avg coverage")
    print(f"  Solver time total: {total_elapsed/1000:.1f}s  ·  wall total: "
          f"{total_wall/1000:.1f}s")
    print(f"  Solver time avg/wk: {total_elapsed/len(rows):.0f} ms  ·  "
          f"wall avg/wk: {total_wall/len(rows):.0f} ms")
    print("  " + "=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
