"""
Smart Fill Diagnostic Trace Mode.

Turns the CP-SAT solver from a black box into a self-explaining one. Given
the inputs and outputs of a single solve, `build_trace` produces a complete,
structured decision report (Sections 1–8 of the spec) plus a pre-rendered
human-readable `report` string. `render_report` does the text rendering.

This module is OBSERVABILITY ONLY. It reads the same structures the model
already built (eligibility sets, the assignment read-back, the resolved
settings) and re-derives "why" — it never feeds back into the model and
never changes a scheduling decision. It is invoked only when the caller
sets `trace: true` on the request.

The six questions this is built to answer instantly:
  1. Why did this driver get 0 shifts?      → Sections 2 + 7
  2. Why did this shift remain open?         → Sections 3 + 8
  3. Was the driver excluded before solver?  → driver.considered_by_solver
  4. Was the driver considered by solver?    → driver.considered_by_solver
  5. Was the shift sent to solver?           → shift.sent_to_solver
  6. Did scoring or eligibility cause it?    → driver/shift.cause
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from .eligibility import (
    DOW_NAMES,
    CONSECUTIVE_DAYS_FAIL,
    DOUBLE_BOOK_LOCKED,
    FailReason,
    MAX_HOURS_FAIL,
    STATUS_FAIL,
    first_failure_reason,
)
from .models import AssignedShift, DriverIn, ShiftIn, SolveRequest, UncoveredShift

TRACE_VERSION = "smart-fill-trace-v1"

# Driver pool-entry statuses the pipeline treats as schedulable. Anything
# else is an operator-side exclusion (the dashboard normally filters these
# before the payload is built; we still report it if one slips through).
_SCHEDULABLE_STATUSES = {"active", "onboarding"}


# ── Inputs ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SolveArtifacts:
    """Everything `build_trace` needs from a single `solve()` invocation.

    Populated by cpsat_model.solve() right before it returns, so the trace
    reflects exactly the model that ran — same eligibility sets, same
    read-back, same resolved settings."""

    # Pre-solve structures.
    pto_dates_by_driver: dict[str, set[str]]
    locked_dates_by_driver: dict[str, set[str]]
    open_shifts: list[ShiftIn]
    locked_shifts: list[ShiftIn]
    eligible_drivers_per_shift: dict[str, list[str]]
    eligible_shifts_per_driver: dict[str, list[str]]
    shift_hours: dict[str, int]
    settings_used: dict[str, Any]

    # Post-solve read-back.
    assigned_out: list[AssignedShift]
    uncovered_out: list[UncoveredShift]
    status_name: str
    response_status: str
    solver_wall_ms: int
    structural_issues: list[dict] = field(default_factory=list)


# ── Small helpers ─────────────────────────────────────────────────────────


def _extra(obj: Any, key: str, default: Any = None) -> Any:
    """Read a possibly-extra (extra='allow') field off a pydantic model."""
    me = getattr(obj, "model_extra", None) or {}
    if key in me and me[key] is not None:
        return me[key]
    val = getattr(obj, key, None)
    return default if val is None else val


def _dow_name(iso: str) -> str:
    try:
        return DOW_NAMES[datetime.strptime(iso, "%Y-%m-%d").date().isoweekday() % 7]
    except (ValueError, TypeError):
        return "?"


def _is_cushion(shift: ShiftIn) -> bool:
    """Cushion seats are planned-capacity shift rows. The dashboard marks
    them with `is_cushion` (preferred) or `shift_kind == "cushion"`; the
    engine fills them like any other open shift, so the flag is observability
    only. Absent marker → treated as a regular shift."""
    if _extra(shift, "is_cushion", False) is True:
        return True
    return str(_extra(shift, "shift_kind", "") or "").lower() == "cushion"


def _seat_kind(shift: ShiftIn) -> str:
    return "cushion" if _is_cushion(shift) else "regular"


def _required_certs(route_type: str) -> list[str]:
    rt = (route_type or "standard").lower()
    if rt == "step_van":
        return ["DOT"]
    if rt == "xl":
        return ["XL"]
    if rt == "edv":
        return ["EDV"]
    return []


def _driver_name(d: DriverIn) -> str:
    return (d.full_name or d.id or "").strip() or d.id


def _aggregate_reasons(reasons: list[FailReason]) -> list[dict]:
    """Roll a list of first-failure reasons up to [{code, count, message}],
    most common first (ties broken by code for determinism)."""
    by_code: dict[str, dict] = {}
    counts: Counter = Counter()
    for r in reasons:
        counts[r.code] += 1
        by_code.setdefault(r.code, {"code": r.code, "message": r.message})
    out = [
        {"code": c, "count": counts[c], "message": by_code[c]["message"]}
        for c in by_code
    ]
    out.sort(key=lambda x: (-x["count"], x["code"]))
    return out


def _effective_cap(
    driver_id: str,
    weekly_cap: int,
    pto_dates_by_driver: dict[str, set[str]],
    pto_counts_toward_cap: bool,
    pto_hours_per_day: float,
) -> int:
    """Mirror cpsat_model's per-driver effective weekly-hour cap."""
    if not pto_counts_toward_cap:
        return weekly_cap
    pto_days = len(pto_dates_by_driver.get(driver_id, set()))
    return max(0, weekly_cap - int(round(pto_days * pto_hours_per_day)))


