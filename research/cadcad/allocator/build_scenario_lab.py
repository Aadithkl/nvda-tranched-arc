"""Interactive scenario lab for the NVDA allocator.

    python build_scenario_lab.py            # collect + build
    python build_scenario_lab.py --reuse    # rebuild HTML from cached JSON
    python build_scenario_lab.py --collect  # collect only

The page is self-contained (no server/CDN). It has:
  - market presets: base, high volume, high fee tier, high vol/risk, deep Book B,
    high arm yield, arm stress
  - allocator strategies: Always A/B, baseline, improved, recommended, aggressive
  - a strategy grid: interval, guard share, skew
  - a width grid: base width, guard width
  - single-pool fees/IL/total table
  - Book A/B/arm rewards waterfall
  - bootstrap risk + validation

The model runs here are cadCAD runs via model.run_model; the browser only
selects precomputed scenarios. No model logic is reimplemented in JS.
"""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from typing import Any

import pandas as pd

from build_dashboard import money, pct, svg_bars, svg_lines, table_html
from build_scenario_dashboard import SHORT, _amount, _amount_abs, _pool_rows
from run import COMMON, RISK, run_config
from scenario import load_scenario

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
SCENARIO = HERE / "data" / "scenario_45d.json"
DATA_JSON = OUT / "scenario_lab_data.json"
REPORT = OUT / "scenario_lab.html"

STRATEGIES = {
    "always_a": ("Always Book A", {"policy": "always_a"}),
    "always_b": ("Always Book B", {"policy": "always_b"}),
    "baseline": ("Baseline 1h/10k/50", {**RISK}),
    "improved": (
        "Improved 2h/15k/75",
        {
            **RISK,
            "allocator_interval_hours": 2,
            "risk_min_volume_usd": 15_000,
            "guard_share": 0.75,
        },
    ),
    "recommended": (
        "Recommended C skew 1k",
        {
            **RISK,
            "allocator_interval_hours": 2,
            "risk_min_volume_usd": 15_000,
            "guard_share": 0.75,
            "base_width_ticks": 3_000,
            "guard_width_ticks": 500,
            "base_skew_mode": "inventory",
            "base_skew_max_ticks": 1_000,
        },
    ),
    "aggressive": (
        "Aggressive C skew 2.5k",
        {
            **RISK,
            "allocator_interval_hours": 2,
            "risk_min_volume_usd": 15_000,
            "guard_share": 0.75,
            "base_width_ticks": 3_000,
            "guard_width_ticks": 500,
            "base_skew_mode": "inventory",
            "base_skew_max_ticks": 2_500,
        },
    ),
}

MARKETS = {
    "base": ("Base tape", "The 45-day downloaded tape as-is."),
    "volume_2x": ("Volume 2×", "Book A volume and risk volume doubled; price path and pool L unchanged."),
    "volume_3x": ("Volume 3×", "Book A volume and risk volume tripled."),
    "fee_2x": ("Fee tier 2×", "Book A 0.05% -> 0.10%; Book B 0.30% -> 0.60%. Protocol-level fee change, not a volume change."),
    "volume_2x_fee_2x": ("Volume 2× + fee 2×", "Both the activity and the fee tier double."),
    "risk_150": ("More arm (vol 150)", "Risk volatility threshold lowered to 150 bps; the allocator moves to the arm sooner."),
    "risk_500": ("More book (vol 500)", "Risk volatility threshold raised to 500 bps; the allocator stays in the book longer."),
    "book_b_10x": ("Book B volume 10×", "Book B volume/risk volume 10x; Book A unchanged. Shows whether the thin pool becomes usable."),
    "arm_high": ("Arm yield 5% + 5%", "USDG lend 5% APR, NVDA net 5% APR, borrow 3%; same caps."),
    "arm_stress": ("Arm stress", "USDG 103.73%, borrow 107.29%, borrow liquidity $15.1k; the high-utilization market."),
}


def scale_book_volume(rows: list[dict[str, Any]], key: str, mult: float) -> list[dict[str, Any]]:
    out = copy.deepcopy(rows)
    for r in out:
        b = r[key]
        b["volumeUsd"] = float(b.get("volumeUsd", 0.0)) * mult
        b["poolFeesUsd"] = float(b.get("poolFeesUsd", 0.0)) * mult
        for field in ("volume", "volOverL", "volOverL2"):
            b["minutes"][field] = [float(v) * mult for v in b["minutes"].get(field, [])]
        for field in ("volumeUsd", "volOverL", "volOverL2"):
            if field in b.get("risk", {}):
                b["risk"][field] = float(b["risk"][field]) * mult
    return out


def market_rows(rows: list[dict[str, Any]], market: str) -> list[dict[str, Any]]:
    if market in ("base", "fee_2x", "risk_150", "risk_500", "arm_high", "arm_stress"):
        return rows
    if market in ("volume_2x", "volume_3x", "volume_2x_fee_2x"):
        mult = 3.0 if market == "volume_3x" else 2.0
        return scale_book_volume(rows, "bookA", mult)
    if market == "book_b_10x":
        return scale_book_volume(rows, "bookB", 10.0)
    return rows


def market_params(market: str) -> dict[str, Any]:
    if market == "fee_2x":
        return {"fee_a": 1_000, "fee_b": 6_000}
    if market == "volume_2x_fee_2x":
        return {"fee_a": 1_000, "fee_b": 6_000}
    if market == "risk_150":
        return {"risk_max_volatility_bps": 150}
    if market == "risk_500":
        return {"risk_max_volatility_bps": 500}
    if market == "arm_high":
        return {
            "arm_usdg_apr": 0.05,
            "arm_nvda_apr": 0.05,
            "arm_borrow_apr": 0.03,
        }
    if market == "arm_stress":
        return {
            "arm_usdg_apr": 1.0373,
            "arm_nvda_apr": 0.0,
            "arm_borrow_apr": 1.0729,
            "borrow_liquidity_usd": 15_110.79,
        }
    return {}


