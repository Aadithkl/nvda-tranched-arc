"""Presentation dashboard: single pools vs the allocator simulation.

    python build_scenario_dashboard.py
    # writes out/scenario_dashboard.html

This is a lighter, display-oriented companion to dashboard.html. It focuses on:
  - every single pool over the 45-day tape: fees, IL, price/HODL, net, total
  - Book A vs Book B vs arm: where the money comes from
  - allocator scenarios: baseline, 2h/15k/75%, recommended C skew 1k, aggressive C
  - large-NAV scaling and the honest bootstrap/tail check
  - model validation: fees vs the pool-level research sims, tests, NAV identity
"""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any

import pandas as pd

from build_dashboard import money, pct, svg_bars, svg_lines, table_html

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
REPO = HERE.parents[2]
SCENARIO = HERE / "data" / "scenario_45d.json"
REPORT = OUT / "scenario_dashboard.html"

POOLS = [
    ("USDG/NVDA V3 0.05%", "v3-usdg-nvda-005-fee500-45d.json", "USDG", "$10,000"),
    ("USDG/NVDA V4 0.30%", "v4-usdg-nvda-030-fee3000-45d.json", "USDG", "$10,000"),
    ("USDG/NVDA V4 0.01%", "v4-usdg-nvda-001-fee100-45d.json", "USDG", "$10,000"),
    ("USDG/NVDA V4 0.0375%", "v4-usdg-nvda-00375-fee375-45d.json", "USDG", "$10,000"),
    ("ETH/NVDA V3 0.05%", "v3-weth-nvda-005-fee500-45d.json", "WETH", "5 WETH"),
    ("ETH/NVDA V3 0.30%", "v3-weth-nvda-030-fee3000-45d.json", "WETH", "5 WETH"),
    ("ETH/NVDA V4 0.05%", "v4-weth-nvda-005-fee500-45d.json", "WETH", "5 WETH"),
]

SHORT = {
    "USDG/NVDA V3 0.05%": "USDG .05",
    "USDG/NVDA V4 0.30%": "USDG .30",
    "USDG/NVDA V4 0.01%": "USDG .01",
    "USDG/NVDA V4 0.0375%": "USDG .0375",
    "ETH/NVDA V3 0.05%": "ETH .05",
    "ETH/NVDA V3 0.30%": "ETH .30",
    "ETH/NVDA V4 0.05%": "ETH .05 V4",
}


def _pool_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for label, filename, quote, capital_label in POOLS:
        path = REPO / "research" / "out" / filename
        if not path.exists():
            continue
        with open(path, "r", encoding="utf-8") as fh:
            d = json.load(fh)
        capital = float(d["capital"])
        fees = float(d["feesUsd"])
        position = float(d["positionValueUsd"])
        hodl = float(d["hodlValueUsd"])
        window_days = float(d.get("windowDays", 45.0))
        duration_days = float(d.get("durationSeconds", window_days * 86_400.0)) / 86_400.0
        il = position - hodl
        net = fees + il
        total = fees + position - capital
        price_move_pct = (hodl / capital - 1.0) * 100.0
        fee_apr = fees / capital * 100.0 * 365.0 / duration_days
        net_apr = net / capital * 100.0 * 365.0 / duration_days
        total_pct = total / capital * 100.0
        total_apr = total_pct * 365.0 / duration_days
        fee_pips = int(d["feePips"])
        fee_tier = {
            500: "0.05%",
            3000: "0.30%",
            100: "0.01%",
            375: "0.0375%",
        }.get(fee_pips, f"{fee_pips / 10_000:g}%")
        rows.append(
            {
                "label": label,
                "quote": quote,
                "capital_label": capital_label,
                "capital": capital,
                "fee_tier": fee_tier,
                "fees": fees,
                "il": il,
                "price_move_pct": price_move_pct,
                "net": net,
                "total": total,
                "fee_apr": fee_apr,
                "net_apr": net_apr,
                "total_pct": total_pct,
                "total_apr": total_apr,
                "guard": float(d.get("inGuardPct", 0.0)),
                "swaps": int(d.get("swaps", 0)),
                "window_days": window_days,
                "duration_days": duration_days,
            }
        )
    return rows


