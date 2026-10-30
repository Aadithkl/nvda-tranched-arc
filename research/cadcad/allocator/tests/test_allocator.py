import pytest

from allocator import (
    assess_book_risk,
    borrow_size,
    choose_book,
    decide_by_risk,
    decide_pool_switch,
    plan_arm_entry,
    plan_book_return,
)


def test_risk_calm_book_normal():
    r = assess_book_risk(400, 50_000, 80, True, False)
    assert r["risk"] == "NORMAL"
    assert r["reasons"] == []


def test_risk_high_volatility():
    r = assess_book_risk(900, 50_000, 450, True, False)
    assert r["risk"] == "HIGH"
    assert "volatility" in ",".join(r["reasons"])


def test_risk_thin_volume():
    r = assess_book_risk(900, 500, 50, True, False)
    assert r["risk"] == "HIGH"
    assert "volume" in ",".join(r["reasons"])


def test_risk_guard_absent_or_depeg():
    assert assess_book_risk(900, 50_000, 50, False, False)["risk"] == "HIGH"
    assert assess_book_risk(900, 50_000, 50, True, True)["risk"] == "HIGH"


def test_risk_fee_floor_off_by_default_and_configurable():
    assert assess_book_risk(0, 50_000, 50, True, False)["risk"] == "NORMAL"
    r = assess_book_risk(50, 50_000, 50, True, False, {"minFeeAprBps": 100})
    assert r["risk"] == "HIGH"
    assert "fee" in ",".join(r["reasons"])


def test_decide_by_risk():
    assert decide_by_risk("HIGH", "BOOKS") == {
        "mode": "ARMS",
        "action": "MOVE_TO_ARMS",
        "reason": "risk high -> safe harbor",
    }
    assert decide_by_risk("NORMAL", "ARMS") == {
        "mode": "BOOKS",
        "action": "MOVE_TO_BOOKS",
        "reason": "risk normal -> book fees",
    }
    assert decide_by_risk("HIGH", "ARMS")["action"] == "HOLD"
    assert decide_by_risk("NORMAL", "BOOKS")["action"] == "HOLD"


def test_borrow_size_hard_cap():
    assert borrow_size(1000, 5000, 6250) == pytest.approx(300.0)
    assert borrow_size(1000, 2500, 6250) == pytest.approx(250.0)
    assert borrow_size(1000, 0, 6250) == 0.0
    assert borrow_size(200_000, 6000, 6250) == pytest.approx(60_000.0)


def test_arm_entry_quote_then_nvda_then_borrow():
    p = plan_arm_entry(
        usdg_available=10_000.0,
        nvda_available=100.0,
        nvda_price=200.0,
        ltv_bps=2_937,
        max_ltv_bps=6_250,
        morpho_share_bps=8_000,
        nvda_step_bps=1_000,
    )
    assert p["usdgMove"] == pytest.approx(8_000.0)
    assert p["nvdaMove"] == pytest.approx(10.0)
    assert p["borrow"] == pytest.approx(587.4)
    assert [s["action"] for s in p["steps"]] == [
        "ALLOCATE_USDG",
        "ALLOCATE_NVDA",
        "BORROW_USDG",
        "ALLOCATE_USDG",
    ]


def test_arm_entry_quote_target_met():
    p = plan_arm_entry(
        usdg_available=2_000.0,
        usdg_deployed=8_000.0,
        nvda_available=100.0,
        nvda_price=200.0,
        morpho_share_bps=8_000,
        nvda_step_bps=1_000,
    )
    assert p["usdgMove"] == 0.0
    assert p["nvdaMove"] == pytest.approx(10.0)
    assert p["steps"][0]["action"] == "ALLOCATE_NVDA"


def test_arm_entry_never_above_hard_30pct():
    p = plan_arm_entry(
        usdg_available=0.0,
        nvda_available=1_000.0,
        nvda_price=200.0,
        ltv_bps=6_000,
        max_ltv_bps=6_250,
        nvda_step_bps=10_000,
    )
    assert p["borrow"] == pytest.approx(60_000.0)


def test_book_return_repay_first():
    p = plan_book_return(10_000.0, 100.0, 5_000.0, 2_500)
    assert p["steps"][0]["action"] == "REPAY_NVDA"
    assert p["steps"][0]["repay"] == pytest.approx(1_250.0)


def test_book_return_withdraw_then_deallocate():
    p = plan_book_return(10_000.0, 100.0, 0.0, 2_500)
    assert p["steps"][0]["action"] == "WITHDRAW_NVDA"
    assert p["steps"][0]["collateral"] == pytest.approx(25.0)

    p = plan_book_return(10_000.0, 0.0, 0.0, 2_500)
    assert p["steps"][0]["action"] == "DEALLOCATE_USDG"
    assert p["steps"][0]["amount"] == pytest.approx(2_500.0)


def test_book_return_dust_snaps_to_full():
    p = plan_book_return(2.0, 0.001, 0.0, 2_500, dust_usdg=1.0, dust_nvda=0.001)
    assert p["steps"][0]["action"] == "WITHDRAW_NVDA"
    assert p["steps"][0]["collateral"] == pytest.approx(0.001)


def test_choose_book():
    assert choose_book(100, 200, 0) == 1
    assert choose_book(200, 100, 1) == 0
    assert choose_book(100, 100, 1) == 1


def test_pool_switch_no_pool_beats_buffer_goes_to_arms():
    d = decide_pool_switch(
        [
            {"name": "v3-0.05", "netAprBps": 266, "risk": "NORMAL"},
            {"name": "v4-0.05", "netAprBps": 100, "risk": "NORMAL"},
        ],
        current_pool="v4-0.05",
        switch_buffer_bps=500,
    )
    assert d["action"] == "ARMS"


def test_pool_switch_best_clearly_beats_buffer_and_current():
    d = decide_pool_switch(
        [
            {"name": "v3-0.05", "netAprBps": 900, "risk": "NORMAL"},
            {"name": "v4-0.05", "netAprBps": 200, "risk": "NORMAL"},
        ],
        current_pool="v4-0.05",
        switch_buffer_bps=500,
    )
    assert d["action"] == "SWITCH"
    assert d["pool"] == "v3-0.05"


def test_pool_switch_best_is_current_hold():
    d = decide_pool_switch(
        [{"name": "v3-0.05", "netAprBps": 900, "risk": "NORMAL"}],
        current_pool="v3-0.05",
        switch_buffer_bps=500,
    )
    assert d["action"] == "HOLD"


def test_pool_switch_lead_below_buffer_hold_current():
    d = decide_pool_switch(
        [
            {"name": "v3-0.05", "netAprBps": 650, "risk": "NORMAL"},
            {"name": "v4-0.05", "netAprBps": 500, "risk": "NORMAL"},
        ],
        current_pool="v4-0.05",
        switch_buffer_bps=500,
    )
    assert d["action"] == "HOLD"
    assert d["pool"] == "v4-0.05"


def test_pool_switch_high_risk_candidate_skipped():
    d = decide_pool_switch(
        [
            {"name": "v3-0.05", "netAprBps": 5000, "risk": "HIGH"},
            {"name": "v4-0.05", "netAprBps": 200, "risk": "NORMAL"},
        ],
        current_pool="v4-0.05",
        switch_buffer_bps=500,
    )
    assert d["action"] == "ARMS"