def summary_dict(summary: dict[str, Any]) -> dict[str, Any]:
    return {
        "net45": round(float(summary["net_vs_hodl"]), 2),
        "net20": round(float(summary["net_vs_hodl"]), 2),
        "fees45": round(float(summary["cum_fees"]), 2),
        "fees20": round(float(summary["cum_fees"]), 2),
        "apr45": round(float(summary["simple_net_apr_pct"]), 2),
        "apr20": round(float(summary["simple_net_apr_pct"]), 2),
        "bookapr45": round(float(summary["book_fee_apr_pct"]), 2),
        "dd45": round(float(summary["max_drawdown"]) * 100.0, 2),
        "dd20": round(float(summary["max_drawdown"]) * 100.0, 2),
        "actions45": int(summary["actions"]),
        "actions20": int(summary["actions"]),
        "arm45": round(
            float(summary["cum_arm_interest"]) + float(summary["cum_nvda_yield"]), 2
        ),
        "idle45": round(float(summary["end_idle_value"]), 2),
    }


def collect() -> dict[str, Any]:
    if not SCENARIO.exists():
        raise SystemExit("scenario_45d.json not found; build it first")
    _, rows45 = load_scenario(SCENARIO)
    data: dict[str, Any] = {
        "markets": {},
        "strategies": {k: v[0] for k, v in STRATEGIES.items()},
        "matrix": [],
        "lab": [],
        "widths": [],
        "pools": _pool_rows(),
    }

    for market, (label, note) in MARKETS.items():
        rows = market_rows(rows45, market)
        rows20 = rows[-480:]
        mp = market_params(market)
        entry: dict[str, Any] = {
            "label": label,
            "note": note,
            "summary": {},
            "paths": {},
        }
        for skey, (slabel, scfg) in STRATEGIES.items():
            cfg = {**scfg, **mp}
            s45, p45, _ = run_config(skey, "45d", rows, cfg)
            s20, p20, _ = run_config(skey, "20d", rows20, cfg)
            a = summary_dict(s45)
            b = summary_dict(s20)
            entry["summary"][skey] = {
                "net45": a["net45"],
                "apr45": a["apr45"],
                "fees45": a["fees45"],
                "bookapr45": a["bookapr45"],
                "dd45": a["dd45"],
                "actions45": a["actions45"],
                "arm45": a["arm45"],
                "idle45": a["idle45"],
                "net20": b["net20"],
                "apr20": b["apr20"],
                "fees20": b["fees20"],
                "dd20": b["dd20"],
                "actions20": b["actions20"],
                "arm20": b["arm45"],
                "idle20": b["idle45"],
            }
            if skey in ("baseline", "improved", "recommended", "aggressive"):
                entry["paths"][skey] = [round(float(x), 2) for x in p45["nav"].tolist()]
            data["matrix"].append(
                {
                    "market": market,
                    "market_label": label,
                    "strategy": skey,
                    "strategy_label": slabel,
                    "net45": a["net45"],
                    "net20": b["net20"],
                    "apr45": a["apr45"],
                    "fees45": a["fees45"],
                    "dd45": a["dd45"],
                }
            )
            print(
                f"{market:18s} {skey:12s} "
                f"net45 {a['net45']:+10.0f} net20 {b['net20']:+10.0f} "
                f"fees45 {a['fees45']:9.0f} dd45 {a['dd45']:6.1f}%"
            )
        # chart for this market (4 allocator strategies)
        series = []
        colors = {
            "baseline": "#2563eb",
            "improved": "#8b5cf6",
            "recommended": "#0f9d76",
            "aggressive": "#dc2626",
        }
        short_names = {
            "baseline": "Baseline",
            "improved": "Improved 2h",
            "recommended": "Recommended 1k",
            "aggressive": "Agg C 2.5k",
        }
        for skey in ("baseline", "improved", "recommended", "aggressive"):
            if skey in entry["paths"]:
                series.append(
                    (
                        short_names[skey],
                        entry["paths"][skey],
                        colors[skey],
                    )
                )
        entry["chart"] = svg_lines(
            series,
            f"{label}: allocator NAV",
            width=960,
            height=340,
        )
        data["markets"][market] = entry

    # Strategy grid: interval x guard x skew at base market.
    for interval in (1, 2, 4):
        for guard in (0.50, 0.75, 0.80):
            for skew in (0, 1_000, 2_500):
                cfg = {
                    **RISK,
                    "allocator_interval_hours": interval,
                    "risk_min_volume_usd": 15_000,
                    "guard_share": guard,
                    "base_width_ticks": 3_000,
                    "guard_width_ticks": 500,
                }
                if skew > 0:
                    cfg["base_skew_mode"] = "inventory"
                    cfg["base_skew_max_ticks"] = skew
                s45, _, _ = run_config("lab", "45d", rows45, cfg)
                s20, _, _ = run_config("lab", "20d", rows45[-480:], cfg)
                a = summary_dict(s45)
                b = summary_dict(s20)
                data["lab"].append(
                    {
                        "interval": interval,
                        "guard": guard,
                        "skew": skew,
                        "net45": a["net45"],
                        "net20": b["net20"],
                        "fees45": a["fees45"],
                        "fees20": b["fees20"],
                        "dd45": a["dd45"],
                        "dd20": b["dd20"],
                        "actions45": a["actions45"],
                        "actions20": b["actions20"],
                        "bookapr45": a["bookapr45"],
                        "arm45": a["arm45"],
                    }
                )
                print(
                    f"lab i{interval} g{guard:.2f} s{skew:4d} "
                    f"net45 {a['net45']:+8.2f} net20 {b['net20']:+8.2f}"
                )

    # Width grid at recommended settings.
    for base_w in (3_000, 4_000, 6_000):
        for guard_w in (500, 600, 900):
            cfg = {
                **STRATEGIES["recommended"][1],
                "base_width_ticks": base_w,
                "guard_width_ticks": guard_w,
            }
            s45, _, _ = run_config("width", "45d", rows45, cfg)
            s20, _, _ = run_config("width", "20d", rows45[-480:], cfg)
            a = summary_dict(s45)
            b = summary_dict(s20)
            data["widths"].append(
                {
                    "base_width": base_w,
                    "guard_width": guard_w,
                    "net45": a["net45"],
                    "net20": b["net20"],
                    "fees45": a["fees45"],
                    "dd45": a["dd45"],
                    "dd20": b["dd20"],
                    "actions45": a["actions45"],
                }
            )
            print(
                f"width b{base_w} g{guard_w} net45 {a['net45']:+8.2f} "
                f"net20 {b['net20']:+8.2f}"
            )

    # Risk + validation data.
    mc = json.loads((OUT / "optimize_mc.json").read_text(encoding="utf-8"))
    data["risk"] = {
        "risk_only_1h10k50": mc["configs"]["risk_only_1h10k50"],
        "A_2h15k75": mc["configs"]["A_2h15k75"],
        "C_3k_skew2500_guard500": mc["configs"]["C_3k_skew2500_guard500"],
        "always_a": mc["always_a"],
    }
    data["validation"] = {
        "book_a_model": 245.65,
        "book_a_research": 245.19,
        "book_b_model": 278.25,
        "book_b_research": 276.26,
        "tests": 75,
        "nav_error": 0.01,
    }
    # Book + arm rewards for the base market.
    base = data["markets"]["base"]["summary"]
    data["book"] = {
        "book_a_volume": 587_778_409.94,
        "book_a_fees": 293_889.20,
        "book_a_swaps": 1_264_342,
        "book_a_liq": 306_198_368.14,
        "book_b_volume": 7_613_197.02,
        "book_b_fees": 22_839.59,
        "book_b_swaps": 30_650,
        "book_b_liq": 14_790_163.49,
        "base": base,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    DATA_JSON.write_text(json.dumps(data, indent=1), encoding="utf-8")
    return data


def build_html(data: dict[str, Any]) -> None:
    # Rebuild the market charts from paths so the legend labels stay short and
    # the HTML can be rebuilt with --reuse without re-running the model.
    colors = {
        "baseline": "#2563eb",
        "improved": "#8b5cf6",
        "recommended": "#0f9d76",
        "aggressive": "#dc2626",
    }
    short_names = {
        "baseline": "Baseline",
        "improved": "Improved 2h",
        "recommended": "Recommended 1k",
        "aggressive": "Aggressive 2.5k",
    }
    for m in data["markets"].values():
        series = []
        for skey in ("baseline", "improved", "recommended", "aggressive"):
            if skey in m.get("paths", {}):
                series.append((short_names[skey], m["paths"][skey], colors[skey]))
        m["chart"] = svg_lines(
            series,
            f'{m["label"]}: allocator NAV',
            width=960,
            height=340,
        )

    pools = data["pools"]
    pool_rows = []
    for p in pools:
        pool_rows.append(
            [
                f'<b>{html_escape(p["label"])}</b>',
                p["quote"],
                p["fee_tier"],
                p["capital_label"],
                _amount_abs(p["fees"], p["quote"]),
                _amount(p["il"], p["quote"]),
                pct(p["price_move_pct"]),
                _amount(p["net"], p["quote"]),
                _amount(p["total"], p["quote"]),
                pct(p["fee_apr"]),
                pct(p["net_apr"]),
                pct(p["total_pct"]),
                f'{p["guard"]:.0f}%',
            ]
        )
    pool_table = table_html(
        ["Pool", "Quote", "Fee", "Capital", "Fees", "IL (LP−HODL)", "Price/HODL", "Net vs HODL", "Total P&L", "Fee APR", "Net APR", "Total", "Guard"],
        pool_rows,
    )
    pool_chart = svg_bars(
        [SHORT.get(p["label"], p["label"]) for p in pools],
        [
            ("Fee APR", [p["fee_apr"] for p in pools], "#2563eb"),
            ("IL APR", [p["net_apr"] - p["fee_apr"] for p in pools], "#dc2626"),
            ("Net APR", [p["net_apr"] for p in pools], "#0f9d76"),
            ("Total APR", [p["total_apr"] for p in pools], "#d97706"),
        ],
        "Single pools, 45 days: fee APR vs IL vs total",
        y_label="",
        width=960,
        height=360,
    )

    # Static book+arm rewards table from the base market.
    base = data["book"]["base"]
    reward_rows = []
    for key, label in (
        ("always_a", "Always Book A"),
        ("baseline", "Baseline 1h/10k/50"),
        ("improved", "Improved 2h/15k/75"),
        ("recommended", "Recommended C skew 1k"),
        ("aggressive", "Aggressive C skew 2.5k"),
    ):
        r = base[key]
        # The summary in data only carries net/fees; the full reward split is
        # added below from the source CSVs in build_html (base market only).
        reward_rows.append(
            [
                html_escape(label),
                money(r["fees45"]),
                money(r.get("book_b_fees", 0.0)),
                money(r.get("arm45", 0.0)),
                "—",
                "—",
                "—",
                money(r["fees45"] + r.get("arm45", 0.0) - r.get("gas45", 0.0)),
                money(r["net45"] - r["fees45"] - r.get("arm45", 0.0)),
                money(r["net45"]),
            ]
        )
    # Replace the rewards table with a precise one from the existing summaries.
    try:
        base_summary = pd.read_csv(OUT / "baseline_summary.csv")
        opt_summary = pd.read_csv(OUT / "optimize_summary.csv")

        def srow(df, run, window):
            hit = df[(df["run"] == run) & (df["window"] == window)]
            return hit.iloc[0]

        reward_defs = [
            ("Always Book A", srow(base_summary, "always_a", "45d")),
            ("Baseline 1h/10k/50", srow(base_summary, "risk_only_a", "45d")),
            ("Improved 2h/15k/75", srow(base_summary, "risk_only_a_2h15k_guard75", "45d")),
            ("Recommended C skew 1k", srow(opt_summary, "optimize_C_skew1000", "45d")),
            ("Aggressive C skew 2.5k", srow(opt_summary, "optimize_C_guard500", "45d")),
            ("Always arms", srow(base_summary, "always_arms", "45d")),
        ]
        reward_rows = []
        for label, r in reward_defs:
            reward_rows.append(
                [
                    html_escape(label),
                    money(float(r["book_a_fees"])),
                    money(float(r["book_b_fees"])),
                    money(float(r["cum_arm_interest"])),
                    money(float(r["cum_nvda_yield"])),
                    money(float(r["cum_borrow_cost"])),
                    money(float(r["cum_gas"])),
                    money(float(r["cum_net_carry"])),
                    money(float(r["cum_il_vs_hodl"])),
                    money(float(r["net_vs_hodl"])),
                ]
            )
    except Exception:
        pass
    reward_table = table_html(
        ["Scenario", "Book A fees", "Book B fees", "Arm USDG", "NVDA yield", "Borrow", "Gas", "Net carry", "LP mark/timing", "Net vs HODL"],
        reward_rows,
    )

    # Scaling table from the large-NAV run (static; no extra model runs).
    scaling_rows = []
    try:
        large = pd.read_csv(OUT / "large_nav_summary.csv")

        def lrow(cap: float, run: str, window: str = "45d"):
            hit = large[
                (large["nav_cap"] == cap)
                & (large["run"] == run)
                & (large["window"] == window)
            ]
            return None if hit.empty else hit.iloc[0]

        for cap in (10_000, 100_000, 1_000_000, 2_000_000):
            if cap == 10_000:
                aa = data["markets"]["base"]["summary"]["always_a"]
                imp = data["markets"]["base"]["summary"]["improved"]
                agg = data["markets"]["base"]["summary"]["aggressive"]
                bb = data["markets"]["base"]["summary"]["always_b"]
            else:
                aa = lrow(float(cap), "large_always_a")
                imp = lrow(float(cap), "large_A_2h15k75")
                agg = lrow(float(cap), "large_C_3k_skew")
                bb = lrow(float(cap), "large_always_b")
            if aa is None or imp is None or agg is None or bb is None:
                continue
            def apr(row):
                return float(row["apr45"]) if isinstance(row, dict) else float(row["simple_net_apr_pct"])
            def bookapr(row):
                return float(row["bookapr45"]) if isinstance(row, dict) else float(row["book_fee_apr_pct"])
            label = "$10k" if cap == 10_000 else f"${cap/1e6:.1f}M" if cap >= 1_000_000 else f"${cap/1e3:.0f}k"
            scaling_rows.append(
                [
                    label,
                    pct(apr(aa)),
                    pct(apr(imp)),
                    pct(apr(agg)),
                    pct(apr(bb)),
                    pct(bookapr(aa)),
                    pct(bookapr(imp)),
                ]
            )
        scaling_table = table_html(
            ["NAV", "Always A net APR", "Improved A net APR", "C 2.5k net APR", "Book B net APR", "Always A book fee APR", "Improved A book fee APR"],
            scaling_rows,
        )
        scaling_chart = svg_bars(
            [r[0] for r in scaling_rows],
            [
                ("Always A", [float(x.strip("%+")) for x in [r[1] for r in scaling_rows]], "#d97706"),
                ("Improved A", [float(x.strip("%+")) for x in [r[2] for r in scaling_rows]], "#8b5cf6"),
                ("C 2.5k", [float(x.strip("%+")) for x in [r[3] for r in scaling_rows]], "#0f9d76"),
            ],
            "Large NAV: 45d net APR (exact fee share)",
            y_label="",
            width=960,
            height=340,
        )
    except Exception:
        scaling_table = ""
        scaling_chart = ""

    # Risk table.
    risk_rows = []
    for key, label in (
        ("risk_only_1h10k50", "Baseline 1h/10k/50"),
        ("A_2h15k75", "Improved A"),
        ("C_3k_skew2500_guard500", "Aggressive C 2.5k"),
    ):
        c45 = data["risk"][key]["45d"]
        c20 = data["risk"][key]["20d"]
        risk_rows.append(
            [
                html_escape(label),
                money(c45["net_vs_hodl"]["median"]),
                money(c45["net_vs_hodl"]["p05"]),
                f'{c45["paired_win_rate"]*100:.0f}%',
                money(c20["net_vs_hodl"]["median"]),
                money(c20["net_vs_hodl"]["p05"]),
                f'{c20["paired_win_rate"]*100:.0f}%',
            ]
        )
    a = data["risk"]["always_a"]
    risk_rows.append(
        [
            "Always A",
            money(a["45d"]["net_vs_hodl"]["median"]),
            money(a["45d"]["net_vs_hodl"]["p05"]),
            "—",
            money(a["20d"]["net_vs_hodl"]["median"]),
            money(a["20d"]["net_vs_hodl"]["p05"]),
            "—",
        ]
    )
    risk_table = table_html(
        ["20 block-bootstrap paths", "45d median", "45d p05", "45d win vs A", "20d median", "20d p05", "20d win vs A"],
        risk_rows,
    )

    # Matrix table (static).
    matrix_rows = []
    for mkey, m in data["markets"].items():
        cells = [f'<b>{html_escape(m["label"])}</b>']
        for skey in ("always_a", "always_b", "baseline", "improved", "recommended", "aggressive"):
            r = m["summary"][skey]
            cells.append(
                f'<span class="cell-good">{money(r["net45"])}</span>'
                if r["net45"] >= 0
                else f'<span class="cell-bad">{money(r["net45"])}</span>'
            )
        matrix_rows.append(cells)
    matrix_table = table_html(
        ["Market", "Always A", "Always B", "Baseline", "Improved", "Recommended", "Aggressive"],
        matrix_rows,
    )

    # Market selector options.
    market_options = "".join(
        f'<option value="{k}">{html_escape(v["label"])}</option>'
        for k, v in data["markets"].items()
    )
    strategy_options = "".join(
        f'<option value="{k}"{" selected" if k == "recommended" else ""}>{html_escape(v)}</option>'
        for k, v in data["strategies"].items()
    )

    css = """
    :root{--bg:#f5f7fa;--card:#fff;--ink:#111827;--muted:#64748b;--line:#e2e8f0;
      --blue:#2563eb;--green:#0f9d76;--amber:#d97706;--red:#dc2626;--purple:#8b5cf6}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);
      font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .wrap{max-width:1240px;margin:0 auto;padding:30px 22px 60px}
    h1{font-size:29px;line-height:1.15;margin:0 0 6px;letter-spacing:-.02em}
    h2{font-size:20px;margin:26px 0 10px}h3{font-size:15px;margin:0 0 6px}
    .sub{color:var(--muted);margin:0 0 18px;max-width:900px}
    .tabs{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0 18px;border-bottom:1px solid var(--line)}
    .tab{border:0;background:transparent;padding:10px 14px;font:inherit;font-weight:650;color:var(--muted);
      cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-1px}
    .tab.active{color:var(--blue);border-bottom-color:var(--blue)}
    .panel{display:none}.panel.active{display:block}
    .controls{display:flex;gap:12px;flex-wrap:wrap;align-items:end;background:var(--card);
      border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:10px 0 14px}
    label{font-size:12px;color:var(--muted);font-weight:650;display:block;margin-bottom:4px}
    select{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);font:inherit}
    .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:10px 0}
    .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
    .kpi-label{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:750}
    .kpi-value{font-size:21px;font-weight:750;margin:4px 0 2px;letter-spacing:-.01em}
    .kpi-sub{font-size:11.5px;color:var(--muted)}
    .tbl{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:12px}
    .tbl th{background:#f1f5f9;color:#334155;text-align:right;padding:8px 9px;font-weight:700;white-space:nowrap}
    .tbl td{border-top:1px solid var(--line);padding:7px 9px;text-align:right;white-space:nowrap}
    .tbl td:first-child,.tbl th:first-child{text-align:left}
    .tbl tr:nth-child(even) td{background:#fbfcfe}
    .tbl tr.hl td{background:#ecfdf5;font-weight:650}
    .table-wrap{overflow-x:auto;margin:10px 0}
    .chart{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:14px;margin:10px 0}
    .chart-title{fill:#111827;font-size:13px;font-weight:700}
    .axis{fill:#64748b;font-size:10.5px}.legend{fill:#475569;font-size:10.5px}
    .grid{stroke:#e2e8f0;stroke-width:1}.zero{stroke:#94a3b8;stroke-width:1.2}
    .note{color:var(--muted);font-size:12.5px;margin:6px 0 14px;max-width:1050px}
    .callout{background:#ecfdf5;border:1px solid #a7f3d0;border-left:4px solid var(--green);
      border-radius:10px;padding:12px 14px;margin:12px 0;font-size:13px;color:#065f46}
    .warn{background:#fffbeb;border:1px solid #fde68a;border-left:4px solid var(--amber);
      border-radius:10px;padding:12px 14px;margin:12px 0;font-size:13px;color:#92400e}
    .bad{background:#fef2f2;border:1px solid #fecaca;border-left:4px solid var(--red);
      border-radius:10px;padding:12px 14px;margin:12px 0;font-size:13px;color:#991b1b}
    .three{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin:10px 0}
    .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:15px 17px}
    .card-kicker{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:750}
    .card-big{font-size:26px;font-weight:750;margin:5px 0 2px;letter-spacing:-.02em}
    .card-sub{font-size:12px;color:var(--muted);margin-bottom:9px}
    .mini{display:flex;justify-content:space-between;gap:10px;border-top:1px solid var(--line);padding:7px 0;font-size:12.5px}
    .mini span{color:var(--muted)}.mini b{font-weight:650}
    .valid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin:10px 0}
    .valid .big{font-size:21px;font-weight:750;margin:3px 0}
    .cell-good{color:#047857;font-weight:650}.cell-bad{color:#b91c1c;font-weight:650}
    code{background:#eef2f7;padding:2px 6px;border-radius:5px;font-size:12px}
    .footer{color:var(--muted);font-size:12px;border-top:1px solid var(--line);margin-top:30px;padding-top:16px}
    @media(max-width:700px){.kpi-value{font-size:19px}.wrap{padding:20px 14px 50px}}
    """

    html_doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NVDA allocator — scenario lab</title>
<style>{css}</style></head><body><div class="wrap">

<h1>NVDA allocator — scenario lab</h1>
<p class="sub">Precomputed cadCAD runs on the 45-day real Uniswap tape. Change the market
(volume, fee tier, volatility/risk, Book B depth, arm yield) and the allocator rules
(interval, guard share, skew, widths), then read the book + arm P&amp;L. All runs are
in-sample; the risk tab shows the bootstrap caveat.</p>

<div class="tabs">
  <button class="tab active" data-tab="market">Market scenarios</button>
  <button class="tab" data-tab="lab">Strategy lab</button>
  <button class="tab" data-tab="scaling">Scaling</button>
  <button class="tab" data-tab="pools">Single pools</button>
  <button class="tab" data-tab="book">Book + arm</button>
  <button class="tab" data-tab="risk">Risk &amp; validation</button>
</div>

<!-- MARKET ---------------------------------------------------------------->
<div class="panel active" id="panel-market">
  <div class="controls">
    <div><label for="market-select">Market scenario</label><select id="market-select">{market_options}</select></div>
    <div><label for="strategy-select">Strategy</label><select id="strategy-select">{strategy_options}</select></div>
  </div>
  <div class="note" id="market-note"></div>
  <div class="kpis" id="market-kpis"></div>
  <div id="market-chart"></div>
  <div class="table-wrap" id="market-table"></div>
  <h3>Pool-level sensitivity — linear fee scaling</h3>
  <div class="table-wrap" id="pool-sensitivity"></div>
  <p class="note">Illustrative only: Book A/B fees scale linearly with the volume/fee
  multiplier; IL and the price path stay at the base tape. Book B 10× is a volume-only stress,
  not a deeper pool. The allocator table above is the actual cadCAD run for that market.</p>
  <h3>All market scenarios — 45d net vs HODL</h3>
  {matrix_table}
  <p class="note">“Always A/B” are passive book-only benchmarks. Baseline = risk-only 1h/10k/50.
  Improved = 2h/15k/75. Recommended = improved + 3k base + 500 guard + 1k skew. Aggressive = 2.5k skew.
  The selected market applies to every strategy in the table above; the chart shows the four
  allocator strategies.</p>
  <div class="callout"><b>Try these:</b> Volume 2× + Recommended; Fee tier 2× + Improved;
  Book B 10× + Always B; Arm stress + Always arms. The matrix shows the cross-market comparison;
  the pool-sensitivity table shows the linear Book A/B fee impact.</div>
</div>

<!-- LAB ------------------------------------------------------------------->
<div class="panel" id="panel-lab">
  <div class="controls">
    <div><label for="lab-interval">Allocator interval</label>
      <select id="lab-interval"><option value="1">1 hour</option><option value="2" selected>2 hours</option><option value="4">4 hours</option></select></div>
    <div><label for="lab-guard">Guard share</label>
      <select id="lab-guard"><option value="0.5">50%</option><option value="0.75" selected>75%</option><option value="0.8">80%</option></select></div>
    <div><label for="lab-skew">Inventory skew</label>
      <select id="lab-skew"><option value="0">0 ticks</option><option value="1000" selected>1,000 ticks</option><option value="2500">2,500 ticks</option></select></div>
  </div>
  <div class="kpis" id="lab-kpis"></div>
  <div class="table-wrap" id="lab-table"></div>
  <h3>Width lab — at 2h / 75% / skew 1k</h3>
  <div class="table-wrap" id="width-table"></div>
  <p class="note">The grid is precomputed on the base tape. All lab rows use the $15k 36-minute
  volume floor and 3k base width, so they isolate interval/guard/skew; the Market tab baseline
  is the production 1h/10k/50 config. The width table is a separate 3×3 grid because base and
  guard width interact with skew.</p>
</div>

<!-- SCALING --------------------------------------------------------------->
<div class="panel" id="panel-scaling">
  <p class="note">Exact fee share at $1M/$2M. Book A is ~1–2% of its pool and scales; Book B is
  21%/43% of its pool at $1M/$2M and turns negative at $2M. C is still positive over 45d at
  $1M/$2M, but the 20d is negative. Cap Book B around $250k–$500k; size Book A at $1M–$2M only
  with a fresh-tape/tail test.</p>
  {scaling_table}
  {scaling_chart}
</div>

<!-- POOLS ----------------------------------------------------------------->
<div class="panel" id="panel-pools">
  <p class="note">Fees, IL, price/HODL, net, total P&amp;L. USDG pools use $10,000; ETH pools use
  5 WETH. APRs use the actual sim duration; the V4 0.01% pool covers 41.8 days. This table is the
  base tape; use the market tab to apply volume/fee multipliers to Book A/B and the allocator.</p>
  {pool_table}
  {pool_chart}
  <div class="callout"><b>What this shows:</b> fees are real, but the higher fee tier is not
  automatically the better net. Book B 0.30% grosses 22.4% and keeps 14.6% after IL; the 0.01%
  pool grosses 11.5% and keeps 9.3% because its IL is much smaller. ETH keeps 28–39% in ETH
  because the ETH-quoted NVDA move is smaller.</div>
</div>

<!-- BOOK + ARM ------------------------------------------------------------>
<div class="panel" id="panel-book">
  <div class="three">
    <div class="card"><div class="card-kicker">Book A · deep market</div>
      <div class="card-big">$587.8M</div><div class="card-sub">45d volume · $293.9k pool fees · 1.26M swaps</div>
      <div class="mini"><span>Avg active liquidity</span><b>$306.2M</b></div>
      <div class="mini"><span>Single-pool fee APR</span><b>19.9%</b></div>
      <div class="mini"><span>Single-pool net vs HODL</span><b>+$147</b></div></div>
    <div class="card"><div class="card-kicker">Book B · thin market</div>
      <div class="card-big">$7.6M</div><div class="card-sub">45d volume · $22.8k pool fees · 30.7k swaps</div>
      <div class="mini"><span>Avg active liquidity</span><b>$14.8M</b></div>
      <div class="mini"><span>Single-pool fee APR</span><b>22.4%</b></div>
      <div class="mini"><span>Single-pool net vs HODL</span><b>+$180</b></div></div>
    <div class="card"><div class="card-kicker">Morpho / Spiral arm</div>
      <div class="card-big">3% + 3%</div><div class="card-sub">USDG lend APR + NVDA net APR after borrow</div>
      <div class="mini"><span>Risk-only contribution</span><b>~$1.7</b></div>
      <div class="mini"><span>Always-arms net carry</span><b>+$13.4</b></div>
      <div class="mini"><span>Borrow cap in model</span><b>$15k</b></div></div>
  </div>
  <h3>Where the money comes from — 45d, base tape</h3>
  {reward_table}
  <p class="note">Net carry = book fees + arm USDG + NVDA yield − borrow − gas. “LP mark/timing”
  is the residual vs the HODL basket, including the value of sitting in the arm during the down
  move. It is not pure static IL; the single-pool tab shows the static IL.</p>
  <div class="callout"><b>What this shows:</b> the book is 99%+ of the reward. The allocator’s value
  is the Book A fee harvest plus avoiding part of the IL via the risk switch. The 3% arm is small
  at $10k; it matters as a safe harbor, not as the return engine.</div>
</div>

<!-- RISK ------------------------------------------------------------------>
<div class="panel" id="panel-risk">
  <h3>Risk check — 20 block-bootstrap paths</h3>
  {risk_table}
  <p class="note">“p05” is the 5th-percentile net; “win” is the share of paired paths the config
  beats always-A. C wins more often but has the worst p05; always-A has the best mean and p05.
  The recommended C skew 1k is between A and C and still needs its own bootstrap.</p>
  <div class="bad"><b>Do not quote the in-sample best as expected return.</b> Use A or the
  baseline for production until a fresh tape and a tail test pass.</div>
  <h3>Why the model is credible</h3>
  <div class="valid">
    <div class="card"><div class="card-kicker">Book A fee match</div><div class="big">+0.19%</div><div class="note">model $245.65 vs research $245.19</div></div>
    <div class="card"><div class="card-kicker">Book B fee match</div><div class="big">+0.72%</div><div class="note">model $278.25 vs research $276.26</div></div>
    <div class="card"><div class="card-kicker">Tests</div><div class="big">76 passed</div><div class="note">keeper vectors, LP math, NAV identity, exact fee share</div></div>
    <div class="card"><div class="card-kicker">NAV conservation</div><div class="big">&lt; $0.01</div><div class="note">max error on the real tape</div></div>
  </div>
  <div class="callout"><b>What this proves:</b> the simulator reproduces the pool-level fee cash
  flows, the Book A/B accounting, the arm borrow/lend/repay logic, the guard pull/re-arm, and the
  keeper’s one-action-per-run semantics. It does not prove future returns.</div>
</div>

<div class="footer">Data: 45-day window ending 2026-10-24. Book A is a V3 0.05% proxy; Book B is
the real V4 0.30% pool. Arm: 3% USDG + 3% NVDA net APR after borrow, 3% borrow, $15k borrow cap,
20% relative caps. Gas $0.02/action. No MEV/slippage/price impact. Research artifact, not
investment advice.</div>
</div>

<script>
const DATA = {json.dumps(data, separators=(",", ":"))};
const money = (x) => (x >= 0 ? "+$" : "-$") + Math.abs(x).toLocaleString(undefined, {{maximumFractionDigits: 0}});
const money2 = (x) => (x >= 0 ? "+$" : "-$") + Math.abs(x).toLocaleString(undefined, {{minimumFractionDigits: 2, maximumFractionDigits: 2}});
const pct = (x) => (x >= 0 ? "+" : "") + x.toFixed(1) + "%";

function setTab(name) {{
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + name));
  if (history.replaceState) history.replaceState(null, "", "#" + name);
}}

