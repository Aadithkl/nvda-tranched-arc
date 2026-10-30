import copy
import math

import pandas as pd
import pytest

from lp import position_value_usd

from model import (
    PSUBS,
    _close_book,
    _execute_action,
    _fund_book,
    _liquidate,
    _return_to_books_action,
    _surplus_action,
    book_fee_for_hour,
    book_fee_parts,
    build_initial_state,
    default_params,
    metrics_frame,
    portfolio_nav,
    run_model,
    s_portfolio_income,
)
from tests.conftest import make_scenario


def _params(**overrides):
    p = default_params()
    p.update(
        {
            "policy": "risk_only",
            "fix_empty_book_guard": True,
            "fix_hypothetical_range": True,
            "warmup_hours": 0,
            "gas_cost_usd": 0.02,
        }
    )
    p.update(overrides)
    return p


def test_row_count_and_schema(synthetic_scenario):
    df = run_model(synthetic_scenario, _params(), T=24)
    assert len(df) == 1 + 24 * len(PSUBS)
    assert set(df["substep"].unique()) == set(range(len(PSUBS) + 1))
    for col in ("nav", "hodl_nav", "portfolio", "book_metrics", "decision", "metrics"):
        assert col in df.columns


def test_determinism(synthetic_scenario):
    a = run_model(synthetic_scenario, _params(), T=12)
    b = run_model(synthetic_scenario, _params(), T=12)
    assert a["nav"].tolist() == b["nav"].tolist()
    assert a["portfolio"].tolist() == b["portfolio"].tolist()


def test_psub_variables_exist_in_initial_state(synthetic_scenario):
    state = build_initial_state(synthetic_scenario, _params())
    for psub in PSUBS:
        for var in psub["variables"]:
            assert var in state, f"PSUB writes missing state variable {var}"


def test_no_input_mutation(synthetic_scenario):
    before = copy.deepcopy(synthetic_scenario)
    run_model(synthetic_scenario, _params(), T=12)
    assert synthetic_scenario == before


def test_nav_conservation_on_actions():
    # Force a risk-high period so the allocator recalls and moves to the arms.
    rows = make_scenario(n_hours=24, risk_high_hours=24)
    df = run_model(rows, _params(), T=24)
    mf = metrics_frame(df)
    acted = mf[mf["cum_actions"] > 0]
    assert len(acted) > 0
    err = (acted["nav_before"] - acted["nav_after"] - acted["last_costs"]).abs()
    # Funding a range at the current price is exact to float precision; allow
    # a small tolerance for token-amount rounding.
    assert err.max() < 0.01
    # The NAV state must equal the post-execute nav.
    assert (mf["nav"] - mf["nav_after"]).abs().max() < 0.01


def test_non_negative_balances(synthetic_scenario):
    df = run_model(synthetic_scenario, _params(), T=48)
    mf = metrics_frame(df)
    for col in ("idle_usdg", "idle_nvda", "arm_debt", "arm_usdg_lent", "arm_nvda", "book_a_value", "book_b_value"):
        assert (mf[col] >= -1e-9).all(), col


def test_arm_ltv_at_borrow_below_30pct():
    rows = make_scenario(n_hours=120, risk_high_hours=120)
    df = run_model(rows, _params(), T=120)
    mf = metrics_frame(df)
    ev = []
    for _, r in df[df["substep"] == len(PSUBS)].iterrows():
        ev.extend(r["last_events"] or [])
    borrows = [e for e in ev if e.get("type") == "BORROW_USDG"]
    assert borrows, "expected an arm borrow"
    step = borrows[0]["step"]
    row = mf[mf["step"] == step].iloc[0]
    assert row["arm_ltv"] <= 0.3001
    assert row["arm_ltv"] > 0


def test_guard_pull_and_rearm():
    rows = make_scenario(n_hours=12, guard_pull_hour=2)
    p = _params(policy="always_a")
    df = run_model(rows, p, T=12)
    mf = metrics_frame(df)
    ev = []
    for _, r in df[df["substep"] == len(PSUBS)].iterrows():
        ev.extend(r["last_events"] or [])
    assert any(e.get("type") == "GUARD_PULLED" for e in ev)
    assert any(e.get("type") == "GUARD_REARMED" for e in ev)
    assert not bool(mf.iloc[2]["guard_present_a"])
    assert bool(mf.iloc[-1]["guard_present_a"])


