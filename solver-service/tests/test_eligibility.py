"""
First-failure eligibility reasons.

Locks the gate ORDER and the reason CODES the diagnostic trace depends on,
and proves `is_eligible` is the exact boolean the model needs (so wiring it
into cpsat_model._is_eligible is behavior-preserving).
"""

from __future__ import annotations

from rr_solver import eligibility as E
from rr_solver.eligibility import first_failure_reason, is_eligible
from rr_solver.models import DriverIn, ShiftIn


def _d(**kw):
    base = {"id": "d1", "available_dows": [0, 1, 2, 3, 4, 5, 6]}
    base.update(kw)
    return DriverIn(**base)


def _s(**kw):
    base = {"id": "s1", "date": "2026-06-01", "route_type": "standard"}  # Mon
    base.update(kw)
    return ShiftIn(**base)


def test_eligible_pair_has_no_reason():
    assert first_failure_reason(_d(), _s(), {}) is None
    assert is_eligible(_d(), _s(), {}) is True


def test_pto_is_first_failure():
    r = first_failure_reason(_d(), _s(), {"d1": {"2026-06-01"}})
    assert r is not None and r.code == E.PTO_FAIL
    assert is_eligible(_d(), _s(), {"d1": {"2026-06-01"}}) is False


def test_no_availability_on_file_fails():
    r = first_failure_reason(_d(available_dows=[]), _s(), {})
    assert r is not None and r.code == E.AVAILABILITY_FAIL
    assert "No availability" in r.message


def test_wrong_dow_fails_with_weekday_name():
    # Driver available Tue/Wed only; shift is Monday.
    r = first_failure_reason(_d(available_dows=[2, 3]), _s(), {})
    assert r is not None and r.code == E.AVAILABILITY_FAIL
    assert "Monday" in r.message


def test_none_availability_is_unconstrained():
    assert is_eligible(_d(available_dows=None), _s(), {}) is True


def test_dot_cert_required_for_step_van():
    r = first_failure_reason(_d(dot_certified=False), _s(route_type="step_van"), {})
    assert r is not None and r.code == E.DOT_FAIL


def test_xl_cert_required_for_xl():
    r = first_failure_reason(_d(xl_certified=False), _s(route_type="xl"), {})
    assert r is not None and r.code == E.XL_FAIL


def test_xl_helper_seat_needs_no_cert():
    # The helper seat on an XL route rides along — an uncertified driver is
    # eligible for it even though the seat's route_type is "xl".
    r = first_failure_reason(
        _d(xl_certified=False), _s(route_type="xl", shift_kind="helper"), {}
    )
    assert r is None
    assert is_eligible(
        _d(xl_certified=False), _s(route_type="xl", shift_kind="helper"), {}
    ) is True


def test_xl_certified_driver_still_eligible_for_helper_seat():
    # A certified driver can also fill a helper seat (nothing forbids it — the
    # objective is what steers scarce certified drivers to the driver seat).
    assert is_eligible(
        _d(xl_certified=True), _s(route_type="xl", shift_kind="helper"), {}
    ) is True


def test_xl_driver_seat_still_gated_when_kind_regular():
    # Belt-and-suspenders: the regular (non-helper) XL seat keeps its gate.
    r = first_failure_reason(
        _d(xl_certified=False), _s(route_type="xl", shift_kind="regular"), {}
    )
    assert r is not None and r.code == E.XL_FAIL


def test_edv_cert_required_for_edv():
    r = first_failure_reason(_d(edv_certified=False), _s(route_type="edv"), {})
    assert r is not None and r.code == E.EDV_FAIL


def test_expired_license_fails():
    r = first_failure_reason(_d(dl_expires_on="2020-01-01"), _s(), {})
    assert r is not None and r.code == E.LICENSE_FAIL


def test_license_valid_on_shift_date_passes():
    assert is_eligible(_d(dl_expires_on="2026-12-31"), _s(), {}) is True


def test_gate_order_pto_before_availability():
    # On PTO AND wrong DOW → PTO wins (checked first).
    r = first_failure_reason(_d(available_dows=[3]), _s(), {"d1": {"2026-06-01"}})
    assert r is not None and r.code == E.PTO_FAIL


def test_gate_order_availability_before_cert():
    # Wrong DOW AND missing XL cert → availability wins (checked first).
    r = first_failure_reason(
        _d(available_dows=[3], xl_certified=False), _s(route_type="xl"), {}
    )
    assert r is not None and r.code == E.AVAILABILITY_FAIL


def test_matches_legacy_cpsat_is_eligible():
    # The model's _is_eligible must be the exact same decision.
    from rr_solver.cpsat_model import _is_eligible as model_is_eligible

    cases = [
        (_d(), _s(), {}),
        (_d(available_dows=[]), _s(), {}),
        (_d(available_dows=[2, 3]), _s(), {}),
        (_d(dot_certified=False), _s(route_type="step_van"), {}),
        (_d(xl_certified=False), _s(route_type="xl"), {}),
        (_d(edv_certified=False), _s(route_type="edv"), {}),
        (_d(dl_expires_on="2020-01-01"), _s(), {}),
        (_d(), _s(), {"d1": {"2026-06-01"}}),
    ]
    for d, s, pto in cases:
        assert model_is_eligible(d, s, pto) == is_eligible(d, s, pto)
