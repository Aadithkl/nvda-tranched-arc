"""cadCAD model: fee-first allocation with a direct live switch check.

This is the clean rebuild. The primary policy is ``fee_check``: it compares the
fees our sleeve would earn in the 0.30 pool against the fees the same capital
would earn in the 0.05 pool, subtracts switching cost and a buffer, and moves
only if the edge is positive *and* the 0.30 risk gate is NORMAL.

The move rule is fee-only. The risk-only return (``hurdle_total``) is a
reporting benchmark, not a hurdle subtracted from the edge. The 0.30 risk gate
covers a 3-hour trailing volume average, volatility, guard pulls, depeg proxy
and the 5% pool-share cap.

    python run.py baseline
    python run.py sweep
    python run.py reverse
"""

from __future__ import annotations

from typing import Any

import pandas as pd
from cadCAD.configuration import Experiment
from cadCAD.configuration.utils import config_sim
from cadCAD.engine import ExecutionContext, ExecutionMode, Executor

POOLS = ("p05", "p15", "p30")


def default_params() -> dict[str, Any]:
    return {
        "initial_nav": 100_000.0,
        "fee_rate": {"p05": 0.0005, "p15": 0.0015, "p30": 0.003},
        # Dollar capacity calibrated to the observed fee shares at $100k:
        # 0.05 -> 1.2245%, 0.30 -> 15.6458%. 0.15 is a parameter.
        "capacity": {"p05": 8_066_000.0, "p15": 539_100.0, "p30": 539_100.0},
        "vol15_mult": 2.0,
        "vol30_mult": 1.0,
        "policy": "fee_check",
        "static_weights": {"p05": 1.0, "p15": 0.0, "p30": 0.0},
        "weight_cap": {"p15": 0.30, "p30": 0.30},
        "share_cap": {"p15": 0.10, "p30": 0.05},
        "rebalance_hours": 24,
        "move_step": 0.05,
        "switch_cost_bps": 5.0,
        "gas_cost": 0.02,
        "fee_buffer_usd": 25.0,
        # 0.30 risk gate. Thresholds are calibrated to the 36m 0.30 tape:
        # volume mean $4,357 / median $698, volatility p90 24 bps, max5m max
        # 122 bps, depeg 0, guardPulls 0 at 200 bps.
        "risk_min_volume_usd": 2_000.0,
        # The gate averages 0.30 volume over this trailing window (hours,
        # including the current row). One-hour volume is too noisy: a single
        # thin hour would otherwise block an otherwise healthy pool.
        "risk_volume_window_hours": 3,
        "risk_max_volatility_bps": 300.0,
        "risk_guard_pull_threshold_bps": 200.0,
        "risk_max_guard_pulls": 2,
        "risk_depeg_bps": 200.0,
        "eval_hours": 168.0,
        "il_total": 972.02,
        "hurdle_total": 1_696.47,
        "margin_total": 0.0,
        "horizon_hours": 1_080,
        "seed": 0,
    }


def _norm(weights: dict[str, float]) -> dict[str, float]:
    total = sum(max(0.0, float(weights.get(p, 0.0))) for p in POOLS)
    if total <= 0:
        return {"p05": 1.0, "p15": 0.0, "p30": 0.0}
    return {p: max(0.0, float(weights.get(p, 0.0))) / total for p in POOLS}


def _next_weights(
    old: dict[str, float], targets: dict[str, float], step: float
) -> dict[str, float]:
    new = {}
    for p in POOLS:
        delta = float(targets.get(p, 0.0)) - float(old[p])
        new[p] = float(old[p]) + max(-step, min(step, delta))
    return _norm(new)


def fee_switch_edge(
    w: float,
    nav: float,
    fee_a_hour: float,
    fee_b_hour: float,
    cap_a: float,
    cap_b: float,
    eval_hours: float,
    switch_bps: float,
    gas: float,
    buffer_usd: float,
) -> float:
    """Dollar edge of moving fraction ``w`` from 0.05 to 0.30 over the window.

    edge = fees in 0.30 - fees the sleeve would earn in 0.05
           - switching cost - buffer

    The switch cost (5 bps + gas) is execution cost, not a return hurdle. The
    risk-only benchmark does not enter this rule; whether the move is *safe* is
    decided separately by :func:`pool_b_risk`.
    """
    w = max(0.0, min(1.0, float(w)))
    nav = max(0.0, float(nav))
    capital_b = w * nav
    s_a = nav / (nav + max(1e-9, cap_a))
    s_b = capital_b / (capital_b + max(1e-9, cap_b)) if capital_b > 0 else 0.0
    fees_a = w * float(fee_a_hour) * s_a * float(eval_hours)
    fees_b = float(fee_b_hour) * s_b * float(eval_hours)
    cost = w * nav * float(switch_bps) / 10_000.0 + (float(gas) if w > 0 else 0.0)
    return fees_b - fees_a - cost - float(buffer_usd)


