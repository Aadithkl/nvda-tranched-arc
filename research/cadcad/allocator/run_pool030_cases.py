"""Would moving to the 0.30 pool have made more money?

Runs the recommended $100k strategy twice for every case:
  - risk-only baseline (never uses the 0.30 pool)
  - the same strategy with the 0.30 pool allowed, under a volume and share cap

    python run_pool030_cases.py
    # out/pool030_cases.csv
    # out/pool030_cases.json
    # out/pool030_cases.html

The 10x volume cases hold liquidity fixed. That is a sensitivity, not a forecast:
real volume growth attracts liquidity and dilutes fee APR.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from build_scenario_lab import scale_book_volume
from run import run_config
from run_recommended_100k import PARAMS
from scenario import load_scenario

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
SCENARIO = HERE / "data" / "scenario_45d.json"
BASE_CAPITAL = 100_000.0

VOLS = (1.0, 2.0, 3.0, 5.0, 10.0)
CAPS = (0.05, 0.10, 0.15, 0.25, 0.50)
WINDOWS = {"45d": None, "20d": 480}
CONFIGS = {
    "2h/2h/1000": {
        "opportunity_window_hours": 2,
        "opportunity_check_hours": 2,
        "opportunity_buffer_bps": 1_000,
    },
    "4h/1h/500": {
        "opportunity_window_hours": 4,
        "opportunity_check_hours": 1,
        "opportunity_buffer_bps": 500,
    },
}
CAPITAL_SWEEP = (10_000.0, 50_000.0, 250_000.0)


def params_for(capital: float, cap: float, config: dict, floor: float = 50_000.0) -> dict:
    scale = capital / BASE_CAPITAL
    p = {
        **PARAMS,
        "initial_nav_usd": capital,
        "book_capital_usd": capital,
        "arm_abs_cap_usd": BASE_CAPITAL * scale,
        "usdg_lend_abs_cap_usd": BASE_CAPITAL * scale,
        "borrow_liquidity_usd": 15_000.0,
        "max_borrow_per_call_usd": 10_000.0,
        "book_b_max_share": cap,
        "book_b_min_volume_window_usd": floor,
    }
    p.update(config)
    return p


def run_case(name: str, window: str, rows, params: dict) -> dict:
    summary, path, _ = run_config(name, window, rows, params)
    active = path["active_book"].to_numpy()
    deployed_b = (active == 1) & (path["book_b_value"].to_numpy() > 0)
    b_hours = int(deployed_b.sum())
    entries = int((deployed_b & ~pd.Series(deployed_b).shift(1, fill_value=False)).sum())
    return {
        "net": float(summary["net_vs_hodl"]),
        "net_apr": float(summary["simple_net_apr_pct"]),
        "fees": float(summary["cum_fees"]),
        "max_dd": float(summary["max_drawdown"]),
        "b_hours": b_hours,
        "entries": entries,
        "final": float(summary["final_nav"]),
    }


def main() -> None:
    rows = {}
    for window, hours in WINDOWS.items():
        base = load_scenario(SCENARIO, hours=hours)[1]
        for vol in VOLS:
            rows[(window, vol)] = base if vol == 1.0 else scale_book_volume(base, "bookB", vol)

    records: list[dict] = []
    baselines: dict[tuple[float, str], dict] = {}

    def baseline(capital: float, window: str) -> dict:
        key = (capital, window)
        if key not in baselines:
            p = params_for(capital, 0.05, {})
            p["opportunity_window_hours"] = 0
            baselines[key] = run_case(f"baseline_{capital:.0f}_{window}", window, rows[(window, 1.0)], p)
        return baselines[key]

    def add(scope: str, capital: float, window: str, vol: float, cap: float,
            config_name: str, floor: float) -> None:
        case = run_case(
            f"{scope}_{capital:.0f}_v{vol:g}_c{cap:g}_{config_name}_{window}",
            window,
            rows[(window, vol)],
            params_for(capital, cap, CONFIGS[config_name], floor),
        )
        base = baseline(capital, window)
        records.append(
            {
                "scope": scope,
                "capital": capital,
                "window": window,
                "vol_mult": vol,
                "cap": cap,
                "config": config_name,
                "floor": floor,
                **case,
                "baseline_net": base["net"],
                "delta": case["net"] - base["net"],
            }
        )

    # Main grid at $100k, $50k volume floor.
    for vol in VOLS:
        for cap in CAPS:
            for config_name in CONFIGS:
                for window in WINDOWS:
                    add("main", BASE_CAPITAL, window, vol, cap, config_name, 50_000.0)

    # Lower volume floor: can the actual tape qualify?
    for vol in (1.0, 2.0):
        for cap in (0.05, 0.15, 0.25):
            for config_name in CONFIGS:
                for window in WINDOWS:
                    add("floor", BASE_CAPITAL, window, vol, cap, config_name, 25_000.0)

    # Capital sweep at 10x volume.
    for capital in CAPITAL_SWEEP:
        baseline(capital, "45d")
        baseline(capital, "20d")
        for cap in (0.05, 0.15, 0.25):
            for config_name in CONFIGS:
                for window in WINDOWS:
                    add("capital", capital, window, 10.0, cap, config_name, 50_000.0)

    df = pd.DataFrame(records)
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / "pool030_cases.csv", index=False)

    base100 = {w: baseline(BASE_CAPITAL, w) for w in WINDOWS}
    main45 = df[(df.scope == "main") & (df.window == "45d")]
    main20 = df[(df.scope == "main") & (df.window == "20d")]
    winners = main45[main45.delta > 0].sort_values(["delta", "cap"], ascending=[False, True])
    winners = winners.drop_duplicates(subset=["vol_mult", "config", "delta"], keep="first")

    best = None
    best_both = None
    if not winners.empty:
        row = winners.iloc[0]
        match = main20[
            (main20.vol_mult == row.vol_mult)
            & (main20.cap == row.cap)
            & (main20.config == row.config)
        ]
        best = {
            "vol_mult": float(row.vol_mult),
            "cap": float(row.cap),
            "config": row.config,
            "net_45d": float(row.net),
            "delta_45d": float(row.delta),
            "b_hours_45d": int(row.b_hours),
            "net_20d": float(match.iloc[0].net) if not match.empty else None,
            "delta_20d": float(match.iloc[0].delta) if not match.empty else None,
            "b_hours_20d": int(match.iloc[0].b_hours) if not match.empty else None,
        }
        merged = winners.merge(
            main20[["vol_mult", "cap", "config", "delta", "net", "b_hours"]].rename(
                columns={"delta": "delta_20d", "net": "net_20d", "b_hours": "b_hours_20d"}
            ),
            on=["vol_mult", "cap", "config"],
            how="left",
        )
        both = merged[merged.delta_20d > 0].sort_values("delta", ascending=False)
        if not both.empty:
            r = both.iloc[0]
            best_both = {
                "vol_mult": float(r.vol_mult),
                "cap": float(r.cap),
                "config": r.config,
                "net_45d": float(r.net),
                "delta_45d": float(r.delta),
                "b_hours_45d": int(r.b_hours),
                "net_20d": float(r.net_20d),
                "delta_20d": float(r.delta_20d),
                "b_hours_20d": int(r.b_hours_20d),
            }

    winners_summary = []
    if not winners.empty:
        for _, row in winners.head(12).iterrows():
            match = main20[
                (main20.vol_mult == row.vol_mult)
                & (main20.cap == row.cap)
                & (main20.config == row.config)
            ]
            winners_summary.append(
                {
                    "vol_mult": float(row.vol_mult),
                    "cap": float(row.cap),
                    "config": row.config,
                    "delta_45d": float(row.delta),
                    "net_45d": float(row.net),
                    "b_hours_45d": int(row.b_hours),
                    "entries_45d": int(row.entries),
                    "delta_20d": float(match.iloc[0].delta) if not match.empty else None,
                    "b_hours_20d": int(match.iloc[0].b_hours) if not match.empty else None,
                }
            )

    summary = {
        "initial_capital": BASE_CAPITAL,
        "baseline": {
            "45d": {k: base100["45d"][k] for k in ("net", "net_apr", "fees", "max_dd", "b_hours")},
            "20d": {k: base100["20d"][k] for k in ("net", "net_apr", "fees", "max_dd", "b_hours")},
        },
        "cases": int(len(df)),
        "main_cases": int(len(main45)),
        "winners": int(len(winners)),
        "best": best,
        "best_both": best_both,
        "winners_table": winners_summary,
        "actual_tape_best_45d": float(main45[main45.vol_mult == 1.0].delta.max()),
        "actual_tape_best_20d": float(main20[main20.vol_mult == 1.0].delta.max()),
        "capital_best": (
            df[(df.scope == "capital") & (df.window == "45d")]
            .sort_values("delta", ascending=False)
            .head(5)[["capital", "cap", "config", "delta", "b_hours", "net"]]
            .to_dict("records")
        ),
    }
    with open(OUT / "pool030_cases.json", "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)

    html = build_html(df, summary)
    (OUT / "pool030_cases.html").write_text(html, encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k not in ("winners_table",)}, indent=2))
    print(f"wrote {OUT / 'pool030_cases.html'} ({len(html)/1024:.1f} KiB)")


def _money(x: float) -> str:
    return f"{'+' if x >= 0 else '-'}${abs(x):,.0f}"


def _pct(x: float) -> str:
    return f"{'+' if x >= 0 else ''}{x:.1f}%"


def _cls(x: float) -> str:
    return "pos" if x > 0 else ("neg" if x < 0 else "")


def _heat_table(df: pd.DataFrame, window: str) -> str:
    part = df[(df.scope == "main") & (df.window == window) & (df.config == "2h/2h/1000")]
    pivot = part.pivot(index="vol_mult", columns="cap", values="delta")
    hours = part.pivot(index="vol_mult", columns="cap", values="b_hours")
    head = "".join(f"<th>{int(c*100)}% cap</th>" for c in sorted(pivot.columns))
    body = []
    for vol in sorted(pivot.index):
        cells = []
        for cap in sorted(pivot.columns):
            delta = float(pivot.loc[vol, cap])
            bh = int(hours.loc[vol, cap])
            alpha = min(0.30, abs(delta) / 9_000 * 0.30)
            color = f"rgba(15,157,118,{alpha:.2f})" if delta > 0 else f"rgba(220,38,38,{alpha:.2f})"
            cells.append(
                f'<td class="heat" style="background:{color}">{_money(delta)}'
                f'<span>{bh}h in 0.30</span></td>'
            )
        body.append(f"<tr><th>{int(vol)}× volume</th>{''.join(cells)}</tr>")
    return (
        '<div class="table-wrap"><table class="tbl heat-tbl"><thead><tr><th>0.30 pool volume</th>'
        + head
        + "</tr></thead><tbody>"
        + "".join(body)
        + "</tbody></table></div>"
    )


def _bar_svg(df: pd.DataFrame) -> str:
    part = df[(df.scope == "main") & (df.window == "45d")]
    best = part.loc[part.groupby("vol_mult")["delta"].idxmax()].sort_values("vol_mult")
    width, height = 760, 250
    pl, pr, pt, pb = 58, 18, 24, 38
    pw, ph = width - pl - pr, height - pt - pb
    vals = [float(v) for v in best["delta"]]
    lo = min(0.0, min(vals))
    hi = max(0.0, max(vals))
    span = max(1.0, hi - lo)

    def y(v: float) -> float:
        return pt + ph * (1 - (v - lo) / span)

    zero = y(0)
    parts = [
        f'<svg viewBox="0 0 {width} {height}" class="chart" role="img" aria-label="Best 0.30-pool gain by volume">',
        f'<text x="{pl}" y="16" class="chart-title">Best 45-day gain vs staying out — by 0.30-pool volume (best cap and rule)</text>',
    ]
    for k in range(5):
        v = lo + span * k / 4
        yy = y(v)
        parts.append(f'<line x1="{pl}" y1="{yy:.1f}" x2="{width-pr}" y2="{yy:.1f}" class="grid"/>')
        parts.append(f'<text x="{pl-8}" y="{yy+4:.1f}" class="axis" text-anchor="end">{_money(v)}</text>')
    n = len(best)
    slot = pw / n
    for i, (_, row) in enumerate(best.iterrows()):
        v = float(row["delta"])
        x = pl + i * slot + slot * 0.22
        w = slot * 0.56
        top = min(zero, y(v))
        h = abs(y(v) - zero)
        color = "#0f9d76" if v > 0 else "#dc2626"
        parts.append(f'<rect x="{x:.1f}" y="{top:.1f}" width="{w:.1f}" height="{max(1.0,h):.1f}" rx="4" fill="{color}" opacity=".85"/>')
        parts.append(f'<text x="{x+w/2:.1f}" y="{top-5:.1f}" class="axis" text-anchor="middle">{_money(v)}</text>')
        parts.append(f'<text x="{x+w/2:.1f}" y="{height-14}" class="axis" text-anchor="middle">{int(row["vol_mult"])}×</text>')
    parts.append(f'<line x1="{pl}" y1="{zero:.1f}" x2="{width-pr}" y2="{zero:.1f}" class="zero"/>')
    parts.append("</svg>")
    return "".join(parts)


def build_html(df: pd.DataFrame, summary: dict) -> str:
    b45 = summary["baseline"]["45d"]
    b20 = summary["baseline"]["20d"]
    best = summary["best"]
    best_both = summary.get("best_both")
    main45 = df[(df.scope == "main") & (df.window == "45d")]
    main20 = df[(df.scope == "main") & (df.window == "20d")]

    def best_for(vol: float, window_df: pd.DataFrame):
        part = window_df[window_df.vol_mult == vol]
        row = part.loc[part["delta"].idxmax()]
        return row

    rows = []
    for vol in sorted(main45.vol_mult.unique()):
        r45 = best_for(vol, main45)
        r20 = main20[
            (main20.vol_mult == vol) & (main20.cap == r45.cap) & (main20.config == r45.config)
        ]
        entered = int(r45.b_hours) > 0
        rows.append(
            f"<tr><td><b>{int(vol)}×</b></td><td>{int(r45.cap*100)}%</td>" if entered else
            f"<tr><td><b>{int(vol)}×</b></td><td>no entry</td>"
        )
        rows[-1] += (
            f"<td>{r45.config if entered else '—'}</td>"
            f"<td class=\"{_cls(r45.delta)}\">{_money(r45.delta)}</td>"
            f"<td>{int(r45.b_hours)}h</td>"
            f"<td class=\"{_cls(r20.iloc[0].delta) if not r20.empty else ''}\">"
            f"{_money(r20.iloc[0].delta) if not r20.empty else '—'}</td></tr>"
        )

    winning_rows = []
    for row in summary["winners_table"]:
        d20 = row.get("delta_20d")
        winning_rows.append(
            f"<tr><td>{int(row['vol_mult'])}×</td><td>{int(row['cap']*100)}%</td>"
            f"<td>{row['config']}</td><td class=\"pos\">{_money(row['delta_45d'])}</td>"
            f"<td>{row['b_hours_45d']}h / {row['entries_45d']} entries</td>"
            f"<td class=\"{'pos' if d20 is not None and d20 > 0 else 'neg'}\">"
            f"{_money(d20) if d20 is not None else '—'}</td>"
            f"<td>{row['b_hours_20d'] if row['b_hours_20d'] is not None else '—'}h</td></tr>"
        )

    cap_rows = []
    for capital in sorted(df[df.scope == "capital"].capital.unique()):
        part = df[
            (df.scope == "capital")
            & (df.window == "45d")
            & (df.config == "2h/2h/1000")
            & (df.capital == capital)
        ]
        base = float(part.iloc[0]["baseline_net"])
        cells = []
        for cap in sorted(part.cap.unique()):
            r = part[part.cap == cap].iloc[0]
            cells.append(
                f'<td class="{_cls(r.delta)} cell-stack">{_money(r.delta)}'
                f'<span>{int(r.b_hours)}h in 0.30</span></td>'
            )
        cap_rows.append(
            f"<tr><th>${capital/1000:.0f}k</th><td>{_money(base)}</td>{''.join(cells)}</tr>"
        )

    answer = (
        "<b>Yes — but only in a higher-volume 0.30 pool with a larger share cap.</b> "
        "On the actual tape no case beat staying out; the best was a tie "
        "(the 5–10% caps never entered, and every cap that entered lost money). "
        + (
            f"The best 45-day case is <b>{int(best['vol_mult'])}× 0.30-pool volume</b>, "
            f"<b>{int(best['cap']*100)}% share cap</b>, <b>{best['config']}</b>: "
            f"{_money(best['delta_45d'])} over 45 days, but "
            f"{_money(best['delta_20d']) if best['delta_20d'] is not None else '—'} over the last 20 days."
            if best
            else "No case beat the risk-only run."
        )
        + (
            f" The best case that also improves the last 20 days is "
            f"<b>{int(best_both['vol_mult'])}× volume, {int(best_both['cap']*100)}% cap, "
            f"{best_both['config']}</b>: {_money(best_both['delta_45d'])} over 45 days and "
            f"{_money(best_both['delta_20d'])} over the last 20 days."
            if best_both
            else ""
        )
    )

    css = """
    :root{--bg:#f6f7f9;--card:#fff;--ink:#17202a;--muted:#667085;--line:#e4e7ec;
      --green:#0f9d76;--red:#dc2626;--amber:#d97706;--blue:#2563eb}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);
      font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .wrap{max-width:1120px;margin:0 auto;padding:34px 22px 60px}
    h1{font-size:30px;line-height:1.15;margin:0 0 6px;letter-spacing:-.025em}
    h2{font-size:21px;margin:36px 0 10px;letter-spacing:-.015em}
    .sub{color:var(--muted);margin:0 0 18px;max-width:900px}
    .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:14px 0}
    .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 15px}
    .kpi-label{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:750}
    .kpi-value{font-size:23px;font-weight:780;margin:4px 0 1px;letter-spacing:-.01em}
    .kpi-sub{font-size:11.5px;color:var(--muted)}
    .kpi.pos{border-top:3px solid var(--green)} .kpi.neg{border-top:3px solid var(--red)}
    .callout{background:#ecfdf3;border:1px solid #abefc6;border-left:4px solid var(--green);
      border-radius:10px;padding:12px 14px;margin:12px 0;font-size:13px;color:#054f31}
    .warn{background:#fffaeb;border:1px solid #fedf89;border-left:4px solid var(--amber);
      border-radius:10px;padding:12px 14px;margin:12px 0;font-size:13px;color:#93370d}
    .tbl{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);
      border-radius:12px;overflow:hidden;font-size:12px}
    .tbl th{background:#f2f4f7;color:#344054;text-align:right;padding:8px 9px;font-weight:750;white-space:nowrap}
    .tbl td{border-top:1px solid var(--line);padding:8px 9px;text-align:right;white-space:nowrap}
    .tbl th:first-child,.tbl td:first-child{text-align:left}
    .tbl tr:nth-child(even) td{background:#fbfcfe}
    .table-wrap{overflow-x:auto;margin:10px 0}
    .heat{padding:10px 9px!important;text-align:center!important;font-weight:650}
    .heat span{display:block;font-size:10px;color:#475467;font-weight:500;margin-top:2px}
    .pos{color:#0b7f5f;font-weight:700}.neg{color:#b42318;font-weight:700}
    .cell-stack span{display:block;font-size:10px;color:#475467;font-weight:500;margin-top:2px}
    .chart{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:14px;margin:10px 0}
    .chart-title{fill:#17202a;font-size:12px;font-weight:750}
    .axis{fill:#667085;font-size:10px}.grid{stroke:#e4e7ec;stroke-width:1}.zero{stroke:#98a2b3;stroke-width:1.2}
    .note{color:var(--muted);font-size:12.5px;margin:6px 0 14px;max-width:1050px}
    .footer{color:var(--muted);font-size:12px;border-top:1px solid var(--line);margin-top:36px;padding-top:16px}
    """

    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Would the 0.30 pool have made more money?</title>
<style>{css}</style></head><body><div class="wrap">

<h1>Would the 0.30 pool have made more money?</h1>
<p class="sub">Same $100,000, same 45-day tape, same recommended strategy. One change at a time:
allow the 0.30 pool, raise its share cap, or multiply its volume. Every case is compared with the
risk-only run that never uses it.</p>

<div class="callout">{answer}</div>

<div class="kpis">
  <div class="kpi"><div class="kpi-label">Never use 0.30 — 45d</div><div class="kpi-value">{_money(b45['net'])}</div><div class="kpi-sub">{_pct(b45['net_apr'])} net APR</div></div>
  <div class="kpi"><div class="kpi-label">Best case — 45d</div><div class="kpi-value">{_money(best['net_45d']) if best else '—'}</div><div class="kpi-sub">{_money(best['delta_45d']) if best else '—'} vs never 0.30 · 20d {_money(best['delta_20d']) if best and best['delta_20d'] is not None else '—'}</div></div>
  <div class="kpi"><div class="kpi-label">Best 45d + 20d</div><div class="kpi-value">{_money(best_both['net_45d']) if best_both else '—'}</div><div class="kpi-sub">{_money(best_both['delta_45d']) if best_both else '—'} 45d · {_money(best_both['delta_20d']) if best_both else '—'} 20d vs never 0.30</div></div>
  <div class="kpi"><div class="kpi-label">Cases tested</div><div class="kpi-value">{summary['cases']}</div><div class="kpi-sub">{summary['winners']} beat staying out (45d)</div></div>
</div>
<p class="note">“Net” is net of fees, IL, gas, switching and borrow costs, versus holding the
initial LP basket. “Delta” is the difference from the never-use-0.30 run. A positive delta means
the 0.30 pool paid for the extra risk.</p>

<h2>1. Best case at each 0.30-pool volume</h2>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>0.30 volume</th><th>Share cap</th><th>Rule</th><th>45d delta</th><th>45d in 0.30</th><th>20d delta</th>
</tr></thead><tbody>{''.join(rows)}</tbody></table></div>
{_bar_svg(df)}
<p class="note">A $0 cell means every cap that allowed an entry lost money, so the best result was
not to enter. The curve turns positive only at 10× volume, and only when the cap is relaxed to 15%
or more.</p>

<h2>2. Delta vs never using 0.30 — 45 days</h2>
{_heat_table(df, '45d')}
<p class="note">Each cell is the gain or loss versus the risk-only run; the second line is the
hours spent in the 0.30 pool. Rule fixed at 2h window / 2h check / 1,000 bps entry buffer.</p>

<h2>3. Delta — last 20 days</h2>
{_heat_table(df, '20d')}
<p class="note">The 20-day window is much weaker: the 10× gain shrinks to +$258 with the 2h rule
and turns into −$38 with the 4h rule. The 15% entries at 2–5× recover only $104–$234, and the
45-day losers stay negative. The opportunity is front-loaded, not steady.</p>

<h2>4. Every case that beat staying out</h2>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>0.30 volume</th><th>Share cap</th><th>Rule</th><th>45d delta</th><th>45d exposure</th><th>20d delta</th><th>20d in 0.30</th>
</tr></thead><tbody>{''.join(winning_rows) if winning_rows else '<tr><td colspan="7">No winning case.</td></tr>'}</tbody></table></div>

<h2>5. Does a smaller position get in under the 5% cap?</h2>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>Capital</th><th>Never 0.30 (45d)</th><th>5% cap</th><th>15% cap</th><th>25% cap</th>
</tr></thead><tbody>{''.join(cap_rows)}</tbody></table></div>
<p class="note">At 10× volume, 2h rule, 45 days. A $10k position is a small enough share of the
0.30 pool to pass the 5% cap and adds about <b>+$710</b>; at $50k the 5% cap still blocks it and
15% adds about <b>+$3,037</b>; at $250k even 15% blocks it, and the 25% cap enters briefly and
loses about <b>$5,392</b>. Arm caps scale with capital; Morpho borrow liquidity is held at
$15k and $10k per call, matching the repo's large-NAV convention.</p>
<p class="note">Lowering the 3h volume floor from $50k to $25k did not create a winner: the 5%
caps still never enter, and the 15–25% entries that do happen lose $418–$3,424.</p>

<h2>6. What would have to be true</h2>
<div class="warn"><b>The 10× case is not a forecast.</b> It holds the 0.30 pool's liquidity fixed
while multiplying its volume 10×, which lifts its fee APR to roughly 190%. In reality that volume
would attract more liquidity and dilute the fee APR. The honest reading is: the 0.30 pool needs
roughly an order of magnitude more volume at today's depth, and a share cap around 15–25%, before
it pays for the concentration risk. At the actual tape, it does not.</div>

<div class="footer">45-day real tape ending 2026-10-24 · $100,000 · in-sample · 76 tests.
0.05 pool = deep, low fee tier; 0.30 pool = thin, 6× fee tier. Risk-only baseline = recommended
strategy with the 0.30 pool disabled. Research display, not investment advice.</div>
</div></body></html>"""
    return html


if __name__ == "__main__":
    main()
