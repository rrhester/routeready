"""
Ad-hoc constraint compiler (Step 5.5).

Translates the operator-authored ad_hoc_constraints rows (from the
ad_hoc_constraints table, migration 0326) into CP-SAT constraints
that compose with the rest of the model.

v1 ships compilers for the 5 most common DSP-specific patterns:

  driver_pair_forbidden      { driver_a, driver_b }
  driver_lock_to_day         { driver_id, dow }
  driver_exclude_from_day    { driver_id, dow }
  driver_max_days_override   { driver_id, max_days }
  date_blackout_driver       { driver_id, date_from, date_to, reason? }

Hardness:
  • 'hard' rules add the constraint directly. If the model becomes
    infeasible, the solver returns status=infeasible and the dashboard
    surfaces which rules contributed (in a follow-up — see step 5.5b
    for the assumption-based infeasibility report).
  • 'soft' rules add the same constraint with a slack boolean +
    a negative-weight penalty term so the solver MAY violate them
    when coverage demands. The weight is read from the rule's
    `weight` field (set by the dashboard when the rule was created).

Adding a new template:
  1. Add the kind name to TEMPLATE_KINDS.
  2. Implement `_compile_<kind>(model, vars, payload, weight, hardness, ctx)`.
  3. Add a test in test_ad_hoc.py.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from ortools.sat.python import cp_model


# Catalog of supported templates. Anything else is logged and skipped
# (forward-compatible with future templates the dashboard adds before
# the solver ships compiler support).
TEMPLATE_KINDS = {
    "driver_pair_forbidden",
    "driver_lock_to_day",
    "driver_exclude_from_day",
    "driver_max_days_override",
    "date_blackout_driver",
}


class AdHocContext:
    """Bundle the model variables a compiler needs to read. Built once
    inside cpsat_model.solve() and passed in."""

    def __init__(
        self,
        assign: dict[tuple[str, str], cp_model.IntVar],
        on_day: dict[tuple[str, str], cp_model.IntVar],
        shifts_by_id: dict[str, Any],
        eligible_drivers_per_shift: dict[str, list[str]],
        all_dates_sorted: list[str],
    ):
        self.assign = assign
        self.on_day = on_day
        self.shifts_by_id = shifts_by_id
        self.eligible_drivers_per_shift = eligible_drivers_per_shift
        self.all_dates_sorted = all_dates_sorted


def _dow_from_iso(iso: str) -> int:
    return datetime.strptime(iso, "%Y-%m-%d").date().isoweekday() % 7


def _maybe_soft(
    model: cp_model.CpModel,
    constraint_expr,
    op: str,
    rhs: int,
    weight: int,
    hardness: str,
    name: str,
) -> list:
    """Add a constraint either as hard or as soft-with-slack.

    Returns the list of objective penalty terms to be appended by the
    caller. For hard rules this is empty.

    Supported ops: '<=' and '=='. Soft is implemented as
    `constraint_expr <op> rhs + slack`, with slack ∈ [0, large], and
    a penalty `weight * slack` on the objective.
    """
    if hardness == "hard":
        if op == "<=":
            model.Add(constraint_expr <= rhs)
        elif op == "==":
            model.Add(constraint_expr == rhs)
        else:
            raise ValueError(f"unsupported op {op}")
        return []
    # soft
    slack = model.NewIntVar(0, 1_000_000, f"slack_{name}")
    if op == "<=":
        model.Add(constraint_expr <= rhs + slack)
    elif op == "==":
        # Equality slack is symmetric — use absolute deviation.
        # For now treat as "constraint - rhs <= slack and rhs - constraint <= slack"
        model.Add(constraint_expr - rhs <= slack)
        model.Add(rhs - constraint_expr <= slack)
    return [-weight * slack]


# ── Template compilers ────────────────────────────────────────────────


def _compile_driver_pair_forbidden(
    model, ctx: AdHocContext, payload: dict, weight: int, hardness: str, rule_id: str
) -> list:
    """Two drivers can't both work on any of the same shifts. Practically
    "Bob and Frank can't be on the same shift" — interpreted as: for each
    shift s, assign[a, s] + assign[b, s] <= 1."""
    a, b = payload.get("driver_a"), payload.get("driver_b")
    if not a or not b:
        return []
    penalty_terms: list = []
    for s_id in ctx.shifts_by_id:
        if a in ctx.eligible_drivers_per_shift.get(s_id, []) and \
           b in ctx.eligible_drivers_per_shift.get(s_id, []):
            expr = ctx.assign[(a, s_id)] + ctx.assign[(b, s_id)]
            penalty_terms.extend(
                _maybe_soft(model, expr, "<=", 1, weight, hardness,
                            f"pf_{rule_id}_{s_id}")
            )
    return penalty_terms


def _compile_driver_lock_to_day(
    model, ctx: AdHocContext, payload: dict, weight: int, hardness: str, rule_id: str
) -> list:
    """Driver must work on `dow` whenever there's an eligible shift on
    that DOW. Translates to: sum(on_day[d, dt] for dt with dow(dt)==dow)
    must be at least the number of available DOW-matching dates."""
    did = payload.get("driver_id")
    dow = payload.get("dow")
    if did is None or dow is None:
        return []
    matching = [
        dt for dt in ctx.all_dates_sorted
        if _dow_from_iso(dt) == dow and (did, dt) in ctx.on_day
    ]
    if not matching:
        return []
    # Lock = require >= len(matching). Soft means slack lets it be less.
    target = len(matching)
    expr = sum(ctx.on_day[(did, dt)] for dt in matching)
    if hardness == "hard":
        model.Add(expr >= target)
        return []
    slack = model.NewIntVar(0, target, f"slack_lockday_{rule_id}")
    model.Add(expr + slack >= target)
    return [-weight * slack]


def _compile_driver_exclude_from_day(
    model, ctx: AdHocContext, payload: dict, weight: int, hardness: str, rule_id: str
) -> list:
    """Driver may NEVER work on `dow`. sum(on_day[d, dt] for dt with
    dow(dt)==dow) <= 0."""
    did = payload.get("driver_id")
    dow = payload.get("dow")
    if did is None or dow is None:
        return []
    matching = [
        dt for dt in ctx.all_dates_sorted
        if _dow_from_iso(dt) == dow and (did, dt) in ctx.on_day
    ]
    if not matching:
        return []
    expr = sum(ctx.on_day[(did, dt)] for dt in matching)
    return _maybe_soft(model, expr, "<=", 0, weight, hardness,
                       f"exday_{rule_id}")


def _compile_driver_max_days_override(
    model, ctx: AdHocContext, payload: dict, weight: int, hardness: str, rule_id: str
) -> list:
    """Per-driver override of the global max_days cap. Tighter than the
    global rule wins automatically because both apply."""
    did = payload.get("driver_id")
    max_days = payload.get("max_days")
    if did is None or max_days is None:
        return []
    per_day = [
        ctx.on_day[(d, dt)] for (d, dt) in ctx.on_day if d == did
    ]
    if not per_day:
        return []
    expr = sum(per_day)
    return _maybe_soft(model, expr, "<=", int(max_days), weight, hardness,
                       f"maxd_{rule_id}")


def _compile_date_blackout_driver(
    model, ctx: AdHocContext, payload: dict, weight: int, hardness: str, rule_id: str
) -> list:
    """Driver is unavailable for an explicit date range. Hard
    constraint: on_day for any date in range must be 0."""
    did = payload.get("driver_id")
    df, du = payload.get("date_from"), payload.get("date_to")
    if not did or not df or not du:
        return []
    try:
        from_d = datetime.strptime(df, "%Y-%m-%d").date()
        to_d = datetime.strptime(du, "%Y-%m-%d").date()
    except ValueError:
        return []
    matching = [
        dt for dt in ctx.all_dates_sorted
        if from_d <= datetime.strptime(dt, "%Y-%m-%d").date() <= to_d
        and (did, dt) in ctx.on_day
    ]
    penalty_terms: list = []
    for dt in matching:
        expr = ctx.on_day[(did, dt)]
        penalty_terms.extend(
            _maybe_soft(model, expr, "==", 0, weight, hardness,
                        f"blk_{rule_id}_{dt}")
        )
    return penalty_terms


COMPILERS = {
    "driver_pair_forbidden":    _compile_driver_pair_forbidden,
    "driver_lock_to_day":       _compile_driver_lock_to_day,
    "driver_exclude_from_day":  _compile_driver_exclude_from_day,
    "driver_max_days_override": _compile_driver_max_days_override,
    "date_blackout_driver":     _compile_date_blackout_driver,
}


def compile_ad_hoc(
    model: cp_model.CpModel,
    ctx: AdHocContext,
    constraints: list[dict],
) -> tuple[list, dict[str, list]]:
    """Compile every ad-hoc constraint in `constraints`.

    Returns (objective_terms, touched_by) where:
      objective_terms — list of penalty terms (negative ints * vars)
        to add to the solver's Maximize() objective for soft rules.
      touched_by — { constraint_id → list of shift_ids touched } so
        the audit layer can show which rules influenced which shifts.

    Unknown templates are logged and skipped (forward-compatible).
    """
    penalty_terms: list = []
    touched_by: dict[str, list] = {}

    for raw in constraints or []:
        if not isinstance(raw, dict):
            continue
        kind = raw.get("kind")
        if kind not in COMPILERS:
            continue
        rule_id = str(raw.get("id") or f"anon_{kind}")
        payload = raw.get("payload") or {}
        hardness = raw.get("hardness") or "hard"
        weight = int(raw.get("weight") or 100)

        try:
            terms = COMPILERS[kind](model, ctx, payload, weight, hardness, rule_id)
            penalty_terms.extend(terms)
            # touched_by is best-effort here; the solver knows which
            # specific shifts each rule touched but we'd need finer
            # bookkeeping inside each compiler to report it. v1 just
            # marks the rule as "active" with an empty shift list.
            touched_by.setdefault(rule_id, [])
        except Exception as e:  # noqa: BLE001
            # A buggy rule shouldn't take down the whole solve.
            print(f"[ad_hoc] compile failed for {kind} ({rule_id}): {e}")
            continue

    return penalty_terms, touched_by