def _trailing_volume(
    rows: list[dict[str, Any]],
    idx: int,
    window_hours: int,
    vol_mult: float,
) -> float:
    """Average 0.30 ``volumeUsd`` over the trailing window ending at ``idx``.

    The window is clamped to the rows available, so early hours use fewer than
    ``window_hours`` observations. The result is scaled by ``vol_mult`` (the
    ``vol30_mult`` scenario multiplier) to match the fee revenue scaling.
    """
    window = max(1, int(window_hours))
    start = max(0, int(idx) - window + 1)
    window_rows = rows[start : int(idx) + 1]
    total = 0.0
    for r in window_rows:
        book_b = r.get("bookB") or {}
        book_risk = book_b.get("risk") or {}
        total += float(book_risk.get("volumeUsd", 0.0))
    return total / max(1, len(window_rows)) * float(vol_mult)


def pool_b_risk(
    rows: list[dict[str, Any]],
    idx: int,
    nav: float,
    params: dict[str, Any],
    w: float,
) -> dict[str, Any]:
    """Evaluate the 0.30 pool risk gate for a sleeve weight ``w``.

    Pure: reads the scenario rows and ``params``; writes nothing.

    Reasons (tags, in check order):

    - ``volume``: the average ``bookB.risk.volumeUsd`` over the trailing
      ``risk_volume_window_hours`` (including the current row, clamped to the
      rows available) times ``vol30_mult`` is below
      ``risk_min_volume_usd``. A single thin hour does not fire the gate when
      the window average is healthy.
    - ``volatility``: ``bookB.risk.volatilityBps`` above
      ``risk_max_volatility_bps``.
    - ``guard``: ``bookB.max5mMoveBps`` above
      ``risk_guard_pull_threshold_bps`` or ``bookB.guardPulls`` above
      ``risk_max_guard_pulls``.
    - ``depeg``: ``bookB.depegProxy`` above ``risk_depeg_bps`` or the row
      carries ``depeg_paused``.
    - ``share-cap``: the current pool share exceeds ``share_cap["p30"]``, or
      the cap-safe target weight is not positive (no entry possible).

    Volatility, guard and depeg are current-row checks; only volume is
    averaged. Returns ``{risk, reasons, volume, volatility, max5m, depeg,
    share}`` where ``risk`` is ``"HIGH"`` when any reason fired and
    ``"NORMAL"`` otherwise.
    """
    idx = min(max(0, int(idx)), len(rows) - 1)
    row = rows[idx]
    book_b = row.get("bookB") or {}
    book_risk = book_b.get("risk") or {}
    volume = _trailing_volume(
        rows,
        idx,
        int(params["risk_volume_window_hours"]),
        float(params["vol30_mult"]),
    )
    volatility = float(book_risk.get("volatilityBps", 0.0))
    max5m = float(book_b.get("max5mMoveBps", 0.0))
    guard_pulls = int(book_b.get("guardPulls", 0) or 0)
    depeg = float(book_b.get("depegProxy", 0.0))

    nav = max(0.0, float(nav))
    w = max(0.0, min(1.0, float(w)))
    cap_b = float(params["capacity"]["p30"])
    share_cap = float(params["share_cap"]["p30"])
    capital_b = w * nav
    share = capital_b / (capital_b + cap_b) if capital_b + cap_b > 0 else 0.0
    w_cap_share = (
        share_cap * cap_b / (nav * (1.0 - share_cap)) if nav > 0 else 0.0
    )

    reasons: list[str] = []
    if volume < float(params["risk_min_volume_usd"]):
        reasons.append("volume")
    if volatility > float(params["risk_max_volatility_bps"]):
        reasons.append("volatility")
    if max5m > float(params["risk_guard_pull_threshold_bps"]) or guard_pulls > int(
        params["risk_max_guard_pulls"]
    ):
        reasons.append("guard")
    if depeg > float(params["risk_depeg_bps"]) or bool(row.get("depeg_paused")):
        reasons.append("depeg")
    # Relative tolerance so the *at-cap* sleeve is not treated as over-cap by
    # floating-point noise.
    if share > share_cap * (1.0 + 1e-9) or w_cap_share <= 0.0:
        reasons.append("share-cap")

    return {
        "risk": "HIGH" if reasons else "NORMAL",
        "reasons": reasons,
        "volume": volume,
        "volatility": volatility,
        "max5m": max5m,
        "depeg": depeg,
        "share": share,
    }


