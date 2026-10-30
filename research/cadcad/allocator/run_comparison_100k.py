"""Build the $100k comparison: 0.05 pool, 0.30 pool, our strategy, HODL NVDA/USDG.

    python run_comparison_100k.py
    # out/comparison_100k_paths.csv
    # out/comparison_100k_summary.json
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

PASSIVE = {
    **COMMON,
    **RISK,
    "initial_nav_usd": INITIAL,
    "book_capital_usd": INITIAL,
    "fee_share_mode": "exact",
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    _, rows45 = load_scenario(SCENARIO)
    _, rows20 = load_scenario(SCENARIO, hours=480)

    a45, pa45, _ = run_config("always_005", "45d", rows45, {**PASSIVE, "policy": "always_a"})
    b45, pb45, _ = run_config("always_030", "45d", rows45, {**PASSIVE, "policy": "always_b"})
    a20, _, _ = run_config("always_005", "20d", rows20, {**PASSIVE, "policy": "always_a"})
    b20, _, _ = run_config("always_030", "20d", rows20, {**PASSIVE, "policy": "always_b"})

    rec = pd.read_csv(OUT / "recommended_100k_path.csv")
    rec_summary = json.loads((OUT / "recommended_100k_summary.json").read_text(encoding="utf-8"))
    if len(rec) != len(pa45) or abs(float(rec["price"].iloc[-1]) - float(pa45["price"].iloc[-1])) > 1e-6:
        raise SystemExit("recommended path is stale or from another tape: re-run run_recommended_100k.py")
    price = rec["price"].tolist()
    start_price = float(price[0])
    hold_nvda = [INITIAL * p / start_price for p in price]
    hold_usdg = [INITIAL for _ in price]

    path = pd.DataFrame(
        {
            "step": rec["step"],
            "day": rec["day"],
            "price": price,
            "hold_nvda": hold_nvda,
            "hold_usdg": hold_usdg,
            "lp_005": pa45["nav"].tolist(),
            "lp_030": pb45["nav"].tolist(),
            "strategy": rec["nav"].tolist(),
            "state": rec["state"],
        }
    )
    path.to_csv(OUT / "comparison_100k_paths.csv", index=False)

    def max_dd(values: list[float]) -> float:
        peak = values[0]
        dd = 0.0
        for v in values:
            peak = max(peak, v)
            dd = min(dd, v / peak - 1.0)
        return dd

    summary = {
        "initial": INITIAL,
        "price_start": start_price,
        "price_end": float(price[-1]),
        "price_low": float(min(price)),
        "price_high": float(max(price)),
        "price_move_pct": (float(price[-1]) / start_price - 1.0) * 100.0,
        "paths": {
            "lp_005": {
                "label": "LP — 0.05 pool",
                "final": float(a45["final_nav"]),
                "fees": float(a45["cum_fees"]),
                "net_vs_hodl": float(a45["net_vs_hodl"]),
                "fee_apr": float(a45["book_fee_apr_pct"]),
                "net_apr": float(a45["simple_net_apr_pct"]),
                "nav_apr": (float(a45["final_nav"]) / INITIAL - 1.0) * 365 / 45 * 100,
                "max_dd": float(a45["max_drawdown"]),
                "net_20d": float(a20["net_vs_hodl"]),
                "net_apr_20d": float(a20["simple_net_apr_pct"]),
            },
            "lp_030": {
                "label": "LP — 0.30 pool",
                "final": float(b45["final_nav"]),
                "fees": float(b45["cum_fees"]),
                "net_vs_hodl": float(b45["net_vs_hodl"]),
                "fee_apr": float(b45["book_fee_apr_pct"]),
                "net_apr": float(b45["simple_net_apr_pct"]),
                "nav_apr": (float(b45["final_nav"]) / INITIAL - 1.0) * 365 / 45 * 100,
                "max_dd": float(b45["max_drawdown"]),
                "net_20d": float(b20["net_vs_hodl"]),
                "net_apr_20d": float(b20["simple_net_apr_pct"]),
            },
            "strategy": {
                "label": "Deploy to us",
                "final": float(rec["nav"].iloc[-1]),
                "fees": float(rec["cum_fees"].iloc[-1]),
                "max_dd": max_dd(rec["nav"].tolist()),
                "net_vs_hodl": float(rec_summary["net_vs_initial_pool"]),
                "fee_apr": float(rec_summary["fees"]) / INITIAL * 365 / 45 * 100,
                "net_apr": float(rec_summary["net_apr_pct"]),
                "nav_apr": (float(rec["nav"].iloc[-1]) / INITIAL - 1.0) * 365 / 45 * 100,
                "il_mark": float(rec_summary["lp_mark"]),
                "net_20d": float(rec_summary["net_20d"]),
                "net_apr_20d": float(rec_summary["net_20d_apr_pct"]),
                "arm_interest": float(rec_summary["arm_interest"]),
                "nvda_yield": float(rec_summary["nvda_yield"]),
                "borrow_cost": float(rec_summary["borrow_cost"]),
                "hours_pool1": int(rec_summary["hours_pool1"]),
                "hours_pool2": int(rec_summary["hours_pool2"]),
                "hours_morpho": int(rec_summary["hours_morpho"]),
                "transitions": rec_summary.get("transitions", []),
            },
            "hold_nvda": {
                "label": "Hold NVDA",
                "final": hold_nvda[-1],
                "fees": 0.0,
                "max_dd": max_dd(hold_nvda),
                "net_vs_hodl": None,
                "fee_apr": 0.0,
                "net_apr": 0.0,
                "nav_apr": (hold_nvda[-1] / INITIAL - 1.0) * 365 / 45 * 100,
            },
            "hold_usdg": {
                "label": "Hold USDG",
                "final": INITIAL,
                "fees": 0.0,
                "max_dd": 0.0,
                "net_vs_hodl": None,
                "fee_apr": 0.0,
                "net_apr": 0.0,
                "nav_apr": 0.0,
            },
        },
    }
    summary["paths"]["lp_005"]["il"] = (
        summary["paths"]["lp_005"]["net_vs_hodl"] - summary["paths"]["lp_005"]["fees"]
    )
    summary["paths"]["lp_030"]["il"] = (
        summary["paths"]["lp_030"]["net_vs_hodl"] - summary["paths"]["lp_030"]["fees"]
    )
    summary["hodl_basket_change_pct"] = (float(a45["final_hodl"]) / INITIAL - 1.0) * 100.0

    with open(OUT / "comparison_100k_summary.json", "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