def test_hodl_has_no_fees_and_tracks_hodl():
    rows = make_scenario(n_hours=48)
    df = run_model(rows, _params(policy="hodl"), T=48)
    mf = metrics_frame(df)
    assert mf["cum_fees"].iloc[-1] == pytest.approx(0.0)
    assert mf["nav"].iloc[-1] == pytest.approx(mf["hodl_nav"].iloc[-1], rel=1e-9)
    assert mf["cum_actions"].iloc[-1] == 0


def test_always_arms_respects_caps():
    rows = make_scenario(n_hours=96)
    df = run_model(rows, _params(policy="always_arms"), T=96)
    mf = metrics_frame(df)
    last = mf.iloc[-1]
    assert last["cum_actions"] > 0
    assert last["arm_nvda"] * last["price"] <= 2_000.0 + 1.0
    assert last["arm_usdg_lent"] <= 2_000.0 + 1.0
    if last["arm_debt"] > 0:
        assert last["arm_debt"] <= 0.30 * last["arm_nvda"] * last["price"] + 1.0


def test_risk_only_returns_to_book_after_risk_normalizes():
    rows = make_scenario(n_hours=168, risk_high_hours=12)
    df = run_model(rows, _params(policy="risk_only"), T=168)
    mf = metrics_frame(df)
    # It must leave the book during the risk-high period and come back later.
    assert (mf["mode"] == "ARMS").any()
    assert (mf["book_a_value"] > 1.0).iloc[100:].any()
    assert mf["cum_actions"].iloc[-1] > 0


def test_static_fee_reproduction(real_scenario):
    """Reproduce the prior research sim's static fee totals."""
    refs = {
        "always_a": (245.18959268831065, 0.003),
        "always_b": (276.26020450403627, 0.008),
    }
    for policy, (ref, tol) in refs.items():
        p = _params(policy=policy, guard_pull_threshold_bps=1e9, gas_cost_usd=0.0)
        df = run_model(real_scenario, p, T=len(real_scenario))
        mf = metrics_frame(df)
        assert mf["cum_fees"].iloc[-1] == pytest.approx(ref, rel=tol)


# ---------------------------------------------------------------------------
# Direct execution / accounting tests for the reviewer's findings
# ---------------------------------------------------------------------------

def _arm_portfolio(collateral_value: float, debt: float, lend: float, idle: float = 1_000.0):
    rows = make_scenario(n_hours=1, price=225.0)
    p = _params(policy="risk_only")
    state = build_initial_state(rows, p)
    pf = state["portfolio"]
    env = state["env"]
    for book in pf["books"]:
        book.update(
            {
                "deployed": False,
                "base_L": 0.0,
                "guard_L": 0.0,
                "guard_present": False,
                "fees": 0.0,
            }
        )
    pf["idle_usdg"] = idle
    pf["idle_nvda"] = 0.0
    pf["arm"] = {
        "nvda": collateral_value / env["price"] if env["price"] > 0 else 0.0,
        "debt": debt,
        "usdg_lent": lend,
        "bad_debt": 0.0,
    }
    pf["last_events"] = []
    return pf, env, p, float(env["sqrtP"]), float(env["price"])


def test_liquidation_does_not_create_nav():
    cases = [
        (100.0, 200.0, 0.0),  # collateral below debt, no lend buffer
        (100.0, 200.0, 50.0),  # lend buffer absorbs part of the shortfall
        (150.0, 100.0, 0.0),  # equity positive, HF<1, bonus is the loss
        (90.0, 200.0, 0.0),  # deeper shortfall
    ]
    for collateral, debt, lend in cases:
        pf, env, p, sqrt_p, price = _arm_portfolio(collateral, debt, lend)
        before = portfolio_nav(pf, sqrt_p, price)
        _liquidate(pf, sqrt_p, price, 1, p)
        after = portfolio_nav(pf, sqrt_p, price)
        assert after <= before + 1e-6, (collateral, debt, lend, before, after)
        assert pf["arm"]["usdg_lent"] >= -1e-9
        assert pf["arm"]["bad_debt"] >= -1e-9
        assert pf["arm"]["nvda"] >= -1e-9
        assert pf["cum"]["liquidation_loss"] >= -1e-9


