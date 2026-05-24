"""Smoke tests for the solver service."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from rr_solver.main import app


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("RR_SOLVER_TOKEN", "test-token")
    return TestClient(app)


@pytest.fixture
def auth_headers():
    return {"Authorization": "Bearer test-token"}


def _sample_payload():
    return {
        "schedule_week_start": "2026-06-01",
        "max_days": 4,
        "weekly_hour_cap": 40,
        "rules": {},
        "drivers": [
            {"id": "d1", "full_name": "Alice", "available_dows": [1, 2, 3, 4, 5]},
            {"id": "d2", "full_name": "Bob",   "available_dows": [1, 2, 3, 4, 5]},
        ],
        "shifts": [
            {"id": "s1", "date": "2026-06-01", "route_type": "standard"},  # Mon
            {"id": "s2", "date": "2026-06-02", "route_type": "standard"},  # Tue
            {"id": "s3", "date": "2026-06-03", "route_type": "standard"},  # Wed
        ],
        "vans": [
            {"id": "v1", "code": "VAN-1", "status": "active",
             "vehicle_type": "standard", "primary_driver_id": "d1"},
        ],
        "van_pairings": [
            {"driver_id": "d1", "van_id": "v1", "kind": "primary"},
        ],
        "pto": [],
    }


def test_healthz_no_auth_required(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["service"] == "rr-solver"


def test_solve_requires_token(client):
    r = client.post("/solve", json=_sample_payload())
    assert r.status_code == 401


def test_solve_rejects_bad_token(client):
    r = client.post("/solve", json=_sample_payload(),
                    headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 403


def test_solve_assigns_all_shifts_when_enough_drivers(client, auth_headers):
    r = client.post("/solve", json=_sample_payload(), headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok"
    assert body["solver_version"].startswith("rr-solver-")
    assert len(body["assigned_shifts"]) == 3
    assert len(body["uncovered_shifts"]) == 0
    # d1 paired to v1 → v1 should appear on at least one assignment.
    assert any(a.get("van_id") == "v1" for a in body["assigned_shifts"])


def test_solve_respects_max_days_cap(client, auth_headers):
    payload = _sample_payload()
    # Only one driver, three shifts on three different days, max_days=2.
    payload["drivers"] = [
        {"id": "d1", "full_name": "Alice", "available_dows": [1, 2, 3, 4, 5]},
    ]
    payload["max_days"] = 2
    r = client.post("/solve", json=payload, headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    # Two shifts get d1; one is uncovered.
    assert len(body["assigned_shifts"]) == 2
    assert len(body["uncovered_shifts"]) == 1


def test_solve_skips_drivers_without_required_cert(client, auth_headers):
    payload = _sample_payload()
    payload["shifts"] = [
        {"id": "s_edv", "date": "2026-06-01", "route_type": "edv"},
    ]
    # Neither driver has edv_certified.
    r = client.post("/solve", json=payload, headers=auth_headers)
    body = r.json()
    assert body["status"] == "ok"
    assert len(body["assigned_shifts"]) == 0
    assert len(body["uncovered_shifts"]) == 1


def test_validate_flags_duplicate_ids(client, auth_headers):
    payload = _sample_payload()
    payload["drivers"].append({"id": "d1", "full_name": "duplicate"})
    r = client.post("/validate", json=payload, headers=auth_headers)
    issues = r.json()["issues"]
    codes = {i["code"] for i in issues}
    assert "duplicate_driver_id" in codes
