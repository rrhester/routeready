#!/usr/bin/env python3
"""Real-world stress test of the live solver.

Simulates a DSP under realistic operational pressure across N weeks:
  * Attrition — ~5%/wk of active drivers terminate (compounds to ~20%/mo).
  * PTO       — ~5%/wk of remaining drivers take 1–2 days off.
  * Availability drift — ~10%/wk of drivers swap one of their dows.
  * Demand swing — daily shift count jitters ±10% off a base value.
  * Affinity rollforward — previous week's assignments inform the
    next week's weekday_affinity[] input so the engine can favour
    stable patterns the way it would on the live dashboard.

Defaults match the operator's brief: 50 routes/day ±10%, 110 drivers,
8 weeks, EDV/XL cert mix.

Usage:
  cd ~/routeready/solver-service
  python3 stress_test.py
  python3 stress_test.py --drivers 110 --routes 50 --weeks 8
  python3 stress_test.py --attrition 0.05 --pto 0.05 --budget 60000
"""
from __future__ import annotations

import argparse
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
FIRST_WEEK_START = date(2026, 6, 1)

random.seed(42)


# ── Roster construction ────────────────────────────────────────────────


def build_roster(num_drivers: int) -> list[dict]:
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
            "_is_ft": is_ft,
        })
    return drivers


# ── Weekly pre-solve dynamics ──────────────────────────────────────────


def apply_attrition(roster: list[dict], rate: float) -> tuple[list[dict], list[str]]:
    if not roster:
        return roster, []
    n_drop = max(1, int(round(len(roster) * rate)))
    n_drop = min(n_drop, len(roster) - 1)  # always keep at least 1
    leaving = random.sample(roster, n_drop)
    leaving_ids = {d["id"] for d in leaving}
    kept = [d for d in roster if d["id"] not in leaving_ids]
    return kept, sorted(leaving_ids)


def drift_availability(roster: list[dict], rate: float) -> list[str]:
    """For ~rate of drivers, swap one available dow for one currently
    not available. Mirrors a driver telling the DSP 'I can do Wed now
    but not Sat.' Returns ids of changed drivers."""
    if not roster:
        return []
    n_change = max(1, int(round(len(roster) * rate)))
    n_change = min(n_change, len(roster))
    changed = random.sample(roster, n_change)
    for d in changed:
        avail_set = set(d.get("available_dows") or [])
        if len(avail_set) >= 7 or not avail_set:
            continue
        not_avail = set(range(1, 7)) - avail_set
        if not not_avail:
            continue
        out_dow = random.choice(sorted(avail_set))
        in_dow  = random.choice(sorted(not_avail))
        avail_set.discard(out_dow)
        avail_set.add(in_dow)
        d["available_dows"] = sorted(avail_set)
    return [d["id"] for d in changed]


def generate_pto(roster: list[dict], week_start: date, rate: float) -> list[dict]:
    if not roster:
        return []
    n_pto = max(1, int(round(len(roster) * rate)))
    n_pto = min(n_pto, len(roster))
    requesters = random.sample(roster, n_pto)
    pto: list[dict] = []
    for d in requesters:
        n_days = random.choice([1, 1, 2])  # most take 1 day, some 2
        start = random.randint(0, 6)
        for j in range(n_days):
            if start + j > 6:
                break
            pto.append({
                "driver_id": d["id"],
                "date": (week_start + timedelta(days=start + j)).isoformat(),
            })
    return pto


def generate_shifts(week_start: date, base_per_day: int, jitter: float) -> list[dict]:
    shifts = []
    for day_offset in range(7):
        d = week_start + timedelta(days=day_offset)
        n = max(0, int(round(base_per_day * (1 + random.uniform(-jitter, jitter)))))
        for j in range(n):
            shifts.append({
                "id": f"s_{d.isoformat()}_{j}",
                "date": d.isoformat(),
                "route_type": "edv" if random.random() < 0.20 else "standard",
            })
    return shifts


# ── Affinity rollforward ───────────────────────────────────────────────


