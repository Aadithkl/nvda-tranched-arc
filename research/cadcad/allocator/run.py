"""Reproducible experiments for the allocator cadCAD model.

    python run.py validate
    python run.py baseline
    python run.py sweep
    python run.py mc --mc-paths 30
    python run.py all

The default scenario is data/scenario_45d.json (built from the local swap
tapes by scripts/research/build_allocator_scenario.mjs).
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from model import PSUBS, default_params, metrics_frame, run_model
from scenario import block_bootstrap, load_scenario

HERE = Path(__file__).resolve().parent
SCENARIO = HERE / "data" / "scenario_45d.json"
OUT = HERE / "out"
REPO = HERE.parents[2]
YEAR_HOURS = 365 * 24

COMMON = {
    # The keeper has no warmup; the first allocator run uses whatever stats are
    # available. Keep the baseline keeper-matching.
    "warmup_hours": 0,
    "gas_cost_usd": 0.02,
    "guard_pull_threshold_bps": 200,
    # The user's 3% Spiral NVDA yield is APR after borrowing cost. Gross it up
    # by LTV*borrow_apr, then subtract borrow cost in the model.
    "nvda_apr_is_net": True,
}

RISK = {
    "policy": "risk_only",
    "fix_empty_book_guard": True,
    "fix_hypothetical_range": True,
}

LIVE = {
    "arm_usdg_apr": 0.010247982684562278,
    "arm_nvda_apr": 0.0,
    "arm_borrow_apr": 0.013510325755470577,
    "borrow_liquidity_usd": 337.20159974499626,
}

STRESS = {
    "arm_usdg_apr": 1.0373,
    "arm_nvda_apr": 0.0,
    "arm_borrow_apr": 1.0729,
    "borrow_liquidity_usd": 15_110.79,
}


def _params(overrides: dict[str, Any]) -> dict[str, Any]:
    p = default_params()
    p.update(COMMON)
    p.update(overrides)
    return p


def _events(df: pd.DataFrame) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    last = df[df["substep"] == len(PSUBS)]
    for _, row in last.iterrows():
        out.extend(row["last_events"] or [])
    return out


def run_config(
    label: str,
    window: str,
    rows: list[dict[str, Any]],
    params: dict[str, Any],
) -> tuple[dict[str, Any], pd.DataFrame, list[dict[str, Any]]]:
    p = _params(params)
    df = run_model(rows, p, T=len(rows))
    mf = metrics_frame(df)
    last = mf.iloc[-1]
    initial = float(p["initial_nav_usd"])
    steps = len(rows)
    net = float(last["nav"] - last["hodl_nav"])
    net_carry = float(last["cum_net_carry"])
    il_vs_hodl = float(last["cum_il_vs_hodl"])
    gross_rewards = (
        float(last["cum_fees"])
        + float(last["cum_arm_interest"])
        + float(last["cum_nvda_yield"])
    )
    cash_costs = (
        float(last["cum_borrow_cost"])
        + float(last["cum_gas"])
        + float(last["cum_switch_cost"])
        + float(last["cum_swap_cost"])
    )
    funded = int(((mf["book_a_value"] + mf["book_b_value"]) > 1.0).sum())
    events = _events(df)
    counts: dict[str, int] = {}
    for e in events:
        counts[e.get("type", "?")] = counts.get(e.get("type", "?"), 0) + 1
    surplus_sweeps = sum(
        1 for e in events if str(e.get("reason", "")).startswith("surplus:")
    )

    summary = {
        "run": label,
        "window": window,
        "policy": p["policy"],
        "start_book": int(p.get("start_book", 0)),
        "steps": steps,
        "initial_nav": initial,
        "final_nav": float(last["nav"]),
        "final_hodl": float(last["hodl_nav"]),
        "net_vs_hodl": net,
        "simple_net_apr_pct": net / initial * YEAR_HOURS / steps * 100.0,
        "simple_nav_apr_pct": (float(last["nav"]) / initial - 1.0) * YEAR_HOURS / steps * 100.0,
        "book_fee_apr_pct": float(last["cum_fees"]) / initial * YEAR_HOURS / steps * 100.0,
        "arm_apr_pct": (
            float(last["cum_arm_interest"]) + float(last["cum_nvda_yield"])
        )
        / initial
        * YEAR_HOURS
        / steps
        * 100.0,
        "max_drawdown": float(mf["drawdown"].min()),
        "hours_arms": int((mf["mode"] == "ARMS").sum()),
        "hours_books": int((mf["mode"] == "BOOKS").sum()),
        "funded_hours": funded,
        "funded_pct": funded / steps,
        "actions": int(last["cum_actions"]),
        "switches": counts.get("SWITCH_BOOK", 0),
        "fundings": counts.get("FUND_BOOK", 0),
        "recalls": counts.get("RECALL_BOOK", 0),
        "guard_pulls": float(last["cum_guard_pulls"]),
        "cum_fees": float(last["cum_fees"]),
        "cum_guard_fees": float(last["cum_guard_fees"]),
        "book_a_fees": float(last["book_a_fees"]),
        "book_b_fees": float(last["book_b_fees"]),
        "cum_arm_interest": float(last["cum_arm_interest"]),
        "cum_borrow_cost": float(last["cum_borrow_cost"]),
        "cum_nvda_yield": float(last["cum_nvda_yield"]),
        "cum_gas": float(last["cum_gas"]),
        "cum_swap_cost": float(last["cum_swap_cost"]),
        "cum_net_carry": net_carry,
        "cum_il_vs_hodl": il_vs_hodl,
        "gross_rewards": gross_rewards,
        "cash_costs": cash_costs,
        "net_carry_apr_pct": net_carry / initial * YEAR_HOURS / steps * 100.0,
        "il_vs_hodl_apr_pct": il_vs_hodl / initial * YEAR_HOURS / steps * 100.0,
        "rewards_apr_pct": gross_rewards / initial * YEAR_HOURS / steps * 100.0,
        "costs_apr_pct": cash_costs / initial * YEAR_HOURS / steps * 100.0,
        "cum_liquidation_loss": float(last["cum_liquidation_loss"]),
        "end_idle_usdg": float(last["idle_usdg"]),
        "end_idle_nvda": float(last["idle_nvda"]),
        "end_idle_value": float(last["idle_value"]),
        "avg_idle_value": float(mf["idle_value"].mean()),
        "max_idle_value": float(mf["idle_value"].max()),
        "end_arm_equity": float(last["arm_equity"]),
        "end_book_value": float(last["book_a_value"] + last["book_b_value"]),
        "end_mode": str(last["mode"]),
        "end_active_book": int(last["active_book"]),
        "max_arm_ltv": float(mf["arm_ltv"].max()),
        "avg_arm_ltv": float(mf.loc[mf["arm_debt"] > 1.0, "arm_ltv"].mean())
        if (mf["arm_debt"] > 1.0).any()
        else 0.0,
        "arm_usdg_apr": float(p["arm_usdg_apr"]),
        "arm_nvda_apr": float(p["arm_nvda_apr"]),
        "arm_borrow_apr": float(p["arm_borrow_apr"]),
        "nvda_apr_is_net": bool(p.get("nvda_apr_is_net", False)),
        "surplus_sweep": bool(p.get("surplus_sweep", False)),
        "surplus_sweeps": surplus_sweeps,
        "fee_share_mode": str(p.get("fee_share_mode", "expansion")),
        "arm_rel_cap_bps": float(p["arm_rel_cap_bps"]),
        "usdg_lend_rel_cap_bps": float(p["usdg_lend_rel_cap_bps"]),
        "guard_pull_threshold_bps": float(p["guard_pull_threshold_bps"]),
        "risk_min_volume_usd": float(p["risk_min_volume_usd"]),
        "risk_window_minutes": int(p.get("risk_window_minutes", 36)),
        "risk_use_rolling": bool(p.get("risk_use_rolling", False)),
        "opportunity_window_hours": int(p.get("opportunity_window_hours", 0)),
        "opportunity_check_hours": int(p.get("opportunity_check_hours", 1)),
        "book_b_min_volume_window_usd": float(
            p.get("book_b_min_volume_window_usd", 0.0)
        ),
        "book_b_max_share": float(p.get("book_b_max_share", 1.0)),
        "book_step_bps": float(p["book_step_bps"]),
    }

    path = mf[
        [
            "step",
            "price",
            "nav",
            "hodl_nav",
            "drawdown",
            "mode",
            "active_book",
            "book_a_value",
            "book_b_value",
            "idle_usdg",
            "idle_nvda",
            "arm_equity",
            "arm_ltv",
            "cum_fees",
            "cum_arm_interest",
            "cum_borrow_cost",
            "cum_gas",
            "cum_swap_cost",
            "cum_net_carry",
            "cum_il_vs_hodl",
            "idle_value",
            "base_skew_a",
            "base_skew_b",
        ]
    ].copy()
    path["run"] = label
    path["window"] = window
    path["ts"] = [rows[int(s)]["ts"] for s in path["step"]]
    return summary, path, events


def _write_summary(rows: list[dict[str, Any]], name: str) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / f"{name}.csv", index=False)
    return df


def _write_paths(paths: list[pd.DataFrame], name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    pd.concat(paths, ignore_index=True).to_csv(OUT / f"{name}.csv", index=False)


def cmd_validate(scenario_path: Path) -> None:
    meta, rows = load_scenario(scenario_path)
    refs = {
        "v3-usdg-nvda-005-fee500-45d": ("always_a", "bookA", 245.18959268831065),
        "v4-usdg-nvda-030-fee3000-45d": ("always_b", "bookB", 276.26020450403627),
    }
    out = []
    for key, (policy, book, fee_ref) in refs.items():
        p = _params(
            {
                "policy": policy,
                "guard_pull_threshold_bps": 1e9,
                "gas_cost_usd": 0.0,
                "warmup_hours": 0,
            }
        )
        df = run_model(rows, p, T=len(rows))
        mf = metrics_frame(df)
        last = mf.iloc[-1]
        net_model = float(last["nav"] - last["hodl_nav"])
        ref_path = REPO / "research" / "out" / f"{key}.json"
        net_ref = None
        if ref_path.exists():
            with open(ref_path, "r", encoding="utf-8") as fh:
                net_ref = json.load(fh).get("netVsHodlUsd")
        out.append(
            {
                "book": book,
                "policy": policy,
                "fee_model": float(last["cum_fees"]),
                "fee_research": fee_ref,
                "fee_diff_pct": (float(last["cum_fees"]) / fee_ref - 1.0) * 100.0,
                "net_model": net_model,
                "net_research": net_ref,
                "net_diff_usd": (net_model - net_ref) if net_ref is not None else None,
                "final_nav": float(last["nav"]),
                "final_hodl": float(last["hodl_nav"]),
            }
        )
        print(
            f"validate {book}: fees {last['cum_fees']:.3f} vs {fee_ref:.3f} "
            f"({(last['cum_fees']/fee_ref-1)*100:+.3f}%), net {net_model:+.2f}"
        )
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "validation.json", "w", encoding="utf-8") as fh:
        json.dump({"meta": meta, "results": out}, fh, indent=2)
    _write_summary(out, "validation")


def _baseline_configs() -> list[tuple[str, dict[str, Any]]]:
    return [
        ("hodl", {"policy": "hodl"}),
        ("always_a", {"policy": "always_a"}),
        ("always_b", {"policy": "always_b"}),
        ("always_arms", {"policy": "always_arms"}),
        ("allocator_as_built", {"policy": "allocator"}),
        (
            "allocator_as_built_strict_ltv",
            {"policy": "allocator", "min_health_factor": 2.083333},
        ),
        (
            "allocator_fixed_apr_gate",
            {"policy": "allocator", "fix_empty_book_guard": True, "fix_hypothetical_range": True},
        ),
        ("risk_only_a", {**RISK}),
        ("risk_only_b", {**RISK, "start_book": 1}),
        ("risk_only_a_live", {**RISK, **LIVE}),
        ("risk_only_a_stress", {**RISK, **STRESS}),
        (
            "risk_only_a_caps50",
            {
                **RISK,
                "arm_rel_cap_bps": 5_000,
                "usdg_lend_rel_cap_bps": 5_000,
                "arm_abs_cap_usd": 100_000,
                "usdg_lend_abs_cap_usd": 100_000,
            },
        ),
        (
            "risk_only_a_caps100",
            {
                **RISK,
                "arm_rel_cap_bps": 10_000,
                "usdg_lend_rel_cap_bps": 10_000,
                "arm_abs_cap_usd": 100_000,
                "usdg_lend_abs_cap_usd": 100_000,
            },
        ),
        ("risk_only_a_guard50", {**RISK, "guard_pull_threshold_bps": 50}),
        ("risk_only_a_guard100", {**RISK, "guard_pull_threshold_bps": 100}),
        ("risk_only_a_strict_ltv", {**RISK, "min_health_factor": 2.083333}),
        ("risk_only_a_vol5k", {**RISK, "risk_min_volume_usd": 5_000}),
        ("risk_only_a_vol15k", {**RISK, "risk_min_volume_usd": 15_000}),
        ("risk_only_a_step5000", {**RISK, "book_step_bps": 5_000}),
        ("risk_only_a_step10000", {**RISK, "book_step_bps": 10_000}),
        ("risk_only_b_minvol1k", {**RISK, "start_book": 1, "risk_min_volume_usd": 1_000}),
        # Allocator cadence: the keeper runs hourly; test 2/4/8h on the same tape.
        ("risk_only_a_interval2", {**RISK, "allocator_interval_hours": 2}),
        ("risk_only_a_interval4", {**RISK, "allocator_interval_hours": 4}),
        ("risk_only_a_interval8", {**RISK, "allocator_interval_hours": 8}),
        # Spiral/NVDA arm at 30% and 35% absolute LTV, 3% NVDA + 3% USDG + 3% borrow.
        ("risk_only_a_ltv30", {**RISK, "ltv_bps": 3_000, "hard_cap_bps": 3_000}),
        ("risk_only_a_ltv35", {**RISK, "ltv_bps": 3_500, "hard_cap_bps": 3_500}),
        ("always_arms_ltv30", {"policy": "always_arms", "ltv_bps": 3_000, "hard_cap_bps": 3_000}),
        ("always_arms_ltv35", {"policy": "always_arms", "ltv_bps": 3_500, "hard_cap_bps": 3_500}),
        # Guard share: 0 = all base, 0.5 = production 50/50, 0.75 = guard-heavy.
        ("risk_only_a_guard0", {**RISK, "guard_share": 0.0}),
        ("risk_only_a_guard25", {**RISK, "guard_share": 0.25}),
        ("risk_only_a_guard75", {**RISK, "guard_share": 0.75}),
        ("always_a_guard0", {"policy": "always_a", "guard_share": 0.0}),
        # Best combined cadence/quality/guard mix on the 45d+20d tape.
        (
            "risk_only_a_2h15k",
            {**RISK, "allocator_interval_hours": 2, "risk_min_volume_usd": 15_000},
        ),
        (
            "risk_only_a_2h15k_guard75",
            {
                **RISK,
                "allocator_interval_hours": 2,
                "risk_min_volume_usd": 15_000,
                "guard_share": 0.75,
            },
        ),
        # No-swap inventory sweep: leave a reserve, push excess NVDA to the arm.
        ("risk_only_a_sweep", {**RISK, "surplus_sweep": True}),
        (
            "risk_only_a_2h15k75_sweep",
            {
                **RISK,
                "allocator_interval_hours": 2,
                "risk_min_volume_usd": 15_000,
                "guard_share": 0.75,
                "surplus_sweep": True,
            },
        ),
        (
            "risk_only_a_2h15k75_sweep_caps50",
            {
                **RISK,
                "allocator_interval_hours": 2,
                "risk_min_volume_usd": 15_000,
                "guard_share": 0.75,
                "surplus_sweep": True,
                "arm_rel_cap_bps": 5_000,
                "usdg_lend_rel_cap_bps": 5_000,
                "arm_abs_cap_usd": 100_000,
                "usdg_lend_abs_cap_usd": 100_000,
            },
        ),
    ]


def cmd_baseline(scenario_path: Path) -> None:
    meta, rows45 = load_scenario(scenario_path)
    _, rows20 = load_scenario(scenario_path, hours=480)
    summaries: list[dict[str, Any]] = []
    paths: list[pd.DataFrame] = []
    for window, rows in (("45d", rows45), ("20d", rows20)):
        for label, cfg in _baseline_configs():
            summary, path, _ = run_config(label, window, rows, cfg)
            summaries.append(summary)
            paths.append(path)
            print(
                f"{label:28s} {window} net {summary['net_vs_hodl']:+8.2f} "
                f"nav {summary['final_nav']:8.2f} dd {summary['max_drawdown']:6.3f} "
                f"arms {summary['hours_arms']:4d} actions {summary['actions']:4d}"
            )
    _write_summary(summaries, "baseline_summary")
    _write_paths(paths, "baseline_paths")
    with open(OUT / "baseline.json", "w", encoding="utf-8") as fh:
        json.dump({"meta": meta, "results": summaries}, fh, indent=2)


def _sweep_configs() -> list[tuple[str, str, Any, dict[str, Any]]]:
    base = {**RISK}
    out: list[tuple[str, str, Any, dict[str, Any]]] = []
    for v in (0.0, 0.01, 0.03, 0.05):
        out.append((f"arm_usdg_apr_{v:.4f}", "arm_usdg_apr", v, {**base, "arm_usdg_apr": v}))
    for v in (0.0, 0.03, 0.05):
        out.append((f"arm_nvda_apr_{v:.2f}", "arm_nvda_apr", v, {**base, "arm_nvda_apr": v}))
    for v in (0.0135, 0.03, 0.10, 1.0729):
        out.append((f"arm_borrow_apr_{v:.4f}", "arm_borrow_apr", v, {**base, "arm_borrow_apr": v}))
    for v in (2_000, 5_000, 10_000):
        out.append(
            (
                f"arm_rel_cap_{v}",
                "arm_rel_cap_bps",
                v,
                {
                    **base,
                    "arm_rel_cap_bps": v,
                    "usdg_lend_rel_cap_bps": v,
                    "arm_abs_cap_usd": 100_000,
                    "usdg_lend_abs_cap_usd": 100_000,
                },
            )
        )
    for v in (200, 300, 400):
        out.append((f"risk_vol_{v}", "risk_max_volatility_bps", v, {**base, "risk_max_volatility_bps": v}))
    for v in (2_500, 5_000, 10_000, 15_000):
        out.append((f"risk_min_volume_{v}", "risk_min_volume_usd", v, {**base, "risk_min_volume_usd": v}))
    for v in (50, 100, 200, 300):
        out.append(
            (f"guard_{v}", "guard_pull_threshold_bps", v, {**base, "guard_pull_threshold_bps": v})
        )
    for v in (2_500, 5_000, 10_000):
        out.append((f"book_step_{v}", "book_step_bps", v, {**base, "book_step_bps": v}))
    for v in (1, 2, 4, 8):
        out.append(
            (
                f"allocator_interval_{v}",
                "allocator_interval_hours",
                v,
                {**base, "allocator_interval_hours": v},
            )
        )
    for v in (0.0, 0.25, 0.5, 0.75):
        out.append(
            (f"guard_share_{v:.2f}", "guard_share", v, {**base, "guard_share": v})
        )
    for v in (2_937, 3_000, 3_500):
        out.append(
            (
                f"ltv_{v}",
                "ltv_bps",
                v,
                {**base, "ltv_bps": v, "hard_cap_bps": v},
            )
        )
    for v in (1.5, 2.0, 2.083333):
        out.append((f"min_hf_{v:.3f}", "min_health_factor", v, {**base, "min_health_factor": v}))
    for v in (0.0, 0.02, 0.10, 0.50):
        out.append((f"gas_{v:.2f}", "gas_cost_usd", v, {**base, "gas_cost_usd": v}))
    for v in (1_000, 10_000, 100_000):
        out.append(
            (
                f"capital_{v}",
                "initial_nav_usd",
                v,
                {
                    **base,
                    "initial_nav_usd": float(v),
                    "book_capital_usd": float(v),
                    "arm_abs_cap_usd": max(10_000.0, float(v)),
                    "usdg_lend_abs_cap_usd": max(10_000.0, float(v)),
                },
            )
        )
    return out


def cmd_sweep(scenario_path: Path) -> None:
    _, rows = load_scenario(scenario_path)
    summaries: list[dict[str, Any]] = []
    for label, param, value, cfg in _sweep_configs():
        summary, _, _ = run_config(label, "45d", rows, cfg)
        summary["sweep_param"] = param
        summary["sweep_value"] = value
        summaries.append(summary)
        print(
            f"{label:28s} net {summary['net_vs_hodl']:+8.2f} "
            f"nav {summary['final_nav']:8.2f} dd {summary['max_drawdown']:6.3f} "
            f"arms {summary['hours_arms']:4d} actions {summary['actions']:4d}"
        )
    _write_summary(summaries, "sweep_summary")


def _percentiles(x: np.ndarray) -> dict[str, float]:
    return {
        "median": float(np.median(x)),
        "p05": float(np.percentile(x, 5)),
        "p95": float(np.percentile(x, 95)),
        "mean": float(np.mean(x)),
    }


def cmd_mc(
    scenario_path: Path,
    n_paths: int,
    block_hours: int,
    seed: int,
    risk_min_volume: float = 10_000.0,
) -> None:
    _, rows = load_scenario(scenario_path)
    paths = block_bootstrap(rows, n_paths=n_paths, block_hours=block_hours, seed=seed)
    risk_cfg = {**RISK, "risk_min_volume_usd": float(risk_min_volume)}
    risk_rows: list[dict[str, Any]] = []
    always_rows: list[dict[str, Any]] = []
    diffs: list[float] = []
    navs_risk: list[float] = []
    navs_always: list[float] = []
    dds_risk: list[float] = []
    dds_always: list[float] = []

    for i, path in enumerate(paths):
        s_risk, _, _ = run_config(f"risk_only_{i}", "mc", path, risk_cfg)
        s_always, _, _ = run_config(f"always_a_{i}", "mc", path, {"policy": "always_a"})
        risk_rows.append(s_risk)
        always_rows.append(s_always)
        diffs.append(s_risk["net_vs_hodl"] - s_always["net_vs_hodl"])
        navs_risk.append(s_risk["final_nav"])
        navs_always.append(s_always["final_nav"])
        dds_risk.append(s_risk["max_drawdown"])
        dds_always.append(s_always["max_drawdown"])

    diffs_arr = np.array(diffs)
    summary = {
        "paths": n_paths,
        "block_hours": block_hours,
        "seed": seed,
        "risk_min_volume_usd": float(risk_min_volume),
        "risk_only_net_vs_hodl": _percentiles(np.array([r["net_vs_hodl"] for r in risk_rows])),
        "always_a_net_vs_hodl": _percentiles(np.array([r["net_vs_hodl"] for r in always_rows])),
        "risk_only_nav": _percentiles(np.array(navs_risk)),
        "always_a_nav": _percentiles(np.array(navs_always)),
        "risk_only_max_dd": _percentiles(np.array(dds_risk)),
        "always_a_max_dd": _percentiles(np.array(dds_always)),
        "paired_diff_risk_minus_always": _percentiles(diffs_arr),
        "paired_win_rate": float((diffs_arr > 0).mean()),
        "risk_only_simple_net_apr_pct": _percentiles(
            np.array([r["simple_net_apr_pct"] for r in risk_rows])
        ),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "mc_summary.json", "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
    _write_summary(risk_rows + always_rows, "mc_summary")
    print(json.dumps(summary, indent=2))


def _optimize_configs() -> list[tuple[str, dict[str, Any]]]:
    base = {**RISK}
    A = {
        **base,
        "allocator_interval_hours": 2,
        "risk_min_volume_usd": 15_000,
        "guard_share": 0.75,
    }
    B = {
        **A,
        "base_width_ticks": 3_000,
        "base_skew_mode": "inventory",
        "base_skew_max_ticks": 2_500,
    }
    C = {**B, "guard_width_ticks": 500}
    D = {**C, "guard_share": 0.8}
    return [
        ("optimize_baseline", {**base}),
        ("optimize_swap10", {**base, "funding_mode": "swap", "swap_cost_bps": 10}),
        ("optimize_swap30", {**base, "funding_mode": "swap", "swap_cost_bps": 30}),
        (
            "optimize_skew2000",
            {**base, "base_skew_mode": "inventory", "base_skew_max_ticks": 2_000},
        ),
        ("optimize_recenter500", {**base, "recenter_threshold_bps": 500}),
        ("optimize_recenter1000", {**base, "recenter_threshold_bps": 1_000}),
        (
            "optimize_feeil_gate",
            {
                **base,
                "policy": "risk_fee_il",
                "fee_il_hurdle": 1.0,
                "fee_il_buffer_bps": 250,
                "fee_il_confirm_hours": 8,
                "fee_il_window_hours": 24,
            },
        ),
        (
            "optimize_guard_feeil",
            {
                **base,
                "guard_rule": "fee_il",
                "guard_fee_il_hurdle": 1.5,
                "fee_il_window_hours": 12,
            },
        ),
        ("optimize_base3000", {**base, "base_width_ticks": 3_000}),
        ("optimize_base4000", {**base, "base_width_ticks": 4_000}),
        ("optimize_guard500", {**base, "guard_width_ticks": 500}),
        ("optimize_guard900", {**base, "guard_width_ticks": 900}),
        ("optimize_guard80", {**base, "guard_share": 0.8}),
        ("optimize_fund10000", {**base, "fund_book_bps": 10_000}),
        ("optimize_A_2h15k75", A),
        ("optimize_B_skew2500", B),
        ("optimize_C_guard500", C),
        ("optimize_D_guard80", D),
        (
            "optimize_conservative",
            {
                **A,
                "base_width_ticks": 2_500,
                "base_skew_mode": "inventory",
                "base_skew_max_ticks": 2_500,
            },
        ),
        ("optimize_A_base3000", {**A, "base_width_ticks": 3_000}),
        (
            "optimize_A_skew2500",
            {**A, "base_skew_mode": "inventory", "base_skew_max_ticks": 2_500},
        ),
        ("optimize_A_sweep", {**A, "surplus_sweep": True}),
        (
            "optimize_C_skew1000",
            {
                **A,
                "base_width_ticks": 3_000,
                "base_skew_mode": "inventory",
                "base_skew_max_ticks": 1_000,
                "guard_width_ticks": 500,
            },
        ),
        ("optimize_C_sweep_noskew", {**C, "base_skew_mode": "none", "base_skew_max_ticks": 0, "surplus_sweep": True}),
        ("optimize_C_sweep", {**C, "surplus_sweep": True}),
        (
            "optimize_C_sweep_caps50",
            {
                **C,
                "surplus_sweep": True,
                "arm_rel_cap_bps": 5_000,
                "usdg_lend_rel_cap_bps": 5_000,
                "arm_abs_cap_usd": 100_000,
                "usdg_lend_abs_cap_usd": 100_000,
            },
        ),
    ]


def cmd_optimize(scenario_path: Path) -> None:
    meta, rows45 = load_scenario(scenario_path)
    _, rows20 = load_scenario(scenario_path, hours=480)
    summaries: list[dict[str, Any]] = []
    paths: list[pd.DataFrame] = []
    for window, rows in (("45d", rows45), ("20d", rows20)):
        for label, cfg in _optimize_configs():
            summary, path, _ = run_config(label, window, rows, cfg)
            summaries.append(summary)
            paths.append(path)
            print(
                f"{label:30s} {window} net {summary['net_vs_hodl']:+8.2f} "
                f"carry {summary['cum_net_carry']:+8.2f} "
                f"fees {summary['cum_fees']:8.2f} dd {summary['max_drawdown']:6.3f} "
                f"idle {summary['end_idle_value']:8.1f} actions {summary['actions']:4d}"
            )
    _write_summary(summaries, "optimize_summary")
    _write_paths(paths, "optimize_paths")
    with open(OUT / "optimize.json", "w", encoding="utf-8") as fh:
        json.dump({"meta": meta, "results": summaries}, fh, indent=2)


def cmd_mc_optimize(
    scenario_path: Path,
    n_paths: int = 20,
    block_hours: int = 24,
    seed: int = 42,
) -> None:
    _, rows = load_scenario(scenario_path)
    paths = block_bootstrap(rows, n_paths=n_paths, block_hours=block_hours, seed=seed)
    A = {
        **RISK,
        "allocator_interval_hours": 2,
        "risk_min_volume_usd": 15_000,
        "guard_share": 0.75,
    }
    C = {
        **A,
        "base_width_ticks": 3_000,
        "base_skew_mode": "inventory",
        "base_skew_max_ticks": 2_500,
        "guard_width_ticks": 500,
    }
    D = {**C, "guard_share": 0.8}
    configs = {
        "risk_only_1h10k50": {**RISK},
        "A_2h15k75": A,
        "C_3k_skew2500_guard500": C,
        "D_3k_skew2500_guard500_80": D,
    }
    out: dict[str, Any] = {
        "paths": n_paths,
        "block_hours": block_hours,
        "seed": seed,
        "configs": {},
        "always_a": {},
    }
    per_path: dict[str, dict[str, list[float]]] = {
        k: {"45d": [], "20d": []} for k in list(configs) + ["always_a"]
    }
    per_path_dd: dict[str, dict[str, list[float]]] = {
        k: {"45d": [], "20d": []} for k in list(configs) + ["always_a"]
    }
    for i, path in enumerate(paths):
        for window, sub in (("45d", path), ("20d", path[-480:])):
            for label, cfg in configs.items():
                summary, _, _ = run_config(label, window, sub, cfg)
                per_path[label][window].append(float(summary["net_vs_hodl"]))
                per_path_dd[label][window].append(float(summary["max_drawdown"]))
            s_always, _, _ = run_config("always_a", window, sub, {"policy": "always_a"})
            per_path["always_a"][window].append(float(s_always["net_vs_hodl"]))
            per_path_dd["always_a"][window].append(float(s_always["max_drawdown"]))
        print(f"mc-optimize path {i + 1}/{n_paths}")

    for window in ("45d", "20d"):
        always = np.array(per_path["always_a"][window])
        out["always_a"][window] = {
            "net_vs_hodl": _percentiles(always),
            "max_dd": _percentiles(np.array(per_path_dd["always_a"][window])),
        }
        for label in configs:
            x = np.array(per_path[label][window])
            diffs = x - always
            out["configs"].setdefault(label, {})[window] = {
                "net_vs_hodl": _percentiles(x),
                "max_dd": _percentiles(np.array(per_path_dd[label][window])),
                "paired_diff_vs_always": _percentiles(diffs),
                "paired_win_rate": float((diffs > 0).mean()),
            }
    with open(OUT / "optimize_mc.json", "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    print(json.dumps(out, indent=2))


def cmd_large(scenario_path: Path) -> None:
    """Large-NAV scaling check with exact fee shares.

    At $1M/$2M the book can become a material share of the pool, so the
    second-order fee-share expansion is no longer safe. This command uses the
    exact share and scales the absolute arm caps with NAV, while keeping the
    live borrow liquidity ($15k) and the keeper's $10k max borrow per call.
    """
    _, rows45 = load_scenario(scenario_path)
    _, rows20 = load_scenario(scenario_path, hours=480)
    A = {
        **RISK,
        "allocator_interval_hours": 2,
        "risk_min_volume_usd": 15_000,
        "guard_share": 0.75,
    }
    C = {
        **A,
        "base_width_ticks": 3_000,
        "base_skew_mode": "inventory",
        "base_skew_max_ticks": 2_500,
        "guard_width_ticks": 500,
    }
    configs = [
        ("large_always_a", {"policy": "always_a"}),
        ("large_always_b", {"policy": "always_b"}),
        ("large_risk_only", {**RISK}),
        ("large_A_2h15k75", A),
        ("large_C_3k_skew", C),
    ]
    summaries: list[dict[str, Any]] = []
    for cap in (100_000, 250_000, 500_000, 1_000_000, 2_000_000):
        for window, rows in (("45d", rows45), ("20d", rows20)):
            for label, cfg in configs:
                p = {
                    **cfg,
                    "initial_nav_usd": float(cap),
                    "book_capital_usd": float(cap),
                    "arm_abs_cap_usd": 0.20 * cap,
                    "usdg_lend_abs_cap_usd": 0.20 * cap,
                    "arm_rel_cap_bps": 2_000,
                    "usdg_lend_rel_cap_bps": 2_000,
                    "borrow_liquidity_usd": 15_000.0,
                    "max_borrow_per_call_usd": 10_000.0,
                    "fee_share_mode": "exact",
                }
                summary, _, _ = run_config(label, window, rows, p)
                summary["nav_cap"] = float(cap)
                summaries.append(summary)
                print(
                    f"{label:22s} ${cap/1e6:4.1f}M {window} "
                    f"net {summary['net_vs_hodl']:+11.0f} "
                    f"netAPR {summary['simple_net_apr_pct']:+7.2f}% "
                    f"fees {summary['cum_fees']:10.0f} "
                    f"bookAPR {summary['book_fee_apr_pct']:6.2f}% "
                    f"idle {summary['end_idle_value']:10.0f} "
                    f"maxLTV {summary['max_arm_ltv']:.3f}"
                )
    _write_summary(summaries, "large_nav_summary")
    with open(OUT / "large_nav.json", "w", encoding="utf-8") as fh:
        json.dump({"results": summaries}, fh, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "mode",
        choices=["validate", "baseline", "sweep", "mc", "optimize", "mc-optimize", "large", "all"],
        nargs="?",
        default="all",
    )
    parser.add_argument("--scenario", type=Path, default=SCENARIO)
    parser.add_argument("--mc-paths", type=int, default=30)
    parser.add_argument("--mc-block-hours", type=int, default=24)
    parser.add_argument("--mc-seed", type=int, default=42)
    parser.add_argument("--risk-min-volume", type=float, default=10_000.0)
    parser.add_argument("--opt-paths", type=int, default=20)
    args = parser.parse_args()

    if not args.scenario.exists():
        raise SystemExit(
            f"scenario not found: {args.scenario}\n"
            "Build it with: node scripts/research/build_allocator_scenario.mjs"
        )

    if args.mode in ("validate", "all"):
        cmd_validate(args.scenario)
    if args.mode in ("baseline", "all"):
        cmd_baseline(args.scenario)
    if args.mode in ("sweep", "all"):
        cmd_sweep(args.scenario)
    if args.mode in ("optimize", "all"):
        cmd_optimize(args.scenario)
    if args.mode in ("large", "all"):
        cmd_large(args.scenario)
    if args.mode in ("mc", "all"):
        cmd_mc(
            args.scenario,
            args.mc_paths,
            args.mc_block_hours,
            args.mc_seed,
            args.risk_min_volume,
        )
    if args.mode in ("mc-optimize", "all"):
        cmd_mc_optimize(
            args.scenario,
            args.opt_paths,
            args.mc_block_hours,
            args.mc_seed,
        )


if __name__ == "__main__":
    main()