# ── Trace builder ─────────────────────────────────────────────────────────


def build_trace(
    req: SolveRequest,
    art: SolveArtifacts,
    *,
    now: Optional[datetime] = None,
) -> dict:
    """Build the full structured trace + rendered report for one solve."""
    now = now or datetime.now(timezone.utc)
    s = art.settings_used

    drivers = sorted(req.drivers, key=lambda d: d.id)
    all_shifts = sorted(req.shifts, key=lambda x: x.id)

    # ── Index the read-back ────────────────────────────────────────────
    assigned_by_shift: dict[str, AssignedShift] = {a.shift_id: a for a in art.assigned_out}
    uncovered_ids = {u.shift_id for u in art.uncovered_out}
    uncovered_by_id = {u.shift_id: u for u in art.uncovered_out}

    assigned_shift_ids_by_driver: dict[str, list[str]] = defaultdict(list)
    assigned_hours_by_driver: dict[str, int] = defaultdict(int)
    locked_hours_by_driver: dict[str, int] = defaultdict(int)
    for a in art.assigned_out:
        assigned_shift_ids_by_driver[a.driver_id].append(a.shift_id)
        h = art.shift_hours.get(a.shift_id, 0)
        assigned_hours_by_driver[a.driver_id] += h
        if a.source == "locked":
            locked_hours_by_driver[a.driver_id] += h

    eligible_set_per_shift = {
        sid: set(dids) for sid, dids in art.eligible_drivers_per_shift.items()
    }

    # ── One pass over open (shift × driver): per-pair fail reasons ──────
    # Drives Section 4 (eligibility), and feeds the "dominant reason"
    # aggregations for Sections 2/3/7/8.
    fails_by_shift: dict[str, list[tuple[str, FailReason]]] = defaultdict(list)
    fails_by_driver: dict[str, list[FailReason]] = defaultdict(list)
    pass_count = 0
    fail_count = 0
    fail_code_counter: Counter = Counter()

    for shift in art.open_shifts:
        eligible_set = eligible_set_per_shift.get(shift.id, set())
        for d in drivers:
            if d.id in eligible_set:
                pass_count += 1
                continue
            # FAIL — reproduce solve()'s gate order: locked-day conflict
            # is checked before static eligibility.
            if shift.date in art.locked_dates_by_driver.get(d.id, set()):
                reason = FailReason(
                    DOUBLE_BOOK_LOCKED,
                    f"Already holds a locked shift on {shift.date}",
                )
            else:
                reason = first_failure_reason(d, shift, art.pto_dates_by_driver) or FailReason(
                    "UNKNOWN", "Ineligible (no reason determined)"
                )
            fails_by_shift[shift.id].append((d.id, reason))
            fails_by_driver[d.id].append(reason)
            fail_count += 1
            fail_code_counter[reason.code] += 1

    # ── Section 4 · Eligibility trace ──────────────────────────────────
    eligibility_by_shift = []
    for shift in art.open_shifts:
        eligibility_by_shift.append({
            "shift_id": shift.id,
            "eligible_driver_ids": sorted(eligible_set_per_shift.get(shift.id, set())),
            "failed": [
                {"driver_id": did, "code": r.code, "message": r.message}
                for did, r in sorted(fails_by_shift.get(shift.id, []), key=lambda x: x[0])
            ],
        })
    eligibility_by_shift.sort(key=lambda x: x["shift_id"])

    section_eligibility = {
        "note": (
            "PASS ⇔ the solver created an assign variable for the pair. "
            "FAIL stores the first hard gate that blocked it (PTO / availability "
            "/ cert / license / locked-day double-book). Capacity caps (max days, "
            "consecutive days, weekly hours, rest) are global solve constraints, "
            "not per-pair gates — they surface at the driver/shift layer instead."
        ),
        "evaluated_pairs": pass_count + fail_count,
        "pass_count": pass_count,
        "fail_count": fail_count,
        "fail_by_code": dict(sorted(fail_code_counter.items())),
        "by_shift": eligibility_by_shift,
    }

    # ── Per-driver classification (Sections 2 + 7) ─────────────────────
    weekly_cap = int(s.get("weekly_hour_cap", req.weekly_hour_cap or 40))
    max_days = int(s.get("max_days", req.max_days or 5))
    target_days = int(s.get("target_days_per_week", 4))
    pto_counts = bool(s.get("pto_counts_toward_cap", True))
    pto_hpd = float(s.get("pto_hours_per_day", 10) or 10)
    solve_ok = art.response_status in ("ok",)

    driver_traces = []
    zero_shift_reports = []
    disposition_buckets: dict[str, list[str]] = {
        "assigned": [], "considered_not_selected": [], "excluded_before_solver": [],
    }

    for d in drivers:
        considered = len(art.eligible_shifts_per_driver.get(d.id, [])) > 0
        assigned_ids = sorted(assigned_shift_ids_by_driver.get(d.id, []))
        assigned_count = len(assigned_ids)
        assigned_hours = assigned_hours_by_driver.get(d.id, 0)
        locked_hours = locked_hours_by_driver.get(d.id, 0)
        eff_cap = _effective_cap(d.id, weekly_cap, art.pto_dates_by_driver, pto_counts, pto_hpd)
        ot_hours = max(0, assigned_hours - eff_cap)
        status = (d.status or "").lower()
        pto_days = len(art.pto_dates_by_driver.get(d.id, set()))

        # Disposition + the one-sentence "why".
        cause = "n/a"
        if assigned_count > 0:
            disposition = "assigned"
            why = (
                f"Assigned {assigned_count} shift(s) "
                f"({assigned_hours}h"
                + (f", {ot_hours}h over the {eff_cap}h cap" if ot_hours else "")
                + ")."
            )
        else:
            # Zero shifts — explain definitively.
            if not considered:
                disposition = "excluded_before_solver"
                if status and status not in _SCHEDULABLE_STATUSES:
                    cause = "eligibility"
                    why = (
                        f"Excluded before solver — status is '{status}', "
                        "which is not schedulable."
                    )
                    exclusion = [{"code": STATUS_FAIL,
                                  "count": 1,
                                  "message": f"Driver status '{status}' is not schedulable"}]
                else:
                    cause = "eligibility"
                    agg = _aggregate_reasons(fails_by_driver.get(d.id, []))
                    exclusion = agg
                    n_open = len(art.open_shifts)
                    if agg:
                        top = agg[0]
                        why = (
                            f"Eligible for 0 of {n_open} open shift(s) — "
                            f"excluded before solver because {top['message'].lower()} "
                            f"(blocked {top['count']} of {n_open})."
                        )
                    else:
                        why = "Excluded before solver (no eligible shift)."
            else:
                disposition = "considered_not_selected"
                eligible_sids = set(art.eligible_shifts_per_driver.get(d.id, []))
                their_uncovered = sorted(eligible_sids & uncovered_ids)
                taken_by_others = sorted(
                    sid for sid in eligible_sids
                    if sid in assigned_by_shift
                    and assigned_by_shift[sid].driver_id != d.id
                )
                exclusion = []
                if not solve_ok:
                    cause = "solver_status"
                    why = (
                        f"Considered for {len(eligible_sids)} shift(s) but the solver "
                        f"did not reach a usable solution (status={art.status_name})."
                    )
                elif their_uncovered:
                    # Could have taken an uncovered shift → a hard cap on the
                    # driver is the only thing that can stop coverage (which
                    # dominates the objective ~1e6:1).
                    cause = "capacity"
                    locked_days = len(art.locked_dates_by_driver.get(d.id, set()))
                    if locked_days >= max_days:
                        detail = (
                            f"already at the {max_days}-day max from "
                            f"{locked_days} locked shift(s)"
                        )
                        code = MAX_HOURS_FAIL
                    elif eff_cap == 0:
                        detail = "weekly-hour cap fully consumed by approved PTO"
                        code = MAX_HOURS_FAIL
                    else:
                        detail = (
                            "every remaining eligible shift would breach a hard cap "
                            "(max days / consecutive days / weekly hours / rest)"
                        )
                        code = CONSECUTIVE_DAYS_FAIL
                    why = (
                        f"Eligible for {len(eligible_sids)} shift(s) — "
                        f"{len(their_uncovered)} left open — but {detail}."
                    )
                    exclusion = [{"code": code, "count": len(their_uncovered),
                                  "message": detail}]
                else:
                    cause = "scoring"
                    winners = sorted({
                        assigned_by_shift[sid].driver_id for sid in taken_by_others
                    })
                    sample = ", ".join(winners[:3]) + ("…" if len(winners) > 3 else "")
                    why = (
                        f"Eligible for {len(eligible_sids)} shift(s) but lost the "
                        f"scoring competition — every one went to another eligible "
                        f"driver" + (f" ({sample})" if sample else "") + "."
                    )

        disposition_buckets[disposition].append(d.id)

        driver_traces.append({
            "driver_id": d.id,
            "driver_name": _driver_name(d),
            "pool_entry": "included" if considered else "excluded",
            "considered_by_solver": considered,
            "disposition": disposition,
            "cause": cause,
            "status": d.status,
            "availability_dows": d.available_dows,
            "availability_days": (
                None if d.available_dows is None
                else [DOW_NAMES[x] for x in d.available_dows if 0 <= x <= 6]
            ),
            "preferred_dows": d.preferred_dows,
            "target_days": target_days,
            "certifications": {
                "dot": bool(d.dot_certified),
                "xl": bool(d.xl_certified),
                "edv": bool(d.edv_certified),
            },
            "license_expires_on": d.dl_expires_on,
            "pto_days": pto_days,
            "current_hours": locked_hours,
            "eligible_shift_count": len(art.eligible_shifts_per_driver.get(d.id, [])),
            "results": {
                "assigned_shift_ids": assigned_ids,
                "assigned_shifts": assigned_count,
                "assigned_hours": assigned_hours,
                "overtime_hours": ot_hours,
            },
            "exclusion_reasons": exclusion if assigned_count == 0 else [],
            "why": why,
        })

        if assigned_count == 0:
            zero_shift_reports.append({
                "driver_id": d.id,
                "driver_name": _driver_name(d),
                "considered_by_solver": considered,
                "cause": cause,
                "reason": why,
            })

    # ── Per-shift classification (Sections 3 + 8) ──────────────────────
    shift_traces = []
    unfilled_reports = []
    locked_id_set = {ls.id for ls in art.locked_shifts}

    for shift in all_shifts:
        is_locked = shift.id in locked_id_set
        cushion = _is_cushion(shift)
        eligible_ids = sorted(eligible_set_per_shift.get(shift.id, set()))
        a = assigned_by_shift.get(shift.id)

        base = {
            "shift_id": shift.id,
            "date": shift.date,
            "day_of_week": _dow_name(shift.date),
            "route_type": shift.route_type,
            "seat_kind": _seat_kind(shift),
            "is_cushion": cushion,
            "required_certifications": _required_certs(shift.route_type),
            "duration_hours": art.shift_hours.get(shift.id),
            "sent_to_solver": not is_locked,
            "eligible_driver_count": len(eligible_ids),
            "eligible_driver_ids": eligible_ids,
        }

        if is_locked:
            base.update({
                "disposition": "not_sent_to_solver",
                "assigned_driver_id": a.driver_id if a else shift.assigned_driver_id,
                "cause": "n/a",
                "why": (
                    f"Locked / preserved row — honored verbatim, never sent to "
                    f"the solver (driver {a.driver_id if a else shift.assigned_driver_id})."
                ),
            })
        elif a is not None:
            base.update({
                "disposition": "filled",
                "assigned_driver_id": a.driver_id,
                "cause": "n/a",
                "why": f"Filled by driver {a.driver_id} ({a.source}).",
            })
        else:
            # Open + uncovered — say why definitively.
            base["assigned_driver_id"] = None
            if not solve_ok:
                base["disposition"] = "uncovered_solver_status"
                base["cause"] = "solver_status"
                base["why"] = (
                    f"Solver did not reach a feasible/optimal solution "
                    f"(status={art.status_name}); every open shift left uncovered."
                )
            elif len(eligible_ids) == 0:
                agg = _aggregate_reasons([r for _, r in fails_by_shift.get(shift.id, [])])
                base["disposition"] = "uncovered_no_eligible"
                base["cause"] = "eligibility"
                base["top_block_reasons"] = agg
                if agg:
                    top = agg[0]
                    base["why"] = (
                        f"No eligible drivers — top blocker: {top['message'].lower()} "
                        f"({top['count']} driver(s))."
                    )
                else:
                    base["why"] = "No eligible drivers."
            else:
                base["disposition"] = "uncovered_capacity"
                base["cause"] = "capacity"
                base["why"] = (
                    f"{len(eligible_ids)} eligible driver(s) existed, but every one "
                    "would breach a hard cap (max days / consecutive days / weekly "
                    "hours / rest) if assigned. Coverage dominates the objective, so "
                    "the solver leaves a shift open only when no feasible driver "
                    "remains."
                )

        shift_traces.append(base)
        if base.get("disposition", "").startswith("uncovered"):
            unfilled_reports.append({
                "shift_id": shift.id,
                "date": shift.date,
                "route_type": shift.route_type,
                "seat_kind": _seat_kind(shift),
                "cause": base["cause"],
                "reason": base["why"],
            })

    # ── Section 5 · Solver input echo ──────────────────────────────────
    regular_open = sum(1 for x in art.open_shifts if not _is_cushion(x))
    cushion_open = sum(1 for x in art.open_shifts if _is_cushion(x))
    section_input = {
        "driver_count": len(req.drivers),
        "shift_count": len(req.shifts),
        "open_shift_count": len(art.open_shifts),
        "locked_shift_count": len(art.locked_shifts),
        "regular_open_shift_count": regular_open,
        "cushion_open_shift_count": cushion_open,
        "drivers": [
            {
                "driver_id": d.id,
                "status": d.status,
                "available_dows": d.available_dows,
                "current_hours": locked_hours_by_driver.get(d.id, 0),
                "pto_days": len(art.pto_dates_by_driver.get(d.id, set())),
                "certifications": {
                    "dot": bool(d.dot_certified),
                    "xl": bool(d.xl_certified),
                    "edv": bool(d.edv_certified),
                },
                "eligible_shift_count": len(art.eligible_shifts_per_driver.get(d.id, [])),
            }
            for d in drivers
        ],
        "shifts": [
            {
                "shift_id": x.id,
                "date": x.date,
                "type": x.route_type,
                "seat_kind": _seat_kind(x),
                "is_locked": x.id in locked_id_set,
                "required_certifications": _required_certs(x.route_type),
                "duration_hours": art.shift_hours.get(x.id),
            }
            for x in all_shifts
        ],
    }

    # ── Section 6 · Solver output ──────────────────────────────────────
    warnings: list[str] = []
    for iss in art.structural_issues:
        warnings.append(f"structural: {iss.get('code', '?')} — {iss.get('message', '')}")
    bad_status = sorted(
        d.id for d in req.drivers
        if (d.status or "").lower() not in _SCHEDULABLE_STATUSES and (d.status or "")
    )
    for did in bad_status:
        warnings.append(f"driver {did}: non-schedulable status received in payload")

    assign_var_count = sum(len(v) for v in art.eligible_drivers_per_shift.values())
    section_output = {
        "assignments_returned": len(art.assigned_out),
        "fresh_assignments": sum(1 for a in art.assigned_out if a.source != "locked"),
        "locked_assignments": sum(1 for a in art.assigned_out if a.source == "locked"),
        "unfilled_shifts": len(art.uncovered_out),
        "warnings": warnings,
        "diagnostics": {
            "solver_status": art.status_name,
            "response_status": art.response_status,
            "solver_wall_ms": art.solver_wall_ms,
            "model": {
                "drivers_total": len(req.drivers),
                "drivers_considered": sum(
                    1 for d in req.drivers
                    if len(art.eligible_shifts_per_driver.get(d.id, [])) > 0
                ),
                "open_shifts": len(art.open_shifts),
                "locked_shifts": len(art.locked_shifts),
                "assign_variables": assign_var_count,
            },
        },
        "driver_dispositions": {
            "assigned": disposition_buckets["assigned"],
            "considered_but_not_selected": disposition_buckets["considered_not_selected"],
            "never_considered_excluded_before_solver": disposition_buckets["excluded_before_solver"],
        },
    }

    # ── Section 1 · Run summary ────────────────────────────────────────
    shift_dates = sorted({x.date for x in req.shifts})
    drivers_excluded = len(disposition_buckets["excluded_before_solver"])
    drivers_eligible = len(req.drivers) - drivers_excluded
    shift_by_id = {x.id: x for x in all_shifts}
    cushion_assigned = sum(
        1 for a in art.assigned_out
        if a.shift_id in shift_by_id and _is_cushion(shift_by_id[a.shift_id])
    )
    cushion_unfilled = sum(
        1 for u in art.uncovered_out
        if u.shift_id in shift_by_id and _is_cushion(shift_by_id[u.shift_id])
    )

    section_summary = {
        "run_id": req.run_id,
        "timestamp": now.isoformat(),
        "dsp_id": req.dsp_id,
        "schedule_week_start": req.schedule_week_start,
        "date_range": {
            "start": shift_dates[0] if shift_dates else req.schedule_week_start,
            "end": shift_dates[-1] if shift_dates else req.schedule_week_start,
        },
        "settings_used": s,
        "counts": {
            "drivers_received": len(req.drivers),
            "drivers_eligible": drivers_eligible,
            "drivers_excluded": drivers_excluded,
            "shifts_received": len(req.shifts),
            "shifts_assigned": len(art.assigned_out),
            "shifts_unfilled": len(art.uncovered_out),
            "cushion_seats_assigned": cushion_assigned,
            "cushion_seats_unfilled": cushion_unfilled,
        },
    }

    trace = {
        "trace_version": TRACE_VERSION,
        "run_summary": section_summary,
        "driver_trace": driver_traces,
        "shift_trace": shift_traces,
        "eligibility_trace": section_eligibility,
        "solver_input": section_input,
        "solver_output": section_output,
        "zero_shift_report": sorted(zero_shift_reports, key=lambda x: x["driver_id"]),
        "unfilled_shift_report": sorted(unfilled_reports, key=lambda x: x["shift_id"]),
    }
    trace["report"] = render_report(trace)
    return trace