def _signed_money(x: float) -> str:
    return f"{'+' if x >= 0 else '-'}${abs(x):,.2f}"


def _amount(x: float, quote: str) -> str:
    if quote == "USDG":
        return _signed_money(x)
    return f"{x:+.4f} WETH"


def _amount_abs(x: float, quote: str) -> str:
    if quote == "USDG":
        return money(x)
    return f"{x:.4f} WETH"


def _row(df: pd.DataFrame, run: str, window: str):
    hit = df[(df["run"] == run) & (df["window"] == window)]
    if hit.empty:
        raise KeyError(f"missing {run}/{window}")
    return hit.iloc[0]


def _load_paths() -> dict[str, list[float]]:
    frames = []
    for name in ("baseline_paths.csv", "optimize_paths.csv"):
        p = OUT / name
        if p.exists():
            frames.append(pd.read_csv(p))
    p = pd.concat(frames, ignore_index=True)
    p = p[p["window"] == "45d"]
    out: dict[str, list[float]] = {}
    for run, label in (
        ("hodl", "HODL"),
        ("always_a", "Always A"),
        ("risk_only_a", "Baseline 1h"),
        ("risk_only_a_2h15k_guard75", "Improved 2h"),
        ("optimize_C_skew1000", "C skew 1k"),
        ("optimize_C_guard500", "C skew 2.5k"),
    ):
        sub = p[p["run"] == run].sort_values("step")
        if not sub.empty:
            out[label] = sub["nav"].tolist()
    return out


