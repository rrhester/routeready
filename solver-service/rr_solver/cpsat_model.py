"""
Real CP-SAT scheduling model.

Step 5b — hard constraints + a coverage-maximizing objective. The
constraint catalog matches what the in-browser heuristic enforces today:

  HARD
  • Driver eligibility: PTO, availability_dows, cert match (DOT/XL/EDV),
    DL not expired on shift date.
  • No double-book: a driver works at most one shift per date.
  • Max days/week cap.
  • WOC: max consecutive working days.
  • Locked / preserved shifts honored verbatim.

  OBJECTIVE (v1)
  • Maximize covered shifts (minimize uncovered). Soft objective terms
    (affinity / stability / OT / fairness / attendance / doublework)
    land in step 6.

Determinism: fixed seed, single random-search worker for reproducible
outputs. Wall-clock budget honored via `time_budget_ms`. Returns the
same SolveResponse shape the stub solver returns, so the wire format
is unchanged and the dashboard side doesn't need to know which engine
produced the result.

Vans are still pinned via van_pairings (same logic as the stub) — full
van decision variables come in step 5c so this PR's blast radius stays
contained.
"""

from __future__ import annotations

import time
from collections import defaultdict
from datetime import datetime
from typing import Optional

from ortools.sat.python import cp_model

from .models import (
    AssignedShift,
    DriverIn,
    ShiftIn,
    SolveMetrics,
    SolveRequest,
    SolveResponse,
    UncoveredShift,
    UnscheduledDriver,
    VanPairingIn,
)
from .eligibility import _dow, is_eligible
from .trace import SolveArtifacts, build_trace

SOLVER_VERSION = "rr-solver-cpsat-v3-strict-hierarchy"

# Default WOC max-consecutive-days if the operator hasn't set one. The
# in-browser engine defaults to 6 (matches the popover).
DEFAULT_WOC_MAX_CONSECUTIVE_DAYS = 6


def _is_eligible(
    driver: DriverIn,
    shift: ShiftIn,
    pto_dates_by_driver: dict[str, set[str]],
    eligible_driver_status: Optional[str] = None,
) -> bool:
    """Static hard-rule check. If this returns False, the solver never
    even creates the assign variable for this (driver, shift) pair —
    that's how we keep the model size sane.

    The gate logic now lives in `eligibility.py` so the diagnostic Trace
    Mode can name the *first* rule that blocked a pair without re-deriving
    (and drifting from) the order applied here. This is a thin, behavior-
    preserving delegation: `is_eligible(...)` is exactly the old decision.
    """
    return is_eligible(driver, shift, pto_dates_by_driver, eligible_driver_status)


def _is_van_type_compatible(route_type: str, van_type: str) -> bool:
    """Whether a van of `van_type` can run a `route_type` shift.
    Pulled out of _van_for_driver so the CP-SAT van decision variables
    (Step 5c) and the heuristic locked-row pinning use the same rules."""
    if route_type == "edv":
        return van_type == "edv"
    if route_type == "step_van":
        return van_type == "step_van"
    # standard / xl shifts take any non-EDV van (EDVs reserved for EDV routes).
    return van_type != "edv"


def _van_for_driver(
    driver_id: str,
    route_type: str,
    pairings_by_driver: dict[str, list[VanPairingIn]],
    van_types: dict[str, str],
    van_used_dates: dict[str, set[str]],
    shift_date: str,
) -> Optional[str]:
    """Heuristic van pick for LOCKED shifts (which aren't in the
    CP-SAT model). Step 5c handles open-shift vans as first-class
    decision variables; this helper stays for the locked-row path."""
    for p in pairings_by_driver.get(driver_id, []):
        vt = van_types.get(p.van_id, "standard")
        if not _is_van_type_compatible(route_type, vt):
            continue
        if shift_date in van_used_dates.get(p.van_id, set()):
            continue
        return p.van_id
    return None