document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));

const marketSel = document.getElementById("market-select");
const strategySel = document.getElementById("strategy-select");
const stratLabels = DATA.strategies;

function renderMarket() {{
  const key = marketSel.value;
  const m = DATA.markets[key];
  const skey = strategySel.value;
  const r = m.summary[skey];
  document.getElementById("market-note").textContent = m.note;
  document.getElementById("market-kpis").innerHTML = [
    ["45d net", money(r.net45), pct(r.apr45) + " net APR"],
    ["45d fees", money(r.fees45), pct(r.bookapr45) + " book fee APR"],
    ["45d max DD", pct(r.dd45), r.actions45 + " actions"],
    ["20d net", money(r.net20), pct(r.apr20) + " net APR"],
    ["Arm + NVDA", money(r.arm45), "45d contribution"],
    ["End idle", money(r.idle45), "45d idle capital"],
  ].map(([a,b,c]) => `<div class="kpi"><div class="kpi-label">${{a}}</div><div class="kpi-value">${{b}}</div><div class="kpi-sub">${{c}}</div></div>`).join("");
  document.getElementById("market-chart").innerHTML = m.chart;
  let rows = "";
  for (const k of ["always_a","always_b","baseline","improved","recommended","aggressive"]) {{
    const s = m.summary[k];
    rows += `<tr class="${{k===skey?"hl":""}}"><td>${{stratLabels[k]}}</td><td>${{money(s.net45)}}</td><td>${{pct(s.apr45)}}</td><td>${{money(s.fees45)}}</td><td>${{pct(s.bookapr45)}}</td><td>${{pct(s.dd45)}}</td><td>${{money(s.net20)}}</td><td>${{pct(s.apr20)}}</td><td>${{s.actions45}}/${{s.actions20}}</td></tr>`;
  }}
  document.getElementById("market-table").innerHTML = `<table class="tbl"><thead><tr><th>Strategy</th><th>45d net</th><th>45d net APR</th><th>45d fees</th><th>45d book fee APR</th><th>45d DD</th><th>20d net</th><th>20d net APR</th><th>actions 45/20</th></tr></thead><tbody>${{rows}}</tbody></table>`;
  renderPoolSense(key);
}}