def test_real_tape_nav_conservation(real_scenario):
    """The price/tick convention must conserve NAV on the actual tape."""
    p = _params(policy="always_arms")
    df = run_model(real_scenario, p, T=48)
    mf = metrics_frame(df)
    acted = mf[mf["cum_actions"] > 0]
    assert len(acted) > 0
    err = (acted["nav_before"] - acted["nav_after"] - acted["last_costs"]).abs()
    assert err.max() < 0.01


def test_execute_borrow_respects_hard_ltv_cap():
    pf, env, p, sqrt_p, price = _arm_portfolio(10.0 * 225.0, 0.0, 0.0)
    action = {"action": "BORROW_USDG", "amount": 100_000.0}
    out = _execute_action(pf, env, p, action, 1)
    assert out["arm"]["debt"] > 0
    assert out["arm"]["debt"] <= 0.30 * out["arm"]["nvda"] * price + 1e-6

    p_low = dict(p)
    p_low["hard_cap_bps"] = 2_500
    out_low = _execute_action(pf, env, p_low, action, 1)
    assert out_low["arm"]["debt"] <= 0.25 * out_low["arm"]["nvda"] * price + 1e-6


def test_execute_withdraw_keeps_health_floor():
    pf, env, p, sqrt_p, price = _arm_portfolio(10.0 * 225.0, 600.0, 0.0)
    action = {"action": "WITHDRAW_NVDA", "amount": 100.0}
    out = _execute_action(pf, env, p, action, 1)
    hf = p["lltv"] * out["arm"]["nvda"] * price / out["arm"]["debt"]
    assert hf >= p["min_health_factor"] - 1e-6
    assert out["arm"]["nvda"] < 10.0


def test_return_to_books_does_not_withdraw_with_debt():
    pf, env, p, sqrt_p, price = _arm_portfolio(10.0 * 225.0, 100.0, 0.0)
    pf["idle_usdg"] = 0.0
    action = _return_to_books_action(pf, p)
    assert action["action"] == "HOLD"


def test_fund_book_uses_90pct_of_idle():
    rows = make_scenario(n_hours=1, price=225.0)
    p = _params()
    state = build_initial_state(rows, p)
    pf = state["portfolio"]
    env = state["env"]
    _close_book(pf, 0, float(env["sqrtP"]))
    price = float(env["price"])
    funded = _fund_book(pf, 0, env, p)
    assert funded == pytest.approx(9_000.0, rel=0.01)
    leftover = pf["idle_usdg"] + pf["idle_nvda"] * price
    assert leftover == pytest.approx(1_000.0, rel=0.05)


def test_borrow_apr_ceiling_triggers_deleverage():
    rows = make_scenario(n_hours=120, risk_high_hours=120)
    p = _params(policy="risk_only", arm_borrow_apr=0.50)
    df = run_model(rows, p, T=120)
    mf = metrics_frame(df)
    ev = [e for _, r in df[df["substep"] == len(PSUBS)].iterrows() for e in (r["last_events"] or [])]
    borrows = [e for e in ev if e.get("type") == "BORROW_USDG"]
    assert borrows
    step = borrows[0]["step"]
    later = mf[(mf["step"] > step) & (mf["step"] <= step + 5)]
    assert later["arm_debt"].min() < mf[mf["step"] == step]["arm_debt"].iloc[0]


def test_guard_pull_is_an_event_not_bins():
    rows = make_scenario(n_hours=12, guard_pull_hour=2)
    p = _params(policy="always_a")
    df = run_model(rows, p, T=12)
    mf = metrics_frame(df)
    assert mf["cum_guard_pulls"].iloc[-1] == 1
    assert mf["guard_pulls_hour"].iloc[2] == 1


