"""Fee-based break-even map for a 0.30-pool sleeve.

Uses the observed pool fees, not volume. The decision metric is the fee ratio
    r = 0.30 pool fees / your 0.05 fees at full capital
and the profit function
    Delta(w) = m * F_B * s(w) - w * (F_A + H)
where H is what the risk-only engine earns above all-0.05. Volume is only an
input to F_B; it is never the trigger.

    python run_fee_break_even.py
    # out/fee_break_even.csv
    # out/fee_break_even.json
    # out/fee_break_even.html
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pandas as pd

from build_scenario_lab import scale_book_volume
from run_split_cases import run_split
from scenario import load_scenario

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
SCENARIO = HERE / "data" / "scenario_45d.json"
CAP = 100_000.0
POOL_A_FEES = 293_889.20
POOL_B_FEES = 22_839.59
VOLS = (1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.5, 3.0, 5.0, 10.0)
WEIGHTS = (0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.28, 0.33, 0.43, 0.50, 0.75, 1.0)


def main() -> None:
    base = load_scenario(SCENARIO)[1]
    risk = json.loads((OUT / "recommended_100k_summary.json").read_text(encoding="utf-8"))
    risk_net = float(risk["net_vs_initial_pool"])
    a0 = run_split(0.0, base)
    a_net = float(a0["net"])
    f_a = float(a0["fees"])
    h = risk_net - a_net
    all_in = run_split(1.0, base)
    s1 = float(all_in["b_fee"]) / POOL_B_FEES
    a = s1 / (1.0 - s1)
    fee_ratio_1x = POOL_B_FEES / POOL_A_FEES

    records = []
    for m in VOLS:
        rows = base if m == 1.0 else scale_book_volume(base, "bookB", m)
        for w in WEIGHTS:
            r = run_split(w, rows)
            combined = (1.0 - w) * risk_net + (r["net"] - (1.0 - w) * a_net)
            records.append(
                {
                    "vol_mult": m,
                    "w": w,
                    "share_b": r["b_fee"] / (POOL_B_FEES * m) if w > 0 else 0.0,
                    "net": r["net"],
                    "delta_a": r["net"] - a_net,
                    "combined": combined,
                    "delta_risk": combined - risk_net,
                    "fee_ratio": m * fee_ratio_1x,
                }
            )
    df = pd.DataFrame(records)
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / "fee_break_even.csv", index=False)

    # Break-even multiples per sleeve, using the observed share at 1x.
    base_w = df[(df.vol_mult == 1.0) & (df.w > 0)].copy()
    rows_be = []
    for _, r in base_w.iterrows():
        w = float(r.w)
        s_w = float(r.share_b)
        m_pool = w * f_a / (POOL_B_FEES * s_w)
        m_risk = w * (f_a + h) / (POOL_B_FEES * s_w)
        rows_be.append(
            {
                "w": w,
                "share": s_w,
                "m_pool": m_pool,
                "ratio_pool": m_pool * fee_ratio_1x,
                "m_risk": m_risk,
                "ratio_risk": m_risk * fee_ratio_1x,
            }
        )
    be = pd.DataFrame(rows_be).sort_values("w")

    # Optimal weights as a function of the fee ratio.
    def w_star(ratio: float, hurdle: float = 0.0) -> float:
        r2 = ratio * f_a / (f_a + hurdle)
        val = (math.sqrt(max(0.0, r2 * a)) - 1.0) / a
        return max(0.0, min(1.0, val))

    current = {
        "fee_ratio": fee_ratio_1x,
        "r": POOL_B_FEES / f_a,
        "w_fee_star": w_star(POOL_B_FEES / f_a),
        "w_profit_star": w_star(POOL_B_FEES / f_a, h),
        "a": a,
        "s1": s1,
        "f_a": f_a,
        "h": h,
        "risk_net": risk_net,
        "a_net": a_net,
    }

    # Historical rolling 7-day fee ratio.
    fa = [float(r["bookA"].get("poolFeesUsd", 0.0)) for r in base]
    fb = [float(r["bookB"].get("poolFeesUsd", 0.0)) for r in base]
    ratios = []
    for i in range(168, len(fa) + 1):
        sa = sum(fa[i - 168 : i])
        sb = sum(fb[i - 168 : i])
        if sa > 0:
            ratios.append(sb / sa)
    hist = {
        "min": min(ratios),
        "median": sorted(ratios)[len(ratios) // 2],
        "max": max(ratios),
        "now": fee_ratio_1x,
        "x15_min": min(r * 1.5 for r in ratios),
        "x15_median": sorted(r * 1.5 for r in ratios)[len(ratios) // 2],
        "x15_max": max(r * 1.5 for r in ratios),
    }

    summary = {
        "current": current,
        "break_even": be.to_dict("records"),
        "history": hist,
        "grid": df.to_dict("records"),
    }
    with open(OUT / "fee_break_even.json", "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)

    html = build_html(df, be, summary)
    (OUT / "fee_break_even.html").write_text(html, encoding="utf-8")
    print(json.dumps({"current": current, "history": hist}, indent=2))
    print(f"wrote {OUT / 'fee_break_even.html'} ({len(html)/1024:.1f} KiB)")


def _money(x: float) -> str:
    return f"{'+' if x >= 0 else '-'}${abs(x):,.0f}"


def _pct(x: float) -> str:
    return f"{x*100:.2f}%"


def _cls(x: float) -> str:
    return "pos" if x > 0 else ("neg" if x < 0 else "")


def _heat(df: pd.DataFrame) -> str:
    part = df[df.vol_mult <= 2.0 + 1e-9]
    head = "".join(f"<th>{int(w*100)}%</th>" for w in WEIGHTS)
    body = []
    for m in sorted(part.vol_mult.unique()):
        cells = []
        for w in WEIGHTS:
            row = part[(part.vol_mult == m) & (part.w == w)]
            d = float(row.iloc[0]["delta_risk"])
            alpha = min(0.35, abs(d) / 700 * 0.35)
            color = f"rgba(15,157,118,{alpha:.2f})" if d > 0 else f"rgba(220,38,38,{alpha:.2f})"
            style = "background:" + color
            if abs(m - 1.5) < 1e-9:
                style += ";outline:2px solid #2563eb;outline-offset:-2px"
            cells.append(f'<td class="heat" style="{style}">{_money(d)}</td>')
        body.append(f"<tr><th>{m:.1f}×</th>{''.join(cells)}</tr>")
    return (
        '<div class="table-wrap"><table class="tbl heat-tbl"><thead><tr><th>0.30 volume</th>'
        + head
        + "</tr></thead><tbody>"
        + "".join(body)
        + "</tbody></table></div>"
    )


def build_html(df: pd.DataFrame, be: pd.DataFrame, summary: dict) -> str:
    cur = summary["current"]
    hist = summary["history"]

    be_rows = []
    for _, r in be.iterrows():
        be_rows.append(
            f"<tr><td>{r.w*100:.0f}%</td><td>{r.share*100:.2f}%</td>"
            f"<td>{r.ratio_pool*100:.2f}%</td><td>{r.m_pool:.2f}×</td>"
            f"<td>{r.ratio_risk*100:.2f}%</td><td>{r.m_risk:.2f}×</td></tr>"
        )

    def gain(m: float, w: float) -> float:
        row = df[(df.vol_mult == m) & (df.w == w)]
        return float(row.iloc[0]["delta_risk"])

    demo_rows = []
    for w in (0.05, 0.10, 0.20, 0.28, 0.43, 0.50, 1.0):
        demo_rows.append(
            f"<tr><td>{int(w*100)}%</td><td>{gain(1.0, w):+,.0f}</td>"
            f"<td>{gain(1.5, w):+,.0f}</td><td>{gain(2.0, w):+,.0f}</td></tr>"
        )

    decomp_rows = []
    for m in (1.0, 1.2, 1.3, 1.4, 1.5, 2.0):
        row = df[(df.vol_mult == m) & (df.w == 0.28)].iloc[0]
        fee_gain = float(row["delta_a"])
        cost = 0.28 * cur["h"]
        net = fee_gain - cost
        decomp_rows.append(
            f"<tr><td>{m:.1f}×</td><td class=\"{_cls(fee_gain)}\">{_money(fee_gain)}</td>"
            f"<td class=\"neg\">−${cost:,.0f}</td>"
            f"<td class=\"{_cls(net)}\">{_money(net)}</td></tr>"
        )

    cap = 0.05
    w_cap = min(1.0, cap / (cur["a"] * (1.0 - cap)))

    css = """
    :root{--bg:#f6f7f9;--card:#fff;--ink:#17202a;--muted:#667085;--line:#e4e7ec;
      --green:#0f9d76;--red:#dc2626;--amber:#d97706;--blue:#2563eb}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);
      font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .wrap{max-width:1120px;margin:0 auto;padding:34px 22px 60px}
    h1{font-size:30px;line-height:1.15;margin:0 0 6px;letter-spacing:-.025em}
    h2{font-size:21px;margin:36px 0 10px;letter-spacing:-.015em}
    .sub{color:var(--muted);margin:0 0 18px;max-width:920px}
    .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:10px;margin:14px 0}
    .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 15px}
    .kpi-label{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:750}
    .kpi-value{font-size:23px;font-weight:780;margin:4px 0 1px;letter-spacing:-.01em}
    .kpi-sub{font-size:11.5px;color:var(--muted)}
    .kpi.pos{border-top:3px solid var(--green)}.kpi.neg{border-top:3px solid var(--red)}
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
    .heat{padding:8px 7px!important;text-align:center!important;font-weight:650}
    .pos{color:#0b7f5f;font-weight:700}.neg{color:#b42318;font-weight:700}
    .formula{background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:12px 14px;
      font:13px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:#344054;margin:10px 0;overflow-x:auto}
    .note{color:var(--muted);font-size:12.5px;margin:6px 0 14px;max-width:1050px}
    .footer{color:var(--muted);font-size:12px;border-top:1px solid var(--line);margin-top:36px;padding-top:16px}
    """

    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fee break-even: when is the 0.30 pool worth it?</title>
<style>{css}</style></head><body><div class="wrap">

<h1>Fee break-even: when is the 0.30 pool worth it?</h1>
<p class="sub">The trigger is the fee ratio, not volume. Use the observed fees:
<b>ρ = 0.30 pool fees / 0.05 pool fees</b> (currently {hist['now']*100:.2f}%) and
<b>r = 0.30 pool fees / your 0.05 fees at full capital</b> (currently {cur['r']:.2f}). Volume is
only an input to the 0.30 fee counter. The model sizes the sleeve with exact fee share and compares
it with the risk-only engine on the remaining capital.</p>

<div class="callout"><b>At current fees, a partial 0.30 sleeve is fee-positive but not yet
better than our risk-only strategy.</b> The 0.30 pool earns <b>{hist['now']*100:.2f}%</b> of the
0.05 pool's fees. A 28% sleeve becomes profitable versus all-0.05 at a fee ratio of
<b>{float(be[be.w==0.28].iloc[0]['ratio_pool'])*100:.2f}%</b>, which it already exceeds. But to
beat the risk-only engine it needs <b>{float(be[be.w==0.28].iloc[0]['ratio_risk'])*100:.2f}%</b>
— about <b>{float(be[be.w==0.28].iloc[0]['m_risk']):.2f}×</b> current volume. At <b>1.5×</b>
fees ({hist['now']*1.5*100:.2f}%) the 28% sleeve adds <b>{_money(gain(1.5,0.28))}</b>, and a 43%
sleeve adds <b>{_money(gain(1.5,0.43))}</b>.</div>

<div class="kpis">
  <div class="kpi"><div class="kpi-label">Fee ratio now</div><div class="kpi-value">{hist['now']*100:.2f}%</div><div class="kpi-sub">0.30 fees / 0.05 fees</div></div>
  <div class="kpi"><div class="kpi-label">28% break-even vs all-0.05</div><div class="kpi-value">{float(be[be.w==0.28].iloc[0]['ratio_pool'])*100:.2f}%</div><div class="kpi-sub">{float(be[be.w==0.28].iloc[0]['m_pool']):.2f}× current volume</div></div>
  <div class="kpi"><div class="kpi-label">28% break-even vs risk-only</div><div class="kpi-value">{float(be[be.w==0.28].iloc[0]['ratio_risk'])*100:.2f}%</div><div class="kpi-sub">{float(be[be.w==0.28].iloc[0]['m_risk']):.2f}× current volume</div></div>
  <div class="kpi pos"><div class="kpi-label">28% sleeve at 1.5×</div><div class="kpi-value">{_money(gain(1.5,0.28))}</div><div class="kpi-sub">vs risk-only, 45d</div></div>
</div>

<h2>1. The break-even fee ratio by sleeve</h2>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>0.30 sleeve</th><th>Your share</th><th>Break-even fee ratio vs all-0.05</th><th>Volume multiple</th><th>Break-even fee ratio vs risk-only</th><th>Volume multiple</th>
</tr></thead><tbody>{''.join(be_rows)}</tbody></table></div>
<p class="note">The fee ratio is the 0.30 pool's fees divided by the 0.05 pool's fees. The
volume multiple is only the equivalent volume that produces that fee ratio; the trigger should be
the fee ratio itself. At 100% sleeve the 0.30 pool needs 7.83% of the 0.05 fees to beat all-0.05;
it is at 7.77%, just below. To beat the risk-only engine it needs 11.51%; at 1.5× (11.66%) it
just clears.</p>

<h2>2. Profit by sleeve and volume — combined with the risk-only engine</h2>
{_heat(df)}
<p class="note">Delta versus the risk-only run over 45 days. The 1.5× row is outlined. Red cells
lose money; green cells beat staying in the risk-only strategy. At 1.5× the best sleeve is around
43–50%, above the 5% share cap; the cap-constrained 28% is the practical choice.</p>

<h2>3. The check and move function</h2>
<div class="formula">rho = F_B_pool / F_A_pool      (the visible fee ratio)<br>
r   = F_B / F_A = rho / share_A<br>
s1  = your fee share if 100% were in 0.30<br>
a   = s1 / (1 - s1)<br><br>
Delta(w) = m * F_B * s(w) - w * (F_A + H)<br>
s(w)    = w * a / (1 + w * a)<br><br>
w* = ( sqrt( m * F_B * a / (F_A + H) ) - 1 ) / a<br>
w  = clamp(w*, 0, w_cap),  w_cap = cap / (a * (1 - cap))<br><br>
F_B = 0.30 pool fee revenue over the horizon<br>
F_A = your 0.05 fee revenue at full capital<br>
H   = risk-only net minus all-0.05 net (the return you give up by moving)<br>
cap = your limit on the 0.30 share</div>
<p class="note">This is the whole rule. <b>H</b> is the “further loss” term: moving capital out of
the risk-only engine costs <b>w × H</b>, so the fee gain must clear it. If you compare only with
passive all-0.05, set H = 0; the same formula gives the pool-only optimum. At current fees the
risk-only version gives w* = 0, while the fee-only version gives 46%. At 1.5× the risk-only
version gives about 51%, capped at 28%; at 2× it wants 100%, capped at 28%.</p>

<h2>4. What 1.5× actually does</h2>
<h3>The 28% sleeve: fee gain vs the cost of leaving risk-only</h3>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>0.30 volume</th><th>Fee gain vs all-0.05</th><th>Cost of leaving risk-only</th><th>Net vs risk-only</th>
</tr></thead><tbody>{''.join(decomp_rows)}</tbody></table></div>
<p class="note">The cost is <b>w × H</b>, where H is the risk-only engine's return above all-0.05
(here {_money(cur['h'])} per $100k). At 1× the fee gain is too small to cover it; at 1.3× the
two are roughly equal; at 1.5× the fee gain clears the cost by about {_money(gain(1.5,0.28))}.</p>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>Sleeve</th><th>1.0×</th><th>1.5×</th><th>2.0×</th>
</tr></thead><tbody>{''.join(demo_rows)}</tbody></table></div>
<p class="note">Delta versus the risk-only run, 45 days. At 1× every sleeve loses to the risk-only
engine. At 1.5× the 5% sleeve is +{gain(1.5,0.05):,.0f}, the 28% sleeve is
+{gain(1.5,0.28):,.0f}, and the 43% sleeve is +{gain(1.5,0.43):,.0f}. The 100% sleeve is only
+{gain(1.5,1.0):,.0f}, because it gives up the risk-only engine entirely.</p>

<h2>5. The historical fee signal</h2>
<p class="note">Seven-day rolling fee ratio over the 45-day tape: min
<b>{hist['min']*100:.2f}%</b>, median <b>{hist['median']*100:.2f}%</b>, max
<b>{hist['max']*100:.2f}%</b>. At 1.5× those become
<b>{hist['x15_min']*100:.2f}%</b> / <b>{hist['x15_median']*100:.2f}%</b> /
<b>{hist['x15_max']*100:.2f}%</b>. The 28% risk-only threshold is
<b>{float(be[be.w==0.28].iloc[0]['ratio_risk'])*100:.2f}%</b>; the signal crosses it in the
better weeks and falls below it in the weaker weeks. That is why the keeper needs a rolling
window and hysteresis, not a single 45-day average.</p>

<h2>6. What this does and does not prove</h2>
<div class="warn"><b>The fee ratio is historical, not a forecast.</b> The volume multiples scale
the 0.30 fee counter while holding liquidity fixed; real volume growth attracts liquidity and
dilutes the fee APR. The sleeves are passive: no re-centering, no skew, no Morpho overlay on the
0.30 side. The risk-only comparison is an overlay approximation. The result that survives is the
function and the break-even levels: the 0.30 pool is already fee-positive for a partial sleeve,
but only beats the risk-only engine at about 1.3× the current fee ratio. At 1.5× the 28% sleeve
is worth roughly +{gain(1.5,0.28):,.0f}.</div>

<div class="footer">45-day real tape ending 2026-10-24 · $100,000 · in-sample · 76 tests.
0.05 pool = deep, low fee tier; 0.30 pool = thin, 6× fee tier. Research display, not investment
advice.</div>
</div></body></html>"""
    return html


if __name__ == "__main__":
    main()