def build_initial_state(params: dict[str, Any]) -> dict[str, Any]:
    if params.get("policy") == "fee_check":
        w = {"p05": 1.0, "p15": 0.0, "p30": 0.0}
    else:
        w = _norm(params.get("static_weights", {"p05": 1.0}))
    return {
        "step": 0,
        "weights": w,
        "targets": dict(w),
        "fees": {p: 0.0 for p in POOLS},
        "cum_costs": 0.0,
        "cum_il": 0.0,
        "nav": float(params["initial_nav"]),
        "market": {},
        "metrics": {},
    }


# ---------------------------------------------------------------------------
# PSUB 1: environment
# ---------------------------------------------------------------------------

def p_market(params, substep, sH, s, additional_objs=None, **kwargs):
    rows = params["scenario"]
    idx = min(int(s["step"]), len(rows) - 1)
    row = rows[idx]
    fee30 = float(row["bookB"].get("poolFeesUsd", 0.0)) * float(params["vol30_mult"])
    fee15 = (
        float(row["bookB"].get("poolFeesUsd", 0.0))
        * (float(params["fee_rate"]["p15"]) / float(params["fee_rate"]["p30"]))
        * float(params["vol15_mult"])
    )
    fee05 = float(row["bookA"].get("poolFeesUsd", 0.0))
    horizon = max(1.0, float(params["horizon_hours"]))
    return {
        "market": {
            "fee_rev": {"p05": fee05, "p15": fee15, "p30": fee30},
            "capacity": dict(params["capacity"]),
            "il_rate": float(params["il_total"]) / horizon / float(params["initial_nav"]),
            # Reporting benchmark only: not subtracted from the move edge.
            "hurdle_rate": float(params["hurdle_total"]) / horizon / float(params["initial_nav"]),
        }
    }


def s_market(params, substep, sH, s, _input, **kwargs):
    return "market", _input["market"]


# ---------------------------------------------------------------------------
# PSUB 2: targets and movement cost
# ---------------------------------------------------------------------------

def p_targets(params, substep, sH, s, additional_objs=None, **kwargs):
    old = s["weights"]
    policy = params.get("policy", "fee_check")

    if policy == "static":
        targets = _norm(params["static_weights"])
    elif policy == "all_05":
        targets = {"p05": 1.0, "p15": 0.0, "p30": 0.0}
    elif policy == "all_15":
        targets = {"p05": 0.0, "p15": 1.0, "p30": 0.0}
    elif policy == "all_30":
        targets = {"p05": 0.0, "p15": 0.0, "p30": 1.0}
    elif policy == "fee_check" and int(s["step"]) % max(1, int(params["rebalance_hours"])) == 0:
        market = s["market"]
        nav = max(1.0, float(s["nav"]))
        rows = params["scenario"]
        idx = min(int(s["step"]), len(rows) - 1)
        window = max(1, int(params["eval_hours"]))
        start = max(0, idx - window + 1)
        n = max(1, idx + 1 - start)
        f05 = sum(float(r["bookA"].get("poolFeesUsd", 0.0)) for r in rows[start : idx + 1]) / n
        f30 = (
            sum(float(r["bookB"].get("poolFeesUsd", 0.0)) for r in rows[start : idx + 1])
            / n
            * float(params["vol30_mult"])
        )
        cap_a = float(market["capacity"]["p05"])
        cap_b = float(market["capacity"]["p30"])
        w = float(old["p30"])
        step_w = float(params["move_step"])
        share_cap = float(params["share_cap"]["p30"])
        w_cap_share = (
            share_cap * cap_b / (nav * (1.0 - share_cap)) if nav > 0 else 0.0
        )
        w_target = min(float(params["weight_cap"]["p30"]), max(0.0, w_cap_share))

        def edge(candidate: float) -> float:
            return fee_switch_edge(
                candidate,
                nav,
                f05,
                f30,
                cap_a,
                cap_b,
                float(params["eval_hours"]),
                float(params["switch_cost_bps"]),
                float(params["gas_cost"]),
                float(params["fee_buffer_usd"]),
            )

        gate = pool_b_risk(rows, idx, nav, params, w)
        targets = dict(old)
        if gate["risk"] == "HIGH":
            # Risk gate: de-risk one step and never add, even when the fee-only
            # edge is positive. p15 is left unchanged.
            targets["p30"] = max(0.0, w - step_w)
        elif edge(w_target) > 0.0:
            targets["p30"] = w_target
        elif edge(w) < 0.0 and w > 0.0:
            targets["p30"] = max(0.0, w - step_w)
        targets["p05"] = max(0.0, 1.0 - targets["p15"] - targets["p30"])
        targets = _norm(targets)
    else:
        targets = dict(old)

    return {"targets": targets}


def s_targets(params, substep, sH, s, _input, **kwargs):
    return "targets", _input["targets"]


def s_weights(params, substep, sH, s, _input, **kwargs):
    return "weights", _next_weights(s["weights"], _input["targets"], float(params["move_step"]))