def test_guard_fee_prorated_at_first_pull_bin():
    book = {
        "deployed": True,
        "base_L": 0.001,
        "guard_L": 0.005,
        "base_lo": -10_000,
        "base_hi": 10_000,
        "guard_lo": -1_000,
        "guard_hi": 1_000,
        "guard_present": True,
    }
    minutes = {
        "tick": [0] * 60,
        "volume": [1.0] * 60,
        "volOverL": [1_000.0] * 60,
        "volOverL2": [10.0] * 60,
    }
    total0, guard0, base0 = book_fee_for_hour(book, minutes, 500, None)
    total1, guard1, base1 = book_fee_for_hour(book, minutes, 500, 6)
    assert total0 > total1
    assert base1 == pytest.approx(base0)
    assert guard1 == pytest.approx(guard0 * 0.5)


def test_allocator_interval_2h_holds_odd_hours():
    rows = make_scenario(n_hours=12, risk_high_hours=12)
    one = run_model(rows, _params(policy="risk_only", allocator_interval_hours=1), T=12)
    two = run_model(rows, _params(policy="risk_only", allocator_interval_hours=2), T=12)
    mf1 = metrics_frame(one)
    mf2 = metrics_frame(two)
    assert mf2["cum_actions"].iloc[-1] < mf1["cum_actions"].iloc[-1]
    odd = mf2[mf2["step"] % 2 == 1]
    assert odd["decision_reason"].str.contains("outside 2h allocator interval").all()


def test_guard_share_zero_is_base_only():
    rows = make_scenario(n_hours=12)
    p = _params(policy="always_a", guard_share=0.0, guard_pull_threshold_bps=1e9)
    state = build_initial_state(rows, p)
    book = state["portfolio"]["books"][0]
    assert book["guard_L"] == 0.0
    assert book["base_L"] > 0
    df = run_model(rows, p, T=12)
    mf = metrics_frame(df)
    assert mf["cum_fees"].iloc[-1] > 0


def test_ltv_35_caps_borrow_at_35pct():
    pf, env, p, sqrt_p, price = _arm_portfolio(10.0 * 225.0, 0.0, 0.0)
    p["ltv_bps"] = 3_500
    p["hard_cap_bps"] = 3_500
    action = {"action": "BORROW_USDG", "amount": 100_000.0}
    out = _execute_action(pf, env, p, action, 1)
    ltv = out["arm"]["debt"] / (out["arm"]["nvda"] * price)
    assert ltv <= 0.35 + 1e-6
    assert ltv > 0.29


def test_rewards_identity_real(real_scenario):
    p = _params()
    df = run_model(real_scenario, p, T=len(real_scenario))
    mf = metrics_frame(df)
    last = mf.iloc[-1]
    lhs = (
        float(last["cum_net_carry"])
        - float(last["cum_liquidation_loss"])
        + float(last["cum_il_vs_hodl"])
    )
    assert lhs == pytest.approx(float(last["net_vs_hodl"]), abs=1e-6)
    assert float(last["cum_net_carry"]) == pytest.approx(
        float(last["cum_fees"])
        + float(last["cum_arm_interest"])
        + float(last["cum_nvda_yield"])
        - float(last["cum_borrow_cost"])
        - float(last["cum_gas"])
        - float(last["cum_switch_cost"])
        - float(last["cum_swap_cost"])
    )


def test_swap_funding_deploys_more_and_costs_nav():
    rows = make_scenario(n_hours=4)
    p = _params(policy="always_a")
    state = build_initial_state(rows, p)
    env = state["env"]
    sqrt_p = float(env["sqrtP"])
    price = float(env["price"])

    def imbalanced():
        pf = copy.deepcopy(state["portfolio"])
        _close_book(pf, 0, sqrt_p)
        pf["arm"] = {"nvda": 0.0, "debt": 0.0, "usdg_lent": 0.0, "bad_debt": 0.0}
        pf["idle_nvda"] = 0.0
        pf["idle_usdg"] = 10_000.0
        return pf

    pf_scale = imbalanced()
    funded_scale = _fund_book(pf_scale, 0, env, {**p, "funding_mode": "scale"})

    pf_swap = imbalanced()
    nav_before = portfolio_nav(pf_swap, sqrt_p, price)
    funded_swap = _fund_book(
        pf_swap,
        0,
        env,
        {**p, "funding_mode": "swap", "swap_cost_bps": 30.0},
    )
    nav_after = portfolio_nav(pf_swap, sqrt_p, price)
    cost = float(pf_swap["cum"]["swap_cost"])

    assert funded_swap > funded_scale + 1.0
    assert cost > 0
    assert nav_after == pytest.approx(nav_before - cost, abs=0.02)


