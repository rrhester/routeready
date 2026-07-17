"""
FastAPI app entry point.

Three endpoints:
  • POST /solve     — runs the solver, returns the assignment
  • POST /validate  — hard-rule pre-check only, no solve
  • GET  /healthz   — liveness probe

Auth via a single shared-secret bearer token in RR_SOLVER_TOKEN env var.
Same token is sent by the dashboard's edge-function dispatcher.
"""

from __future__ import annotations
import hmac

import logging
import os

from fastapi import Depends, FastAPI, Header, HTTPException, status

from . import __version__
from .cpsat_model import SOLVER_VERSION as CPSAT_VERSION, solve as cpsat_solve
from .models import SolveRequest, SolveResponse
from .solver import SOLVER_VERSION as STUB_VERSION, solve as stub_solve
from .validators import quick_validate

# RR_SOLVER_ENGINE=cpsat (default) | stub
#
# Lets us flip back to the heuristic stub without redeploying, in case
# the CP-SAT model misbehaves on a particular payload in production.
_ENGINE = os.environ.get("RR_SOLVER_ENGINE", "cpsat").lower()

logger = logging.getLogger("rr_solver")
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")

_TOKEN_ENV = "RR_SOLVER_TOKEN"

app = FastAPI(
    title="RouteReady Solver",
    version=__version__,
    description="CP-SAT optimization service for driver + van scheduling.",
)


def require_bearer_token(authorization: str | None = Header(default=None)) -> None:
    """Reject anything missing or mismatching the shared secret."""
    expected = os.environ.get(_TOKEN_ENV)
    if not expected:
        # Fail-safe: if the env var isn't set, refuse all traffic. Prevents
        # accidentally exposing an unauthenticated solver in production.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{_TOKEN_ENV} not configured on this instance",
        )
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="invalid bearer token")


@app.get("/healthz")
def healthz() -> dict:
    """Liveness. No auth — used by the platform's health checks."""
    return {
        "ok": True,
        "service": "rr-solver",
        "version": __version__,
        "engine": _ENGINE,
        "solver_version": CPSAT_VERSION if _ENGINE == "cpsat" else STUB_VERSION,
    }


@app.post("/validate", dependencies=[Depends(require_bearer_token)])
def validate(req: SolveRequest) -> dict:
    """Run the cheap hard-rule pre-check. Returns a list of structural
    issues. Empty list = looks structurally sound (doesn't guarantee
    feasibility)."""
    return {"issues": quick_validate(req)}


@app.post("/solve",
          response_model=SolveResponse,
          dependencies=[Depends(require_bearer_token)])
def solve_endpoint(req: SolveRequest) -> SolveResponse:
    """Run the solver. Engine selection via RR_SOLVER_ENGINE env var
    (cpsat | stub). Default: cpsat. Both engines return the same
    SolveResponse shape, so callers don't need to know which ran."""
    engine_fn = cpsat_solve if _ENGINE == "cpsat" else stub_solve
    engine_label = CPSAT_VERSION if _ENGINE == "cpsat" else STUB_VERSION
    try:
        issues = quick_validate(req)
        if issues:
            logger.warning("solve called with %d structural issues", len(issues))
        result = engine_fn(req)
        logger.info(
            "solve ok: engine=%s assigned=%d uncovered=%d coverage=%s%% wall=%dms status=%s",
            engine_label, result.metrics.assigned, result.metrics.uncovered,
            result.metrics.coverage_pct, result.metrics.solver_wall_ms or 0,
            result.metrics.solver_status,
        )
        return result
    except Exception as exc:  # noqa: BLE001 — surface everything to the caller
        logger.exception("solve failed (engine=%s)", engine_label)
        return SolveResponse(
            status="error",
            solver_version=engine_label,
            error_message=str(exc),
        )