def affinity_from_assignments(
    roster: list[dict],
    assigned_shifts: list[dict],
    shifts: list[dict],
    prior_affinity: dict[str, list[int]] | None = None,
    decay: float = 0.6,
) -> dict[str, list[int]]:
    shift_dow = {s["id"]: date.fromisoformat(s["date"]).isoweekday() % 7
                 for s in shifts}
    out: dict[str, list[int]] = {d["id"]: [0] * 7 for d in roster}
    for a in assigned_shifts:
        did = a["driver_id"]
        sid = a["shift_id"]
        if did in out and sid in shift_dow:
            out[did][shift_dow[sid]] += 40
    if prior_affinity:
        for did, prev in prior_affinity.items():
            if did in out:
                for i in range(7):
                    out[did][i] = min(100, int(out[did][i] + prev[i] * decay))
    return out


# ── Payload + request ──────────────────────────────────────────────────


def build_payload(
    roster: list[dict],
    week_start: date,
    shifts: list[dict],
    pto: list[dict],
    affinity_by_driver: dict[str, list[int]] | None,
    time_budget_ms: int,
) -> dict:
    drivers_out = []
    for d in roster:
        d2 = {k: v for k, v in d.items() if not k.startswith("_")}
        if affinity_by_driver and d["id"] in affinity_by_driver:
            d2["weekday_affinity"] = affinity_by_driver[d["id"]]
        drivers_out.append(d2)
    return {
        "schedule_week_start": week_start.isoformat(),
        "max_days": 5,
        "weekly_hour_cap": 40,
        "time_budget_ms": time_budget_ms,
        "solver_seed": 0,
        "rules": {
            "weights": {
                "coverage": 10000, "fairness": 2, "ot_risk": 5,
                "affinity": 1, "van_continuity": 10,
                "preferred_days": 5, "attendance": 100,
            },
            "use_pto": True, "use_affinity": True,
            "use_van_pairings": True, "use_attendance": True,
            "use_fifth_day_optin": True, "use_ad_hoc_rules": True,
        },
        "drivers": drivers_out,
        "shifts": shifts,
        "vans": [], "van_pairings": [],
        "pto": pto,
        "ad_hoc_constraints": [],
    }


def post(payload: dict) -> tuple[dict, float]:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{SOLVER_URL.rstrip('/')}/solve",
        data=body, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SOLVER_TOKEN}",
        },
    )
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=240) as resp:
        result = json.loads(resp.read().decode())
    return result, (time.perf_counter() - started) * 1000


