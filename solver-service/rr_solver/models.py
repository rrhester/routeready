"""
Pydantic request / response models for the solver service.

Shape mirrors the existing in-browser sfPayload (see autoAssignDriversForWeek
in dashboard/live.js) so the dashboard can hand its existing payload over
the wire with minimal translation. Vans + van_pairings are baked in from
day 1 so the wire format is stable when the CP-SAT model gains
van-assignment variables in step 5b.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# ── Inputs ────────────────────────────────────────────────────────────────


class DriverIn(BaseModel):
    model_config = ConfigDict(extra="allow")  # accept unknown fields gracefully

    id: str
    full_name: Optional[str] = None
    status: Optional[str] = None
    hire_date: Optional[str] = None
    dl_expires_on: Optional[str] = None
    dot_certified: bool = False
    xl_certified: bool = False
    edv_certified: bool = False
    available_dows: Optional[list[int]] = None  # null = no constraint
    preferred_dows: Optional[list[int]] = None
    final_corrective_action: bool = False
    weekday_affinity: Optional[list[int]] = None  # 7 ints 0-100; null when unknown
    fifth_day_ok: bool = False


class ShiftIn(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    date: str  # ISO yyyy-mm-dd
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    duration_hours: Optional[float] = None
    route_type: str = "standard"  # standard | step_van | xl | edv
    # "regular" | "helper" (+ the manual kinds training/ride_along/rescue/other).
    # A "helper" seat on an XL route is the second body that rides along — it
    # needs NO certification even though the seat's route_type is "xl" (only
    # ONE of the two on-road drivers must be XL-certified). See eligibility.py.
    shift_kind: str = "regular"
    assigned_driver_id: Optional[str] = None  # set for locked / preserved rows
    is_locked: bool = False
    station_id: Optional[str] = None
    route_code: Optional[str] = None


class VanIn(BaseModel):
    """First-class van. Status='active' means available; anything else is excluded."""
    model_config = ConfigDict(extra="allow")

    id: str
    code: str
    status: str = "active"
    vehicle_type: str = "standard"  # standard | step_van | xl | edv
    primary_driver_id: Optional[str] = None
    backup_driver_id: Optional[str] = None
    notes: Optional[str] = None


class VanPairingIn(BaseModel):
    """Driver↔van continuity hint. Solver prefers honoring these unless a
    hard constraint forces otherwise."""
    model_config = ConfigDict(extra="allow")

    driver_id: str
    van_id: str
    kind: Literal["primary", "backup", "manual"] = "primary"


class PTOIn(BaseModel):
    driver_id: str
    date: str  # ISO yyyy-mm-dd


class SolveRequest(BaseModel):
    """The full solver input. Matches the dashboard's sfPayload shape."""
    model_config = ConfigDict(extra="allow")

    schedule_week_start: str = Field(..., description="ISO yyyy-mm-dd, week-start date")
    max_days: int = 5
    weekly_hour_cap: int = 40
    rules: dict[str, Any] = Field(default_factory=dict)
    drivers: list[DriverIn] = Field(default_factory=list)
    shifts: list[ShiftIn] = Field(default_factory=list)
    vans: list[VanIn] = Field(default_factory=list)
    van_pairings: list[VanPairingIn] = Field(default_factory=list)
    pto: list[PTOIn] = Field(default_factory=list)
    ad_hoc_constraints: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Compiled ad-hoc constraints. Ignored by v1; step 5.5 wires them up.",
    )
    # Caller-supplied controls
    solver_seed: int = 0
    time_budget_ms: int = 8000

    # ── Diagnostics ───────────────────────────────────────────────────────
    # When true, the solver attaches a full decision trace to the response
    # (see SolveResponse.trace + trace.py). Opt-in because the trace can be
    # large (every driver, every shift, every evaluated pair). Pure
    # observability — enabling it NEVER changes a scheduling decision.
    trace: bool = False
    # Optional identifiers echoed verbatim into the trace's Run Summary
    # (Section 1). The dashboard can pass its optimization_runs row id and
    # the DSP id so a saved trace is traceable back to the run that made it.
    run_id: Optional[str] = None
    dsp_id: Optional[str] = None


# ── Outputs ───────────────────────────────────────────────────────────────


class ScoreComponents(BaseModel):
    """Breakdown of the objective for one assignment. All fields are nullable
    so the stub solver can leave them empty without breaking deserializers."""
    model_config = ConfigDict(extra="allow")

    coverage: float = 0
    affinity: float = 0
    preferred: float = 0
    stability: float = 0
    seniority: float = 0
    ot_risk: float = 0
    fairness: float = 0
    attendance: float = 0
    doublework: float = 0
    fifth_day: float = 0


class Alternative(BaseModel):
    driver_id: str
    score: float
    reason_missed: str


class AssignedShift(BaseModel):
    model_config = ConfigDict(extra="allow")

    shift_id: str
    driver_id: str
    van_id: Optional[str] = None
    source: str  # auto_fill | swap | pattern_pass | fifth_day | locked | preserved
    total_score: Optional[float] = None
    score_components: Optional[ScoreComponents] = None
    alternatives: list[Alternative] = Field(default_factory=list)
    binding_constraints: list[str] = Field(default_factory=list)
    summary: Optional[str] = None


class UncoveredShift(BaseModel):
    shift_id: str
    summary: str
    top_block_reasons: list[dict[str, Any]] = Field(default_factory=list)


class UnscheduledDriver(BaseModel):
    driver_id: str
    eligible_somewhere: bool
    block_reasons: list[dict[str, Any]] = Field(default_factory=list)


class SolveMetrics(BaseModel):
    coverage_pct: Optional[float] = None
    total_shifts: int = 0
    open_shifts: int = 0
    assigned: int = 0
    uncovered: int = 0
    unscheduled_drivers: int = 0
    solver_wall_ms: Optional[int] = None
    solver_status: Optional[str] = None


class SolveResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    status: Literal["ok", "infeasible", "timeout", "error"]
    solver_version: str
    assigned_shifts: list[AssignedShift] = Field(default_factory=list)
    uncovered_shifts: list[UncoveredShift] = Field(default_factory=list)
    unscheduled_drivers: list[UnscheduledDriver] = Field(default_factory=list)
    metrics: SolveMetrics = Field(default_factory=SolveMetrics)
    error_message: Optional[str] = None
    # Diagnostic decision trace (Sections 1–8). Populated only when the
    # request set `trace: true`; otherwise None. Includes both the
    # structured sections and a pre-rendered human-readable `report` string.
    trace: Optional[dict[str, Any]] = None