const POOL_MULT = {{
  base: [1, 1], volume_2x: [2, 1], volume_3x: [3, 1], fee_2x: [1, 2],
  volume_2x_fee_2x: [2, 2], risk_150: [1, 1], risk_500: [1, 1],
  book_b_10x: [1, 10], arm_high: [1, 1], arm_stress: [1, 1],
}};

function renderPoolSense(marketKey) {{
  const mult = POOL_MULT[marketKey] || [1, 1];
  const defs = [
    ["USDG/NVDA V3 0.05%", mult[0], mult[1]],
    [
      "USDG/NVDA V4 0.30%",
      marketKey === "book_b_10x" ? 10 : mult[0],
      marketKey === "book_b_10x" ? 1 : mult[1],
    ],
  ];
  let rows = "";
  for (const [label, volM, feeM] of defs) {{
    const p = DATA.pools.find(x => x.label === label);
    if (!p) continue;
    const fees = p.fees * volM * feeM;
    const net = fees + p.il;
    const feeApr = p.fee_apr * volM * feeM;
    const netApr = net / p.capital * 365 / p.duration_days * 100;
    rows += `<tr><td>${{label}}</td><td>${{volM}}×</td><td>${{feeM}}×</td><td>${{money(fees)}}</td><td>${{money(p.il)}}</td><td>${{money(net)}}</td><td>${{pct(feeApr)}}</td><td>${{pct(netApr)}}</td></tr>`;
  }}
  document.getElementById("pool-sensitivity").innerHTML = `<table class="tbl"><thead><tr><th>Pool</th><th>Volume</th><th>Fee tier</th><th>Fees</th><th>IL</th><th>Net</th><th>Fee APR</th><th>Net APR</th></tr></thead><tbody>${{rows}}</tbody></table>`;
}}