# ── Main loop ──────────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--drivers", type=int, default=110, help="starting roster size")
    p.add_argument("--routes",  type=int, default=50,  help="base shifts/day")
    p.add_argument("--weeks",   type=int, default=8,   help="number of weeks")
    p.add_argument("--jitter",  type=float, default=0.10, help="daily route-count variability")
    p.add_argument("--attrition", type=float, default=0.05, help="weekly attrition rate")
    p.add_argument("--pto",     type=float, default=0.05, help="weekly PTO request rate")
    p.add_argument("--avail_drift", type=float, default=0.10, help="weekly availability-change rate")
    p.add_argument("--budget",  type=int, default=30000, help="solver time budget ms")
    args = p.parse_args()

    roster = build_roster(args.drivers)
    initial_count = len(roster)
    print(f"Stress test  ·  solver {SOLVER_URL}")
    print(f"  start roster   : {initial_count} drivers (70% FT, 30% PT, ~45% EDV-cert)")
    print(f"  base demand    : {args.routes} routes/day ±{int(args.jitter*100)}%")
    print(f"  weekly churn   : attrition {args.attrition*100:.0f}%, "
          f"PTO {args.pto*100:.0f}%, avail-drift {args.avail_drift*100:.0f}%")
    print(f"  solve budget   : {args.budget} ms / week")
    print()
    header = ("  Wk  Start         |  Roster  Term  PTO  Avail-chg  "
              "|  Shifts  Covered            "
              "|  EDV          |  Per-drv  |  Solver ms")
    print(header)
    print("  " + "-" * (len(header) - 2))

    rows: list[dict] = []
    affinity: dict[str, list[int]] | None = None

    for wk in range(args.weeks):
        week_start = FIRST_WEEK_START + timedelta(weeks=wk)
        # Apply weekly dynamics BEFORE the solve.
        if wk > 0:  # week 1 starts at full roster
            roster, terminated = apply_attrition(roster, args.attrition)
        else:
            terminated = []
        avail_changed = drift_availability(roster, args.avail_drift)
        pto = generate_pto(roster, week_start, args.pto)
        shifts = generate_shifts(week_start, args.routes, args.jitter)

        payload = build_payload(
            roster, week_start, shifts, pto, affinity, args.budget,
        )
        try:
            result, wall_ms = post(payload)
        except Exception as e:
            print(f"  Wk {wk + 1}  REQUEST FAILED: {e}", file=sys.stderr)
            return 1

        assigned = result.get("assigned_shifts", [])
        metrics = result.get("metrics") or {}
        solver_ms = metrics.get("solver_wall_ms")
        cov_pct = 100.0 * len(assigned) / len(shifts) if shifts else 0
        edv_total = sum(1 for s in shifts if s["route_type"] == "edv")
        edv_filled = sum(1 for a in assigned if any(
            s["id"] == a["shift_id"] and s["route_type"] == "edv" for s in shifts
        ))
        load = {}
        for a in assigned:
            load[a["driver_id"]] = load.get(a["driver_id"], 0) + 1
        avg_per = sum(load.values()) / len(load) if load else 0
        max_per = max(load.values()) if load else 0

        print(f"  {wk+1:<2}  {week_start}  |  {len(roster):>5}  "
              f"{len(terminated):>4}  {len(set(p['driver_id'] for p in pto)):>3}  "
              f"{len(avail_changed):>9}  "
              f"|  {len(shifts):>5}  {len(assigned):>4}/{len(shifts)} ({cov_pct:5.1f}%)  "
              f"|  {edv_filled:>3}/{edv_total:<3}      "
              f"|  avg {avg_per:4.2f} max {max_per}  "
              f"|  {solver_ms or '?':>6}  (wall {wall_ms:.0f})")

        rows.append({
            "week": wk + 1, "roster": len(roster), "shifts": len(shifts),
            "assigned": len(assigned), "coverage_pct": cov_pct,
            "edv_filled": edv_filled, "edv_total": edv_total,
            "solver_ms": solver_ms or 0, "wall_ms": wall_ms,
        })

        affinity = affinity_from_assignments(roster, assigned, shifts, prior_affinity=affinity)

    print()
    print("  " + "=" * 70)
    total_shifts = sum(r["shifts"] for r in rows)
    total_assigned = sum(r["assigned"] for r in rows)
    avg_cov = sum(r["coverage_pct"] for r in rows) / len(rows)
    print(f"  TOTAL  {len(rows)} weeks  ·  roster {initial_count} → {len(roster)} "
          f"(–{initial_count - len(roster)}, –{100*(initial_count-len(roster))/initial_count:.0f}%)")
    print(f"         shifts {total_assigned}/{total_shifts}  ·  avg coverage {avg_cov:.1f}%")
    total_wall = sum(r["wall_ms"] for r in rows)
    total_solver = sum(r["solver_ms"] for r in rows)
    print(f"         solver time total {total_solver/1000:.1f}s  ·  wall total {total_wall/1000:.1f}s")
    print(f"         avg/wk: solver {total_solver/len(rows):.0f} ms, wall {total_wall/len(rows):.0f} ms")
    # Coverage trend
    first_half_cov = sum(r["coverage_pct"] for r in rows[:len(rows)//2]) / max(1, len(rows)//2)
    second_half_cov = sum(r["coverage_pct"] for r in rows[len(rows)//2:]) / max(1, len(rows) - len(rows)//2)
    delta = second_half_cov - first_half_cov
    trend = "stable" if abs(delta) < 1 else ("improving" if delta > 0 else "declining")
    print(f"         coverage trend: {first_half_cov:.1f}% → {second_half_cov:.1f}% "
          f"({trend}, {delta:+.1f}pp)")
    print("  " + "=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
