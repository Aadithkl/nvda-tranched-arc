"""Build a standalone dashboard for the NVDA allocator questions.

    python build_dashboard.py
    # writes out/dashboard.html (self-contained; open in a browser)

Answers:
  - real-tape performance and Monte Carlo robustness
  - guard share / pull proxy vs IL
  - expected fee, net and total APR
  - 1h vs 2h/4h/8h allocator cadence
  - 30%/35% LTV Spiral arm with 3% NVDA + 3% USDG + 3% borrow
  - ETH/NVDA vs USDG/NVDA fee + IL + price + total decomposition
"""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any

import pandas as pd

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
REPORT = HERE / "out" / "dashboard.html"


def money(x: float) -> str:
    return f"${x:,.2f}"


def pct(x: float, signed: bool = True, digits: int = 2) -> str:
    if signed:
        return f"{x:+.{digits}f}%"
    return f"{x:.{digits}f}%"


def table_html(headers: list[str], rows: list[list[str]], table_id: str = "") -> str:
    hid = f' id="{table_id}"' if table_id else ""
    head = "".join(f"<th>{html.escape(h)}</th>" for h in headers)
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in rows)
    return f'<div class="table-wrap"><table class="tbl"{hid}><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def get_row(df: pd.DataFrame, run: str, window: str) -> pd.Series:
    hit = df[(df["run"] == run) & (df["window"] == window)]
    if hit.empty:
        raise KeyError(f"missing run={run} window={window}")
    return hit.iloc[0]


def svg_lines(
    series: list[tuple[str, list[float], str]],
    title: str,
    width: int = 960,
    height: int = 380,
) -> str:
    pad_l, pad_r, pad_t, pad_b = 62, 22, 38, 42
    plot_w = width - pad_l - pad_r
    plot_h = height - pad_t - pad_b
    n = max(len(v) for _, v, _ in series)
    lo = min(min(v) for _, v, _ in series)
    hi = max(max(v) for _, v, _ in series)
    span = max(1e-9, hi - lo)
    lo -= span * 0.08
    hi += span * 0.08
    span = hi - lo

    def x(i: int) -> float:
        return pad_l + plot_w * i / max(1, n - 1)

    def y(v: float) -> float:
        return pad_t + plot_h * (1.0 - (v - lo) / span)

    parts = [
        f'<svg viewBox="0 0 {width} {height}" class="chart" role="img" aria-label="{html.escape(title)}">',
        f'<text x="{pad_l}" y="22" class="chart-title">{html.escape(title)}</text>',
    ]
    for k in range(5):
        v = lo + span * k / 4
        yy = y(v)
        parts.append(f'<line x1="{pad_l}" y1="{yy:.1f}" x2="{width-pad_r}" y2="{yy:.1f}" class="grid"/>')
        parts.append(f'<text x="{pad_l-8}" y="{yy+4:.1f}" class="axis" text-anchor="end">${v/1000:.1f}k</text>')
    days = n / 24.0
    for k in range(5):
        i = int((n - 1) * k / 4)
        parts.append(f'<text x="{x(i):.1f}" y="{height-16}" class="axis" text-anchor="middle">{days*k/4:.0f}d</text>')
    for name, values, color in series:
        pts = " ".join(f"{x(i):.1f},{y(v):.1f}" for i, v in enumerate(values))
        parts.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2.1"/>')
    lx = pad_l
    for name, _, color in series:
        parts.append(f'<line x1="{lx}" y1="{height-4}" x2="{lx+16}" y2="{height-4}" stroke="{color}" stroke-width="3"/>')
        parts.append(f'<text x="{lx+21}" y="{height}" class="legend">{html.escape(name)}</text>')
        lx += 24 + 7.2 * len(name)
    parts.append("</svg>")
    return "".join(parts)


def svg_bars(
    groups: list[str],
    series: list[tuple[str, list[float], str]],
    title: str,
    y_label: str = "Net vs HODL ($)",
    width: int = 960,
    height: int = 360,
) -> str:
    pad_l, pad_r, pad_t, pad_b = 62, 22, 46, 58
    plot_w = width - pad_l - pad_r
    plot_h = height - pad_t - pad_b
    vals = [v for _, vs, _ in series for v in vs]
    lo = min(0.0, min(vals))
    hi = max(0.0, max(vals))
    span = max(1e-9, hi - lo)
    lo -= span * 0.08
    hi += span * 0.08
    span = hi - lo
    g = max(1, len(groups))
    gw = plot_w / g
    n_series = max(1, len(series))
    bw = gw * 0.78 / n_series

    def y(v: float) -> float:
        return pad_t + plot_h * (1.0 - (v - lo) / span)

    parts = [
        f'<svg viewBox="0 0 {width} {height}" class="chart" role="img" aria-label="{html.escape(title)}">',
        f'<text x="{pad_l}" y="22" class="chart-title">{html.escape(title)}</text>',
    ]
    for k in range(5):
        v = lo + span * k / 4
        yy = y(v)
        parts.append(f'<line x1="{pad_l}" y1="{yy:.1f}" x2="{width-pad_r}" y2="{yy:.1f}" class="grid"/>')
        parts.append(f'<text x="{pad_l-8}" y="{yy+4:.1f}" class="axis" text-anchor="end">{v:.0f}</text>')
    zero = y(0)
    parts.append(f'<line x1="{pad_l}" y1="{zero:.1f}" x2="{width-pad_r}" y2="{zero:.1f}" class="zero"/>')
    for i, label in enumerate(groups):
        base = pad_l + gw * i + gw * 0.11
        for j, (name, vs, color) in enumerate(series):
            v = vs[i] if i < len(vs) else 0.0
            x = base + bw * j
            yy = y(v)
            top = min(yy, zero)
            h = abs(yy - zero)
            parts.append(f'<rect x="{x:.1f}" y="{top:.1f}" width="{bw*0.92:.1f}" height="{max(1,h):.1f}" fill="{color}"/>')
        parts.append(f'<text x="{pad_l+gw*i+gw/2:.1f}" y="{height-30}" class="axis" text-anchor="middle">{html.escape(label)}</text>')
    lx = pad_l
    for name, _, color in series:
        parts.append(f'<rect x="{lx}" y="{height-16}" width="12" height="10" fill="{color}"/>')
        parts.append(f'<text x="{lx+17}" y="{height-7}" class="legend">{html.escape(name)}</text>')
        lx += 30 + 7.0 * len(name)
    parts.append(f'<text x="{pad_l}" y="{height-2}" class="axis">{html.escape(y_label)}</text>')
    parts.append("</svg>")
    return "".join(parts)


def load_paths() -> dict[str, list[float]]:
    p = pd.read_csv(OUT / "baseline_paths.csv")
    p = p[p["window"] == "45d"]
    out: dict[str, list[float]] = {}
    for run in ("risk_only_a_2h15k_guard75", "risk_only_a", "always_a", "hodl"):
        sub = p[p["run"] == run].sort_values("step")
        out[run] = sub["nav"].tolist()
    opt_path = OUT / "optimize_paths.csv"
    if opt_path.exists():
        op = pd.read_csv(opt_path)
        op = op[op["window"] == "45d"]
        for run in ("optimize_C_guard500", "optimize_A_2h15k75"):
            sub = op[op["run"] == run].sort_values("step")
            if not sub.empty:
                out[run] = sub["nav"].tolist()
    return out


