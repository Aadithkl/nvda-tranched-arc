import inspect
import math

from model import (
    default_params,
    fee_switch_edge,
    metrics_frame,
    pool_b_risk,
    run_model,
)


def rows(
    n=3,
    fee_a=272.0,
    fee_b=21.0,
    volume=10_000.0,
    volatility=10,
    max5m=0,
    guard=0,
    depeg=0,
    depeg_paused=False,
):
    return [
        {
            "bookA": {"poolFeesUsd": fee_a},
            "bookB": {
                "poolFeesUsd": fee_b,
                "risk": {"volumeUsd": volume, "volatilityBps": volatility},
                "max5mMoveBps": max5m,
                "guardPulls": guard,
                "depegProxy": depeg,
            },
            "depeg_paused": depeg_paused,
        }
        for _ in range(n)
    ]


def test_row_count_and_schema():
    p = {**default_params(), "policy": "static", "horizon_hours": 3}
    df = run_model(rows(3), p, T=3)
    assert len(df) == 1 + 3 * 5
    assert df["substep"].max() == 5
    assert "metrics" in df.columns


def test_weights_sum_to_one_and_nav_identity():
    p = {
        **default_params(),
        "policy": "static",
        "static_weights": {"p05": 0.70, "p15": 0.15, "p30": 0.15},
        "horizon_hours": 5,
    }
    mf = metrics_frame(run_model(rows(5), p, T=5))
    last = mf.iloc[-1]
    assert math.isclose(sum(last["weights"].values()), 1.0, abs_tol=1e-9)
    assert math.isclose(
        last["nav"],
        p["initial_nav"] + last["m_fees_total"] - last["m_cum_costs"],
        abs_tol=1e-6,
    )
    assert math.isclose(
        last["m_net_after_il"],
        last["nav"] - p["initial_nav"] - last["m_cum_il"],
        abs_tol=1e-6,
    )
    assert last["m_fees_total"] > 0


def test_fee_switch_edge_sign():
    common = dict(
        w=0.28,
        nav=100_000.0,
        cap_a=8_066_000.0,
        cap_b=539_100.0,
        eval_hours=168.0,
        switch_bps=5.0,
        gas=0.02,
        buffer_usd=25.0,
    )
    low = fee_switch_edge(fee_a_hour=272.0, fee_b_hour=21.0, **common)
    high = fee_switch_edge(fee_a_hour=272.0, fee_b_hour=210.0, **common)
    assert low < 0
    assert high > 0


def test_fee_switch_edge_is_fee_only():
    # The move rule has no return-hurdle input; the risk-only benchmark is a
    # reporting number, so a "hurdle_rate" parameter must not exist.
    assert "hurdle_rate" not in inspect.signature(fee_switch_edge).parameters

    edge = fee_switch_edge(
        w=0.28,
        nav=100_000.0,
        fee_a_hour=272.0,
        fee_b_hour=210.0,
        cap_a=8_066_000.0,
        cap_b=539_100.0,
        eval_hours=168.0,
        switch_bps=5.0,
        gas=0.02,
        buffer_usd=25.0,
    )
    capital_b = 0.28 * 100_000.0
    s_a = 100_000.0 / (100_000.0 + 8_066_000.0)
    s_b = capital_b / (capital_b + 539_100.0)
    expected = (
        210.0 * s_b * 168.0
        - 0.28 * 272.0 * s_a * 168.0
        - capital_b * 5.0 / 10_000.0
        - 0.02
        - 25.0
    )
    assert math.isclose(edge, expected, rel_tol=0.0, abs_tol=1e-9)


def test_pool_b_risk_reasons():
    p = default_params()
    nav = 100_000.0

    clean = rows(1)[0]
    gate = pool_b_risk([clean], 0, nav, p, 0.0)
    assert gate["risk"] == "NORMAL"
    assert gate["reasons"] == []
    assert gate["volume"] == 10_000.0
    assert gate["volatility"] == 10.0
    assert gate["share"] == 0.0

    def gate_for(reason, w=0.0, **kwargs):
        row = rows(1, **kwargs)[0]
        result = pool_b_risk([row], 0, nav, p, w)
        assert result["risk"] == "HIGH"
        assert reason in result["reasons"]
        return result

    gate_for("volatility", volatility=400)
    gate_for("guard", max5m=250)
    gate_for("guard", guard=3)
    gate_for("depeg", depeg=250)
    gate_for("depeg", depeg_paused=True)
    cap_gate = gate_for("share-cap", w=0.30)
    assert cap_gate["share"] > p["share_cap"]["p30"]

    # The volume check is a trailing average, so three thin hours are needed
    # to fire it.
    thin = pool_b_risk(rows(3, volume=500.0), 2, nav, p, 0.0)
    assert thin["risk"] == "HIGH"
    assert "volume" in thin["reasons"]

    # No entry is possible when the cap-safe target is not positive.
    assert pool_b_risk([rows(1)[0]], 0, 0.0, p, 0.0)["reasons"] == ["share-cap"]


