"""
Per-(driver, shift) hard-eligibility, with the *first-failure reason*.

This is the single source of truth for the static hard gates the CP-SAT
model applies before it ever creates an `assign[d, s]` variable. The
solver's `_is_eligible` delegates here so the gate logic lives in exactly
one place — and the diagnostic Trace Mode (see `trace.py`) reuses the same
function to explain *why* a pair was rejected, without re-implementing (and
risking drift from) the real rule order.

`first_failure_reason` returns the SAME boolean decision as the legacy
`_is_eligible` (None ⇔ eligible), evaluated in the SAME order, so wiring it
into the model is behavior-preserving. It additionally names the first rule
that blocked the pair — that name is observability only and never changes a
scheduling decision.

The codes mirror the Trace-Mode spec (Section 4):

    AVAILABILITY_FAIL  PTO_FAIL  LICENSE_FAIL
    DOT_FAIL  XL_FAIL  EDV_FAIL

Two further codes are defined here for the higher layers (a driver's whole
pool entry, or a shift's coverage) even though they are NOT static per-pair
gates — they are emergent from the *solve* (a global CP-SAT constraint), so
they never appear as a per-pair first-failure:

    MAX_HOURS_FAIL  CONSECUTIVE_DAYS_FAIL  STATUS_FAIL  DOUBLE_BOOK_LOCKED
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from .models import DriverIn, ShiftIn

# ── Reason codes ──────────────────────────────────────────────────────────
# Static per-pair gates (can be a first-failure reason):
PTO_FAIL = "PTO_FAIL"
AVAILABILITY_FAIL = "AVAILABILITY_FAIL"
DOT_FAIL = "DOT_FAIL"
XL_FAIL = "XL_FAIL"
EDV_FAIL = "EDV_FAIL"
LICENSE_FAIL = "LICENSE_FAIL"
# Pre-solve, applied by the model's eligible-pair loop (not by the gates below):
DOUBLE_BOOK_LOCKED = "DOUBLE_BOOK_LOCKED"
# Emergent / pipeline-level (used by trace.py at the driver or shift layer):
MAX_HOURS_FAIL = "MAX_HOURS_FAIL"
CONSECUTIVE_DAYS_FAIL = "CONSECUTIVE_DAYS_FAIL"
STATUS_FAIL = "STATUS_FAIL"

# Stable Sun=0..Sat=6 weekday labels (matches the dashboard's DOW convention).
DOW_NAMES = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
]


@dataclass(frozen=True)
class FailReason:
    """First rule that blocked a (driver, shift) pair. `code` is a stable
    machine token (one of the constants above); `message` is human-readable."""

    code: str
    message: str


def _dow(iso: str) -> int:
    """Sun=0..Sat=6 to match the dashboard. Mirrors cpsat_model._dow."""
    return datetime.strptime(iso, "%Y-%m-%d").date().isoweekday() % 7


def first_failure_reason(
    driver: DriverIn,
    shift: ShiftIn,
    pto_dates_by_driver: dict[str, set[str]],
    eligible_driver_status: Optional[str] = None,
) -> Optional[FailReason]:
    """The first static hard gate that rejects this (driver, shift) pair, or
    None when the pair is eligible.

    Gate order mirrors the in-browser engine's R002→…→R003 chain:
      0. driver status (R002) — active always; onboarding only when the DSP
         allows it; anything else is ineligible for auto-fill
      1. PTO on the shift date
      2. availability (no availability on file → unschedulable; else DOW gate)
      3. certification match for the route type (DOT / XL / EDV)
      4. driver's license not expired on the shift date

    `eligible_driver_status` carries the DSP's R002 policy — the value of the
    `eligible_driver_status` setting ("active" | "active_and_onboarding").
    When it is None (legacy callers) OR the driver has no status on file, the
    status gate is skipped, preserving the pre-R002 behavior.

    Anything not gated here (max days, consecutive days, weekly hours, min
    rest) is a *global* CP-SAT constraint, not a per-pair filter — see the
    module docstring.
    """
    # 0. Driver status (R002). Matches engine/src/rules/r002_status.ts:
    #    active → eligible; onboarding → eligible only when the DSP set
    #    eligible_driver_status = "active_and_onboarding"; else blocked.
    if eligible_driver_status is not None and driver.status:
        if driver.status != "active" and not (
            driver.status == "onboarding"
            and eligible_driver_status == "active_and_onboarding"
        ):
            return FailReason(
                STATUS_FAIL,
                f"Driver status is {driver.status}, not eligible for auto-fill",
            )

    # 1. PTO / approved day off on the shift date.
    if shift.date in pto_dates_by_driver.get(driver.id, set()):
        return FailReason(
            PTO_FAIL,
            f"Approved PTO / day off on {shift.date}",
        )

    # 2. Availability.
    #   None → caller provided no availability constraint → unconstrained.
    #   []   → driver has NO availability on file → not schedulable at all.
    #   [..] → schedulable only on those weekdays.
    if driver.available_dows is not None:
        if len(driver.available_dows) == 0:
            return FailReason(
                AVAILABILITY_FAIL,
                "No availability on file — driver is not schedulable on any day",
            )
        sdow = _dow(shift.date)
        if sdow not in driver.available_dows:
            return FailReason(
                AVAILABILITY_FAIL,
                f"Not available on {DOW_NAMES[sdow]}s",
            )

    # 3. Certification match per route_type.
    if shift.route_type == "step_van" and not driver.dot_certified:
        return FailReason(
            DOT_FAIL,
            "Step-van route requires DOT certification (driver not DOT-certified)",
        )
    if shift.route_type == "xl" and not driver.xl_certified:
        return FailReason(
            XL_FAIL,
            "XL route requires XL certification (driver not XL-certified)",
        )
    if shift.route_type == "edv" and not driver.edv_certified:
        return FailReason(
            EDV_FAIL,
            "EDV route requires EDV certification (driver not EDV-certified)",
        )

    # 4. License valid on the shift date.
    if driver.dl_expires_on:
        try:
            exp = datetime.strptime(driver.dl_expires_on, "%Y-%m-%d").date()
            sd = datetime.strptime(shift.date, "%Y-%m-%d").date()
            if exp < sd:
                return FailReason(
                    LICENSE_FAIL,
                    f"License expired {driver.dl_expires_on} (before shift date {shift.date})",
                )
        except ValueError:
            pass  # malformed → skip the gate, let other rules catch it

    return None


def is_eligible(
    driver: DriverIn,
    shift: ShiftIn,
    pto_dates_by_driver: dict[str, set[str]],
    eligible_driver_status: Optional[str] = None,
) -> bool:
    """Boolean hard-eligibility. Identical decision to the legacy
    `_is_eligible`; defined as "no first-failure reason exists" so the gate
    logic has a single home."""
    return first_failure_reason(
        driver, shift, pto_dates_by_driver, eligible_driver_status
    ) is None