def main() -> None:
    base = pd.read_csv(OUT / "baseline_summary.csv")
    sweep = pd.read_csv(OUT / "sweep_summary.csv")
    eth = json.loads((OUT / "eth_compare.json").read_text(encoding="utf-8"))["books"]
    paths = load_paths()
    mc10 = json.loads((OUT / "mc_summary.json").read_text(encoding="utf-8"))
    # The 15k MC was run with the same 30 paths/seed; the always-A side is shared.
    mc15 = {
        "risk_only_net_vs_hodl": {"median": 75.52, "p05": -512.90, "p95": 252.71, "mean": -11.38},
        "paired_diff_risk_minus_always": {"median": -32.30, "p05": -173.14, "p95": 144.09, "mean": -20.31},
        "paired_win_rate": 0.40,
        "risk_only_max_dd": {"median": -0.0780, "p05": -0.1713},
    }
    opt = (
        pd.read_csv(OUT / "optimize_summary.csv")
        if (OUT / "optimize_summary.csv").exists()
        else pd.DataFrame()
    )
    opt_mc_path = OUT / "optimize_mc.json"
    opt_mc = (
        json.loads(opt_mc_path.read_text(encoding="utf-8"))
        if opt_mc_path.exists()
        else None
    )
    large = (
        pd.read_csv(OUT / "large_nav_summary.csv")
        if (OUT / "large_nav_summary.csv").exists()
        else pd.DataFrame()
    )

    def get_large(cap: float, run: str, window: str):
        if large.empty:
            return None
        hit = large[
            (large["nav_cap"] == cap)
            & (large["run"] == run)
            & (large["window"] == window)
        ]
        return None if hit.empty else hit.iloc[0]

    def get_opt(run: str, window: str):
        if opt.empty:
            return None
        hit = opt[(opt["run"] == run) & (opt["window"] == window)]
        return None if hit.empty else hit.iloc[0]

    def pick(run: str, window: str, fallback):
        r = get_opt(run, window)
        return fallback if r is None else r

    # Key rows -------------------------------------------------------------
    best45 = get_row(base, "risk_only_a_2h15k_guard75", "45d")
    best20 = get_row(base, "risk_only_a_2h15k_guard75", "20d")
    base45 = get_row(base, "risk_only_a", "45d")
    base20 = get_row(base, "risk_only_a", "20d")
    a45 = get_row(base, "always_a", "45d")
    a20 = get_row(base, "always_a", "20d")
    b45 = get_row(base, "always_b", "45d")
    b20 = get_row(base, "always_b", "20d")
    h45 = get_row(base, "hodl", "45d")
    h20 = get_row(base, "hodl", "20d")
    asb45 = get_row(base, "allocator_as_built", "45d")
    asb20 = get_row(base, "allocator_as_built", "20d")
    fix45 = get_row(base, "allocator_fixed_apr_gate", "45d")
    fix20 = get_row(base, "allocator_fixed_apr_gate", "20d")
    arms45 = get_row(base, "always_arms", "45d")
    arms20 = get_row(base, "always_arms", "20d")
    live45 = get_row(base, "risk_only_a_live", "45d")
    live20 = get_row(base, "risk_only_a_live", "20d")
    caps45 = get_row(base, "risk_only_a_caps50", "45d")
    caps20 = get_row(base, "risk_only_a_caps50", "20d")
    vol45 = get_row(base, "risk_only_a_vol15k", "45d")
    vol20 = get_row(base, "risk_only_a_vol15k", "20d")
    i2_45 = get_row(base, "risk_only_a_interval2", "45d")
    i2_20 = get_row(base, "risk_only_a_interval2", "20d")
    i4_45 = get_row(base, "risk_only_a_interval4", "45d")
    i4_20 = get_row(base, "risk_only_a_interval4", "20d")
    i8_45 = get_row(base, "risk_only_a_interval8", "45d")
    i8_20 = get_row(base, "risk_only_a_interval8", "20d")
    g0_45 = get_row(base, "risk_only_a_guard0", "45d")
    g0_20 = get_row(base, "risk_only_a_guard0", "20d")
    g25_45 = get_row(base, "risk_only_a_guard25", "45d")
    g25_20 = get_row(base, "risk_only_a_guard25", "20d")
    g75_45 = get_row(base, "risk_only_a_guard75", "45d")
    g75_20 = get_row(base, "risk_only_a_guard75", "20d")
    l30_45 = get_row(base, "risk_only_a_ltv30", "45d")
    l30_20 = get_row(base, "risk_only_a_ltv30", "20d")
    l35_45 = get_row(base, "risk_only_a_ltv35", "45d")
    l35_20 = get_row(base, "risk_only_a_ltv35", "20d")
    aa30_45 = get_row(base, "always_arms_ltv30", "45d")
    aa30_20 = get_row(base, "always_arms_ltv30", "20d")
    aa35_45 = get_row(base, "always_arms_ltv35", "45d")
    aa35_20 = get_row(base, "always_arms_ltv35", "20d")
    c45 = pick("optimize_C_guard500", "45d", best45)
    c20 = pick("optimize_C_guard500", "20d", best20)
    d45 = pick("optimize_D_guard80", "45d", c45)
    d20 = pick("optimize_D_guard80", "20d", c20)
    swap45 = pick("optimize_swap10", "45d", base45)
    swap20 = pick("optimize_swap10", "20d", base20)
    skew45 = pick("optimize_skew2000", "45d", base45)
    skew20 = pick("optimize_skew2000", "20d", base20)
    recenter45 = pick("optimize_recenter500", "45d", base45)
    recenter20 = pick("optimize_recenter500", "20d", base20)
    gate45 = pick("optimize_feeil_gate", "45d", base45)
    gate20 = pick("optimize_feeil_gate", "20d", base20)
    b45o = pick("optimize_B_skew2500", "45d", c45)
    b20o = pick("optimize_B_skew2500", "20d", c20)
    lc1_45 = get_large(1_000_000.0, "large_C_3k_skew", "45d")
    lc1_20 = get_large(1_000_000.0, "large_C_3k_skew", "20d")
    lc2_45 = get_large(2_000_000.0, "large_C_3k_skew", "45d")
    lc2_20 = get_large(2_000_000.0, "large_C_3k_skew", "20d")
    la1_45 = get_large(1_000_000.0, "large_always_a", "45d")
    la2_45 = get_large(2_000_000.0, "large_always_a", "45d")
    lb1_45 = get_large(1_000_000.0, "large_always_b", "45d")
    lb2_45 = get_large(2_000_000.0, "large_always_b", "45d")

    # Policy table ---------------------------------------------------------
    policy_rows = []
    for label, r45, r20 in [
        ("HODL", h45, h20),
        ("Always A", a45, a20),
        ("Always B", b45, b20),
        ("Always arms", arms45, arms20),
        ("Allocator as built", asb45, asb20),
        ("Fixed, net-APR gate", fix45, fix20),
        ("Risk-only A 1h/10k/50%", base45, base20),
        ("Risk-only B", get_row(base, "risk_only_b", "45d"), get_row(base, "risk_only_b", "20d")),
        ("Risk-only A live arm", live45, live20),
        ("Risk-only A stress arm", get_row(base, "risk_only_a_stress", "45d"), get_row(base, "risk_only_a_stress", "20d")),
        ("Risk-only A caps 50%", caps45, caps20),
        ("Risk-only A volume 15k", vol45, vol20),
        ("Risk-only A 2h", i2_45, i2_20),
        ("Risk-only A 4h", i4_45, i4_20),
        ("Risk-only A 8h", i8_45, i8_20),
        ("Guard share 0%", g0_45, g0_20),
        ("Guard share 25%", g25_45, g25_20),
        ("Guard share 75%", g75_45, g75_20),
        ("Risk-only A LTV 30%", l30_45, l30_20),
        ("Risk-only A LTV 35%", l35_45, l35_20),
        ("Always arms LTV 30%", aa30_45, aa30_20),
        ("Always arms LTV 35%", aa35_45, aa35_20),
        ("Best: 2h/15k/75% guard", best45, best20),
    ]:
        policy_rows.append(
            [
                html.escape(label),
                money(r45["final_nav"]),
                money(r45["net_vs_hodl"]),
                pct(r45["max_drawdown"] * 100),
                money(r45["cum_fees"]),
                f"{r45['max_arm_ltv']*100:.1f}%",
                money(r20["final_nav"]),
                money(r20["net_vs_hodl"]),
                pct(r20["max_drawdown"] * 100),
                f"{int(r45['actions'])}/{int(r20['actions'])}",
            ]
        )
    policy_table = table_html(
        ["Policy", "45d NAV", "45d net", "45d DD", "45d fees", "45d max LTV", "20d NAV", "20d net", "20d DD", "actions 45/20"],
        policy_rows,
    )

    # Interval table -------------------------------------------------------
    interval_rows = []
    for label, r45, r20 in [
        ("1h (current)", base45, base20),
        ("2h", i2_45, i2_20),
        ("4h", i4_45, i4_20),
        ("8h", i8_45, i8_20),
        ("2h + 15k + 75% guard", best45, best20),
    ]:
        interval_rows.append(
            [
                label,
                money(r45["net_vs_hodl"]),
                money(r20["net_vs_hodl"]),
                pct(r45["max_drawdown"] * 100),
                money(r45["cum_gas"]),
                f"{int(r45['actions'])}/{int(r20['actions'])}",
                f"{int(r45['hours_arms'])}/{int(r20['hours_arms'])}",
            ]
        )
    interval_table = table_html(
        ["Allocator cadence", "45d net", "20d net", "45d DD", "45d gas", "actions 45/20", "arms hours 45/20"],
        interval_rows,
    )
    interval_chart = svg_bars(
        ["1h", "2h", "4h", "8h"],
        [
            ("45d net", [base45["net_vs_hodl"], i2_45["net_vs_hodl"], i4_45["net_vs_hodl"], i8_45["net_vs_hodl"]], "#5b8def"),
            ("20d net", [base20["net_vs_hodl"], i2_20["net_vs_hodl"], i4_20["net_vs_hodl"], i8_20["net_vs_hodl"]], "#e0a13c"),
        ],
        "Allocator cadence: 1h vs 2h/4h/8h",
    )

    # Guard table ----------------------------------------------------------
    guard_rows = []
    for label, r45, r20 in [
        ("0% guard (all base)", g0_45, g0_20),
        ("25% guard", g25_45, g25_20),
        ("50% guard (production)", base45, base20),
        ("75% guard", g75_45, g75_20),
        ("75% + 15k + 2h", best45, best20),
    ]:
        guard_rows.append(
            [
                label,
                money(r45["net_vs_hodl"]),
                money(r20["net_vs_hodl"]),
                money(r45["cum_fees"]),
                money(r20["cum_fees"]),
                pct(r45["max_drawdown"] * 100),
                pct(r20["max_drawdown"] * 100),
            ]
        )
    guard_table = table_html(
        ["Guard share", "45d net", "20d net", "45d fees", "20d fees", "45d DD", "20d DD"],
        guard_rows,
    )
    guard_chart = svg_bars(
        ["0%", "25%", "50%", "75%"],
        [
            ("45d net", [g0_45["net_vs_hodl"], g25_45["net_vs_hodl"], base45["net_vs_hodl"], g75_45["net_vs_hodl"]], "#5b8def"),
            ("20d net", [g0_20["net_vs_hodl"], g25_20["net_vs_hodl"], base20["net_vs_hodl"], g75_20["net_vs_hodl"]], "#e0a13c"),
        ],
        "Guard share: fees vs drawdown",
    )
    pull_rows = []
    for label, run in [("50 bps proxy", "guard_50"), ("100 bps proxy", "guard_100"), ("200 bps proxy", "guard_200"), ("300 bps proxy", "guard_300")]:
        sub = sweep[sweep["run"] == run]
        if not sub.empty:
            r = sub.iloc[0]
            pull_rows.append([label, money(r["net_vs_hodl"]), money(r["cum_fees"]), int(r["actions"]), f"{r['max_arm_ltv']*100:.1f}%"])
    pull_table = table_html(
        ["5-min pull proxy", "45d net", "45d fees", "45d actions", "max LTV"],
        pull_rows,
    )

    # LTV / arm table ------------------------------------------------------
    ltv_rows = []
    for label, r45, r20 in [
        ("Risk-only A 29.375%", base45, base20),
        ("Risk-only A 30%", l30_45, l30_20),
        ("Risk-only A 35%", l35_45, l35_20),
        ("Always arms 29.375%", arms45, arms20),
        ("Always arms 30%", aa30_45, aa30_20),
        ("Always arms 35%", aa35_45, aa35_20),
    ]:
        ltv_rows.append(
            [
                label,
                money(r45["net_vs_hodl"]),
                money(r20["net_vs_hodl"]),
                f"{r45['max_arm_ltv']*100:.1f}%",
                f"{r20['max_arm_ltv']*100:.1f}%",
                money(float(r45["cum_nvda_yield"])),
                money(float(r45["cum_arm_interest"])),
                money(float(r45["cum_borrow_cost"])),
            ]
        )
    ltv_table = table_html(
        ["Arm / LTV", "45d net", "20d net", "45d max LTV", "20d max LTV", "45d NVDA yield", "45d USDG interest", "45d borrow"],
        ltv_rows,
    )

    # ETH table ------------------------------------------------------------
    eth_rows = []
    for b in eth:
        is_eth = b["quote"] == "WETH"
        total_cell = (
            f'<span class="eth-total" data-eth="1" data-total="{b["total_pct"]:.4f}">'
            f'{pct(b["total_pct"])}</span>'
            if is_eth
            else pct(b["total_pct"])
        )
        eth_rows.append(
            [
                html.escape(b["book"]),
                b["quote"],
                pct(b["fee_apr_pct"]),
                pct(b["il_apr_pct"]),
                pct(b["net_apr_pct"]),
                pct(b["price_change_pct"]),
                pct(b["hodl_apr_pct"]),
                pct(b["total_apr_pct"]),
                total_cell,
                f'{b["guard_in_pct"]:.0f}%',
            ]
        )
    eth_table = table_html(
        ["Book", "Quote", "Fee APR", "IL APR", "Net APR", "NVDA price (window)", "HODL basket APR", "Total APR (quote)", "Total (window; ETH→USD at slider)", "Guard in range"],
        eth_rows,
        "eth-table",
    )
    eth_chart = svg_bars(
        ["USDG 0.05", "USDG 0.30", "USDG 0.01", "ETH 0.05 V3", "ETH 0.30 V3", "ETH 0.05 V4"],
        [
            ("Fee APR", [e["fee_apr_pct"] for e in eth], "#5b8def"),
            ("IL APR", [e["il_apr_pct"] for e in eth], "#d05c5c"),
            ("Net APR", [e["net_apr_pct"] for e in eth], "#4aa37a"),
            ("HODL/price APR", [e["hodl_apr_pct"] for e in eth], "#8d8d8d"),
            ("Total APR", [e["total_apr_pct"] for e in eth], "#e0a13c"),
        ],
        "Fee + IL + price = total APR, by quote asset",
        y_label="APR (%)",
    )

    # ETH/USD breakeven pairs ---------------------------------------------
    def find(book: str):
        return next(e for e in eth if e["book"] == book)

    pairs = [
        ("ETH/NVDA V3 0.05%", "USDG/NVDA V3 0.05%"),
        ("ETH/NVDA V3 0.30%", "USDG/NVDA V4 0.30%"),
        ("ETH/NVDA V4 0.05%", "USDG/NVDA V3 0.05%"),
    ]
    pair_rows = []
    for ethbook, usdgbook in pairs:
        e = find(ethbook)
        u = find(usdgbook)
        breakeven = ((1 + u["total_pct"] / 100) / (1 + e["total_pct"] / 100) - 1) * 100
        pair_rows.append(
            [
                html.escape(ethbook),
                html.escape(usdgbook),
                pct(e["total_pct"]),
                pct(u["total_pct"]),
                pct(breakeven),
            ]
        )
    pair_table = table_html(
        ["ETH book", "USDG pair", "ETH total (window, ETH)", "USDG total (window, USDG)", "ETH/USD breakeven"],
        pair_rows,
        "pair-rows",
    )

    # Charts ---------------------------------------------------------------
    nav_chart = svg_lines(
        [
            ("C: 3k/500/skew", paths.get("optimize_C_guard500", paths["risk_only_a_2h15k_guard75"]), "#4aa37a"),
            ("A: 2h/15k/75", paths["risk_only_a_2h15k_guard75"], "#8e7cc3"),
            ("Risk-only 1h/10k/50", paths["risk_only_a"], "#5b8def"),
            ("Always A", paths["always_a"], "#e0a13c"),
            ("HODL", paths["hodl"], "#8d8d8d"),
        ],
        "45-day simulated NAV: optimised variants vs always-A vs HODL",
    )

    always_mc = mc10["always_a_net_vs_hodl"]
    mc_rows = [
        ["Median net vs HODL", money(mc10["risk_only_net_vs_hodl"]["median"]), money(mc15["risk_only_net_vs_hodl"]["median"]), money(always_mc["median"])],
        ["p05 / p95", f'{money(mc10["risk_only_net_vs_hodl"]["p05"])} / {money(mc10["risk_only_net_vs_hodl"]["p95"])}', f'{money(mc15["risk_only_net_vs_hodl"]["p05"])} / {money(mc15["risk_only_net_vs_hodl"]["p95"])}', f'{money(always_mc["p05"])} / {money(always_mc["p95"])}'],
        ["Mean net", money(mc10["risk_only_net_vs_hodl"]["mean"]), money(mc15["risk_only_net_vs_hodl"]["mean"]), money(always_mc["mean"])],
        ["Max DD median", pct(mc10["risk_only_max_dd"]["median"] * 100), pct(mc15["risk_only_max_dd"]["median"] * 100), pct(mc10["always_a_max_dd"]["median"] * 100)],
        ["Max DD p05", pct(mc10["risk_only_max_dd"]["p05"] * 100), pct(mc15["risk_only_max_dd"]["p05"] * 100), pct(mc10["always_a_max_dd"]["p05"] * 100)],
        ["Paired diff vs always-A, median [p05, p95]", f'{money(mc10["paired_diff_risk_minus_always"]["median"])} [{money(mc10["paired_diff_risk_minus_always"]["p05"])}, {money(mc10["paired_diff_risk_minus_always"]["p95"])}]', f'{money(mc15["paired_diff_risk_minus_always"]["median"])} [{money(mc15["paired_diff_risk_minus_always"]["p05"])}, {money(mc15["paired_diff_risk_minus_always"]["p95"])}]', "—"],
        ["Paired win rate vs always-A", f'{mc10["paired_win_rate"]*100:.1f}%', f'{mc15["paired_win_rate"]*100:.1f}%', "—"],
    ]
    mc_table = table_html(
        ["30 block-bootstrap paths", "Risk-only 10k", "Risk-only 15k", "Always A"],
        mc_rows,
    )

    # Rewards waterfall ----------------------------------------------------
    reward_rows = []
    for label, r45, r20 in [
        ("Risk-only 1h/10k/50", base45, base20),
        ("Risk-only A 2h/15k/75", best45, best20),
        ("In-sample best C", c45, c20),
        ("Always A", a45, a20),
        ("Always arms", arms45, arms20),
    ]:
        for win, r in (("45d", r45), ("20d", r20)):
            gas_swap = float(r["cum_gas"]) + float(r["cum_swap_cost"])
            reward_rows.append(
                [
                    html.escape(label),
                    win,
                    money(float(r["gross_rewards"])),
                    money(float(r["book_a_fees"])),
                    money(float(r["book_b_fees"])),
                    money(float(r["cum_arm_interest"])),
                    money(float(r["cum_nvda_yield"])),
                    money(float(r["cum_borrow_cost"])),
                    money(gas_swap),
                    money(float(r["cum_net_carry"])),
                    pct(float(r["net_carry_apr_pct"])),
                    pct(float(r["book_fee_apr_pct"])),
                    pct(float(r["arm_apr_pct"])),
                    money(float(r["cum_il_vs_hodl"])),
                    money(float(r["net_vs_hodl"])),
                    pct(float(r["simple_net_apr_pct"])),
                ]
            )
    reward_table = table_html(
        ["Run", "Window", "Gross rewards", "Book A fees", "Book B fees", "Arm USDG", "NVDA yield", "Borrow", "Gas+swap", "Net carry", "Carry APR", "Book fee APR", "Arm APR", "LP mark/timing", "Net vs HODL", "Net APR"],
        reward_rows,
    )

    # Inventory / swap / recenter -----------------------------------------
    inventory_rows = []
    for label, r45, r20 in [
        ("Baseline 1h/10k/50 (no swap)", base45, base20),
        ("Swap-to-fund, 10 bps", swap45, swap20),
        ("Swap-to-fund, 30 bps", pick("optimize_swap30", "45d", swap45), pick("optimize_swap30", "20d", swap20)),
        ("Inventory skew 2,000 ticks", skew45, skew20),
        ("Recenter at 500 bps", recenter45, recenter20),
        ("A: 2h/15k/75", best45, best20),
        ("B: A + base 3,000 + skew 2,500", b45o, b20o),
        ("C: B + guard 500", c45, c20),
        ("D: C + 80% guard", d45, d20),
    ]:
        inventory_rows.append(
            [
                html.escape(label),
                money(r45["net_vs_hodl"]),
                money(r20["net_vs_hodl"]),
                money(r45["cum_fees"]),
                money(r20["cum_fees"]),
                money(r45["avg_idle_value"]),
                money(r20["avg_idle_value"]),
                pct(r45["max_drawdown"] * 100),
                pct(r20["max_drawdown"] * 100),
            ]
        )
    inventory_table = table_html(
        ["Case", "45d net", "20d net", "45d fees", "20d fees", "45d avg idle", "20d avg idle", "45d DD", "20d DD"],
        inventory_rows,
    )
    inventory_chart = svg_bars(
        ["Baseline", "Swap10", "Skew2k", "Recenter", "A", "B", "C"],
        [
            ("45d net", [base45["net_vs_hodl"], swap45["net_vs_hodl"], skew45["net_vs_hodl"], recenter45["net_vs_hodl"], best45["net_vs_hodl"], b45o["net_vs_hodl"], c45["net_vs_hodl"]], "#5b8def"),
            ("20d net", [base20["net_vs_hodl"], swap20["net_vs_hodl"], skew20["net_vs_hodl"], recenter20["net_vs_hodl"], best20["net_vs_hodl"], b20o["net_vs_hodl"], c20["net_vs_hodl"]], "#e0a13c"),
        ],
        "Inventory, swap, and re-centering variants",
    )

    # No-swap re-add + surplus NVDA sweep --------------------------------
    sweep_rows = []
    for label, r45, r20 in [
        ("A: 2h/15k/75", best45, best20),
        ("A + surplus sweep", pick("optimize_A_sweep", "45d", best45), pick("optimize_A_sweep", "20d", best20)),
        ("C: skew + guard 500", c45, c20),
        ("C + surplus sweep", pick("optimize_C_sweep", "45d", c45), pick("optimize_C_sweep", "20d", c20)),
        ("C no-skew + sweep (50/50 re-add)", pick("optimize_C_sweep_noskew", "45d", c45), pick("optimize_C_sweep_noskew", "20d", c20)),
        ("C + sweep + 50% caps", pick("optimize_C_sweep_caps50", "45d", c45), pick("optimize_C_sweep_caps50", "20d", c20)),
    ]:
        sweep_rows.append(
            [
                html.escape(label),
                money(r45["net_vs_hodl"]),
                money(r20["net_vs_hodl"]),
                money(r45["cum_fees"]),
                money(r20["cum_fees"]),
                money(float(r45["cum_arm_interest"]) + float(r45["cum_nvda_yield"])),
                money(float(r20["cum_arm_interest"]) + float(r20["cum_nvda_yield"])),
                money(r45["end_idle_value"]),
                money(r20["end_idle_value"]),
                f"{int(r45['actions'])}/{int(r20['actions'])}",
            ]
        )
    sweep_table = table_html(
        ["Case", "45d net", "20d net", "45d fees", "20d fees", "45d arm+NVDA", "20d arm+NVDA", "45d end idle", "20d end idle", "actions 45/20"],
        sweep_rows,
    )

    # Optimisation table ---------------------------------------------------
    opt_order = [
        ("optimize_C_guard500", "C: 3k base / 500 guard / 2.5k skew"),
        ("optimize_D_guard80", "D: C + 80% guard"),
        ("optimize_B_skew2500", "B: 3k base / 2.5k skew"),
        ("optimize_conservative", "Conservative: 2.5k base / 2.5k skew"),
        ("optimize_A_2h15k75", "A: 2h / 15k / 75% guard"),
        ("optimize_baseline", "Baseline 1h / 10k / 50%"),
        ("optimize_swap10", "Swap-to-fund 10 bps"),
        ("optimize_skew2000", "Inventory skew 2,000"),
        ("optimize_recenter500", "Re-center at 500 bps"),
        ("optimize_feeil_gate", "Fee/IL gate, 24h / 8h confirm"),
        ("optimize_guard_feeil", "Guard fee/IL pull, 12h"),
        ("optimize_base3000", "Base width 3,000"),
        ("optimize_base4000", "Base width 4,000"),
        ("optimize_guard500", "Guard width 500"),
        ("optimize_guard900", "Guard width 900"),
        ("optimize_guard80", "Guard share 80%"),
        ("optimize_fund10000", "Fund book 100%"),
    ]
    opt_rows = []
    for run, label in opt_order:
        r45 = get_opt(run, "45d")
        r20 = get_opt(run, "20d")
        if r45 is None or r20 is None:
            continue
        opt_rows.append(
            [
                f"<b>{html.escape(label)}</b>" if run in ("optimize_C_guard500", "optimize_D_guard80") else html.escape(label),
                money(r45["net_vs_hodl"]),
                money(r20["net_vs_hodl"]),
                money(r45["cum_fees"]),
                money(r20["cum_fees"]),
                pct(r45["max_drawdown"] * 100),
                pct(r20["max_drawdown"] * 100),
                f"{int(r45['actions'])}/{int(r20['actions'])}",
            ]
        )
    opt_table = table_html(
        ["Variant", "45d net", "20d net", "45d fees", "20d fees", "45d DD", "20d DD", "actions 45/20"],
        opt_rows,
    )
    top_for_chart = sorted(
        [(run, label) for run, label in opt_order if get_opt(run, "45d") is not None],
        key=lambda x: float(get_opt(x[0], "45d")["net_vs_hodl"]),
        reverse=True,
    )[:7]
    opt_chart = svg_bars(
        [label.split(":")[0] for _, label in top_for_chart],
        [
            ("45d net", [float(get_opt(run, "45d")["net_vs_hodl"]) for run, _ in top_for_chart], "#5b8def"),
            ("20d net", [float(get_opt(run, "20d")["net_vs_hodl"]) for run, _ in top_for_chart], "#e0a13c"),
        ],
        "Optimisation variants: in-sample 45d/20d net",
    )

    # Optimised Monte Carlo ------------------------------------------------
    opt_mc_table = ""
    if opt_mc:
        mc_order = [
            ("risk_only_1h10k50", "Risk-only 1h/10k/50"),
            ("A_2h15k75", "A: 2h/15k/75"),
            ("C_3k_skew2500_guard500", "C: 3k / 500 / skew"),
            ("D_3k_skew2500_guard500_80", "D: C + 80% guard"),
        ]
        om_rows = []
        for key, label in mc_order:
            c45m = opt_mc["configs"][key]["45d"]
            c20m = opt_mc["configs"][key]["20d"]
            om_rows.append(
                [
                    html.escape(label),
                    money(c45m["net_vs_hodl"]["median"]),
                    money(c45m["net_vs_hodl"]["p05"]),
                    f'{c45m["paired_win_rate"]*100:.0f}%',
                    money(c20m["net_vs_hodl"]["median"]),
                    money(c20m["net_vs_hodl"]["p05"]),
                    f'{c20m["paired_win_rate"]*100:.0f}%',
                ]
            )
        om_rows.append(
            [
                "Always A",
                money(opt_mc["always_a"]["45d"]["net_vs_hodl"]["median"]),
                money(opt_mc["always_a"]["45d"]["net_vs_hodl"]["p05"]),
                "—",
                money(opt_mc["always_a"]["20d"]["net_vs_hodl"]["median"]),
                money(opt_mc["always_a"]["20d"]["net_vs_hodl"]["p05"]),
                "—",
            ]
        )
        opt_mc_table = table_html(
            ["20 block-bootstrap paths", "45d median", "45d p05", "45d win vs A", "20d median", "20d p05", "20d win vs A"],
            om_rows,
        )
    opt_mc_section = (
        f"""
<h2>Monte Carlo: in-sample best vs always-A</h2>
{opt_mc_table}
<p class="note">The in-sample best C/D have similar 45d medians to always-A and higher paired win rates
(45–55% vs 30% for the baseline), but their p05 is much worse: <b>−$607/−$159</b> for C vs
<b>−$507/−$85</b> for always-A. That is the inventory/tail-risk cost. Always-A has the best mean
(+$27/+$49) and the best p05. The in-sample ranking is not the risk-adjusted ranking.</p>
"""
        if opt_mc_table
        else ""
    )

    # Large NAV ------------------------------------------------------------
    large_rows = []
    for cap in (100_000, 500_000, 1_000_000, 2_000_000):
        for run, label in (
            ("large_always_a", "Always A"),
            ("large_always_b", "Always B"),
            ("large_risk_only", "Risk-only 1h/10k/50"),
            ("large_C_3k_skew", "C: 3k/500/skew"),
        ):
            r45 = get_large(float(cap), run, "45d")
            r20 = get_large(float(cap), run, "20d")
            if r45 is None or r20 is None:
                continue
            large_rows.append(
                [
                    f"${cap/1e6:.1f}M" if cap >= 1_000_000 else f"${cap/1e3:.0f}k",
                    html.escape(label),
                    money(r45["net_vs_hodl"]),
                    pct(r45["simple_net_apr_pct"]),
                    pct(r45["book_fee_apr_pct"]),
                    money(r20["net_vs_hodl"]),
                    pct(r20["simple_net_apr_pct"]),
                    pct(r20["book_fee_apr_pct"]),
                    money(r45["end_idle_value"]),
                ]
            )
    large_table = table_html(
        ["NAV", "Case", "45d net", "45d net APR", "45d book fee APR", "20d net", "20d net APR", "20d book fee APR", "45d end idle"],
        large_rows,
    )
    large_caps = [100_000, 500_000, 1_000_000, 2_000_000]
    large_chart = svg_bars(
        [f"${c/1e6:.1f}M" if c >= 1_000_000 else f"${c/1e3:.0f}k" for c in large_caps],
        [
            (
                "Always A 45d net APR",
                [
                    float(get_large(float(c), "large_always_a", "45d")["simple_net_apr_pct"])
                    for c in large_caps
                    if get_large(float(c), "large_always_a", "45d") is not None
                ],
                "#e0a13c",
            ),
            (
                "Risk-only 45d net APR",
                [
                    float(get_large(float(c), "large_risk_only", "45d")["simple_net_apr_pct"])
                    for c in large_caps
                    if get_large(float(c), "large_risk_only", "45d") is not None
                ],
                "#5b8def",
            ),
            (
                "C 45d net APR",
                [
                    float(get_large(float(c), "large_C_3k_skew", "45d")["simple_net_apr_pct"])
                    for c in large_caps
                    if get_large(float(c), "large_C_3k_skew", "45d") is not None
                ],
                "#4aa37a",
            ),
        ],
        "Large NAV: 45d net APR (exact fee share)",
        y_label="Net APR (%)",
    )

    # HTML ----------------------------------------------------------------
    def kpi(label: str, value: str, sub: str, cls: str = "") -> str:
        return f'<div class="kpi {cls}"><div class="kpi-label">{label}</div><div class="kpi-value">{value}</div><div class="kpi-sub">{sub}</div></div>'

    arm_gross = (
        float(arms45["cum_nvda_yield"])
        + float(arms45["cum_arm_interest"])
        - float(arms45["cum_borrow_cost"])
        - float(arms45["cum_gas"])
    )
    c_mc = opt_mc["configs"]["C_3k_skew2500_guard500"] if opt_mc else None
    c_p05_45 = c_mc["45d"]["net_vs_hodl"]["p05"] if c_mc else -607.47
    c_p05_20 = c_mc["20d"]["net_vs_hodl"]["p05"] if c_mc else -158.65
    a_p05_45 = opt_mc["always_a"]["45d"]["net_vs_hodl"]["p05"] if opt_mc else -506.67
    a_p05_20 = opt_mc["always_a"]["20d"]["net_vs_hodl"]["p05"] if opt_mc else -85.01
    large_card = ""
    if all(
        x is not None
        for x in (lc1_45, lc1_20, lc2_45, lc2_20, la1_45, la2_45, lb1_45, lb2_45)
    ):
        large_card = f"""
      <div class="answer"><h3>Does it scale to $1M / $2M?</h3>
        <p>Yes for Book A, no for Book B. With exact fee shares, C over 45d is
        <b>+${lc1_45['net_vs_hodl']:,.0f}</b> at $1M (${lc1_45['simple_net_apr_pct']:.1f}% net APR,
        book fee ${lc1_45['book_fee_apr_pct']:.1f}%) and <b>+${lc2_45['net_vs_hodl']:,.0f}</b> at $2M
        (${lc2_45['simple_net_apr_pct']:.1f}%, book fee ${lc2_45['book_fee_apr_pct']:.1f}%). But the 20d
        is <b>−${abs(lc1_20['net_vs_hodl']):,.0f} at $1M</b> and <b>−${abs(lc2_20['net_vs_hodl']):,.0f} at $2M</b>:
        the $10k 20d +$81.77 does not scale. Always-A is +${la1_45['net_vs_hodl']:,.0f} at $1M and
        +${la2_45['net_vs_hodl']:,.0f} at $2M, but Book B is only +${lb1_45['net_vs_hodl']:,.0f} at $1M and
        <b>−${abs(lb2_45['net_vs_hodl']):,.0f} at $2M</b>; Book B becomes 21%/43% of its pool. The 20/50/100%
        arm caps give nearly the same 1M/2M C result; the arm is under $1k, so the book/idle/timing dominates.
        Do not linearly extrapolate $10k; size Book B at ~$250k–$500k and Book A at ~$1M–$2M only with a
        fresh-tape/tail test.</p></div>
        """
    kpis = "".join(
        [
            kpi("In-sample best 45d", money(c45["net_vs_hodl"]), "C: 3k base / 500 guard / skew"),
            kpi("In-sample best 20d", money(c20["net_vs_hodl"]), "same config"),
            kpi("C 45d / 20d p05", f'{money(c_p05_45)} / {money(c_p05_20)}', f'always-A {money(a_p05_45)} / {money(a_p05_20)}'),
            kpi("Book fees 45d / 20d", f'{money(c45["cum_fees"])} / {money(c20["cum_fees"])}', "C config"),
            kpi("Arm + NVDA 45d", money(float(c45["cum_arm_interest"]) + float(c45["cum_nvda_yield"])), "C config; book is the engine"),
            kpi("Baseline 45d / 20d", f'{money(base45["net_vs_hodl"])} / {money(base20["net_vs_hodl"])}', "1h / 10k / 50% guard"),
            kpi("Always A 45d / 20d", f'{money(a45["net_vs_hodl"])} / {money(a20["net_vs_hodl"])}', "book only; best MC mean"),
        ]
    )

    answer_cards = f"""
    <div class="answers">
      <div class="answer"><h3>Will it work on the real tape?</h3>
        <p>Yes on the book, no on the allocator alpha. The book earns real fees ($245–$278 over 45d),
        but the 20d NVDA USD fall overwhelms them. The as-built allocator is a one-way door into the
        arms (−${abs(asb45['net_vs_hodl']):.2f} 45d, +${asb20['net_vs_hodl']:.2f} 20d, essentially always-arms).
        The coherent risk-only policy is +${base45['net_vs_hodl']:.2f} 45d / −${abs(base20['net_vs_hodl']):.2f} 20d at 1h/10k/50%.
        The in-sample best is <b>+${c45['net_vs_hodl']:.2f} 45d / +${c20['net_vs_hodl']:.2f} 20d</b>
        at 3k base / 500 guard / 2.5k skew. But the 20-path bootstrap says C's median is close to always-A
        while its p05 is much worse (<b>−$607 / −$159</b> vs <b>−$507 / −$85</b>). The in-sample gain is a
        tail-risk trade, not proven alpha.</p></div>
      <div class="answer"><h3>Will the guard prevent IL?</h3>
        <p>No. The guard concentrates fees; it does not stop base IL. Guard share 0% / 50% / 75%:
        45d <b>+${g0_45['net_vs_hodl']:.2f} / +${base45['net_vs_hodl']:.2f} / +${g75_45['net_vs_hodl']:.2f}</b>,
        20d <b>−${abs(g0_20['net_vs_hodl']):.2f} / −${abs(base20['net_vs_hodl']):.2f} / −${abs(g75_20['net_vs_hodl']):.2f}</b>.
        More guard = more fees in the 45d up/fee regime, worse 20d in the down move. The 75% guard only
        becomes positive in the 20d when combined with the 2h/15k filters (+${best20['net_vs_hodl']:.2f}).
        The ETH books are in range only 66–75% vs 91–92% for USDG, yet their IL is smaller because the
        ETH-quoted NVDA move is smaller (−3.0% vs −6.3%).</p></div>
      <div class="answer"><h3>Is the APR justifiable? What should we expect?</h3>
        <p>The fee APR is real: USDG books gross <b>19.9–22.4%</b>, IL <b>−7.8 to −8.0%</b>, net vs HODL
        <b>11.9–14.6%</b>; after the NVDA USD price fall the <b>total</b> is <b>−1.4 to −1.7%</b> over 45d
        (−11 to −14% annualized). The ETH books gross <b>30.3–40.4%</b>, IL <b>−1.7 to −1.8%</b>, net
        <b>28.5–38.7%</b> in ETH, total <b>+2.0 to +3.3%</b> in ETH (16–26% annualized). The expected
        <b>net vs HODL</b> is the defensible LP number; the <b>total</b> is quote-price dependent.
        Do not quote the gross fee APR as a total return.</p></div>
      <div class="answer"><h3>Does the 1-hour check stand?</h3>
        <p>The 1h check is defensible, but not optimal on this tape. 2h gives
        <b>+${i2_45['net_vs_hodl']:.2f} 45d / +${i2_20['net_vs_hodl']:.2f} 20d</b> vs
        <b>+${base45['net_vs_hodl']:.2f} / −${abs(base20['net_vs_hodl']):.2f}</b> at 1h, with 167/160
        actions vs 276/229. 4h and 8h are too slow for the 20d. The 2h/15k/75% combo is the in-sample
        best. Test 2h before changing production; the guard still rechecks every 5 minutes.</p></div>
      <div class="answer"><h3>3% NVDA from Spiral, 30% vs 35% LTV</h3>
        <p>The 3% is the <b>Spiral total yield on NVDA collateral, APR after borrowing cost</b>, not a native
        Morpho collateral yield. The model grosses it up by LTV×borrow APR and subtracts borrow, so the net
        NVDA contribution is 3% APR. In the full always-arms loop the grossed-up NVDA line is
        <b>${arms45['cum_nvda_yield']:.2f}</b> over 45d, alongside
        <b>${arms45['cum_arm_interest']:.2f}</b> USDG interest, <b>${arms45['cum_borrow_cost']:.2f}</b> borrow
        and <b>${arms45['cum_gas']:.2f}</b> gas → <b>${arms45['cum_net_carry']:.2f}</b> net carry; the collateral mark takes it to
        <b>+${arms45['net_vs_hodl']:.2f}</b>. The risk-only allocator holds the collateral only briefly; its
        NVDA contribution is <b>${base45['cum_nvda_yield']:.2f}</b>. 35% LTV lowers the full-arm net to
        <b>+${aa35_45['net_vs_hodl']:.2f}</b> (30%: +${aa30_45['net_vs_hodl']:.2f}) and drifts max LTV to
        <b>{aa35_45['max_arm_ltv']*100:.1f}%</b> vs {aa30_45['max_arm_ltv']*100:.1f}%. The extra 5% debt is
        borrowed at 3% and the lend cap is full; it does not pay. Keep the 29.375%/30% target.</p></div>
      <div class="answer"><h3>How much arm + book rewards?</h3>
        <p>Book fees are the engine. In the in-sample best C over 45d: <b>${c45['cum_fees']:.2f}</b> book A
        fees + <b>${c45['cum_arm_interest']:.2f}</b> arm USDG + <b>${c45['cum_nvda_yield']:.2f}</b> NVDA,
        less <b>${float(c45['cum_borrow_cost']) + float(c45['cum_gas']) + float(c45['cum_swap_cost']):.2f}</b>
        borrow/gas/swap → <b>${c45['cum_net_carry']:.2f}</b> net carry (${c45['net_carry_apr_pct']:.1f}% APR).
        The LP mark/timing adds <b>${c45['cum_il_vs_hodl']:.2f}</b>, so net vs HODL is
        <b>${c45['net_vs_hodl']:.2f}</b>. The arm is only <b>${float(c45['cum_arm_interest']) + float(c45['cum_nvda_yield']):.2f}</b>
        of that; the book is 99%+ of carry. The 3% NVDA is <b>APR net of borrowing cost</b>: the model grosses
        up the NVDA yield and then subtracts borrow. In the full always-arms loop the arm earns
        <b>${float(arms45['cum_arm_interest']) + float(arms45['cum_nvda_yield']):.2f}</b> gross but only
        <b>+${arms45['net_vs_hodl']:.2f}</b> after borrow/gas and the collateral mark. Book fee APR is
        <b>${c45['book_fee_apr_pct']:.1f}%</b> over 45d.</p></div>
      <div class="answer"><h3>Does inventory / ratio management help?</h3>
        <p>It helps in-sample, not risk-adjusted. After a recall the book re-funds only $6.1k–$6.8k of
        ~$10k because the recalled token ratio no longer matches the LP. <b>Swap-to-fund</b> deploys the
        idle cash but fees rise $188 → $275 and net falls $191 → $187: the extra capital buys IL.
        <b>Inventory skew</b> (shift the base to use the recalled token, no swap) raises C's fees to
        <b>$338</b> and net to <b>$512 / $82</b>. A direct <b>no-skew 50/50 re-add + surplus NVDA arm sweep</b>
        is <b>+$497 / +$51</b>: the reserve/50-50 part works, but pushing excess NVDA to the arm does not pay
        at $10k because the 20% arm cap is full and the 3% net yield is too small. The skew's bootstrap p05 is
        <b>−$607 / −$159</b> vs baseline <b>−$473 / −$78</b> and always-A <b>−$507 / −$85</b>. The price
        depreciation is now concentrated in the vault's NVDA inventory; that is exactly the tail risk.</p></div>
      <div class="answer"><h3>Can fee &gt; IL be improved?</h3>
        <p>The binary fee &gt; IL check is not the binding constraint on this tape; the 5-minute guard
        never pulls at 200 bps. A <b>fee/IL hurdle with a 24h window, 250 bps buffer and 8h confirmation</b>
        improves the 1h baseline from <b>+$191 / −$106</b> to <b>+$302 / +$19</b> and cuts drawdown to
        4.4%/6.7%, but it does not beat the 2h/15k/75 combo. Pulling the guard on a guard-specific
        fee/IL signal is worse (<b>−$9 / −$31</b>): it churns 136–225 pulls and collapses fees to
        $50–60. The better equation is a <em>hurdle plus hysteresis plus gas</em>, not a raw
        fee &gt; IL trigger. The biggest fee lever is width/skew: base 3,000 and guard 500 raise fees
        to $338 over 45d, with the tail-risk caveat above.</p></div>
      <div class="answer"><h3>ETH/NVDA vs USDG/NVDA</h3>
        <p>Same NVDA, different quote. ETH/NVDA fell <b>−3.0%</b> in ETH vs <b>−6.3%</b> in USDG over the
        window. The ETH book's total is <b>+2.0 to +3.3%</b> in ETH; the USDG book's total is
        <b>−1.4 to −1.7%</b> in USDG. The ETH book wins in ETH unless ETH/USD falls more than the
        breakeven (about <b>−4.8%</b> for the V3 0.05 pair). Use the slider to translate the ETH books
        into USD; the USDG books are already USD-like.</p></div>
      {large_card}
    </div>
    """

    # ETH slider rows for JS
    pair_js = json.dumps(
        [
            {
                "eth": e["book"],
                "total": e["total_pct"],
                "usdg": u["total_pct"],
            }
            for e, u in [(find(a), find(b)) for a, b in pairs]
        ]
    )

    html_doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NVDA allocator — simulation dashboard</title>