def s_costs(params, substep, sH, s, _input, **kwargs):
    new = _next_weights(s["weights"], _input["targets"], float(params["move_step"]))
    moved = sum(abs(new[p] - s["weights"][p]) for p in POOLS) * float(s["nav"])
    if moved <= 1e-9:
        return "cum_costs", s["cum_costs"]
    cost = moved * float(params["switch_cost_bps"]) / 10_000.0 + float(params["gas_cost"])
    return "cum_costs", float(s["cum_costs"]) + cost


# ---------------------------------------------------------------------------
# PSUB 3: fees and common IL
# ---------------------------------------------------------------------------

def s_fees(params, substep, sH, s, _input, **kwargs):
    market = s["market"]
    nav = max(0.0, float(s["nav"]))
    fees = dict(s["fees"])
    for p in POOLS:
        capital = float(s["weights"][p]) * nav
        capacity = float(market["capacity"][p])
        share = capital / (capital + capacity) if capital + capacity > 0 else 0.0
        fees[p] = float(fees[p]) + float(market["fee_rev"][p]) * share
    return "fees", fees


def s_il(params, substep, sH, s, _input, **kwargs):
    return "cum_il", float(s["cum_il"]) + float(s["market"]["il_rate"]) * float(s["nav"])


# ---------------------------------------------------------------------------
# PSUB 4: NAV (fee equity)
# ---------------------------------------------------------------------------

def s_nav(params, substep, sH, s, _input, **kwargs):
    total_fees = sum(float(v) for v in s["fees"].values())
    return "nav", float(params["initial_nav"]) + total_fees - float(s["cum_costs"])


# ---------------------------------------------------------------------------
# PSUB 5: metrics and step
# ---------------------------------------------------------------------------

def p_metrics(params, substep, sH, s, additional_objs=None, **kwargs):
    market = s["market"]
    total_fees = sum(float(v) for v in s["fees"].values())
    return {
        "metrics": {
            "weights": dict(s["weights"]),
            "fees": dict(s["fees"]),
            "fees_total": total_fees,
            "cum_costs": float(s["cum_costs"]),
            "cum_il": float(s["cum_il"]),
            "nav": float(s["nav"]),
            "net_after_il": float(s["nav"]) - float(params["initial_nav"]) - float(s["cum_il"]),
            "fee_ratio_15": (
                float(market["fee_rev"]["p15"]) / float(market["fee_rev"]["p05"])
                if market["fee_rev"]["p05"] > 0
                else 0.0
            ),
            "fee_ratio_30": (
                float(market["fee_rev"]["p30"]) / float(market["fee_rev"]["p05"])
                if market["fee_rev"]["p05"] > 0
                else 0.0
            ),
            "weights_p15": float(s["weights"]["p15"]),
            "weights_p30": float(s["weights"]["p30"]),
        }
    }


def s_metrics_state(params, substep, sH, s, _input, **kwargs):
    return "metrics", _input["metrics"]


def s_step(params, substep, sH, s, _input, **kwargs):
    return "step", int(s["step"]) + 1


PSUBS = [
    {"policies": {"market": p_market}, "variables": {"market": s_market}},
    {
        "policies": {"targets": p_targets},
        "variables": {"targets": s_targets, "weights": s_weights, "cum_costs": s_costs},
    },
    {"policies": {}, "variables": {"fees": s_fees, "cum_il": s_il}},
    {"policies": {}, "variables": {"nav": s_nav}},
    {"policies": {"metrics": p_metrics}, "variables": {"metrics": s_metrics_state, "step": s_step}},
]


def run_model(
    scenario: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
    T: int | None = None,
) -> pd.DataFrame:
    p = default_params()
    if params:
        p.update(params)
    p["scenario"] = scenario
    if T is None:
        T = min(len(scenario), int(p["horizon_hours"]))
    p["horizon_hours"] = T

    initial_state = build_initial_state(p)
    exp = Experiment()
    exp.append_model(
        model_id="fee_allocator",
        sim_configs=config_sim(
            {"N": 1, "T": range(T), "M": {k: [v] for k, v in p.items()}}
        ),
        initial_state=initial_state,
        partial_state_update_blocks=PSUBS,
    )
    context = ExecutionContext(context=ExecutionMode.single_mode)
    executor = Executor(exec_context=context, configs=exp.configs, supress_print=True)
    records, _, _ = executor.execute()
    return pd.DataFrame(records)


def metrics_frame(df: pd.DataFrame) -> pd.DataFrame:
    last = df[df["substep"] == df["substep"].max()].copy()
    expanded = pd.json_normalize(last["metrics"]).add_prefix("m_")
    return pd.concat([last.reset_index(drop=True), expanded.reset_index(drop=True)], axis=1)