def test_volume_gate_uses_trailing_three_hour_average():
    p = default_params()
    nav = 100_000.0

    # One thin hour inside a healthy 3h window: the average clears the $2,000
    # floor, so the current-hour spike alone does not fire the gate.
    scenario = rows(3, volume=10_000.0)
    scenario[2]["bookB"]["risk"]["volumeUsd"] = 500.0
    gate = pool_b_risk(scenario, 2, nav, p, 0.0)
    assert gate["risk"] == "NORMAL"
    assert "volume" not in gate["reasons"]
    assert math.isclose(gate["volume"], (10_000.0 + 10_000.0 + 500.0) / 3.0)

    # Three thin hours do fire: the trailing average is below the floor.
    thin = rows(3, volume=500.0)
    gate_thin = pool_b_risk(thin, 2, nav, p, 0.0)
    assert gate_thin["risk"] == "HIGH"
    assert "volume" in gate_thin["reasons"]
    assert math.isclose(gate_thin["volume"], 500.0)

    # Early rows clamp the window to the rows available.
    first = pool_b_risk(scenario, 0, nav, p, 0.0)
    assert first["volume"] == 10_000.0


def test_fee_check_enters_at_high_volume_only():
    p = {
        **default_params(),
        "policy": "fee_check",
        "vol30_mult": 10.0,
        "rebalance_hours": 24,
        "horizon_hours": 72,
    }
    mf = metrics_frame(run_model(rows(72, fee_a=272.0, fee_b=21.0), p, T=72))
    assert mf.iloc[-1]["m_weights_p30"] > 0.0

    p_low = {**p, "vol30_mult": 1.0}
    mf_low = metrics_frame(run_model(rows(72, fee_a=272.0, fee_b=21.0), p_low, T=72))
    assert mf_low.iloc[-1]["m_weights_p30"] == 0.0


def test_risk_gate_blocks_entry_even_when_fee_positive():
    p = {
        **default_params(),
        "policy": "fee_check",
        "vol30_mult": 1.0,
        "rebalance_hours": 24,
        "horizon_hours": 72,
    }
    # fee_b=210 makes the fee-only edge strongly positive; the thin 0.30 book
    # still blocks the entry.
    thin = rows(72, fee_b=210.0, volume=500.0)
    mf_thin = metrics_frame(run_model(thin, p, T=72))
    assert mf_thin.iloc[-1]["m_weights_p30"] == 0.0

    deep = rows(72, fee_b=210.0, volume=10_000.0)
    mf_deep = metrics_frame(run_model(deep, p, T=72))
    assert mf_deep.iloc[-1]["m_weights_p30"] > 0.0


def test_risk_gate_exits():
    p = {
        **default_params(),
        "policy": "fee_check",
        "vol30_mult": 1.0,
        "rebalance_hours": 24,
        "horizon_hours": 120,
    }
    scenario = rows(48, fee_b=210.0, volume=50_000.0) + rows(
        72, fee_b=210.0, volume=100.0
    )
    mf = metrics_frame(run_model(scenario, p, T=120))
    w30 = mf["m_weights_p30"].to_numpy()
    # The first thin hour is averaged with two healthy hours, so the sleeve is
    # not cut by a full move step on that rebalance. Sustained thin volume then
    # de-risks it.
    assert w30[47] > 0.0
    assert w30[47] - w30[48] < p["move_step"] / 2.0
    assert w30[-1] < w30[47]


def test_fee_check_respects_share_cap():
    p = {
        **default_params(),
        "policy": "fee_check",
        "vol30_mult": 100.0,
        "rebalance_hours": 2,
        "horizon_hours": 48,
        "share_cap": {"p15": 0.10, "p30": 0.05},
    }
    mf = metrics_frame(run_model(rows(48, fee_a=272.0, fee_b=21.0), p, T=48))
    assert mf.iloc[-1]["m_weights_p30"] <= 0.30 + 1e-9


def test_deterministic_replay():
    p = {**default_params(), "policy": "fee_check", "horizon_hours": 12}
    a = metrics_frame(run_model(rows(12), p, T=12))
    b = metrics_frame(run_model(rows(12), p, T=12))
    assert a["nav"].iloc[-1] == b["nav"].iloc[-1]
    assert a["weights"].iloc[-1] == b["weights"].iloc[-1]