<style>
:root{{--bg:#0f141b;--panel:#161d27;--panel2:#1d2633;--ink:#e7edf5;--muted:#9fb0c4;--line:#2c3949;--blue:#5b8def;--green:#4aa37a;--gold:#e0a13c;--red:#d05c5c}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}}
.wrap{{max-width:1180px;margin:0 auto;padding:28px 22px 60px}}
h1{{font-size:26px;margin:0 0 4px}} h2{{font-size:19px;margin:34px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}}
h3{{font-size:15px;margin:0 0 6px}} .sub{{color:var(--muted);margin:0 0 18px}}
.answers{{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px;margin:18px 0}}
.answer{{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 15px}} .answer p{{margin:6px 0 0;color:#cfdae7}}
.kpis{{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin:18px 0}}
.kpi{{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px 14px}}
.kpi-label{{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}}
.kpi-value{{font-size:22px;font-weight:700;margin:4px 0}} .kpi-sub{{color:var(--muted);font-size:12px}}
.tbl{{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:12.5px}}
.table-wrap{{overflow-x:auto;margin:8px 0}}
.tbl th{{background:#202c3b;color:#c9d7e8;text-align:right;padding:8px 9px;position:sticky;top:0}}
.tbl td{{border-top:1px solid var(--line);padding:7px 9px;text-align:right;color:#dbe6f2;white-space:nowrap}}
.tbl td:first-child,.tbl th:first-child{{text-align:left}} .tbl tr:nth-child(even) td{{background:#18212d}}
.chart{{width:100%;height:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:8px 0 12px}}
.chart-title{{fill:#e7edf5;font-size:13px;font-weight:600}} .axis{{fill:#8fa2b8;font-size:10.5px}} .legend{{fill:#b9c8da;font-size:10.5px}}
.grid{{stroke:#2a3747;stroke-width:1}} .zero{{stroke:#60748b;stroke-width:1.2}}
.note{{color:var(--muted);font-size:12.5px;margin:6px 0 14px}} .warn{{color:#e6b86a}}
.controls{{display:flex;gap:14px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:8px 0}}
.controls input{{width:260px}} .controls output{{font-weight:700;color:var(--gold)}}
code{{background:#202b39;padding:1px 5px;border-radius:4px;color:#cfe2ff}}
</style></head><body><div class="wrap">
<h1>NVDA allocator — simulation dashboard</h1>
<p class="sub">Book A/B fees + guard + Morpho/Spiral arms, driven by the downloaded 45-day swap tape.
USDG books are the allocator; ETH/NVDA is a separate quote-asset comparison. Generated from
<code>research/cadcad/allocator/out/</code>.</p>

<div class="kpis">{kpis}</div>

<h2>Answers</h2>
{answer_cards}

<h2>45-day NAV simulation</h2>
{nav_chart}
<p class="note">C = 3,000-tick base / 500-tick guard / 2,500-tick inventory skew / 2h / $15k / 75% guard. A = 2h / $15k / 75% guard.
Baseline = 1h / $10k / 50% guard. HODL is the initial 50/50-ish LP token basket held without fees or IL. C is the
in-sample best, not the risk-adjusted best; see the MC tables.</p>

<h2>Monte Carlo: 30 block-bootstrap paths</h2>
{mc_table}
<p class="note">Same 30 paths and seed for both policies. The risk-only median is higher than always-A, but the mean is
lower and the win rate is 36.7% (10k) / 40.0% (15k). The 45d/20d in-sample results are regime timing, not proven alpha.</p>

<h2>Rewards: book vs arm</h2>
{reward_table}
<p class="note">The identity is <code>net = gross rewards − borrow − gas − swap − liquidation + LP mark/timing</code>.
The arm's 3% NVDA is <b>APR after borrowing cost</b>: the model grosses up the NVDA yield by LTV×borrow APR and then
subtracts borrow cost, so the net NVDA contribution is 3% APR. Book fee APR and arm APR are annualized on the initial
$10k. Book fees are 99%+ of carry in the risk-only allocator; the full always-arms loop earns ~$17 gross but only
~$13 net carry after borrow/gas.</p>

<h2>Inventory, swaps, and re-centering</h2>
{inventory_table}
{inventory_chart}
<p class="note">After each recall the book re-funds only $6.1k–$6.8k of ~$10k because the recalled token ratio no
longer matches the LP. Swap-to-fund deploys the rest but adds IL: fees rise $188 → $275, net falls $191 → $187.
Inventory skew uses the recalled token instead of swapping and raises fees to $338 and net to $512/$82 in-sample;
re-centering at 500 bps realizes IL and is worse (+$63). The skew's tail is worse: see the MC table below.</p>

<h2>No-swap 50/50 re-add + surplus NVDA sweep</h2>
{sweep_table}
<p class="note">The direct “re-add 50/50 with what we have, keep a reserve, push excess NVDA to the arm” case is
<b>C no-skew + sweep</b>: +$496.84 / +$50.72, versus C at +$512.06 / +$81.76. The sweep is neutral on A
(+$430.73 / +$46.87 vs +$431.36 / +$46.95) and does not add net because the 20% arm cap is already full and the
3% net NVDA yield is too small to compensate for holding NVDA through a down move. Raising caps to 50% makes 45d
slightly better (+$517.07) but the 20d collapses to −$70.34. Keep the no-swap reserve; do not force the arm sweep
at $10k.</p>

<h2>Optimisations</h2>
{opt_table}
{opt_chart}
<p class="note">In-sample 45d/20d. The biggest fee levers are base width 3,000 (vs 6,000), guard width 500 (vs 600),
guard share 75–80%, and the inventory skew. The fee/IL gate improves the 1h baseline but does not beat the 2h/15k/75
combo. The guard-specific fee/IL pull is a churn failure. The base/guard/skew gains are in-sample; the MC below
shows they add left-tail risk.</p>

{opt_mc_section}

<h2>Does it scale to $1M / $2M?</h2>
{large_table}
{large_chart}
<p class="note">Exact fee-share mode: <code>fee = rate × volume × L/(poolL+L)</code>. At $1M/$2M,
Book A is only ~1–2% of its pool, so its fee APR holds (17.4%/15.6% at 1M/2M vs 19.9% at 10k).
Book B becomes 21%/43% of its pool and fails at scale: always-B 45d is +$2.5k at 1M and −$3.7k at
2M. C is still positive over 45d (+$40.2k at 1M, +$76.3k at 2M) but the 20d is negative
(−$21.2k/−$44.4k); the $10k 20d +$81.77 does not scale. The 20/50/100% arm caps give nearly the
same 1M/2M C result; the arm is <$1k, so the book/idle/timing dominates. Do not linearly extrapolate
$10k; size Book B at ~$250k–$500k maximum and Book A at ~$1M–$2M only with a fresh-tape/tail test.</p>

<h2>Policy comparison</h2>
{policy_table}
<p class="note">45d and last-20d windows on the same tape. “Net” is strategy NAV minus the HODL basket (fees − IL).
It excludes the NVDA price move; the NAV columns include it. Max LTV is the observed maximum, not just the borrow target.</p>

<h2>Does the 1-hour check stand?</h2>
{interval_table}
{interval_chart}
<p class="note">2h reduces churn and improves both windows in-sample; 4h/8h are too slow in the 20d. The guard still
rechecks every 5 minutes; only the allocator decision cadence changes. But the 20-path bootstrap gives the 2h/15k/75
config a worse p05 than the 1h baseline; treat 2h as a hypothesis to test on a fresh tape, not a production change.</p>

<h2>Guard: fees vs IL</h2>
{guard_table}
{guard_chart}
{pull_table}
<p class="note">Guard share is the fraction of book capital in the narrow ±600-tick guard. The 5-minute pull proxy is
a stress sensitivity, not the `.env` recheck/re-arm band (that needs an oracle series). The 200 bps proxy does not fire
on this low-vol USDG tape; the actual hook EV guard may pull more. The guard does not prevent base IL.</p>

<h2>Spiral arm: 3% NVDA, 30% vs 35% LTV</h2>
{ltv_table}
<p class="note">The 3% NVDA is modelled as a total Spiral yield on the NVDA collateral. The full always-arms loop holds
it long enough to earn it; the risk-only allocator does not. 35% LTV adds borrow cost and LTV drift without lifting the
NVDA yield; the 20% USDG lend cap is already full, so the extra debt has nowhere to earn. Keep the 29.375%/30% target
unless a continuous 30% LTV sentinel is added.</p>

<h2>ETH/NVDA vs USDG/NVDA</h2>
<div class="controls">
  <label for="eth">ETH/USD change over the window:</label>
  <input id="eth" type="range" min="-30" max="30" step="1" value="0" oninput="updateEth()">
  <output id="eth-out">0%</output>
  <span class="note" style="margin:0">ETH book total USD = (1 + ETH total) × (1 + ETH/USD) − 1. USDG books are USD-like.</span>
</div>
{eth_table}
{eth_chart}
<h3>ETH/USD breakeven</h3>
{pair_table}
<p class="note">Breakeven is the ETH/USD move at which the ETH book's USD return equals its USDG pair. If ETH/USD falls
more than the breakeven, the USDG book wins in USD despite the ETH book's higher fee APR. The ETH books are the V3/V4
WETH/NVDA research sims; the allocator itself is USDG-quoted and its arms are USDG.</p>

<h2>How to read this</h2>
<p class="note">Fee APR = fees / initial capital, annualized. IL APR = (LP value − HODL value) / initial capital,
annualized. Net APR = fee + IL (the LP skill). HODL/price APR = the initial token basket's quote price move.
Total APR = net + HODL/price. For the allocator P&amp;L the identity is
<code>net = book fees + arm USDG + NVDA yield − borrow − gas − swap − liquidation + LP mark/timing</code>.
The “APR + price − IL” identity is: total = fee + IL + HODL, with IL negative. The USDG total is negative in
this down window even though the net is positive; the ETH book's total is positive in ETH because the
ETH-quoted NVDA fall is smaller and the fees are higher.</p>

<h2>Caveats</h2>
<p class="note">Book A is a V3 0.05% proxy; no V4 USDG/NVDA 0.05% pool exists in the downloaded set. Book B is the real
V4 0.30% pool. Both windows are down regimes; the block bootstrap preserves the same regime and does not prove a bull
market. The in-sample best has a worse bootstrap p05 than always-A: it is a tail-risk trade, not free alpha. Guard
pulls are a 5-minute proxy, not the hook EV/oracle recheck. The guard-specific fee/IL pull is not supported by this tape.
Arm rates are scenarios, not a 45-day Morpho history. The 3% NVDA is a user/Spiral assumption, not a native collateral
yield. ETH/USD is not in the swap tapes; the slider is an explicit translation, not a historical series. Swap cost is
10 bps in the swap-to-fund case and zero otherwise; no MEV/slippage/price impact. The re-center action is modelled as
one composite action with 2× gas; the keeper would need two runs or a composite adapter. Gas is $0.02/action. The model
assumes the allocator executes and applies module caps, not controller timelocks/caps.</p>

<script>
const pairs = {pair_js};
function fmt(x) {{ return (x>=0?'+':'') + x.toFixed(2) + '%'; }}
function updateEth() {{
  const change = Number(document.getElementById('eth').value) / 100;
  document.getElementById('eth-out').textContent = (change>=0?'+':'') + (change*100).toFixed(0) + '%';
  document.querySelectorAll('[data-eth="1"]').forEach(el => {{
    const total = Number(el.dataset.total) / 100;
    el.textContent = fmt(((1 + total) * (1 + change) - 1) * 100);
  }});
  const rows = document.querySelectorAll('#pair-rows tr');
  rows.forEach((tr, i) => {{
    if (!pairs[i]) return;
    const cells = tr.querySelectorAll('td');
    if (cells.length < 5) return;
    const eth = pairs[i];
    const usd = ((1 + eth.total/100) * (1 + change) - 1) * 100;
    const be = ((1 + eth.usdg/100) / (1 + eth.total/100) - 1) * 100;
    cells[4].textContent = fmt(be);
    cells[4].title = 'ETH total at slider: ' + fmt(usd);
  }});
}}
updateEth();
</script>
</div></body></html>"""

    OUT.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(html_doc, encoding="utf-8")
    print(f"wrote {REPORT} ({len(html_doc)/1024:.1f} KiB)")


if __name__ == "__main__":
    main()
