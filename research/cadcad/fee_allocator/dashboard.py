"""Build the self-contained fee-allocator dashboard from out/sweep.csv."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
CAP = 100_000.0
CAP30 = 539_100.0
CAP15 = 539_100.0
BASE_FEE = 3_663.42


def main() -> None:
    df = pd.read_csv(OUT / "sweep.csv")
    df["share30"] = df["p30"] * CAP / (df["p30"] * CAP + CAP30)
    df["share15"] = df["p15"] * CAP / (df["p15"] * CAP + CAP15)
    df["cap_ok"] = (df["share30"] <= 0.05 + 1e-9) & (df["share15"] <= 0.10 + 1e-9)
    payload = {
        "base_fee": BASE_FEE,
        "H": 1_696.47,
        "cap": CAP,
        "cases": df.to_dict("records"),
        "vols": sorted(df["vol30"].unique().tolist()),
        "p15s": sorted(df["p15"].unique().tolist()),
        "p30s": sorted(df["p30"].unique().tolist()),
        "vol15s": sorted(df["vol15"].unique().tolist()),
    }
    html = build_html(payload)
    (OUT / "dashboard.html").write_text(html, encoding="utf-8")
    print(f"wrote {OUT / 'dashboard.html'} ({len(html)/1024:.1f} KiB)")


def build_html(data: dict) -> str:
    payload = json.dumps(data, separators=(",", ":"))
    css = """
    :root{--bg:#f6f7f9;--card:#fff;--ink:#17202a;--muted:#667085;--line:#e4e7ec;
      --green:#0f9d76;--red:#dc2626;--amber:#d97706;--blue:#2563eb}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);
      font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .wrap{max-width:1120px;margin:0 auto;padding:32px 22px 60px}
    h1{font-size:29px;line-height:1.15;margin:0 0 6px;letter-spacing:-.025em}
    h2{font-size:20px;margin:32px 0 10px}
    .sub{color:var(--muted);margin:0 0 16px;max-width:920px}
    .controls{display:flex;gap:12px;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);
      border-radius:14px;padding:14px 16px;margin:14px 0}
    label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:750}
    select{display:block;margin-top:4px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;
      background:#fff;font-size:13px;color:var(--ink)}
    .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:10px;margin:12px 0}
    .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
    .kpi-label{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:750}
    .kpi-value{font-size:22px;font-weight:780;margin:4px 0 1px;letter-spacing:-.01em}
    .kpi-sub{font-size:11.5px;color:var(--muted)}
    .kpi.pos{border-top:3px solid var(--green)}.kpi.neg{border-top:3px solid var(--red)}
    .chart{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:14px;margin:10px 0}
    .chart-title{fill:#17202a;font-size:12px;font-weight:750}
    .axis{fill:#667085;font-size:10px}.grid{stroke:#e4e7ec;stroke-width:1}.zero{stroke:#98a2b3;stroke-width:1.2}
    .tbl{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);
      border-radius:12px;overflow:hidden;font-size:12px}
    .tbl th{background:#f2f4f7;color:#344054;text-align:right;padding:8px 9px;font-weight:750;white-space:nowrap}
    .tbl td{border-top:1px solid var(--line);padding:8px 9px;text-align:right;white-space:nowrap}
    .tbl th:first-child,.tbl td:first-child{text-align:left}
    .tbl tr:nth-child(even) td{background:#fbfcfe}
    .table-wrap{overflow-x:auto;margin:10px 0}
    .heat{padding:8px 7px!important;text-align:center!important;font-weight:650}
    .capbad{outline:2px solid #dc2626;outline-offset:-2px}
    .pos{color:#0b7f5f;font-weight:700}.neg{color:#b42318;font-weight:700}
    .note{color:var(--muted);font-size:12.5px;margin:6px 0 14px;max-width:1050px}
    .warn{background:#fffaeb;border:1px solid #fedf89;border-left:4px solid var(--amber);
      border-radius:10px;padding:12px 14px;margin:12px 0;font-size:13px;color:#93370d}
    .footer{color:var(--muted);font-size:12px;border-top:1px solid var(--line);margin-top:34px;padding-top:14px}
    """
    js = r"""
    const DATA = __PAYLOAD__;
    const $ = s => document.querySelector(s);
    const money = v => (v >= 0 ? "+$" : "-$") + Math.abs(v).toLocaleString("en-US", {maximumFractionDigits: 0});
    const pct = v => (v * 100).toFixed(1) + "%";
    const C = ["#0f9d76", "#2563eb", "#d97706", "#7c3aed", "#dc2626", "#0891b2"];

    function find(p15, p30, vol15, vol30) {
      return DATA.cases.find(c => Math.abs(c.p15-p15)<1e-9 && Math.abs(c.p30-p30)<1e-9
        && Math.abs(c.vol15-vol15)<1e-9 && Math.abs(c.vol30-vol30)<1e-9);
    }

    function lineChart(p15, p30, vol15) {
      const vols = DATA.vols;
      const rows = vols.map((v, i) => ({v, d: find(p15,p30,vol15,v)})).filter(r => r.d);
      const W = 900, H = 300, L = 64, R = 20, T = 24, B = 42;
      const pw = W-L-R, ph = H-T-B;
      const vals = rows.map(r => r.d.gain_vs_risk);
      const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
      const span = Math.max(1, hi-lo);
      const x = i => L + (rows.length === 1 ? pw/2 : i*pw/(rows.length-1));
      const y = v => T + ph*(1-(v-lo)/span);
      const zero = y(0);
      let s = `<svg viewBox="0 0 ${W} ${H}" class="chart"><text x="${L}" y="15" class="chart-title">Gain vs risk-only by 0.30 volume — ${Math.round(p15*100)}% 0.15 + ${Math.round(p30*100)}% 0.30</text>`;
      for (let k=0;k<5;k++){ const v=lo+span*k/4, yy=y(v); s+=`<line x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}" class="grid"/><text x="${L-8}" y="${yy+4}" class="axis" text-anchor="end">${money(v)}</text>`; }
      const pts = rows.map((r,i)=>`${x(i)},${y(r.d.gain_vs_risk)}`).join(" ");
      s += `<polyline points="${pts}" fill="none" stroke="#0f9d76" stroke-width="2.6"/>`;
      rows.forEach((r,i)=>{
        s += `<circle cx="${x(i)}" cy="${y(r.d.gain_vs_risk)}" r="4" fill="#0f9d76"/>`;
        s += `<text x="${x(i)}" y="${y(r.d.gain_vs_risk)-8}" class="axis" text-anchor="middle">${money(r.d.gain_vs_risk)}</text>`;
        s += `<text x="${x(i)}" y="${H-16}" class="axis" text-anchor="middle">${r.v}×</text>`;
      });
      s += `<line x1="${L}" y1="${zero}" x2="${W-R}" y2="${zero}" class="zero"/></svg>`;
      return s;
    }

    function heat(p15, vol15) {
      const rows = DATA.vols, cols = DATA.p30s;
      let s = '<div class="table-wrap"><table class="tbl"><thead><tr><th>0.30 volume</th>';
      cols.forEach(c=>s+=`<th>${Math.round(c*100)}% 0.30</th>`);
      s += '</tr></thead><tbody>';
      rows.forEach(v=>{
        s += `<tr><th>${v}×</th>`;
        cols.forEach(c=>{
          const d = find(p15,c,vol15,v);
          if (!d) { s += '<td>—</td>'; return; }
          const a = Math.min(.35, Math.abs(d.gain_vs_risk)/7000*.35);
          const bg = d.gain_vs_risk>0 ? `rgba(15,157,118,${a})` : `rgba(220,38,38,${a})`;
          const cap = d.cap_ok ? "" : " capbad";
          s += `<td class="heat${cap}" style="background:${bg}">${money(d.gain_vs_risk)}</td>`;
        });
        s += '</tr>';
      });
      return s + '</tbody></table></div>';
    }

    function render() {
      const p15 = parseFloat($("#p15").value), p30 = parseFloat($("#p30").value);
      const vol15 = parseFloat($("#vol15").value), vol30 = parseFloat($("#vol30").value);
      const d = find(p15,p30,vol15,vol30);
      if (!d) return;
      $("#kFees").textContent = "$" + d.fees_total.toLocaleString("en-US",{maximumFractionDigits:0});
      $("#kNet").textContent = money(d.net_after_il);
      $("#kGain").textContent = money(d.gain_vs_risk);
      $("#kGain05").textContent = money(d.gain_vs_05);
      $("#kShare").textContent = pct(d.share30);
      $("#kCap").textContent = d.cap_ok ? "inside 5% cap" : "above 5% cap";
      $("#kCap").className = d.cap_ok ? "kpi-sub" : "kpi-sub neg";
      $("#chart").innerHTML = lineChart(p15,p30,vol15);
      $("#heat").innerHTML = heat(p15,vol15);
      const rows = DATA.vols.map(v => ({v, x: find(p15,p30,vol15,v)})).filter(r=>r.x);
      const baseCase = find(p15,p30,vol15,1.0) || d;
      const f30 = baseCase.fees_30;
      const other = baseCase.fees_total - f30;
      const moved = p15 + p30;
      $("#rev").innerHTML = [0,250,500].map(m=>{
        const req = (DATA.base_fee + m + moved*DATA.H - other) / Math.max(1e-9, f30);
        return `<tr><td>+$${m}</td><td>${req.toFixed(2)}×</td><td class="${req<=vol30?'pos':'neg'}">${req<=vol30?'already':'needs volume'}</td></tr>`;
      }).join("");
      $("#caseLine").textContent = `${Math.round(p15*100)}% in 0.15 · ${Math.round(p30*100)}% in 0.30 · ${vol15}× / ${vol30}×`;
    }

    document.addEventListener("DOMContentLoaded", () => {
      const fill = (id, vals, fmt) => {
        const el = $("#"+id);
        el.innerHTML = vals.map(v => `<option value="${v}">${fmt(v)}</option>`).join("");
      };
      fill("p15", DATA.p15s, v => Math.round(v*100)+"% in 0.15");
      fill("p30", DATA.p30s, v => Math.round(v*100)+"% in 0.30");
      fill("vol15", DATA.vol15s, v => v+"× volume");
      fill("vol30", DATA.vols, v => v+"× volume");
      $("#p15").value = "0";
      $("#p30").value = "0.28";
      $("#vol15").value = "2";
      $("#vol30").value = "1.5";
      ["p15","p30","vol15","vol30"].forEach(id=>$("#"+id).addEventListener("change", render));
      render();
    });
    """
    js = js.replace("__PAYLOAD__", payload)

    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fee-first pool allocator — cadCAD sweep</title>
<style>{css}</style></head><body><div class="wrap">
<h1>Fee-first pool allocator</h1>
<p class="sub">cadCAD sweep of the 0.05 / 0.15 / 0.30 pools. Fees are the driver; volume is
reverse-calculated from the fee counters. The 0.15 pool is synthetic: same hourly fee shape as
0.30, half the fee rate, scaled by the volume selector. Red outlines are cases above the 5%
pool-share cap. <b>Volume selectors are multiples of each pool's own base</b>: 1× 0.30 is 1.3%
of the 0.05 pool's volume, not 1× of 0.05.</p>

<div class="warn"><b>Live move rule.</b> 0.30 risk gate: 3-hour trailing volume, volatility, guard, depeg, and the 5% pool-share cap. If NORMAL, fee-only edge: 0.30 fees &gt; 0.05 fees + switch cost + $25 buffer. This page is the static sizing sweep; the "Gain vs risk-only" KPI is a benchmark, not the move rule.</div>

<div class="controls">
  <div><label for="p15">0.15 sleeve</label><select id="p15"></select></div>
  <div><label for="p30">0.30 sleeve</label><select id="p30"></select></div>
  <div><label for="vol15">0.15 volume</label><select id="vol15"></select></div>
  <div><label for="vol30">0.30 volume</label><select id="vol30"></select></div>
</div>

<div class="kpis">
  <div class="kpi"><div class="kpi-label">Fees earned</div><div class="kpi-value" id="kFees">—</div><div class="kpi-sub">45 days</div></div>
  <div class="kpi"><div class="kpi-label">Net after common IL</div><div class="kpi-value" id="kNet">—</div><div class="kpi-sub">fee equity minus IL</div></div>
  <div class="kpi"><div class="kpi-label">Gain vs risk-only</div><div class="kpi-value" id="kGain">—</div><div class="kpi-sub">vs risk-only benchmark (not the move rule)</div></div>
  <div class="kpi"><div class="kpi-label">Fee gain vs all-0.05</div><div class="kpi-value" id="kGain05">—</div><div class="kpi-sub">fee-only edge ignores the benchmark</div></div>
  <div class="kpi"><div class="kpi-label">0.30 pool share</div><div class="kpi-value" id="kShare">—</div><div class="kpi-sub" id="kCap">—</div></div>
</div>

<h2>1. Fee gain vs 0.30 volume</h2>
<div id="chart"></div>
<p class="note" id="caseLine"></p>
<h3>0.30 volume relative to the 0.05 pool</h3>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>0.30 volume</th><th>% of 0.05 volume</th><th>0.30 fees / 0.05 fees</th></tr>
</thead><tbody>
<tr><td>1× (current)</td><td>1.30%</td><td>7.77%</td></tr>
<tr><td>1.5×</td><td>1.94%</td><td>11.66%</td></tr>
<tr><td>12.9×</td><td>16.67%</td><td>100% (total-fee break-even)</td></tr>
<tr><td>38.6×</td><td>50.00%</td><td>300%</td></tr>
</tbody></table></div>
<p class="note">The 1/6 rule is the point where the <b>whole 0.30 pool</b> collects as
many fees as the 0.05 pool: $97.96M, or 12.9× its current volume. Our own fee equality is much
earlier because our 0.30 share is 12.8× our 0.05 share: 100% in 0.30 equalizes at ≈1.01× current
(1.30% of 0.05), and a 28% sleeve is fee-positive even at ≈0.89× current. The live rule
replaces the hurdle with a 0.30 risk gate; the 28% sleeve can be delayed by thin volume,
volatility, guard, depeg or the share cap. Total-fee parity is not the switch rule.</p>

<h2>2. Which sleeve combinations pay</h2>
<div id="heat"></div>
<p class="note">Rows are 0.30 volume multiples; columns are the 0.30 sleeve. The 0.15 sleeve is
fixed by the selector. Green is positive versus the risk-only benchmark; the live rule is
fee-only plus the risk gate. The 1.5× row is the level you asked about.</p>

<h2>3. Reverse-calculated volume for the selected case</h2>
<div class="table-wrap"><table class="tbl"><thead><tr>
<th>Target fee gain</th><th>Required 0.30 volume</th><th>Status</th>
</tr></thead><tbody id="rev"></tbody></table></div>
<p class="note">Derived from the observed fee counter, not volume:
required multiple = (all-0.05 fees + target + moved × H − other fees) / current 0.30 fees.
H is the risk-only benchmark; the live move rule does not subtract it.</p>

<h2>4. What the model assumes</h2>
<div class="warn">The 0.15 pool has no native tape. It uses the 0.30 hourly fee shape at half the
fee rate and the selected volume. The 0.30 volume multiples hold liquidity fixed; real volume
growth would attract liquidity and dilute the fee rate. Sleeves are passive: no re-centering, no
skew. The IL drag is common across pools and is shown as a separate overlay.</div>

<div class="footer">45-day real tape ending 2026-10-24 · $100,000 · cadCAD 0.5.3 · 11 tests.
Research display, not investment advice.</div>
</div>
<script>{js}</script>
</body></html>"""
    return html


if __name__ == "__main__":
    main()