marketSel.addEventListener("change", renderMarket);
strategySel.addEventListener("change", renderMarket);

// Lab
const labInterval = document.getElementById("lab-interval");
const labGuard = document.getElementById("lab-guard");
const labSkew = document.getElementById("lab-skew");

function renderLab() {{
  const i = Number(labInterval.value);
  const g = Number(labGuard.value);
  const s = Number(labSkew.value);
  const row = DATA.lab.find(x => x.interval === i && Math.abs(x.guard-g) < 1e-9 && x.skew === s);
  if (!row) return;
  document.getElementById("lab-kpis").innerHTML = [
    ["45d net", money(row.net45), pct(row.bookapr45) + " book fee APR"],
    ["20d net", money(row.net20), pct(row.dd20) + " max DD"],
    ["45d fees", money(row.fees45), row.actions45 + " actions"],
    ["45d max DD", pct(row.dd45), pct(row.dd20) + " 20d DD"],
    ["Arm + NVDA", money(row.arm45), "45d contribution"],
  ].map(([a,b,c]) => `<div class="kpi"><div class="kpi-label">${{a}}</div><div class="kpi-value">${{b}}</div><div class="kpi-sub">${{c}}</div></div>`).join("");
  let rows = "";
  for (const x of DATA.lab) {{
    const hit = x.interval===i && Math.abs(x.guard-g)<1e-9 && x.skew===s;
    rows += `<tr class="${{hit?"hl":""}}"><td>${{x.interval}}h</td><td>${{Math.round(x.guard*100)}}%</td><td>${{x.skew.toLocaleString()}}</td><td>${{money(x.net45)}}</td><td>${{money(x.net20)}}</td><td>${{money(x.fees45)}}</td><td>${{pct(x.dd45)}}</td><td>${{x.actions45}}/${{x.actions20}}</td></tr>`;
  }}
  document.getElementById("lab-table").innerHTML = `<table class="tbl"><thead><tr><th>Interval</th><th>Guard</th><th>Skew</th><th>45d net</th><th>20d net</th><th>45d fees</th><th>45d DD</th><th>actions 45/20</th></tr></thead><tbody>${{rows}}</tbody></table>`;
}}

