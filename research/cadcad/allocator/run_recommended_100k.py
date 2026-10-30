"""Run the recommended $100k configuration and export the timeline.

    python run_recommended_100k.py
    # out/recommended_100k_path.csv
    # out/recommended_100k_summary.json
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from run import COMMON, RISK, run_config
from scenario import load_scenario

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
SCENARIO = HERE / "data" / "scenario_45d.json"
INITIAL = 100_000.0

PARAMS = {
    **COMMON,
    **RISK,
    "initial_nav_usd": INITIAL,
    "book_capital_usd": INITIAL,
    "arm_abs_cap_usd": 100_000.0,
    "usdg_lend_abs_cap_usd": 100_000.0,
    "borrow_liquidity_usd": 15_000.0,
    "max_borrow_per_call_usd": 10_000.0,
    "fee_share_mode": "exact",
    "allocator_interval_hours": 2,
    "risk_min_volume_usd": 15_000,
    "guard_share": 0.75,
    "base_width_ticks": 3_000,
    "guard_width_ticks": 500,
    "base_skew_mode": "inventory",
    "base_skew_max_ticks": 1_000,
    "risk_use_rolling": True,
    "risk_window_minutes": 36,
    "switch_cost_bps": 5,
    "opportunity_window_hours": 2,
    "opportunity_check_hours": 2,
    "opportunity_buffer_bps": 1_000,
    "book_b_min_volume_window_usd": 50_000,
    "book_b_max_share": 0.05,
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    _, rows45 = load_scenario(SCENARIO)
    _, rows20 = load_scenario(SCENARIO, hours=480)
    s45, p45, _ = run_config("recommended_100k", "45d", rows45, PARAMS)
    s20, _, _ = run_config("recommended_100k", "20d", rows20, PARAMS)

    path = p45.copy()
    path["day"] = path["step"] / 24.0
    path["state"] = path.apply(
        lambda r: "Morpho" if r["mode"] == "ARMS" else ("0.30 pool" if r["active_book"] == 1 else "0.05 pool"),
        axis=1,
    )
    path["pnl"] = path["nav"] - INITIAL
    path["hodl_pnl"] = path["hodl_nav"] - INITIAL
    path.to_csv(OUT / "recommended_100k_path.csv", index=False)

    changes = path[path["state"].ne(path["state"].shift())][
        ["step", "day", "state"]
    ]
    summary = {
        "initial_nav": INITIAL,
        "final_nav": float(s45["final_nav"]),
        "final_hodl": float(s45["final_hodl"]),
        "net_vs_initial_pool": float(s45["net_vs_hodl"]),
        "net_apr_pct": float(s45["simple_net_apr_pct"]),
        "fees": float(s45["cum_fees"]),
        "guard_fees": float(s45["cum_guard_fees"]),
        "arm_interest": float(s45["cum_arm_interest"]),
        "nvda_yield": float(s45["cum_nvda_yield"]),
        "borrow_cost": float(s45["cum_borrow_cost"]),
        "gas": float(s45["cum_gas"]),
        "net_carry": float(s45["cum_net_carry"]),
        "lp_mark": float(s45["cum_il_vs_hodl"]),
        "max_dd": float(s45["max_drawdown"]),
        "actions": int(s45["actions"]),
        "hours_pool1": int(((path["state"] == "0.05 pool")).sum()),
        "hours_pool2": int(((path["state"] == "0.30 pool")).sum()),
        "hours_morpho": int(((path["state"] == "Morpho")).sum()),
        "net_20d": float(s20["net_vs_hodl"]),
        "net_20d_apr_pct": float(s20["simple_net_apr_pct"]),
        "fees_20d": float(s20["cum_fees"]),
        "max_dd_20d": float(s20["max_drawdown"]),
        "transitions": json.loads(changes.to_json(orient="records")),
        "start_price": float(path["price"].iloc[0]),
        "end_price": float(path["price"].iloc[-1]),
        "low_price": float(path["price"].min()),
        "high_price": float(path["price"].max()),
    }
    with open(OUT / "recommended_100k_summary.json", "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
