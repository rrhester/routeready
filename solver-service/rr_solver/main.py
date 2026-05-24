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

import logging
import os

from fastapi import Depends, FastAPI, Header, HTTPException, status

from . import __version__
from .models import SolveRequest, SolveResponse
from .solver import SOLVER_VERSION, solve
from .validators import quick_validate

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
    if token != expected:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="invalid bearer token")


@app.get("/healthz")
def healthz() -> dict:
    """Liveness. No auth — used by the platform's health checks."""
    return {
        "ok": True,
        "service": "rr-solver",
        "version": __version__,
        "solver_version": SOLVER_VERSION,
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
    """Run the solver. v1 returns the stub heuristic result so the wire
    format is validated end-to-end; v2 swaps in the real CP-SAT model
    without changing the response shape."""
    try:
        issues = quick_validate(req)
        if issues:
            logger.warning("solve called with %d structural issues", len(issues))
        result = solve(req)
        logger.info("solve ok: assigned=%d uncovered=%d coverage=%s%% wall=%dms",
                    result.metrics.assigned, result.metrics.uncovered,
                    result.metrics.coverage_pct,
                    result.metrics.solver_wall_ms or 0)
        return result
    except Exception as exc:  # noqa: BLE001 — surface everything to the caller
        logger.exception("solve failed")
        return SolveResponse(
            status="error",
            solver_version=SOLVER_VERSION,
            error_message=str(exc),
        )