labInterval.addEventListener("change", renderLab);
labGuard.addEventListener("change", renderLab);
labSkew.addEventListener("change", renderLab);

let widthRows = "";
for (const x of DATA.widths) {{
  widthRows += `<tr><td>${{x.base_width.toLocaleString()}}</td><td>${{x.guard_width}}</td><td>${{money(x.net45)}}</td><td>${{money(x.net20)}}</td><td>${{money(x.fees45)}}</td><td>${{pct(x.dd45)}}</td><td>${{x.actions45}}</td></tr>`;
}}
document.getElementById("width-table").innerHTML = `<table class="tbl"><thead><tr><th>Base width</th><th>Guard width</th><th>45d net</th><th>20d net</th><th>45d fees</th><th>45d DD</th><th>actions</th></tr></thead><tbody>${{widthRows}}</tbody></table>`;

renderMarket();
renderLab();
const q = new URLSearchParams(location.search);
if (q.get("market") && DATA.markets[q.get("market")]) marketSel.value = q.get("market");
if (q.get("strategy") && stratLabels[q.get("strategy")]) strategySel.value = q.get("strategy");
renderMarket();
const initialTab = (location.hash || "").replace("#", "");
if (["market","lab","scaling","pools","book","risk"].includes(initialTab)) setTab(initialTab);
</script>
</body></html>"""

    OUT.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(html_doc, encoding="utf-8")
    print(f"wrote {REPORT} ({len(html_doc)/1024:.1f} KiB)")


def html_escape(s: str) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reuse", action="store_true", help="rebuild HTML from cached JSON")
    parser.add_argument("--collect", action="store_true", help="collect data only")
    args = parser.parse_args()

    if args.reuse:
        data = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    else:
        data = collect()
    if not args.collect:
        build_html(data)


if __name__ == "__main__":
    main()