def test_inventory_skew_uses_more_recalled_inventory():
    rows = make_scenario(n_hours=4)
    p = _params(policy="always_a")
    state = build_initial_state(rows, p)
    env = state["env"]
    sqrt_p = float(env["sqrtP"])
    price = float(env["price"])

    def imbalanced():
        pf = copy.deepcopy(state["portfolio"])
        _close_book(pf, 0, sqrt_p)
        pf["arm"] = {"nvda": 0.0, "debt": 0.0, "usdg_lent": 0.0, "bad_debt": 0.0}
        pf["idle_usdg"] = 2_000.0
        pf["idle_nvda"] = 8_000.0 / price
        return pf

    pf_scale = imbalanced()
    funded_scale = _fund_book(
        pf_scale,
        0,
        env,
        {**p, "funding_mode": "scale", "base_width_ticks": 3_000},
    )
    pf_skew = imbalanced()
    funded_skew = _fund_book(
        pf_skew,
        0,
        env,
        {
            **p,
            "funding_mode": "scale",
            "base_width_ticks": 3_000,
            "base_skew_mode": "inventory",
            "base_skew_max_ticks": 2_500,
        },
    )
    assert funded_skew > funded_scale + 1.0
    assert int(pf_skew["books"][0]["base_skew_ticks"]) != 0


def test_recenter_action_triggers_on_price_move():
    rows = make_scenario(n_hours=6, guard_pull_hour=2)
    p = _params(
        policy="risk_only",
        guard_pull_threshold_bps=1e9,
        recenter_threshold_bps=200,
    )
    df = run_model(rows, p, T=6)
    events = []
    for _, r in df[df["substep"] == len(PSUBS)].iterrows():
        events.extend(r["last_events"] or [])
    assert any(e.get("type") == "RECENTER_BOOK" for e in events)
    mf = metrics_frame(df)
    assert float(mf.iloc[-1]["cum_actions"]) > 0


def test_recenter_off_by_default_does_not_churn():
    rows = make_scenario(n_hours=6, guard_pull_hour=2)
    p = _params(policy="risk_only", guard_pull_threshold_bps=1e9)
    df = run_model(rows, p, T=6)
    events = []
    for _, r in df[df["substep"] == len(PSUBS)].iterrows():
        events.extend(r["last_events"] or [])
    assert not any(e.get("type") == "RECENTER_BOOK" for e in events)


def test_net_nvda_apr_is_after_borrow_cost():
    rows = make_scenario(n_hours=4)
    p = _params(policy="always_a")
    state = build_initial_state(rows, p)
    env = state["env"]
    price = float(env["price"])
    ltv = 0.29375
    pf = copy.deepcopy(state["portfolio"])
    _close_book(pf, 0, float(env["sqrtP"]))
    pf["arm"] = {
        "nvda": 10.0,
        "debt": 10.0 * price * ltv,
        "usdg_lent": 0.0,
        "bad_debt": 0.0,
    }
    pf["idle_usdg"] = 0.0
    pf["idle_nvda"] = 0.0
    s = {"portfolio": pf, "env": env, "step": 1}
    params = {
        **p,
        "arm_nvda_apr": 0.03,
        "arm_borrow_apr": 0.03,
        "nvda_apr_is_net": True,
        "scenario": rows,
    }
    _, out = s_portfolio_income(params, 0, None, s, None)
    nvda_yield = float(out["cum"]["nvda_yield"])
    borrow_cost = float(out["cum"]["borrow_cost"])
    expected_net = 10.0 * price * 0.03 / (365 * 24)
    # The net NVDA contribution after the debt attributed to the collateral is 3%.
    assert nvda_yield - borrow_cost == pytest.approx(expected_net, rel=1e-9)
    assert nvda_yield > expected_net  # grossed up for borrow


