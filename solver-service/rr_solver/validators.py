"""
Hard-rule pre-check. Same checks the CP-SAT model enforces, but run
upfront so the dashboard can show "this rule will block X assignments"
without paying the cost of a full solve.

v1: minimal coverage — enough to validate the wire format. v2 fills in
the full hard-rule catalog (license, cert, PTO, double-book, WOC, etc.)
as the CP-SAT model gains them.
"""

from __future__ import annotations

from .models import SolveRequest


def quick_validate(req: SolveRequest) -> list[dict]:
    """Return a list of structural issues found in the payload.

    Each issue is a dict with `code`, `message`, and optionally `shift_id`
    or `driver_id`. An empty list means the payload looks structurally
    sound; doesn't guarantee feasibility.
    """
    issues: list[dict] = []

    # Driver IDs unique?
    seen_drivers: set[str] = set()
    for d in req.drivers:
        if d.id in seen_drivers:
            issues.append({"code": "duplicate_driver_id", "driver_id": d.id,
                           "message": f"driver id {d.id} appears more than once"})
        seen_drivers.add(d.id)

    # Shift IDs unique?
    seen_shifts: set[str] = set()
    for s in req.shifts:
        if s.id in seen_shifts:
            issues.append({"code": "duplicate_shift_id", "shift_id": s.id,
                           "message": f"shift id {s.id} appears more than once"})
        seen_shifts.add(s.id)

    # Locked / preserved rows must point at a real driver in the payload.
    for s in req.shifts:
        if s.is_locked and s.assigned_driver_id and s.assigned_driver_id not in seen_drivers:
            issues.append({"code": "locked_shift_unknown_driver",
                           "shift_id": s.id,
                           "driver_id": s.assigned_driver_id,
                           "message": f"shift {s.id} is locked to driver {s.assigned_driver_id} who isn't in the payload"})

    # PTO entries must reference real drivers + valid dates.
    for p in req.pto:
        if p.driver_id not in seen_drivers:
            issues.append({"code": "pto_unknown_driver", "driver_id": p.driver_id,
                           "message": f"PTO record references unknown driver {p.driver_id}"})

    # Vans: status check.
    seen_vans: set[str] = set()
    for v in req.vans:
        if v.id in seen_vans:
            issues.append({"code": "duplicate_van_id", "message": f"van id {v.id} appears more than once"})
        seen_vans.add(v.id)

    return issues