# ── Human-readable report ─────────────────────────────────────────────────


def _h(title: str) -> str:
    bar = "=" * 70
    return f"{bar}\n{title}\n{bar}"


def render_report(trace: dict) -> str:
    """Render the structured trace as a human-readable plain-text report."""
    out: list[str] = []
    rs = trace["run_summary"]
    c = rs["counts"]

    # Section 1
    out.append(_h("SMART FILL DIAGNOSTIC TRACE"))
    out.append(f"Run ID:        {rs.get('run_id') or '(none)'}")
    out.append(f"Timestamp:     {rs.get('timestamp')}")
    out.append(f"DSP ID:        {rs.get('dsp_id') or '(none)'}")
    out.append(f"Week start:    {rs.get('schedule_week_start')}")
    out.append(f"Date range:    {rs['date_range']['start']} → {rs['date_range']['end']}")
    out.append("")
    out.append("Settings used:")
    for k in sorted(rs.get("settings_used", {})):
        out.append(f"  - {k}: {rs['settings_used'][k]}")
    out.append("")
    out.append("Counts:")
    out.append(f"  Drivers received:      {c['drivers_received']}")
    out.append(f"  Drivers eligible:      {c['drivers_eligible']}")
    out.append(f"  Drivers excluded:      {c['drivers_excluded']}")
    out.append(f"  Shifts received:       {c['shifts_received']}")
    out.append(f"  Shifts assigned:       {c['shifts_assigned']}")
    out.append(f"  Shifts unfilled:       {c['shifts_unfilled']}")
    out.append(f"  Cushion seats filled:  {c['cushion_seats_assigned']}")
    out.append(f"  Cushion seats open:    {c['cushion_seats_unfilled']}")
    out.append("")

    # Section 7 (lead with the answers operators ask for first)
    out.append(_h("ZERO-SHIFT DRIVERS — why each got 0 shifts"))
    zsr = trace["zero_shift_report"]
    if not zsr:
        out.append("(none — every driver received at least one shift)")
    for z in zsr:
        out.append(f"  {z['driver_id']} [{z['cause']}]: {z['reason']}")
    out.append("")

    # Section 8
    out.append(_h("UNFILLED SHIFTS — why each stayed open"))
    usr = trace["unfilled_shift_report"]
    if not usr:
        out.append("(none — every shift was filled)")
    for u in usr:
        out.append(
            f"  {u['shift_id']} {u['date']} {u['route_type']}/{u['seat_kind']} "
            f"[{u['cause']}]: {u['reason']}"
        )
    out.append("")

    # Section 2
    out.append(_h("DRIVER TRACE"))
    for d in trace["driver_trace"]:
        certs = ",".join(k.upper() for k, v in d["certifications"].items() if v) or "none"
        av = d["availability_days"]
        av_str = "unconstrained" if av is None else (",".join(av) if av else "NONE on file")
        r = d["results"]
        out.append(
            f"  {d['driver_id']} ({d['driver_name']}) — {d['pool_entry'].upper()} / "
            f"{d['disposition']} [{d['cause']}]"
        )
        out.append(
            f"      status={d['status']} avail={av_str} certs={certs} "
            f"target_days={d['target_days']} current_hrs={d['current_hours']} "
            f"eligible_for={d['eligible_shift_count']}"
        )
        out.append(
            f"      → assigned={r['assigned_shifts']} hours={r['assigned_hours']} "
            f"ot={r['overtime_hours']}"
        )
        out.append(f"      why: {d['why']}")
    out.append("")

    # Section 3
    out.append(_h("SHIFT TRACE"))
    for sh in trace["shift_trace"]:
        certs = ",".join(sh["required_certifications"]) or "none"
        out.append(
            f"  {sh['shift_id']} {sh['date']} ({sh['day_of_week']}) "
            f"{sh['route_type']}/{sh['seat_kind']} req={certs} "
            f"dur={sh['duration_hours']}h — {sh['disposition']} [{sh['cause']}]"
        )
        out.append(
            f"      eligible={sh['eligible_driver_count']} "
            f"assigned={sh.get('assigned_driver_id') or '-'} "
            f"sent_to_solver={sh['sent_to_solver']}"
        )
        out.append(f"      why: {sh['why']}")
    out.append("")

    # Section 5
    si = trace["solver_input"]
    out.append(_h("SOLVER INPUT (payload as the solver saw it)"))
    out.append(
        f"  drivers={si['driver_count']} shifts={si['shift_count']} "
        f"(open={si['open_shift_count']} locked={si['locked_shift_count']}; "
        f"regular_open={si['regular_open_shift_count']} "
        f"cushion_open={si['cushion_open_shift_count']})"
    )
    out.append("")

    # Section 6
    so = trace["solver_output"]
    dg = so["diagnostics"]
    out.append(_h("SOLVER OUTPUT"))
    out.append(
        f"  status={dg['response_status']} (cp-sat={dg['solver_status']}) "
        f"wall={dg['solver_wall_ms']}ms"
    )
    out.append(
        f"  assignments={so['assignments_returned']} "
        f"(fresh={so['fresh_assignments']} locked={so['locked_assignments']}) "
        f"unfilled={so['unfilled_shifts']}"
    )
    m = dg["model"]
    out.append(
        f"  model: drivers_considered={m['drivers_considered']}/{m['drivers_total']} "
        f"open_shifts={m['open_shifts']} assign_vars={m['assign_variables']}"
    )
    dd = so["driver_dispositions"]
    out.append(
        f"  dispositions: assigned={len(dd['assigned'])} "
        f"considered_not_selected={len(dd['considered_but_not_selected'])} "
        f"excluded_before_solver={len(dd['never_considered_excluded_before_solver'])}"
    )
    if so["warnings"]:
        out.append("  warnings:")
        for w in so["warnings"]:
            out.append(f"    - {w}")
    out.append("")

    # Section 4
    el = trace["eligibility_trace"]
    out.append(_h("ELIGIBILITY TRACE (per driver/shift pair)"))
    out.append(
        f"  evaluated={el['evaluated_pairs']} pass={el['pass_count']} "
        f"fail={el['fail_count']}"
    )
    if el["fail_by_code"]:
        out.append("  fails by code: " + ", ".join(
            f"{k}={v}" for k, v in el["fail_by_code"].items()
        ))
    out.append("  (full per-shift PASS/FAIL matrix in the structured JSON)")
    out.append("")

    return "\n".join(out)
