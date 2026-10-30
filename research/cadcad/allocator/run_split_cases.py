"""How much of the book should sit in the 0.30 pool?

Two-sleeve hourly simulation on the real 45-day tape. The 0.05 sleeve and the
0.30 sleeve run simultaneously, each with the recommended 75% guard / 25% base
shape. Fees use the exact share L/(poolL+L), so adding capital to the thin pool
dilutes its own fee share.

    python run_split_cases.py
    # out/split_pool_cases.csv
    # out/split_pool_cases.json
    # out/split_pool_cases.html

The sleeves are passive (no re-centering) to isolate the pool-choice effect.
This is a sensitivity on the same tape, not a forecast.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pandas as pd

from build_scenario_lab import scale_book_volume
from model import (
    _book_template,
    book_fee_for_hour,
    book_tokens,
    book_value,
    default_params,
    price_from_tick,
)
from run import COMMON, RISK
from scenario import load_scenario

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
SCENARIO = HERE / "data" / "scenario_45d.json"
CAP = 100_000.0
POOL_B_FEES = 22_839.59
VOLS = (1.0, 2.0, 3.0, 5.0, 10.0)
WEIGHTS = (0.0, 0.01, 0.02, 0.05, 0.10, 0.15, 0.20, 0.25, 0.28, 0.33, 0.40, 0.43, 0.50, 0.60, 0.75, 1.0)

P = default_params()
P.update(
    {
        **COMMON,
        **RISK,
        "initial_nav_usd": CAP,
        "book_capital_usd": CAP,
        "fee_share_mode": "exact",
        "guard_share": 0.75,
        "base_width_ticks": 3_000,
        "guard_width_ticks": 500,
        "base_skew_mode": "inventory",
        "base_skew_max_ticks": 1_000,
    }
)


def make_book(capital: float, tick: int, sqrt_p: float) -> dict:
    b = _book_template(
        tick,
        sqrt_p,
        capital * (1.0 - P["guard_share"]),
        capital * P["guard_share"],
        P,
    )
    b["deployed"] = True
    b["guard_present"] = True
    b["base_L"] = b["target_base_L"]
    b["guard_L"] = b["target_guard_L"]
    return b


def run_split(w: float, rows: list[dict]) -> dict:
    tick0 = int(rows[0]["tick"])
    sqrt0 = float(rows[0]["sqrtP"])
    a = make_book(CAP * (1.0 - w), tick0, sqrt0)
    b = make_book(CAP * w, tick0, sqrt0)
    a_fee = b_fee = 0.0
    gas = 0.04

    for i in range(len(rows) - 1):
        row = rows[i]
        if CAP * (1.0 - w) > 0:
            a_fee += book_fee_for_hour(a, row["bookA"]["minutes"], P["fee_a"], None, "exact")[0]
        if CAP * w > 0:
            b_fee += book_fee_for_hour(b, row["bookB"]["minutes"], P["fee_b"], None, "exact")[0]

    sqrt_end = float(rows[-1]["sqrtP"])
    nav = book_value(a, sqrt_end) + book_value(b, sqrt_end) + a_fee + b_fee - gas
    hold = make_book(CAP, tick0, sqrt0)
    usdg, nvda = book_tokens(hold, sqrt0)
    hodl = usdg + nvda * price_from_tick(int(rows[-1]["tick"]))
    return {
        "net": nav - hodl,
        "fees": a_fee + b_fee,
        "b_fee": b_fee,
        "a_fee": a_fee,
    }


def main() -> None:
    base45 = load_scenario(SCENARIO)[1]
    base20 = load_scenario(SCENARIO, hours=480)[1]
    risk = json.loads((OUT / "recommended_100k_summary.json").read_text(encoding="utf-8"))
    risk_net = {"45d": float(risk["net_vs_initial_pool"]), "20d": float(risk["net_20d"])}

    records = []
    for window, base in (("45d", base45), ("20d", base20)):
        for m in VOLS:
            rows = base if m == 1.0 else scale_book_volume(base, "bookB", m)
            a_net = run_split(0.0, rows)["net"]
            for w in WEIGHTS:
                r = run_split(w, rows)
                records.append(
                    {
                        "window": window,
                        "vol_mult": m,
                        "w": w,
                        "share_b": r["b_fee"] / (POOL_B_FEES * m) if w > 0 else 0.0,
                        "net": r["net"],
                        "delta_a": r["net"] - a_net,
                        "fees": r["fees"],
                        "b_fee": r["b_fee"],
                        "a_net": a_net,
                        "combined": (1.0 - w) * risk_net[window] + (r["net"] - (1.0 - w) * a_net),
                    }
                )

    df = pd.DataFrame(records)
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / "split_pool_cases.csv", index=False)

    # Curvature: all-in fee share s1 -> a = s1/(1-s1).
    all_in = df[(df.window == "45d") & (df.w == 1.0)][["vol_mult", "share_b"]].copy()
    a45 = float(df[(df.window == "45d") & (df.w == 0.0)].iloc[0]["a_net"])
    f_a = float(df[(df.window == "45d") & (df.w == 0.0)].iloc[0]["fees"])
    rows_formula = []
    for _, r in all_in.iterrows():
        s1 = float(r.share_b)
        a = s1 / (1.0 - s1)
        f_b = POOL_B_FEES * float(r.vol_mult)
        w_star = (math.sqrt(f_b * a / f_a) - 1.0) / a
        rows_formula.append(
            {
                "vol_mult": float(r.vol_mult),
                "s_all": s1,
                "a": a,
                "w_star": max(0.0, min(1.0, w_star)),
                "w_cap5": min(1.0, 0.05 / (a * 0.95)),
                "w_cap10": min(1.0, 0.10 / (a * 0.90)),
                "w_cap15": min(1.0, 0.15 / (a * 0.85)),
            }
        )
    formula = pd.DataFrame(rows_formula)

    # Simulate the cap-constrained weights directly.
    cap_records = []
    for cap in (0.05, 0.10, 0.15):
        for m in VOLS:
            w = min(1.0, cap / (float(formula[formula.vol_mult == m].iloc[0]["a"]) * (1 - cap)))
            rows = base45 if m == 1.0 else scale_book_volume(base45, "bookB", m)
            r = run_split(w, rows)
            a_net = float(df[(df.window == "45d") & (df.vol_mult == m) & (df.w == 0)]["a_net"].iloc[0])
            cap_records.append(
                {
                    "cap": cap,
                    "vol_mult": m,
                    "w": w,
                    "share_b": r["b_fee"] / (POOL_B_FEES * m),
                    "net": r["net"],
                    "delta_a": r["net"] - a_net,
                    "combined": (1 - w) * risk_net["45d"] + (r["net"] - (1 - w) * a_net),
                }
            )

    capdf = pd.DataFrame(cap_records)

    # Best static weight per volume, and the 20-day check at the 28% sleeve.
    best = {}
    for m in VOLS:
        part = df[(df.window == "45d") & (df.vol_mult == m)]
        row = part.loc[part["delta_a"].idxmax()]
        best[m] = row.to_dict()

    w28 = df[(df.window == "45d") & (df.w == 0.28)][
        ["vol_mult", "share_b", "net", "delta_a", "combined"]
    ].copy()
    w28_20 = df[(df.window == "20d") & (df.w == 0.28)][
        ["vol_mult", "net", "delta_a", "combined"]
    ].copy()
    w28 = w28.merge(w28_20, on="vol_mult", suffixes=("", "_20d"))

    combined_rows = []
    for m in (1.0, 2.0, 10.0):
        for w in (0.0, 0.05, 0.28, 0.43, 1.0):
            r = df[(df.window == "45d") & (df.vol_mult == m) & (df.w == w)].iloc[0]
            combined_rows.append(
                {
                    "vol_mult": m,
                    "w": w,
                    "combined": float(r["combined"]),
                    "delta": float(r["combined"]) - risk_net["45d"],
                }
            )

    summary = {
        "initial": CAP,
        "risk_only_net": risk_net,
        "all_a_net_45": a45,
        "actual_tape_best_w": float(best[1.0]["w"]),
        "actual_tape_best_delta": float(best[1.0]["delta_a"]),
        "tenx_best_w": float(best[10.0]["w"]),
        "tenx_best_delta": float(best[10.0]["delta_a"]),
        "tenx_28_delta": float(w28[w28.vol_mult == 10.0]["delta_a"].iloc[0]),
        "tenx_28_combined": float(w28[w28.vol_mult == 10.0]["combined"].iloc[0]),
        "formula": formula.to_dict("records"),
        "cap_table": capdf.to_dict("records"),
        "w28": w28.to_dict("records"),
        "combined_table": combined_rows,
        "all_in_share": {float(r.vol_mult): float(r.share_b) for _, r in all_in.iterrows()},
    }
    with open(OUT / "split_pool_cases.json", "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)

    html = build_html(df, formula, capdf, w28, summary)
    (OUT / "split_pool_cases.html").write_text(html, encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k not in ("formula", "cap_table", "w28")}, indent=2))
    print(f"wrote {OUT / 'split_pool_cases.html'} ({len(html)/1024:.1f} KiB)")


def _money(x: float) -> str:
    return f"{'+' if x >= 0 else '-'}${abs(x):,.0f}"


def _pct(x: float) -> str:
    return f"{x*100:.1f}%"


def _cls(x: float) -> str:
    return "pos" if x > 0 else ("neg" if x < 0 else "")


def _bar_svg(w28: pd.DataFrame, risk_net: float, height: int = 260) -> str:
    width = 760
    pl, pr, pt, pb = 64, 20, 30, 42
    pw, ph = width - pl - pr, height - pt - pb
    vals = [float(v) - risk_net for v in w28["combined"]]
    lo = min(0.0, min(vals))
    hi = max(0.0, max(vals))
    span = max(1.0, hi - lo)

    def y(v: float) -> float:
        return pt + ph * (1 - (v - lo) / span)

    zero = y(0)
    parts = [
        f'<svg viewBox="0 0 {width} {height}" class="chart" role="img" aria-label="Combined gain at a 28% 0.30 sleeve">',
        f'<text x="{pl}" y="16" class="chart-title">Combined 45-day gain vs the risk-only run — 28% sleeve in the 0.30 pool</text>',
    ]
    for k in range(5):
        v = lo + span * k / 4
        yy = y(v)
        parts.append(f'<line x1="{pl}" y1="{yy:.1f}" x2="{width-pr}" y2="{yy:.1f}" class="grid"/>')
        parts.append(f'<text x="{pl-8}" y="{yy+4:.1f}" class="axis" text-anchor="end">{_money(v)}</text>')
    n = len(w28)
    slot = pw / n
    for i, (_, row) in enumerate(w28.iterrows()):
        v = float(row["combined"]) - risk_net
        x = pl + i * slot + slot * 0.22
        w = slot * 0.56
        top = min(zero, y(v))
        h = abs(y(v) - zero)
        color = "#0f9d76" if v > 0 else "#dc2626"
        parts.append(f'<rect x="{x:.1f}" y="{top:.1f}" width="{w:.1f}" height="{max(1.0,h):.1f}" rx="4" fill="{color}" opacity=".85"/>')
        parts.append(f'<text x="{x+w/2:.1f}" y="{top-5:.1f}" class="axis" text-anchor="middle">{_money(v)}</text>')
        parts.append(f'<text x="{x+w/2:.1f}" y="{height-14}" class="axis" text-anchor="middle">{int(row.vol_mult)}×</text>')
    parts.append(f'<line x1="{pl}" y1="{zero:.1f}" x2="{width-pr}" y2="{zero:.1f}" class="zero"/>')
    parts.append("</svg>")
    return "".join(parts)


def build_html(df, formula, capdf, w28, summary) -> str:
    # Net-vs-weight table at 1x and 10x.
    def weight_rows(m):
        part = df[(df.window == "45d") & (df.vol_mult == m)]
        out = []
        for _, r in part.iterrows():
            out.append(
                f"<tr><td>{r.w*100:.0f}%</td><td>{r.share_b*100:.2f}%</td>"
                f"<td class=\"{_cls(r.delta_a)}\">{_money(r.delta_a)}</td>"
                f"<td>{_money(r.net)}</td></tr>"
            )
        return "".join(out)

    # Cap table at 10x.
    caps = []
    for cap in (0.05, 0.10, 0.15):
        r = capdf[(capdf.cap == cap) & (capdf.vol_mult == 10.0)].iloc[0]
        caps.append(
            f"<tr><td>{int(cap*100)}%</td><td>{r.w*100:.0f}%</td><td>≈{r.share_b*100:.1f}%</td>"
            f"<td class=\"{_cls(r.delta_a)}\">{_money(r.delta_a)}</td>"
            f"<td class=\"{_cls(r.combined - summary['risk_only_net']['45d'])}\">"
            f"{_money(r.combined - summary['risk_only_net']['45d'])}</td></tr>"
        )

    formula_rows = []
    for r in summary["formula"]:
        formula_rows.append(
            f"<tr><td>{int(r['vol_mult'])}×</td><td>{r['s_all']*100:.2f}%</td>"
            f"<td>{r['w_star']*100:.0f}%</td><td>{r['w_cap5']*100:.0f}%</td>"
            f"<td>{r['w_cap10']*100:.0f}%</td></tr>"
        )

    w28_rows = []
    for r in summary["w28"]:
        combined_delta = r["combined"] - summary["risk_only_net"]["45d"]
        w28_rows.append(
            f"<tr><td>{int(r['vol_mult'])}×</td><td>{r['share_b']*100:.2f}%</td>"
            f"<td class=\"{_cls(r['delta_a'])}\">{_money(r['delta_a'])}</td>"
            f"<td class=\"{_cls(combined_delta)}\">{_money(combined_delta)}</td>"
            f"<td class=\"{_cls(r['delta_a_20d'])}\">{_money(r['delta_a_20d'])}</td>"
            f"<td class=\"{_cls(r['combined_20d'] - summary['risk_only_net']['20d'])}\">"
            f"{_money(r['combined_20d'] - summary['risk_only_net']['20d'])}</td></tr>"
        )

    grouped = {}
    for r in summary["combined_table"]:
        grouped.setdefault(r["vol_mult"], {})[r["w"]] = r["delta"]
    comb_rows = []
    for m in (1.0, 2.0, 10.0):
        cells = []
        for w in (0.0, 0.05, 0.28, 0.43, 1.0):
            d = grouped[m][w]
            cells.append(f"<td class=\"{_cls(d)}\">{_money(d)}</td>")
        comb_rows.append(f"<tr><td><b>{int(m)}×</b></td>{''.join(cells)}</tr>")

    css = """
    :root{--bg:#f6f7f9;--card:#fff;--ink:#17202a;--muted:#667085;--line:#e4e7ec;
      --green:#0f9d76;--red:#dc2626;--amber:#d97706}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);
      font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .wrap{max-width:1120px;margin:0 auto;padding:34px 22px 60px}
    h1{font-size:30px;line-height:1.15;margin:0 0 6px;letter-spacing:-.025em}
    h2{font-size:21px;margin:36px 0 10px;letter-spacing:-.015em}
    h3{font-size:15px;margin:20px 0 6px}
    .sub{color:var(--muted);margin:0 0 18px;max-width:920px}
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
    .pos{color:#0b7f5f;font-weight:700}.neg{color:#b42318;font-weight:700}
    .chart{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:14px;margin:10px 0}
    .chart-title{fill:#17202a;font-size:12px;font-weight:750}
    .axis{fill:#667085;font-size:10px}.grid{stroke:#e4e7ec;stroke-width:1}.zero{stroke:#98a2b3;stroke-width:1.2}
    .note{color:var(--muted);font-size:12.5px;margin:6px 0 14px;max-width:1050px}
    .formula{background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:12px 14px;
      font:13px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:#344054;margin:10px 0;overflow-x:auto}
    .footer{color:var(--muted);font-size:12px;border-top:1px solid var(--line);margin-top:36px;padding-top:16px}
    """

    best1 = summary["actual_tape_best_w"] * 100
    best1d = summary["actual_tape_best_delta"]
    tenx28 = summary["tenx_28_delta"]
    tenx_comb = summary["tenx_28_combined"] - summary["risk_only_net"]["45d"]

    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Should we split between the 0.05 and 0.30 pools?</title>
<style>{css}</style></head><body><div class="wrap">

<h1>Should we split between the 0.05 and 0.30 pools?</h1>
<p class="sub">Two sleeves, same $100,000, same 45-day tape. The 0.05 sleeve and the 0.30 sleeve run
at the same time, each with the recommended 75% guard / 25% base shape. Fees use the exact
share <b>L / (pool L + L)</b>, so moving more into the thin pool dilutes your own fee share.
No re-centering and no inventory skew: this isolates the pool-choice effect.</p>

<div class="callout"><b>Pool-only, a partial sleeve beats both 100% 0.05 and 100% 0.30.</b>
On the actual tape the best pool-only split is about <b>{best1:.0f}% in the 0.30 pool</b>, worth
<b>{_money(best1d)}</b> over 45 days versus all-0.05. But against our <i>actual</i> risk-only
strategy, the sleeve is negative at 1×. It turns positive at 2× over 45 days (3× over the last
20) and adds about <b>{_money(tenx_comb)}</b> at 10× with a 28% sleeve. Moving 100% into the
0.30 pool is not “owning 100%” — it makes you about
<b>{summary['all_in_share'][10.0]*100:.1f}%</b> of that pool.</div>

<div class="kpis">
  <div class="kpi"><div class="kpi-label">Pool-only best split</div><div class="kpi-value">{best1:.0f}%</div><div class="kpi-sub">{_money(best1d)} vs all-0.05; not vs our strategy</div></div>
  <div class="kpi"><div class="kpi-label">28% sleeve at 10×</div><div class="kpi-value">{_money(tenx28)}</div><div class="kpi-sub">pool-only vs all-0.05</div></div>
  <div class="kpi pos"><div class="kpi-label">28% sleeve + risk-only</div><div class="kpi-value">{_money(tenx_comb)}</div><div class="kpi-sub">vs risk-only at 10×</div></div>
  <div class="kpi"><div class="kpi-label">All-in 0.30 share</div><div class="kpi-value">{summary['all_in_share'][10.0]*100:.1f}%</div><div class="kpi-sub">at this size, not 100%</div></div>
</div>

<h2>1. The actual tape: 1× volume</h2>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>0.30 sleeve</th><th>Your share of 0.30</th><th>Gain vs all-0.05</th><th>Net vs HODL</th>
</tr></thead><tbody>{weight_rows(1.0)}</tbody></table></div>
<p class="note">All-0.05 net is {_money(summary['all_a_net_45'])}. The curve peaks around
43–50%; 100% 0.30 is slightly <i>worse</i> than all-0.05 because the sleeve dilutes its own fee share.
The 5% pool-share cap allows about a 28% sleeve at this size.</p>

<h2>2. The 0.30 pool at 10× volume</h2>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>0.30 sleeve</th><th>Your share of 0.30</th><th>Gain vs all-0.05</th><th>Net vs HODL</th>
</tr></thead><tbody>{weight_rows(10.0)}</tbody></table></div>
<p class="note">At 10× volume more 0.30 is better all the way to 100%, because the fee yield is
large enough to overcome self-dilution. The 5% share cap stops at a 28% sleeve; the 10% cap
allows about 60%; 100% is a 15.6% share.</p>
<p class="note">The 0.30 pool is not a bigger fee pool. At 1× it earns <b>$22,839</b> over 45
days versus <b>$293,889</b> in the 0.05 pool. It is a higher fee <i>rate</i> on a much smaller
base. A “100% sleeve” means 100% of your capital and only 15.6% of the pool; owning the pool
outright would mean buying its existing liquidity, not just adding capital.</p>

<h2>3. What the cap does</h2>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>Share cap</th><th>Max 0.30 sleeve</th><th>Actual share</th><th>Pool-only gain (10×)</th><th>Combined gain vs risk-only</th>
</tr></thead><tbody>{''.join(caps)}</tbody></table></div>
<p class="note">A 5% cap does not mean a 5% sleeve. Because a $100k position is small relative to the
pool's active liquidity, you can put about 28% of the capital in before you own 5% of the 0.30 pool.</p>

<h2>4. The dynamic rule</h2>
<p class="note">Move into the 0.30 pool until its <b>marginal</b> fee dollar equals the 0.05
sleeve's fee dollar. The marginal yield falls as your share rises, so the optimum is finite:</p>
<div class="formula">s1 = your fee share if 100% were in 0.30<br>
a  = s1 / (1 - s1)<br>
w* = ( sqrt(F_B * a / F_A) - 1 ) / a<br>
w  = min(w*, w_cap),  w_cap = cap / (a * (1 - cap))<br><br>
F_B = 0.30 pool fee revenue over the horizon<br>
F_A = your 0.05 fee revenue at full capital<br>
cap = your risk limit on owning the 0.30 pool</div>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>0.30 volume</th><th>All-in share s1</th><th>Unconstrained w*</th><th>5% cap</th><th>10% cap</th>
</tr></thead><tbody>{''.join(formula_rows)}</tbody></table></div>
<p class="note">At 1× the formula says 46%, but the 5% cap limits it to 28%. At 2× and above it
wants 100%, so the cap is the binding constraint. In production, recompute <b>w*</b> from trailing
24h pool fees and your current share every 2h; move in 5-point steps with a 10% hysteresis band,
and pull the sleeve to 0 if the 0.30 edge disappears.</p>

<h2>5. Combined with the risk-only strategy</h2>
<h3>Which split beats our current strategy?</h3>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>0.30 volume</th><th>0%</th><th>5%</th><th>28%</th><th>43%</th><th>100%</th>
</tr></thead><tbody>{''.join(comb_rows)}</tbody></table></div>
<p class="note">Delta versus the risk-only run (45 days). At 1× the best choice is <b>0%</b>:
the 0.30 sleeve earns less than the 0.05/Morpho engine. At 2× and above the best unconstrained
choice is 100%, but the 5% pool-share cap stops at a 28% sleeve. That cap-constrained sleeve is
the practical optimum.</p>
{_bar_svg(w28, summary['risk_only_net']['45d'])}
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>0.30 volume</th><th>Your share</th><th>Pool-only delta (45d)</th><th>Combined delta (45d)</th><th>Pool-only delta (20d)</th><th>Combined delta (20d)</th>
</tr></thead><tbody>{''.join(w28_rows)}</tbody></table></div>
<p class="note">The combined column keeps the existing risk-only 0.05/Morpho engine on the
remaining capital and adds the 0.30 sleeve on top. It is an overlay approximation; the live
keeper needs a split-sleeve implementation. At 1× the sleeve is negative versus the risk-only run;
at 2× it turns positive over 45 days, but over the last 20 days it needs 3× volume. At 10× it
adds about {_money(tenx_comb)} over 45 days and +$1,719 over the last 20.</p>

<h2>6. What this does and does not prove</h2>
<div class="warn"><b>The 10× volume is a sensitivity, not a forecast.</b> It holds the 0.30 pool's
liquidity fixed while multiplying its volume 10×. In reality that volume would attract more
liquidity and dilute the fee APR. The sleeves are also passive: no re-centering, no inventory
skew, and no Morpho overlay on the 0.30 side. The 20-day column is the tail of the same tape,
not independent evidence. The result that survives all of these caveats is the shape: pool-only,
a partial sleeve beats both extremes at 1×; against the risk-only engine, the sleeve only pays at
2× or more; and the cap — not the fee math — is what limits the 10× case.</div>

<div class="footer">45-day real tape ending 2026-10-24 · $100,000 · in-sample · 76 tests.
0.05 pool = deep, low fee tier; 0.30 pool = thin, 6× fee tier. Research display, not investment
advice.</div>
</div></body></html>"""
    return html


if __name__ == "__main__":
    main()