def main() -> None:
    base = pd.read_csv(OUT / "baseline_summary.csv")
    opt = pd.read_csv(OUT / "optimize_summary.csv")
    large = pd.read_csv(OUT / "large_nav_summary.csv")
    mc = json.loads((OUT / "optimize_mc.json").read_text(encoding="utf-8"))
    pools = _pool_rows()
    paths = _load_paths()

    # Key scenario rows ----------------------------------------------------
    h45, h20 = _row(base, "hodl", "45d"), _row(base, "hodl", "20d")
    a45, a20 = _row(base, "always_a", "45d"), _row(base, "always_a", "20d")
    b45, b20 = _row(base, "always_b", "45d"), _row(base, "always_b", "20d")
    asb45, asb20 = _row(base, "allocator_as_built", "45d"), _row(base, "allocator_as_built", "20d")
    base45, base20 = _row(base, "risk_only_a", "45d"), _row(base, "risk_only_a", "20d")
    imp45, imp20 = _row(base, "risk_only_a_2h15k_guard75", "45d"), _row(base, "risk_only_a_2h15k_guard75", "20d")
    rec45, rec20 = _row(opt, "optimize_C_skew1000", "45d"), _row(opt, "optimize_C_skew1000", "20d")
    agg45, agg20 = _row(opt, "optimize_C_guard500", "45d"), _row(opt, "optimize_C_guard500", "20d")
    arms45, arms20 = _row(base, "always_arms", "45d"), _row(base, "always_arms", "20d")

    # KPI cards ------------------------------------------------------------
    def kpi(label: str, value: str, sub: str, color: str = "") -> str:
        return (
            f'<div class="kpi {color}"><div class="kpi-label">{label}</div>'
            f'<div class="kpi-value">{value}</div><div class="kpi-sub">{sub}</div></div>'
        )

    kpis = "".join(
        [
            kpi("Passive Book A", money(a45["net_vs_hodl"]), f'fee {a45["book_fee_apr_pct"]:.1f}% APR · net {a45["simple_net_apr_pct"]:.1f}% APR', "blue"),
            kpi("Passive Book B", money(b45["net_vs_hodl"]), f'fee {b45["book_fee_apr_pct"]:.1f}% APR · net {b45["simple_net_apr_pct"]:.1f}% APR', "amber"),
            kpi("Baseline allocator", money(base45["net_vs_hodl"]), f'1h / 10k / 50% · 20d {money(base20["net_vs_hodl"])}', "muted"),
            kpi("Improved 2h / 15k / 75%", money(imp45["net_vs_hodl"]), f'net {imp45["simple_net_apr_pct"]:.1f}% APR · 20d {money(imp20["net_vs_hodl"])}', "green"),
            kpi("Recommended C skew 1k", money(rec45["net_vs_hodl"]), f'net {rec45["simple_net_apr_pct"]:.1f}% APR · 20d {money(rec20["net_vs_hodl"])}', "green"),
        ]
    )

    # Pool table -----------------------------------------------------------
    pool_rows = []
    for p in pools:
        pool_rows.append(
            [
                f'<b>{html.escape(p["label"])}</b>',
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
        y_label="APR (%)",
    )

    # Scenario table -------------------------------------------------------
    scenario_defs = [
        ("HODL", h45, h20, ""),
        ("Always Book A", a45, a20, ""),
        ("Always Book B", b45, b20, ""),
        ("Allocator as built", asb45, asb20, "warn"),
        ("Baseline 1h / 10k / 50%", base45, base20, ""),
        ("Improved 2h / 15k / 75%", imp45, imp20, "good"),
        ("<b>Recommended C skew 1k</b>", rec45, rec20, "good"),
        ("Aggressive C skew 2.5k", agg45, agg20, ""),
        ("Always arms", arms45, arms20, ""),
    ]
    scenario_rows = []
    for label, r45, r20, cls in scenario_defs:
        label_html = label if label.startswith("<b>") else html.escape(label)
        scenario_rows.append(
            [
                label_html,
                money(r45["net_vs_hodl"]),
                pct(float(r45["simple_net_apr_pct"])),
                money(r45["cum_fees"]),
                pct(float(r45["book_fee_apr_pct"])),
                pct(float(r45["max_drawdown"]) * 100),
                money(r20["net_vs_hodl"]),
                pct(float(r20["simple_net_apr_pct"])),
                money(r20["cum_fees"]),
                f'{int(r45["actions"])}/{int(r20["actions"])}',
            ]
        )
    scenario_table = table_html(
        ["Scenario", "45d net", "45d net APR", "45d fees", "45d book fee APR", "45d DD", "20d net", "20d net APR", "20d fees", "actions 45/20"],
        scenario_rows,
    )

    # Rewards waterfall ----------------------------------------------------
    reward_defs = [
        ("Always Book A", a45),
        ("Baseline 1h / 10k / 50%", base45),
        ("Improved 2h / 15k / 75%", imp45),
        ("<b>Recommended C skew 1k</b>", rec45),
        ("Aggressive C skew 2.5k", agg45),
        ("Always arms", arms45),
    ]
    reward_rows = []
    for label, r in reward_defs:
        label_html = label if label.startswith("<b>") else html.escape(label)
        arm = float(r["cum_arm_interest"])
        nvda = float(r["cum_nvda_yield"])
        borrow = float(r["cum_borrow_cost"])
        gas = float(r["cum_gas"])
        reward_rows.append(
            [
                label_html,
                money(float(r["book_a_fees"])),
                money(float(r["book_b_fees"])),
                money(arm),
                money(nvda),
                money(borrow),
                money(gas),
                money(float(r["cum_net_carry"])),
                money(float(r["cum_il_vs_hodl"])),
                money(float(r["net_vs_hodl"])),
            ]
        )
    reward_table = table_html(
        ["Scenario", "Book A fees", "Book B fees", "Arm USDG", "NVDA yield", "Borrow", "Gas", "Net carry", "LP mark/timing", "Net vs HODL"],
        reward_rows,
    )

    # Book A / B / arm cards ----------------------------------------------
    book_cards = f"""
    <div class="three">
      <div class="card">
        <div class="card-kicker">Book A · deep market</div>
        <div class="card-big">$587.8M</div>
        <div class="card-sub">45d volume · $293.9k pool fees · 1.26M swaps</div>
        <div class="mini"><span>Avg active liquidity</span><b>$306.2M</b></div>
        <div class="mini"><span>Single-pool fee APR</span><b>19.9%</b></div>
        <div class="mini"><span>Single-pool net vs HODL</span><b>+$147</b></div>
      </div>
      <div class="card">
        <div class="card-kicker">Book B · thin market</div>
        <div class="card-big">$7.6M</div>
        <div class="card-sub">45d volume · $22.8k pool fees · 30.7k swaps</div>
        <div class="mini"><span>Avg active liquidity</span><b>$14.8M</b></div>
        <div class="mini"><span>Single-pool fee APR</span><b>22.4%</b></div>
        <div class="mini"><span>Single-pool net vs HODL</span><b>+$180</b></div>
      </div>
      <div class="card">
        <div class="card-kicker">Morpho / Spiral arm</div>
        <div class="card-big">3% + 3%</div>
        <div class="card-sub">USDG lend APR + NVDA net APR after borrow</div>
        <div class="mini"><span>Risk-only contribution</span><b>~$1.7</b></div>
        <div class="mini"><span>Always-arms net carry</span><b>+$13.4</b></div>
        <div class="mini"><span>Borrow cap in model</span><b>$15k</b></div>
      </div>
    </div>
    """

    # Scaling table --------------------------------------------------------
    def lrow(cap: float, run: str, window: str):
        hit = large[(large["nav_cap"] == cap) & (large["run"] == run) & (large["window"] == window)]
        return None if hit.empty else hit.iloc[0]

    scaling_caps = [10_000, 100_000, 1_000_000, 2_000_000]
    scaling_rows = []
    for cap in scaling_caps:
        if cap == 10_000:
            aa = a45
            imp = imp45
            agg = agg45
            bb = b45
        else:
            aa = lrow(float(cap), "large_always_a", "45d")
            imp = lrow(float(cap), "large_A_2h15k75", "45d")
            agg = lrow(float(cap), "large_C_3k_skew", "45d")
            bb = lrow(float(cap), "large_always_b", "45d")
        if aa is None or imp is None or agg is None or bb is None:
            continue
        label = "$10k" if cap == 10_000 else f"${cap/1e6:.1f}M" if cap >= 1_000_000 else f"${cap/1e3:.0f}k"
        scaling_rows.append(
            [
                label,
                pct(float(aa["simple_net_apr_pct"])),
                pct(float(imp["simple_net_apr_pct"])),
                pct(float(agg["simple_net_apr_pct"])),
                pct(float(bb["simple_net_apr_pct"])),
                pct(float(aa["book_fee_apr_pct"])),
                pct(float(imp["book_fee_apr_pct"])),
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
        "Large NAV: 45d net APR",
        y_label="Net APR (%)",
    )

    # Risk table -----------------------------------------------------------
    def mc_row(key: str, label: str):
        c45 = mc["configs"][key]["45d"]
        c20 = mc["configs"][key]["20d"]
        return [
            html.escape(label),
            money(c45["net_vs_hodl"]["median"]),
            money(c45["net_vs_hodl"]["p05"]),
            f'{c45["paired_win_rate"]*100:.0f}%',
            money(c20["net_vs_hodl"]["median"]),
            money(c20["net_vs_hodl"]["p05"]),
            f'{c20["paired_win_rate"]*100:.0f}%',
        ]

    risk_rows = [
        mc_row("risk_only_1h10k50", "Baseline 1h/10k/50"),
        mc_row("A_2h15k75", "Improved A"),
        mc_row("C_3k_skew2500_guard500", "Aggressive C 2.5k"),
    ]
    risk_rows.append(
        [
            "Always A",
            money(mc["always_a"]["45d"]["net_vs_hodl"]["median"]),
            money(mc["always_a"]["45d"]["net_vs_hodl"]["p05"]),
            "—",
            money(mc["always_a"]["20d"]["net_vs_hodl"]["median"]),
            money(mc["always_a"]["20d"]["net_vs_hodl"]["p05"]),
            "—",
        ]
    )
    risk_table = table_html(
        ["20 block-bootstrap paths", "45d median", "45d p05", "45d win vs A", "20d median", "20d p05", "20d win vs A"],
        risk_rows,
    )

    # NAV chart ------------------------------------------------------------
    nav_chart = svg_lines(
        [
            ("HODL", paths["HODL"], "#9ca3af"),
            ("Always A", paths["Always A"], "#d97706"),
            ("Baseline 1h", paths["Baseline 1h"], "#2563eb"),
            ("Improved 2h", paths["Improved 2h"], "#8b5cf6"),
            ("C skew 1k", paths["C skew 1k"], "#0f9d76"),
            ("C skew 2.5k", paths["C skew 2.5k"], "#dc2626"),
        ],
        "45-day NAV: passive books vs allocator scenarios",
    )

    # HTML ----------------------------------------------------------------
    css = """
    :root{--bg:#f5f7fa;--card:#ffffff;--ink:#111827;--muted:#64748b;--line:#e2e8f0;
      --blue:#2563eb;--green:#0f9d76;--amber:#d97706;--red:#dc2626;--purple:#8b5cf6}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .wrap{max-width:1180px;margin:0 auto;padding:32px 22px 64px}
    h1{font-size:30px;line-height:1.15;margin:0 0 6px;letter-spacing:-.02em}
    h2{font-size:21px;margin:38px 0 12px;letter-spacing:-.01em}
    h3{font-size:15px;margin:0 0 6px}
    .sub{color:var(--muted);margin:0 0 22px;max-width:850px}
    .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:20px 0 8px}
    .kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:15px 16px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
    .kpi-label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700}
    .kpi-value{font-size:24px;font-weight:750;margin:6px 0 3px;letter-spacing:-.02em}
    .kpi-sub{font-size:12px;color:var(--muted)}
    .kpi.blue{border-top:3px solid var(--blue)} .kpi.amber{border-top:3px solid var(--amber)}
    .kpi.green{border-top:3px solid var(--green)} .kpi.muted{border-top:3px solid #94a3b8}
    .three{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin:10px 0 8px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
    .card-kicker{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700}
    .card-big{font-size:28px;font-weight:750;margin:6px 0 2px;letter-spacing:-.02em}
    .card-sub{font-size:12px;color:var(--muted);margin-bottom:10px}
    .mini{display:flex;justify-content:space-between;gap:10px;border-top:1px solid var(--line);padding:7px 0;font-size:12.5px}
    .mini span{color:var(--muted)} .mini b{font-weight:650}
    .tbl{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:12px}
    .tbl th{background:#f1f5f9;color:#334155;text-align:right;padding:8px 9px;font-weight:700;white-space:nowrap}
    .tbl td{border-top:1px solid var(--line);padding:7px 9px;text-align:right;white-space:nowrap;color:#1f2937}
    .tbl td:first-child,.tbl th:first-child{text-align:left}
    .tbl tr:nth-child(even) td{background:#fbfcfe}
    .table-wrap{overflow-x:auto;margin:10px 0}
    .chart{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:14px;margin:10px 0 12px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
    .chart-title{fill:#111827;font-size:13px;font-weight:700}
    .axis{fill:#64748b;font-size:10.5px}.legend{fill:#475569;font-size:10.5px}
    .grid{stroke:#e2e8f0;stroke-width:1}.zero{stroke:#94a3b8;stroke-width:1.2}
    .note{color:var(--muted);font-size:12.5px;margin:6px 0 14px;max-width:1000px}
    .callout{background:#ecfdf5;border:1px solid #a7f3d0;border-left:4px solid var(--green);border-radius:10px;padding:12px 14px;margin:10px 0 16px;font-size:13px;color:#065f46}
    .warn{background:#fffbeb;border:1px solid #fde68a;border-left:4px solid var(--amber);border-radius:10px;padding:12px 14px;margin:10px 0 16px;font-size:13px;color:#92400e}
    .bad{background:#fef2f2;border:1px solid #fecaca;border-left:4px solid var(--red);border-radius:10px;padding:12px 14px;margin:10px 0 16px;font-size:13px;color:#991b1b}
    .valid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin:10px 0}
    .valid .card{padding:14px 16px}
    .valid .big{font-size:22px;font-weight:750;margin:4px 0}
    code{background:#eef2f7;padding:2px 6px;border-radius:5px;font-size:12px}
    .footer{color:var(--muted);font-size:12px;border-top:1px solid var(--line);margin-top:38px;padding-top:18px}
    """

    html_doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NVDA tranched vault — scenario compare</title>
<style>{css}</style></head><body><div class="wrap">

<h1>NVDA tranched vault — scenario compare</h1>
<p class="sub">One 45-day real Uniswap tape. Single pools vs the Book A + Book B + Morpho/Spiral
allocator. Base NAV $10,000. Fees are realized; IL and price/HODL are marked to market.
The highlighted rows are in-sample; the risk panel shows the bootstrap caveat.</p>

<div class="kpis">{kpis}</div>
<div class="note">“Passive Book A/B” are always-in-pool benchmarks. “Baseline” is the risk-only
allocator at 1h / $10k volume floor / 50% guard. “Improved” is 2h / $15k / 75% guard.
“Recommended C skew 1k” adds a 3,000-tick base, 500-tick guard, and 1,000-tick inventory skew.</div>

<h2>1. Every single pool over the 45 days</h2>
<p class="note">Fees are what the pool paid the LP. IL is LP value minus the HODL basket. Total P&L is
fees + LP value − capital. USDG pools use $10,000; ETH pools use 5 WETH because the tape is
WETH-quoted. Percentages are directly comparable; dollar/WETH amounts are not. APRs use the actual
sim duration; the V4 0.01% pool covers 41.8 days, the others 45.0 days.</p>
{pool_table}
{pool_chart}
<div class="callout"><b>What this shows:</b> the fees are real, but the higher fee tier is not
automatically the better net. Book B’s 0.30% pool grosses 22.4% APR but only nets 14.6% after IL;
the 0.01% pool grosses 11.5% but keeps 9.3% because its IL is much smaller. The ETH books gross
30–40% and keep 28–39% in ETH because the ETH-quoted NVDA move is smaller.</div>
<div class="warn"><b>Important:</b> the 1.00% USDG pools had one trade in the downloaded set and are
excluded. The 0.0375% pool is included but is thin; it is not the Book B pool.</div>

<h2>2. Book A vs Book B vs the arm</h2>
{book_cards}
<p class="note">Book A is the deep workhorse: 1.26M swaps and $587.8M of volume. Book B has a higher
fee tier but only 1.3% of the volume and 4.8% of the liquidity. The allocator therefore uses Book A
as the main book; Book B is a thin backup. The arm is small at $10k: ~$1.7 of contribution in the
risk-only allocator and ~$13.4 of net carry in the full always-arms loop.</p>

<h2>3. Where the money comes from</h2>
{reward_table}
<p class="note">Net carry = book fees + arm USDG + NVDA yield − borrow − gas. The residual
“LP mark/timing” is the LP value versus the HODL basket, including the value of being in the arm
during the down move. It is positive when the risk switch avoids part of the IL; it is not pure
static IL. The single-pool table shows the pure static IL is negative.</p>
<div class="callout"><b>What this shows:</b> the book is 99%+ of the reward. The allocator’s value
is not the 3% arm; it is (a) harvesting Book A fees and (b) avoiding the worst of the IL by moving
to the arm when volume/volatility/guard conditions say the book is unsafe.</div>

<h2>4. Allocator scenarios</h2>
{scenario_table}
{nav_chart}
<div class="callout"><b>What this shows:</b> the as-built allocator is essentially always-arms
(−$4.52). The risk-only baseline fixes that (+$191). The improved 2h/15k/75% config is +$431.
The moderate C skew 1k is +$502; the aggressive C skew 2.5k is +$512. The last 20 days show the
difference: baseline −$106, improved +$47, C skew 1k +$61, aggressive +$82.</div>
<div class="warn"><b>Do not quote the in-sample best as expected return.</b> The 20-path bootstrap
below says C wins more often but has a much worse p05. Use A or the baseline for production until a
fresh tape and a tail test pass.</div>

<h2>5. Does it scale?</h2>
{scaling_table}
{scaling_chart}
<p class="note">Exact fee share at $1M/$2M. Book A is ~1–2% of its pool, so it scales. Book B is
21%/43% of its pool at $1M/$2M and turns negative at $2M. C is still positive over 45d at $1M/$2M,
but the 20d is negative (−$21k/−$44k). Cap Book B around $250k–$500k; size Book A at $1M–$2M only
with a fresh-tape/tail test.</p>

<h2>6. Risk check — the honest part</h2>
{risk_table}
<p class="note">20 fixed-length 24-hour block-bootstrap paths, paired vs always-A. “p05” is the
5th-percentile net; “win” is the share of paired paths the config beats always-A. C wins more often
but has the worst p05; always-A has the best mean and p05. The recommended C skew 1k is between A
and C and needs its own bootstrap.</p>
<div class="bad"><b>What this means:</b> this is a good research model, not a promise. The in-sample
ranking is not the risk-adjusted ranking. Do not deploy C/D as a return strategy without a tail
hedge or a smaller skew.</div>

<h2>7. Why the model is credible</h2>
<div class="valid">
  <div class="card"><div class="kicker">Book A fee match</div><div class="big">+0.19%</div><div class="note">model $245.65 vs research $245.19</div></div>
  <div class="card"><div class="kicker">Book B fee match</div><div class="big">+0.72%</div><div class="note">model $278.25 vs research $276.26</div></div>
  <div class="card"><div class="kicker">Tests</div><div class="big">76 passed</div><div class="note">keeper vectors, LP math, NAV identity, exact fee share</div></div>
  <div class="card"><div class="kicker">NAV conservation</div><div class="big">&lt; $0.01</div><div class="note">max error on the real tape</div></div>
</div>
<div class="callout"><b>What this proves:</b> the simulator reproduces the pool-level fee cash
flows, the Book A/B accounting, the arm borrow/lend/repay logic, the guard pull/re-arm, and the
keeper’s one-action-per-run semantics. It does not prove future returns; that is what the fresh
tape and tail test are for.</div>

<h2>8. Assumptions</h2>
<p class="note">Book A is a V3 0.05% proxy; no V4 USDG/NVDA 0.05% pool exists in the downloaded
set. Book B is the real V4 0.30% pool. Arm: 3% USDG lend, 3% NVDA total yield APR after borrowing
cost, 3% borrow, $15k borrow cap, 20% relative arm caps. Gas $0.02/action. No MEV/slippage/price
impact. Both the 45d and last-20d windows are down regimes; the bootstrap preserves the same regime.
ETH/NVDA is a separate quote-asset comparison; ETH/USD is not in the tape.</p>

<div class="footer">Generated from <code>research/cadcad/allocator/out/</code> ·
45-day window ending 2026-10-24 · model: 76 tests · this page is a research artifact, not
investment advice. For interactive what-if testing, open <code>scenario_lab.html</code>.</div>
</div></body></html>"""

    OUT.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(html_doc, encoding="utf-8")
    print(f"wrote {REPORT} ({len(html_doc)/1024:.1f} KiB)")


if __name__ == "__main__":
    main()