def test_surplus_sweep_allocates_excess_nvda():
    rows = make_scenario(n_hours=4)
    p = _params(policy="risk_only")
    state = build_initial_state(rows, p)
    pf = copy.deepcopy(state["portfolio"])
    pf["idle_usdg"] = 2_000.0
    pf["idle_nvda"] = 20.0
    params = {
        **p,
        "surplus_sweep": True,
        "inventory_reserve_usd": 1_000.0,
        "inventory_reserve_pct": 0.0,
        "surplus_nvda_min_usd": 100.0,
        "surplus_usdg_min_usd": 100.0,
    }
    action = _surplus_action(pf, state["env"], params, pf["books"][0])
    assert action is not None
    assert action["action"] == "ALLOCATE_NVDA"
    assert action["amount"] > 0
    assert action["reason"].startswith("surplus:")


def test_surplus_sweep_respects_reserve():
    rows = make_scenario(n_hours=4)
    p = _params(policy="risk_only")
    state = build_initial_state(rows, p)
    pf = copy.deepcopy(state["portfolio"])
    pf["idle_usdg"] = 500.0
    pf["idle_nvda"] = 2.0  # ~$450, below the $1k reserve
    params = {
        **p,
        "surplus_sweep": True,
        "inventory_reserve_usd": 1_000.0,
        "inventory_reserve_pct": 0.0,
        "surplus_nvda_min_usd": 100.0,
        "surplus_usdg_min_usd": 100.0,
    }
    assert _surplus_action(pf, state["env"], params, pf["books"][0]) is None


def test_exact_fee_share_matches_expansion_at_small_size(real_scenario):
    p = _params(policy="always_a")
    state = build_initial_state(real_scenario, p)
    book = state["portfolio"]["books"][0]
    minutes = real_scenario[0]["bookA"]["minutes"]
    exp = book_fee_parts(book, minutes, 500.0, "expansion")[0]
    exact = book_fee_parts(book, minutes, 500.0, "exact")[0]
    assert exact == pytest.approx(exp, rel=0.02)


def test_exact_fee_share_is_larger_for_large_book(real_scenario):
    p = _params(policy="always_a")
    state = build_initial_state(real_scenario, p)
    book = copy.deepcopy(state["portfolio"]["books"][0])
    book["base_L"] *= 1_000.0
    book["guard_L"] *= 1_000.0
    minutes = real_scenario[0]["bookA"]["minutes"]
    exp = book_fee_parts(book, minutes, 500.0, "expansion")[0]
    exact = book_fee_parts(book, minutes, 500.0, "exact")[0]
    assert exact > exp
    assert exact > 0


def test_book_b_own_mark_difference_is_small(real_scenario):
    """Book B is marked at Book A's tick; quantify the approximation."""
    row = real_scenario[0]
    state = build_initial_state(real_scenario, _params())
    book = state["portfolio"]["books"][0]
    a_sqrt = math.sqrt(1.0001 ** int(row["tick"]))
    b_tick = row["bookB"].get("tickClose") or row["tick"]
    b_sqrt = math.sqrt(1.0001 ** int(b_tick))

    def value(sqrt_p):
        return position_value_usd(
            book["target_base_L"], sqrt_p, book["base_lo"], book["base_hi"]
        ) + position_value_usd(
            book["target_guard_L"], sqrt_p, book["guard_lo"], book["guard_hi"]
        )

    a_val = value(a_sqrt)
    b_val = value(b_sqrt)
    assert a_val > 0
    assert abs(b_val / a_val - 1.0) < 0.005


def test_book_fee_guard_only_when_base_out_of_range():
    book = {
        "deployed": True,
        "base_L": 0.001,
        "guard_L": 0.005,
        "base_lo": 200,
        "base_hi": 300,
        "guard_lo": -10,
        "guard_hi": 10,
        "guard_present": True,
    }
    minutes = {
        "tick": [0] * 60,
        "volume": [1.0] * 60,
        "volOverL": [1_000.0] * 60,
        "volOverL2": [10.0] * 60,
    }
    total, guard_fee, base_fee = book_fee_for_hour(book, minutes, 500, None)
    assert total > 0
    assert guard_fee == pytest.approx(total)
    assert base_fee == pytest.approx(0.0)