def solve(req: SolveRequest) -> SolveResponse:
    """Real CP-SAT solve. Returns the same SolveResponse shape as the
    stub so the wire format and downstream audit pipeline are unchanged."""
    started_at = time.perf_counter()

    # Rules + data-source toggles. All toggles default True so callers
    # that don't set them get the existing behavior. The dashboard's
    # Smart Fill "Advanced engine controls" expander surfaces these as
    # per-DSP switches so operators can A/B which signals are wired in.
    rules = req.rules or {}
    use_pto             = bool(rules.get("use_pto", True))
    use_affinity        = bool(rules.get("use_affinity", True))
    use_van_pairings    = bool(rules.get("use_van_pairings", True))
    use_attendance      = bool(rules.get("use_attendance", True))
    use_ad_hoc_rules    = bool(rules.get("use_ad_hoc_rules", True))
    # "Schedule Final-corrective drivers last" — the Smart Fill policy
    # checkbox (rules.attendance_penalty). Tri-state:
    #   True   → schedule-last tier: the per-shift FCA penalty is escalated
    #            above every soft term (target-days wall, affinity,
    #            preferred days, fairness, OT), so a final-corrective
    #            driver only works shifts no clean driver can legally
    #            cover. Coverage still dominates — no route, XL above all,
    #            is ever left open to keep an FCA driver off the schedule.
    #   False  → no FCA-based preference at all.
    #   absent → legacy soft penalty (weights.attendance per shift),
    #            preserving behavior for operators who never touched the
    #            checkbox.
    attendance_penalty  = rules.get("attendance_penalty", None)

    max_days = int(req.max_days or 5)
    woc_on = bool(rules.get("woc", True))
    woc_max_consec = int(rules.get("woc_max_consecutive_days") or DEFAULT_WOC_MAX_CONSECUTIVE_DAYS)
    # Weekly hour cap as a HARD constraint (not just an OT penalty). OFF by
    # default — only enforced when the caller explicitly opts in (the
    # dashboard sends weekly_hour_cap_enforcement from the Enforce-WOC
    # toggle). Defaulting off preserves the coverage-first soft behavior for
    # callers that don't request a hard cap.
    weekly_cap_hard = bool(rules.get("weekly_hour_cap_enforcement", False))
    # PTO counts toward the weekly hour cap: an approved-PTO day is treated as
    # `pto_hours_per_day` worked hours, so it REDUCES how many hours the driver
    # can still be scheduled that week. ON by default (the dashboard checkbox
    # ships checked); the operator can turn it off. Without this, PTO only
    # blocked assignment on the PTO day itself — a driver with 20h PTO + a 40h
    # cap could still be scheduled the full 40h of work (= 60h effective).
    pto_counts_toward_cap = bool(rules.get("pto_counts_toward_cap", True))
    try:
        pto_hours_per_day = float(rules.get("pto_hours_per_day") or 10)
    except (TypeError, ValueError):
        pto_hours_per_day = 10.0
    # Minimum rest between a driver's shifts (hard). OFF by default; the
    # dashboard sends min_rest explicitly.
    min_rest_on = bool(rules.get("min_rest", False))
    try:
        min_rest_hours = float(rules.get("min_rest_hours") or 10)
    except (TypeError, ValueError):
        min_rest_hours = 10.0
    # R002 driver-status policy. Default "active" mirrors the in-browser
    # engine's default (only active drivers auto-fill; onboarding drivers
    # join only when the DSP sets "active_and_onboarding"). A driver whose
    # status isn't one of these is never given an assign variable.
    eligible_driver_status = str(rules.get("eligible_driver_status", "active"))

    # ── Inputs ────────────────────────────────────────────────────────
    pto_dates_by_driver: dict[str, set[str]] = defaultdict(set)
    if use_pto:
        for p in req.pto:
            pto_dates_by_driver[p.driver_id].add(p.date)

    van_types: dict[str, str] = {v.id: v.vehicle_type for v in req.vans if v.status == "active"}
    pairings_by_driver: dict[str, list[VanPairingIn]] = defaultdict(list)
    if use_van_pairings:
        for vp in req.van_pairings:
            if vp.van_id in van_types:
                pairings_by_driver[vp.driver_id].append(vp)

    # Driver + shift indexes; pre-filter eligible (d, s) pairs.
    open_shifts: list[ShiftIn] = [s for s in req.shifts if not s.is_locked]
    locked_shifts: list[ShiftIn] = [s for s in req.shifts if s.is_locked and s.assigned_driver_id]

    # Track which dates a driver is ALREADY committed to via locked rows
    # so the rest of the model treats those as filled.
    locked_dates_by_driver: dict[str, set[str]] = defaultdict(set)
    for ls in locked_shifts:
        if ls.assigned_driver_id:
            locked_dates_by_driver[ls.assigned_driver_id].add(ls.date)

    eligible_drivers_per_shift: dict[str, list[str]] = {}
    eligible_shifts_per_driver: dict[str, list[str]] = defaultdict(list)
    for s in open_shifts:
        es: list[str] = []
        for d in req.drivers:
            if s.date in locked_dates_by_driver.get(d.id, set()):
                continue  # already booked that day via a locked shift
            if _is_eligible(d, s, pto_dates_by_driver, eligible_driver_status):
                es.append(d.id)
                eligible_shifts_per_driver[d.id].append(s.id)
        eligible_drivers_per_shift[s.id] = es

    # ── CP-SAT model ──────────────────────────────────────────────────
    model = cp_model.CpModel()

    # assign[d, s] ∈ {0, 1}
    assign: dict[tuple[str, str], cp_model.IntVar] = {}
    for sid, dids in eligible_drivers_per_shift.items():
        for did in dids:
            assign[(did, sid)] = model.NewBoolVar(f"a_{did}_{sid}")

    # uncovered[s] ∈ {0, 1}
    uncovered: dict[str, cp_model.IntVar] = {
        s.id: model.NewBoolVar(f"u_{s.id}") for s in open_shifts
    }

    # Each open shift gets exactly one driver OR is uncovered.
    for s in open_shifts:
        dids = eligible_drivers_per_shift.get(s.id, [])
        model.Add(
            sum(assign[(did, s.id)] for did in dids) + uncovered[s.id] == 1
        )

    # Per (driver, date) on_day boolean — 1 iff driver works any shift
    # on that date. Used by the max_days + WOC caps.
    on_day: dict[tuple[str, str], cp_model.IntVar] = {}
    shifts_by_driver_date: dict[tuple[str, str], list[str]] = defaultdict(list)
    for s in open_shifts:
        for did in eligible_drivers_per_shift.get(s.id, []):
            shifts_by_driver_date[(did, s.date)].append(s.id)

    for (did, date_iso), sids in shifts_by_driver_date.items():
        v = model.NewBoolVar(f"od_{did}_{date_iso}")
        on_day[(did, date_iso)] = v
        # on_day = OR of the assigns for this (driver, date).
        # Equivalent linear formulation: v >= each assign, v <= sum(assigns).
        for sid in sids:
            model.Add(v >= assign[(did, sid)])
        model.Add(v <= sum(assign[(did, sid)] for sid in sids))
        # No double-book per day: at most one assign per (driver, date).
        model.Add(sum(assign[(did, sid)] for sid in sids) <= 1)

    # Pre-baked on_days from locked rows so the caps see the full picture.
    locked_on_days: dict[str, set[str]] = defaultdict(set)
    for ls in locked_shifts:
        if ls.assigned_driver_id:
            locked_on_days[ls.assigned_driver_id].add(ls.date)

    # Max days per week — a HARD ceiling for every driver. A 5th-day opt-in
    # expands which days a driver is AVAILABLE for (baked into available_dows
    # upstream by the dashboard), but it must NOT raise the cap past max_days:
    # operators treat max_days as a hard limit, so the opt-in only helps fill a
    # driver UP TO the cap, never beyond it. (To allow more days, raise
    # max_days.) Previously opted-in drivers got max_days + 1, which let Smart
    # Fill schedule e.g. 6 days against a 5-day cap.
    for d in req.drivers:
        prebaked = len(locked_on_days.get(d.id, set()))
        flex = [
            on_day[(d.id, date_iso)]
            for (did, date_iso) in on_day
            if did == d.id
        ]
        cap = max_days
        if flex:
            model.Add(sum(flex) <= max(0, cap - prebaked))

    # WOC max consecutive days. For each driver, slide a window of size
    # (woc_max_consec + 1) over the week dates and require the count
    # inside the window to be <= woc_max_consec.
    if woc_on and woc_max_consec >= 1:
        # Collect all dates the week touches (open + locked).
        all_dates_sorted = sorted({s.date for s in req.shifts})
        for d in req.drivers:
            # Per-date booleans seen by THIS driver — locked rows count
            # as 1 (fixed) and add to the window sum directly.
            for i in range(0, len(all_dates_sorted) - woc_max_consec):
                window = all_dates_sorted[i : i + woc_max_consec + 1]
                terms = []
                fixed_in_window = 0
                for dt in window:
                    if dt in locked_on_days.get(d.id, set()):
                        fixed_in_window += 1
                    elif (d.id, dt) in on_day:
                        terms.append(on_day[(d.id, dt)])
                # sum(flex) <= woc_max_consec - fixed_in_window
                cap = woc_max_consec - fixed_in_window
                if cap < 0:
                    # Already violated by locked rows; the model is
                    # infeasible if we add this. Skip silently — the
                    # locked rows are the operator's prior choice.
                    continue
                if terms:
                    model.Add(sum(terms) <= cap)

    # Minimum rest between a driver's shifts (HARD). Two shifts the same
    # driver could hold whose end→start gap is below min_rest_hours are
    # mutually exclusive. Catches back-to-back late/early pairs across dates
    # that the one-shift-per-day cap doesn't. A locked shift pins one side:
    # an open shift too close to a locked one is forbidden outright.
    if min_rest_on and min_rest_hours > 0:
        min_rest_secs = min_rest_hours * 3600.0

        def _dt(t):
            try:
                return datetime.fromisoformat(t.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                return None

        shift_times: dict[str, tuple] = {}
        for s in req.shifts:
            if s.starts_at and s.ends_at:
                st, en = _dt(s.starts_at), _dt(s.ends_at)
                if st and en:
                    shift_times[s.id] = (st, en)

        locked_by_driver: dict[str, list[str]] = defaultdict(list)
        for ls in locked_shifts:
            if ls.assigned_driver_id and ls.id in shift_times:
                locked_by_driver[ls.assigned_driver_id].append(ls.id)

        def _too_close(a_id: str, b_id: str) -> bool:
            (sa, ea), (sb, eb) = shift_times[a_id], shift_times[b_id]
            gap = (sb - ea).total_seconds() if sa <= sb else (sa - eb).total_seconds()
            return gap < min_rest_secs

        for d in req.drivers:
            open_ids = [
                sid for sid in eligible_shifts_per_driver.get(d.id, [])
                if sid in shift_times and (d.id, sid) in assign
            ]
            locked_ids = locked_by_driver.get(d.id, [])
            for i in range(len(open_ids)):
                for j in range(i + 1, len(open_ids)):
                    if _too_close(open_ids[i], open_ids[j]):
                        model.Add(
                            assign[(d.id, open_ids[i])] + assign[(d.id, open_ids[j])] <= 1
                        )
            for o_id in open_ids:
                for l_id in locked_ids:
                    if _too_close(o_id, l_id):
                        model.Add(assign[(d.id, o_id)] == 0)

    # ── Objective: weighted soft terms (Step 6) ──────────────────────
    # Weights are tunable per DSP via rules.weights.* (with sane
    # defaults). Coverage dominates by ~100x so uncovered shifts are
    # always the worst outcome; the rest are tie-breakers within the
    # feasible-coverage frontier.
    # Weight hierarchy — STRICT (operator rule: "NEVER allow OT when
    # another driver could take the shift without OT"). Each tier
    # dominates the SUM of every term below it across the whole roster:
    #   1. Coverage (1M per shift) — uncovered is the worst possible
    #      outcome. Max 49 shifts × 1M = 49M overall ceiling.
    #   2. Target_days wall (10k per day over) — max plausible total
    #      OT = ~40 days × 10k = 400k, comfortably below a single
    #      uncovered shift. So coverage can never be sacrificed to
    #      avoid OT, but OT can never be incurred when an alternative
    #      exists (10k > sum of every affinity/preferred/fairness gain).
    #   3. Affinity/preferred/fairness/attendance — fine-tuning inside
    #      a feasible-non-OT schedule. Per-shift gains stay in single
    #      or double digits, well below the OT penalty.
    weights = (rules.get("weights") or {}) if isinstance(rules, dict) else {}
    W_COV  = int(weights.get("coverage",   1000000))  # per shift covered (was 10k)
    W_AFF  = int(weights.get("affinity",   1))        # per affinity-pct point
    W_OT   = int(weights.get("ot_risk",    5))        # per OT hour
    W_FAIR = int(weights.get("fairness",   2))        # per max-hour-of-roster
    W_ATT  = int(weights.get("attendance", 100))      # per shift to a final-corrective driver
    W_PREF = int(weights.get("preferred_days", 5))    # per assignment landing on the driver's preferred DOW

    objective_terms: list = []

    # 1. Coverage — bonus per covered open shift (= 1 - uncovered[s]).
    # XL routes are prioritized hard: a covered XL shift earns W_COV * the
    # XL multiplier. The default (1000) is large enough that ONE covered XL
    # route outweighs covering every standard route combined, so the solver
    # always fills XL before any standard route when drivers are scarce
    # (operator: "XL routes should be filled before other routes"). It's
    # still finite, so once all XL routes are covered the solver fills
    # standard routes normally — XL priority never leaves a coverable
    # standard route open. W_COV is 1e6 and soft terms are ≤100, so 1e9 per
    # XL stays far under CP-SAT's int64 range. Tunable via
    # rules.weights.coverage_xl_multiplier.
    W_COV_XL_MULT = int(weights.get("coverage_xl_multiplier", 1000))
    for s in open_shifts:
        w_cov_s = W_COV * W_COV_XL_MULT if s.route_type == "xl" else W_COV
        objective_terms.append(w_cov_s * (1 - uncovered[s.id]))

    # 2. Affinity — bonus per assignment where the driver historically
    # works that DOW. weekday_affinity is 7 ints in [0, 100] from the
    # driver_affinity table (precomputed nightly; see migration 0325).
    if use_affinity:
        affinity_by_driver: dict[str, list[int]] = {}
        for d in req.drivers:
            if isinstance(d.weekday_affinity, list) and len(d.weekday_affinity) == 7:
                affinity_by_driver[d.id] = [int(x or 0) for x in d.weekday_affinity]
        for s in open_shifts:
            sdow = _dow(s.date)
            for did in eligible_drivers_per_shift.get(s.id, []):
                score = affinity_by_driver.get(did, [0]*7)[sdow]
                if score > 0:
                    objective_terms.append(W_AFF * score * assign[(did, s.id)])

    # 2b. Preferred days — bonus per assignment landing on a DOW the
    # driver has flagged as preferred (driver.preferred_dows, same
    # Sun=0..Sat=6 convention as available_dows). Soft signal: drivers
    # still get scheduled outside their preferences when coverage needs
    # them, but the solver picks preferred days when there's a tie.
    preferred_by_driver: dict[str, set[int]] = {}
    for d in req.drivers:
        if isinstance(d.preferred_dows, list) and d.preferred_dows:
            preferred_by_driver[d.id] = {int(x) for x in d.preferred_dows}
    for s in open_shifts:
        sdow = _dow(s.date)
        for did in eligible_drivers_per_shift.get(s.id, []):
            if sdow in preferred_by_driver.get(did, set()):
                objective_terms.append(W_PREF * assign[(did, s.id)])

    # 3. Per-driver hours + OT penalty. Shift durations in whole hours
    # (CP-SAT performs better with smaller integer ranges; sub-hour
    # precision isn't material to OT decisions).
    shift_hours: dict[str, int] = {}
    for s in req.shifts:
        if s.duration_hours and s.duration_hours > 0:
            shift_hours[s.id] = max(1, round(s.duration_hours))
        elif s.starts_at and s.ends_at:
            try:
                start = datetime.fromisoformat(s.starts_at.replace("Z", "+00:00"))
                end = datetime.fromisoformat(s.ends_at.replace("Z", "+00:00"))
                hrs = max(1, round((end - start).total_seconds() / 3600))
                shift_hours[s.id] = hrs
            except (ValueError, AttributeError):
                shift_hours[s.id] = 10  # fallback to a typical DSP shift
        else:
            shift_hours[s.id] = 10
    weekly_cap = int(req.weekly_hour_cap or 40)

    # hours[d] = sum of (assign[d,s] * hours[s]) for all eligible s,
    # plus the locked hours already on the driver's plate.
    hours: dict[str, cp_model.IntVar] = {}
    ot_hours: dict[str, cp_model.IntVar] = {}
    max_assignable_hours = sum(shift_hours.values()) + 1
    for d in req.drivers:
        h = model.NewIntVar(0, max_assignable_hours, f"h_{d.id}")
        terms = [
            assign[(d.id, s.id)] * shift_hours.get(s.id, 10)
            for s in open_shifts
            if (d.id, s.id) in assign
        ]
        locked_hrs = sum(
            shift_hours.get(ls.id, 10)
            for ls in locked_shifts
            if ls.assigned_driver_id == d.id
        )
        if terms or locked_hrs:
            model.Add(h == sum(terms) + locked_hrs)
        else:
            model.Add(h == 0)
        hours[d.id] = h
        # Effective cap for THIS driver. When PTO counts toward the cap, each
        # approved-PTO day this week consumes pto_hours_per_day of capacity, so
        # the hours the driver can still be SCHEDULED drop accordingly (floored
        # at 0). e.g. 40h cap with 2 PTO days @10h → only 20h of work allowed.
        driver_cap = weekly_cap
        if pto_counts_toward_cap:
            pto_days = len(pto_dates_by_driver.get(d.id, set()))
            driver_cap = max(0, weekly_cap - int(round(pto_days * pto_hours_per_day)))
        # HARD weekly hour cap — a driver's scheduled (worked) hours may not
        # exceed the effective cap. Shifts that can only be covered by busting
        # it are left uncovered (heavily penalized) rather than over-scheduled.
        if weekly_cap_hard and weekly_cap > 0:
            model.Add(h <= driver_cap)
        # ot[d] = max(0, h - cap) — soft OT penalty (0 once the hard cap is on).
        ot = model.NewIntVar(0, max_assignable_hours, f"ot_{d.id}")
        model.AddMaxEquality(ot, [h - driver_cap, 0])
        ot_hours[d.id] = ot
        objective_terms.append(-W_OT * ot)

    # 4. Fairness — penalize the max-hours-of-any-driver. Pushes the
    # solver to spread hours instead of stacking onto a few drivers.
    if hours:
        max_hours_var = model.NewIntVar(0, max_assignable_hours, "max_hours")
        model.AddMaxEquality(max_hours_var, list(hours.values()))
        objective_terms.append(-W_FAIR * max_hours_var)

    # 5. Attendance-risk penalty — final-corrective drivers carry a
    # negative weight per assignment. The solver still picks them when
    # coverage demands, but prefers safer drivers when there's a choice.
    #
    # With the "Schedule Final-corrective drivers last" checkbox ON
    # (rules.attendance_penalty is True), the penalty escalates to a
    # schedule-last tier: it must beat the largest soft gain a single
    # assignment can produce — the target-days wall (10k, ≤40k at the max
    # slider), affinity (≤400), preferred days (≤20), OT/fairness (double
    # digits) — so clean drivers absorb extra days before an FCA driver
    # gets anything. It stays BELOW coverage, clamped to half the standard
    # coverage weight even under a weights override, so no coverable route
    # is ever left open to keep an FCA driver home. XL routes sit another
    # ×1000 above that (W_COV_XL_MULT), so XL coverage is protected at all
    # costs: an FCA driver who is the only XL-certified option still runs
    # the XL route.
    w_fca = 0
    if use_attendance and attendance_penalty is not False:
        if attendance_penalty is True:
            w_fca = min(int(weights.get("attendance_last", 100_000)), W_COV // 2)
        else:
            w_fca = W_ATT
        for d in req.drivers:
            if d.final_corrective_action:
                for s in open_shifts:
                    if (d.id, s.id) in assign:
                        objective_terms.append(-w_fca * assign[(d.id, s.id)])

    # 5b. Soft target days/week per driver (R022 equivalent on CP-SAT).
    # DSPs commonly want every driver at e.g. 4 days a week, going past
    # only when coverage demands it (4×10h = 40h before OT). Linear
    # penalty per day over target, summed across drivers.
    #
    # Calibration: W_TARGET=1000 is intentionally an order of magnitude
    # above the per-shift gains (W_AFF up to 100, W_PREF 5). The soft
    # cap is meant to act as a wall — a high-affinity tenured driver
    # should not get pushed into OT just because they "usually" work
    # that day, as long as a lower-affinity driver under target is
    # eligible. Affinity still controls which weekday each driver lands
    # on inside the wall; it just can't break the wall. Coverage
    # (W_COV=10000) still wins when every driver hits target — that's
    # the OT escape hatch. 0 disables the cap entirely.
    target_days = int(rules.get("target_days_per_week", 4))
    W_TARGET = int(weights.get("target_days", 10000))
    if target_days > 0 and W_TARGET > 0:
        for d in req.drivers:
            d_day_vars = [
                on_day[(did, dt)]
                for (did, dt) in on_day
                if did == d.id
            ]
            if not d_day_vars:
                continue
            prebaked = len(locked_on_days.get(d.id, set()))
            d_total = model.NewIntVar(0, len(d_day_vars) + prebaked,
                                      f"days_{d.id}")
            model.Add(d_total == sum(d_day_vars) + prebaked)
            over = model.NewIntVar(0, len(d_day_vars) + prebaked,
                                   f"over_{d.id}")
            model.AddMaxEquality(over, [d_total - target_days, 0])
            objective_terms.append(-W_TARGET * over)

    # ── 5c. Van decision variables ────────────────────────────────────
    # Vans become first-class assignments alongside drivers. The model
    # decides which van goes to which open shift jointly with which
    # driver, which:
    #   • Maximizes the number of shifts that get a van (globally vs
    #     greedy-per-shift like the heuristic).
    #   • Honors van_pairings via a continuity bonus (pair_match AND).
    #   • Prevents van double-booking per date.
    #
    # Locked shifts get their van via the heuristic _van_for_driver
    # below (in the result-reading section). Slots those consume are
    # pre-subtracted here so the CP-SAT model doesn't try to schedule
    # the same (van, date) twice.
    pre_consumed_van_dates: dict[str, set[str]] = defaultdict(set)
    locked_van_assignment: dict[str, Optional[str]] = {}  # locked shift_id → van_id
    # Compute heuristic van picks for locked shifts here, ONCE, so both
    # this pre-subtraction step and the result-reading step agree.
    _van_used_for_locked: dict[str, set[str]] = defaultdict(set)
    if use_van_pairings:
        for ls in locked_shifts:
            if not ls.assigned_driver_id:
                continue
            vid = _van_for_driver(
                ls.assigned_driver_id, ls.route_type,
                pairings_by_driver, van_types, _van_used_for_locked, ls.date,
            )
            locked_van_assignment[ls.id] = vid
            if vid:
                _van_used_for_locked[vid].add(ls.date)
                pre_consumed_van_dates[vid].add(ls.date)

    # van_assign[v, s] for each open shift × type-compatible van whose
    # date isn't already consumed by a locked row.
    van_assign: dict[tuple[str, str], cp_model.IntVar] = {}
    vans_per_shift: dict[str, list[str]] = defaultdict(list)
    shifts_per_van_date: dict[tuple[str, str], list[str]] = defaultdict(list)
    for s in open_shifts:
        for v in req.vans:
            if v.status != "active":
                continue
            if not _is_van_type_compatible(s.route_type, van_types.get(v.id, "standard")):
                continue
            if s.date in pre_consumed_van_dates.get(v.id, set()):
                continue
            key = (v.id, s.id)
            var = model.NewBoolVar(f"van_{v.id}_{s.id}")
            van_assign[key] = var
            vans_per_shift[s.id].append(v.id)
            shifts_per_van_date[(v.id, s.date)].append(s.id)

    # At most one van per shift.
    for s_id, vids in vans_per_shift.items():
        model.Add(sum(van_assign[(v, s_id)] for v in vids) <= 1)

    # Van can only be assigned to a covered shift.
    # van_total[s] ≤ 1 - uncovered[s].
    for s in open_shifts:
        vids = vans_per_shift.get(s.id, [])
        if vids:
            model.Add(sum(van_assign[(v, s.id)] for v in vids) <= 1 - uncovered[s.id])

    # No van double-book per date (open-shift side; locked already pre-consumed).
    for (v_id, _date), sids in shifts_per_van_date.items():
        model.Add(sum(van_assign[(v_id, s_id)] for s_id in sids) <= 1)

    # Continuity bonus: when van_pairing (d, v) exists AND both d takes
    # shift s AND v takes shift s, add a positive objective term.
    W_VAN_CONT = int(weights.get("van_continuity", 10))
    if use_van_pairings:
        for vp in req.van_pairings:
            if vp.van_id not in van_types:
                continue
            for s in open_shifts:
                if (vp.driver_id, s.id) not in assign:
                    continue
                if (vp.van_id, s.id) not in van_assign:
                    continue
                # pair_match = assign[d, s] AND van_assign[v, s]
                pm = model.NewBoolVar(f"pm_{vp.driver_id}_{vp.van_id}_{s.id}")
                a = assign[(vp.driver_id, s.id)]
                va = van_assign[(vp.van_id, s.id)]
                model.Add(pm <= a)
                model.Add(pm <= va)
                model.Add(pm >= a + va - 1)
                objective_terms.append(W_VAN_CONT * pm)

    # Van coverage — a small reward per van actually assigned, so the model
    # fills a free, type-compatible van onto every covered shift (the stated
    # intent above), not only when a continuity pairing happens to pay out.
    # Kept far below driver coverage (W_COV) and below the target/OT tiers so
    # it can never trade a covered shift — or a non-OT schedule — for a van;
    # it only breaks ties among otherwise-equal solutions. Ranks below the
    # continuity bonus so a paired van still wins its shift.
    W_VAN_COVER = int(weights.get("van_coverage", 3))
    for _key, _var in van_assign.items():
        objective_terms.append(W_VAN_COVER * _var)


    # ── 6. Ad-hoc constraints (Step 5.5) ──────────────────────────────
    # Operator-authored rules compiled into CP-SAT additions. Soft rules
    # contribute slack-penalty terms; hard rules add direct constraints.
    if use_ad_hoc_rules and req.ad_hoc_constraints:
        from .ad_hoc import AdHocContext, compile_ad_hoc
        ah_ctx = AdHocContext(
            assign=assign,
            on_day=on_day,
            shifts_by_id={s.id: s for s in req.shifts},
            eligible_drivers_per_shift=eligible_drivers_per_shift,
            all_dates_sorted=sorted({s.date for s in req.shifts}),
        )
        ah_penalties, _touched = compile_ad_hoc(model, ah_ctx, req.ad_hoc_constraints)
        objective_terms.extend(ah_penalties)

    model.Maximize(sum(objective_terms))

    # ── Solve ─────────────────────────────────────────────────────────
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.5, req.time_budget_ms / 1000.0)
    solver.parameters.random_seed = req.solver_seed or 0
    # Determinism (matches the in-browser engine's byte-identical guarantee):
    # a SINGLE search worker + fixed seed makes the solve reproducible run to
    # run — identical input → identical schedule — even when the time budget
    # cuts the search short (a single-threaded search is itself deterministic;
    # the non-determinism came from multiple workers racing to report a
    # tie-broken optimum). This is the guarantee the module docstring claims,
    # which the previous `= 4` contradicted.
    solver.parameters.num_search_workers = 1

    status_code = solver.Solve(model)
    status_name = solver.StatusName(status_code)

    # ── Read back ─────────────────────────────────────────────────────
    assigned_out: list[AssignedShift] = []
    uncovered_out: list[UncoveredShift] = []
    driver_shifts_count: dict[str, int] = defaultdict(int)
    van_used_dates: dict[str, set[str]] = defaultdict(set)

    # Locked / preserved come back unchanged. Van pinning was already
    # computed up-front (in the 5c block above) so the CP-SAT solver
    # could pre-subtract those (van, date) slots from its decision
    # space — re-use that mapping here for consistency.
    for ls in locked_shifts:
        if not ls.assigned_driver_id:
            continue
        v_id = locked_van_assignment.get(ls.id)
        if v_id:
            van_used_dates[v_id].add(ls.date)
        driver_shifts_count[ls.assigned_driver_id] += 1
        assigned_out.append(AssignedShift(
            shift_id=ls.id,
            driver_id=ls.assigned_driver_id,
            van_id=v_id,
            source="locked",
            summary=f"Locked / preserved row for {ls.assigned_driver_id}.",
        ))

    # Open shifts — read CP-SAT result.
    if status_code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for s in open_shifts:
            if solver.BooleanValue(uncovered[s.id]):
                uncovered_out.append(UncoveredShift(
                    shift_id=s.id,
                    summary=(
                        f"No eligible driver available for shift {s.id} "
                        f"on {s.date} ({s.route_type}). Status={status_name}."
                    ),
                ))
                continue
            picked: Optional[str] = None
            for did in eligible_drivers_per_shift.get(s.id, []):
                if solver.BooleanValue(assign[(did, s.id)]):
                    picked = did
                    break
            if picked is None:
                uncovered_out.append(UncoveredShift(
                    shift_id=s.id,
                    summary=f"Solver returned no assignment for shift {s.id}; status={status_name}.",
                ))
                continue
            # Van read from the CP-SAT model (Step 5c). The solver
            # already prevented double-booking + cert-mismatch + locked-
            # date collisions; just pick whichever van_assign[v, s] the
            # solver set true (at most one by constraint).
            van_id: Optional[str] = None
            for v_id in vans_per_shift.get(s.id, []):
                if solver.BooleanValue(van_assign[(v_id, s.id)]):
                    van_id = v_id
                    break
            if van_id:
                van_used_dates[van_id].add(s.date)
            driver_shifts_count[picked] += 1
            assigned_out.append(AssignedShift(
                shift_id=s.id,
                driver_id=picked,
                van_id=van_id,
                source="auto_fill",
            ))
    else:
        # Infeasible / unknown — everything open is uncovered.
        for s in open_shifts:
            uncovered_out.append(UncoveredShift(
                shift_id=s.id,
                summary=f"Solver could not produce a feasible assignment (status={status_name}).",
            ))

    # ── Unscheduled-driver report ─────────────────────────────────────
    unscheduled_out: list[UnscheduledDriver] = []
    for d in req.drivers:
        if driver_shifts_count.get(d.id, 0) > 0:
            continue
        eligible_anywhere = len(eligible_shifts_per_driver.get(d.id, [])) > 0
        unscheduled_out.append(UnscheduledDriver(
            driver_id=d.id,
            eligible_somewhere=eligible_anywhere,
        ))

    # ── Metrics ───────────────────────────────────────────────────────
    fresh_assigned = sum(1 for a in assigned_out if a.source != "locked")
    locked_count = sum(1 for a in assigned_out if a.source == "locked")
    total = len(req.shifts)
    coverage_pct = round((locked_count + fresh_assigned) / total * 10000) / 100 if total else None
    elapsed_ms = int((time.perf_counter() - started_at) * 1000)

    response_status: str
    if status_code == cp_model.OPTIMAL:
        response_status = "ok"
    elif status_code == cp_model.FEASIBLE:
        response_status = "ok"
    elif status_code == cp_model.INFEASIBLE:
        response_status = "infeasible"
    elif status_code == cp_model.UNKNOWN:
        response_status = "timeout"
    else:
        response_status = "error"

    resp = SolveResponse(
        status=response_status,
        solver_version=SOLVER_VERSION,
        assigned_shifts=assigned_out,
        uncovered_shifts=uncovered_out,
        unscheduled_drivers=unscheduled_out,
        metrics=SolveMetrics(
            coverage_pct=coverage_pct,
            total_shifts=total,
            open_shifts=len(open_shifts),
            assigned=fresh_assigned,
            uncovered=len(uncovered_out),
            unscheduled_drivers=len(unscheduled_out),
            solver_wall_ms=elapsed_ms,
            solver_status=status_name,
        ),
    )

    # ── Diagnostic Trace Mode (opt-in) ────────────────────────────────
    # Pure observability: re-derives "why" from the structures the model
    # already built and attaches a full decision trace. Wrapped so a bug
    # in diagnostics can NEVER break a real solve — the schedule above is
    # already final and unaffected by anything below.
    if getattr(req, "trace", False):
        try:
            from .validators import quick_validate
            settings_used = {
                "max_days": max_days,
                "weekly_hour_cap": weekly_cap,
                "weekly_hour_cap_enforcement": weekly_cap_hard,
                "woc": woc_on,
                "woc_max_consecutive_days": woc_max_consec,
                "pto_counts_toward_cap": pto_counts_toward_cap,
                "pto_hours_per_day": pto_hours_per_day,
                "min_rest": min_rest_on,
                "min_rest_hours": min_rest_hours,
                "target_days_per_week": target_days,
                "use_pto": use_pto,
                "use_affinity": use_affinity,
                "use_van_pairings": use_van_pairings,
                "use_attendance": use_attendance,
                "use_ad_hoc_rules": use_ad_hoc_rules,
                "attendance_penalty": attendance_penalty if isinstance(attendance_penalty, bool) else None,
                "weights": {
                    "coverage": W_COV,
                    "coverage_xl_multiplier": W_COV_XL_MULT,
                    "affinity": W_AFF,
                    "preferred_days": W_PREF,
                    "ot_risk": W_OT,
                    "fairness": W_FAIR,
                    "attendance": W_ATT,
                    "attendance_fca_applied": w_fca,
                    "target_days": W_TARGET,
                },
            }
            art = SolveArtifacts(
                pto_dates_by_driver=pto_dates_by_driver,
                locked_dates_by_driver=locked_dates_by_driver,
                open_shifts=open_shifts,
                locked_shifts=locked_shifts,
                eligible_drivers_per_shift=eligible_drivers_per_shift,
                eligible_shifts_per_driver=eligible_shifts_per_driver,
                shift_hours=shift_hours,
                settings_used=settings_used,
                assigned_out=assigned_out,
                uncovered_out=uncovered_out,
                status_name=status_name,
                response_status=response_status,
                solver_wall_ms=elapsed_ms,
                structural_issues=quick_validate(req),
            )
            resp.trace = build_trace(req, art)
        except Exception as exc:  # noqa: BLE001 — diagnostics must never break a solve
            resp.trace = {"error": f"{type(exc).__name__}: {exc}"}

    return resp
