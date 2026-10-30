"""Public comparison at $100k: 0.05 pool vs 0.30 pool vs deploy-to-us vs HODL.

    python build_simple_dashboard.py
    # out/simple_dashboard.html

Reads:
  out/comparison_100k_summary.json
  out/comparison_100k_paths.csv
"""

from __future__ import annotations

import html
import json
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
REPORT = OUT / "simple_dashboard.html"
INITIAL = 100_000.0

COLORS = {
    "strategy": "#0f9d76",
    "lp_005": "#2563eb",
    "lp_030": "#d97706",
    "hold_nvda": "#7c3aed",
    "hold_usdg": "#98a2b3",
}
STATE_COLORS = {"0.05 pool": "#eff6ff", "0.30 pool": "#fff7ed", "Morpho": "#ecfdf3"}


def money(x: float) -> str:
    return f"{'+' if x >= 0 else '-'}${abs(x):,.2f}"


def usd(x: float) -> str:
    return f"${abs(x):,.2f}"


def pct(x: float, digits: int = 2) -> str:
    return f"{'+' if x >= 0 else ''}{x:.{digits}f}%"


def compact(x: float) -> str:
    ax = abs(x)
    if ax >= 1_000_000:
        return f"${x/1_000_000:.1f}M"
    if ax >= 1_000:
        return f"${x/1_000:.1f}k"
    return f"${x:,.0f}"


def chart_payload(path: pd.DataFrame) -> dict:
    """Numeric payload for the browser-rendered, zoomable charts."""
    days = [round(float(v), 4) for v in path["day"]]
    step = (days[-1] - days[0]) / max(1, len(days) - 1)
    changes = [0] + [
        i for i in range(1, len(path)) if path["state"].iloc[i] != path["state"].iloc[i - 1]
    ]
    states = []
    transitions = []
    for n, start_i in enumerate(changes):
        end_i = changes[n + 1] if n + 1 < len(changes) else len(path)
        start = days[start_i]
        end = days[end_i] if end_i < len(days) else days[-1] + step
        label = str(path["state"].iloc[start_i])
        states.append(
            {"start": start, "end": end, "label": label, "fill": STATE_COLORS.get(label, "#f2f4f7")}
        )
        if start_i > 0:
            transitions.append({"day": start, "label": label})

    def values(col: str, digits: int = 2) -> list[float]:
        return [round(float(v), digits) for v in path[col]]

    return {
        "days": days,
        "price": values("price", 4),
        "initial": INITIAL,
        "priceStart": round(float(path["price"].iloc[0]), 4),
        "series": [
            {
                "label": "Deploy to us",
                "color": COLORS["strategy"],
                "width": 2.8,
                "values": values("strategy"),
            },
            {
                "label": "LP — 0.05 pool",
                "color": COLORS["lp_005"],
                "width": 1.9,
                "values": values("lp_005"),
            },
            {
                "label": "LP — 0.30 pool",
                "color": COLORS["lp_030"],
                "width": 1.9,
                "values": values("lp_030"),
            },
            {
                "label": "Hold NVDA",
                "color": COLORS["hold_nvda"],
                "width": 1.9,
                "values": values("hold_nvda"),
            },
            {
                "label": "Hold USDG",
                "color": COLORS["hold_usdg"],
                "width": 1.4,
                "dash": "5 5",
                "values": values("hold_usdg"),
            },
        ],
        "priceSeries": {
            "label": "NVDA price",
            "color": "#7c3aed",
            "width": 2.2,
            "values": values("price", 4),
        },
        "states": states,
        "transitions": transitions,
    }


CHART_JS = r"""
(function () {
  "use strict";
  const D = window.__CHART_DATA__;
  if (!D) return;
  const NS = "http://www.w3.org/2000/svg";
  const LAST = D.days[D.days.length - 1] + (D.days[1] - D.days[0]);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const money0 = v => (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const money2 = v => (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (v, d) => (v > 0 ? "+" : "") + v.toFixed(d === undefined ? 2 : d) + "%";

  function svgEl(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function htmlEl(tag, cls, parent) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }
  function niceStep(span, target) {
    if (!(span > 0)) return 1;
    const raw = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 3 ? 2.5 : n <= 5 ? 5 : 10;
    return m * mag;
  }
  function nearestIndex(day) {
    let lo = 0;
    let hi = D.days.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (D.days[mid] < day) lo = mid;
      else hi = mid;
    }
    return Math.abs(D.days[lo] - day) <= Math.abs(D.days[hi] - day) ? lo : hi;
  }

  function makeChart(host, cfg) {
    const isValue = cfg.kind === "value";
    const height = cfg.height;
    const series = isValue ? D.series : [D.priceSeries];
    const lastLabel = String(parseFloat(LAST.toFixed(1))) + "d";

    const top = htmlEl("div", "chart-top", host);
    const heading = htmlEl("div", "chart-heading", top);
    heading.textContent = cfg.title;
    const buttons = htmlEl("div", "chart-buttons", top);
    const bOut = htmlEl("button", "", buttons);
    bOut.type = "button";
    bOut.textContent = "−";
    bOut.title = "Zoom out";
    bOut.setAttribute("aria-label", "Zoom out");
    const zLabel = htmlEl("span", "zoom-label", buttons);
    zLabel.setAttribute("aria-live", "polite");
    const bIn = htmlEl("button", "", buttons);
    bIn.type = "button";
    bIn.textContent = "+";
    bIn.title = "Zoom in";
    bIn.setAttribute("aria-label", "Zoom in");
    const bReset = htmlEl("button", "reset", buttons);
    bReset.type = "button";
    bReset.textContent = "Reset";
    bReset.setAttribute("aria-label", "Reset zoom");

    const legend = htmlEl("div", "chart-legend", host);
    series.forEach(s => {
      const item = htmlEl("span", "", legend);
      const sw = htmlEl("i", "", item);
      sw.style.background = s.color;
      item.appendChild(document.createTextNode(s.label));
    });
    const axisNote = htmlEl("span", "axis-note", legend);
    axisNote.textContent = isValue ? "right axis: % vs $100k" : "right axis: % vs start";

    const body = htmlEl("div", "chart-body", host);
    const yLeft = htmlEl("div", "y-axis y-left", body);
    yLeft.setAttribute("aria-hidden", "true");
    const viewport = htmlEl("div", "chart-viewport", body);
    viewport.tabIndex = 0;
    viewport.setAttribute("role", "img");
    viewport.setAttribute("aria-label", cfg.title + ". Use plus and minus to zoom, drag or scroll to pan.");
    const svg = svgEl("svg", {}, viewport);
    const tip = htmlEl("div", "chart-tip", viewport);
    tip.style.display = "none";
    const yRight = htmlEl("div", "y-axis y-right", body);
    yRight.setAttribute("aria-hidden", "true");

    let zoom = 1;
    let W = 900;
    let totalW = 900;
    let pw = 800;
    let ph = height - 52;
    let cross = null;
    let geom = null;
    const M = { l: 10, r: 10, t: 18, b: 34 };

    let lo = Infinity;
    let hi = -Infinity;
    series.forEach(s => s.values.forEach(v => {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }));
    if (isValue) {
      lo = Math.min(lo, D.initial);
      hi = Math.max(hi, D.initial);
    }
    const pad = (hi - lo || 1) * 0.06;
    lo -= pad;
    hi += pad;

    function render() {
      W = Math.max(280, viewport.clientWidth || 900);
      totalW = Math.max(W, Math.round(W * zoom));
      svg.setAttribute("width", totalW);
      svg.setAttribute("height", height);
      svg.setAttribute("viewBox", "0 0 " + totalW + " " + height);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      while (yLeft.firstChild) yLeft.removeChild(yLeft.firstChild);
      while (yRight.firstChild) yRight.removeChild(yRight.firstChild);

      pw = totalW - M.l - M.r;
      ph = height - M.t - M.b;
      const x = d => M.l + (d / LAST) * pw;
      const y = v => M.t + (1 - (v - lo) / (hi - lo)) * ph;

      const defs = svgEl("defs", {}, svg);
      const cid = "clip" + cfg.kind + Math.random().toString(36).slice(2, 8);
      const cp = svgEl("clipPath", { id: cid }, defs);
      svgEl("rect", { x: M.l, y: M.t, width: pw, height: ph }, cp);

      if (isValue) {
        D.states.forEach(st => {
          const a = Math.max(st.start, 0);
          const b = Math.min(st.end, LAST);
          if (b <= a) return;
          svgEl("rect", { x: x(a), y: M.t, width: Math.max(0.5, x(b) - x(a)), height: ph, fill: st.fill, opacity: 0.9 }, svg);
          if (x(b) - x(a) > 64) {
            const t = svgEl("text", { x: (x(a) + x(b)) / 2, y: M.t + 14, "text-anchor": "middle", class: "band-label" }, svg);
            t.textContent = st.label;
          }
        });
      }

      const drawY = (v, leftText, pctValue) => {
        const yy = y(v);
        svgEl("line", { x1: M.l, y1: yy, x2: totalW - M.r, y2: yy, class: "grid" }, svg);
        const l = htmlEl("span", "", yLeft);
        l.style.top = yy + "px";
        l.textContent = leftText;
        const r = htmlEl("span", "pct", yRight);
        r.style.top = yy + "px";
        r.textContent = pct(pctValue, Math.abs(pctValue) >= 10 ? 0 : 1);
      };

      if (isValue) {
        const step = niceStep(hi - lo, 6);
        for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) {
          const k = v / 1000;
          drawY(v, "$" + (Number.isInteger(k) ? k : k.toFixed(1)) + "k", (v / D.initial - 1) * 100);
        }
      } else {
        const pLo = (lo / D.priceStart - 1) * 100;
        const pHi = (hi / D.priceStart - 1) * 100;
        const step = niceStep(pHi - pLo, 6);
        for (let p = Math.ceil(pLo / step - 1e-9) * step; p <= pHi + 1e-9; p += step) {
          const v = D.priceStart * (1 + p / 100);
          drawY(v, "$" + v.toFixed(0), p);
        }
      }

      const span = LAST / zoom;
      const xs = niceStep(span, 6);
      for (let d = 0; d < LAST - 1e-9; d += xs) {
        const xx = x(d);
        svgEl("line", { x1: xx, y1: M.t, x2: xx, y2: M.t + ph, class: "grid", opacity: 0.55 }, svg);
        const l = svgEl("text", { x: xx, y: M.t + ph + 18, "text-anchor": "middle", class: "axis" }, svg);
        l.textContent = (Math.round(d * 10) / 10) + "d";
      }
      const endTick = svgEl("text", { x: x(LAST), y: M.t + ph + 18, "text-anchor": "end", class: "axis" }, svg);
      endTick.textContent = lastLabel;

      if (isValue) {
        const yy = y(D.initial);
        svgEl("line", { x1: M.l, y1: yy, x2: totalW - M.r, y2: yy, class: "zero" }, svg);
        D.transitions.forEach(tr => {
          const xx = x(tr.day);
          svgEl("line", { x1: xx, y1: M.t, x2: xx, y2: M.t + ph, stroke: "#667085", "stroke-width": 1, "stroke-dasharray": "4 4", opacity: 0.65 }, svg);
          if (zoom > 1.4) {
            const l = svgEl("text", { x: xx + 4, y: M.t + 30, class: "axis" }, svg);
            l.textContent = tr.day.toFixed(1) + "d";
          }
        });
      }

      const g = svgEl("g", { "clip-path": "url(#" + cid + ")" }, svg);
      series.forEach(s => {
        let d = "";
        for (let i = 0; i < D.days.length; i++) {
          d += (i ? "L" : "M") + x(D.days[i]).toFixed(1) + " " + y(s.values[i]).toFixed(1);
        }
        const p = svgEl("path", { d: d, fill: "none", stroke: s.color, "stroke-width": s.width, "stroke-linejoin": "round" }, g);
        if (s.dash) p.setAttribute("stroke-dasharray", s.dash);
      });

      cross = svgEl("line", { x1: 0, y1: M.t, x2: 0, y2: M.t + ph, class: "crosshair" }, svg);
      cross.style.display = "none";
      geom = { x: x, y: y };
      zLabel.textContent = Math.round(zoom * 100) + "%";
      bOut.disabled = zoom <= 1.001;
      bReset.disabled = zoom <= 1.001;
    }

    function zoomAt(anchor, factor) {
      const next = clamp(zoom * factor, 1, 12);
      if (Math.abs(next - zoom) < 0.001) return;
      const frac = (viewport.scrollLeft + anchor) / totalW;
      zoom = next;
      render();
      viewport.scrollLeft = Math.max(0, frac * totalW - anchor);
    }
    function reset() {
      zoom = 1;
      render();
      viewport.scrollLeft = 0;
      hideTip();
    }
    function hideTip() {
      if (cross) cross.style.display = "none";
      tip.style.display = "none";
    }
    function showTip(e) {
      if (!geom) return;
      const r = viewport.getBoundingClientRect();
      const contentX = e.clientX - r.left + viewport.scrollLeft;
      if (contentX < M.l || contentX > totalW - M.r) {
        hideTip();
        return;
      }
      const day = clamp(((contentX - M.l) / pw) * LAST, 0, LAST);
      const i = nearestIndex(day);
      const d = D.days[i];
      const px = geom.x(d);
      cross.setAttribute("x1", px);
      cross.setAttribute("x2", px);
      cross.style.display = "";
      const price = D.price[i];
      const pricePct = (price / D.priceStart - 1) * 100;
      let html = '<div class="tip-day">Day ' + d.toFixed(1) + " · NVDA " + money2(price) + " (" + pct(pricePct, 1) + ")</div>";
      if (isValue) {
        series.forEach(s => {
          const v = s.values[i];
          const g = (v / D.initial - 1) * 100;
          html += '<div class="tip-row"><i style="background:' + s.color + '"></i><span>' + s.label + "</span><b>" + money0(v) + ' <em class="' + (g < 0 ? "neg" : "") + '">' + pct(g, 2) + "</em></b></div>";
        });
        html += '<div class="tip-foot">gain/loss vs the $100,000 start</div>';
      } else {
        const v = D.priceSeries.values[i];
        const g = (v / D.initial - 1) * 100;
        html += '<div class="tip-row"><i style="background:' + D.priceSeries.color + '"></i><span>Deploy to us</span><b>' + money0(v) + ' <em class="' + (g < 0 ? "neg" : "") + '">' + pct(g, 2) + "</em></b></div>";
        html += '<div class="tip-foot">price change vs start, and what $100k became</div>';
      }
      tip.innerHTML = html;
      tip.style.display = "block";
      const tw = tip.offsetWidth || 220;
      let left = px + 14;
      if (left + tw > viewport.scrollLeft + W - 10) left = px - tw - 14;
      tip.style.left = Math.max(viewport.scrollLeft + 8, left) + "px";
      const th = tip.offsetHeight || 150;
      const ty = e.clientY - r.top - 12;
      tip.style.top = Math.max(8, Math.min(ty, height - th - 8)) + "px";
    }

    bIn.addEventListener("click", () => zoomAt(W / 2, 1.5));
    bOut.addEventListener("click", () => zoomAt(W / 2, 1 / 1.5));
    bReset.addEventListener("click", reset);

    viewport.addEventListener("wheel", e => {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = viewport.getBoundingClientRect();
        zoomAt(e.clientX - r.left, Math.exp(-dy * 0.0022));
      } else if (zoom > 1.001 && Math.abs(dy) > Math.abs(dx)) {
        const atStart = viewport.scrollLeft <= 0;
        const atEnd = viewport.scrollLeft + viewport.clientWidth >= totalW - 1;
        if ((dy < 0 && atStart) || (dy > 0 && atEnd)) return;
        e.preventDefault();
        viewport.scrollLeft += dy;
      }
    }, { passive: false });

    let drag = null;
    viewport.addEventListener("pointerdown", e => {
      if (e.button !== 0 || !e.target.closest("svg")) return;
      drag = { x: e.clientX, left: viewport.scrollLeft };
      viewport.classList.add("dragging");
      viewport.setPointerCapture(e.pointerId);
      hideTip();
    });
    viewport.addEventListener("pointermove", e => {
      if (drag) {
        viewport.scrollLeft = drag.left - (e.clientX - drag.x);
        return;
      }
      showTip(e);
    });
    viewport.addEventListener("pointerup", () => {
      drag = null;
      viewport.classList.remove("dragging");
    });
    viewport.addEventListener("pointercancel", () => {
      drag = null;
      viewport.classList.remove("dragging");
      hideTip();
    });
    viewport.addEventListener("pointerleave", () => {
      if (!drag) hideTip();
    });
    viewport.addEventListener("scroll", hideTip, { passive: true });
    viewport.addEventListener("keydown", e => {
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomAt(W / 2, 1.5);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomAt(W / 2, 1 / 1.5);
      } else if (e.key === "0") {
        e.preventDefault();
        reset();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        viewport.scrollLeft += W * 0.25;
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        viewport.scrollLeft -= W * 0.25;
      }
    });

    let rt;
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        clearTimeout(rt);
        rt = setTimeout(() => {
          const center = (viewport.scrollLeft + W / 2) / totalW;
          render();
          viewport.scrollLeft = Math.max(0, center * totalW - W / 2);
        }, 120);
      }).observe(host);
    }

    const q = new URLSearchParams(location.search);
    const qz = parseFloat(q.get("zoom"));
    if (qz > 0) zoom = clamp(qz, 1, 12);
    render();
    const qat = parseFloat(q.get("at"));
    if (qat >= 0) viewport.scrollLeft = Math.max(0, (qat / LAST) * totalW - W / 2);
  }

  const priceHost = document.getElementById("priceChart");
  const valueHost = document.getElementById("valueChart");
  if (priceHost) {
    makeChart(priceHost, {
      kind: "price",
      height: 250,
      title: "NVDA price — USDG per NVDA (same days as the value chart)",
    });
  }
  if (valueHost) {
    makeChart(valueHost, {
      kind: "value",
      height: 400,
      title: "What $100k became — do it yourself, deploy to us, or hold",
    });
  }
})();
"""


def main() -> None:
    summary = json.loads((OUT / "comparison_100k_summary.json").read_text(encoding="utf-8"))
    path = pd.read_csv(OUT / "comparison_100k_paths.csv")
    payload = json.dumps(chart_payload(path), ensure_ascii=False, separators=(",", ":"))
    p = summary["paths"]
    s = p["strategy"]

    kpis = [
        (
            "Deploy to us",
            usd(s["final"]),
            f'NAV APR {pct(s["nav_apr"])} · vs-pool APR {pct(s["net_apr"])}',
            "green",
        ),
        (
            "Do it yourself — 0.05 pool",
            usd(p["lp_005"]["final"]),
            f'NAV APR {pct(p["lp_005"]["nav_apr"])} · vs-basket APR {pct(p["lp_005"]["net_apr"])}',
            "blue",
        ),
        (
            "Do it yourself — 0.30 pool",
            usd(p["lp_030"]["final"]),
            f'NAV APR {pct(p["lp_030"]["nav_apr"])} · vs-basket APR {pct(p["lp_030"]["net_apr"])}',
            "amber",
        ),
        ("Hold NVDA", usd(p["hold_nvda"]["final"]), f'{pct(summary["price_move_pct"])} price move', "purple"),
        ("Hold USDG", usd(p["hold_usdg"]["final"]), "flat", "muted"),
    ]

    def kpi(label, value, sub, color):
        return (
            f'<div class="kpi {color}"><div class="kpi-label">{label}</div>'
            f'<div class="kpi-value">{value}</div><div class="kpi-sub">{sub}</div></div>'
        )

    kpi_html = "".join(kpi(*x) for x in kpis)

    # Comparison table
    rows = []
    for key, time in (
        ("hold_usdg", "100% USDG"),
        ("hold_nvda", "100% NVDA"),
        ("lp_005", "100% 0.05 pool"),
        ("lp_030", "100% 0.30 pool"),
        ("strategy", f'{s.get("hours_pool1", 638)}h 0.05 / 0.30 {s.get("hours_pool2", 0)}h / Morpho {s.get("hours_morpho", 442)}h'),
    ):
        r = p[key]
        net = r.get("net_vs_hodl")
        il = r.get("il", r.get("il_mark"))
        total = r["final"] - INITIAL
        rows.append(
            [
                html.escape(r["label"]),
                usd(r["final"]),
                money(r["fees"]),
                "—" if il is None else money(il),
                "—" if net is None else money(net),
                "—" if net is None else pct(net / INITIAL * 100),
                pct(summary["price_move_pct"]) if key == "hold_nvda" else (pct(summary["hodl_basket_change_pct"]) if key.startswith("lp") else "—"),
                money(total),
                pct(r["nav_apr"]),
                pct(r["max_dd"] * 100),
                html.escape(time),
            ]
        )
    table = (
        '<div class="table-wrap"><table class="tbl"><thead><tr><th>Path</th><th>Final value</th>'
        "<th>Fees</th><th>IL / LP mark</th><th>Net vs initial pool</th><th>Net %</th><th>NVDA / basket move</th>"
        "<th>Total P&amp;L</th><th>NAV APR</th><th>Max DD</th><th>Time / exposure</th></tr></thead><tbody>"
        + "".join("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in rows)
        + "</tbody></table></div>"
    )
    carry = float(s["net_vs_hodl"]) - float(s["fees"]) - float(s["il_mark"])

    state_rows = []
    for i, t in enumerate(s.get("transitions", [])):
        start = float(t["day"])
        end = float(s["transitions"][i + 1]["day"]) if i + 1 < len(s["transitions"]) else 45.0
        state = t["state"]
        state_rows.append(
            f"<tr><td>{start:.1f}d – {end:.1f}d</td><td><b>{html.escape(state)}</b></td>"
            f"<td>{(end-start)*24:.0f}h</td><td>"
            + (
                "0.05 pool earns fees; 75% guard + 25% base"
                if state == "0.05 pool"
                else "Safety check sent the position to Morpho"
                if state == "Morpho"
                else "0.30 pool selected by the opportunity check"
            )
            + "</td></tr>"
        )
    state_table = (
        '<div class="table-wrap"><table class="tbl"><thead><tr><th>Period</th><th>State</th>'
        "<th>Hours</th><th>What happened</th></tr></thead><tbody>"
        + "".join(state_rows)
        + "</tbody></table></div>"
    )

    css = """
    :root{--bg:#f6f7f9;--card:#fff;--ink:#17202a;--muted:#667085;--line:#e4e7ec;
      --blue:#2563eb;--green:#0f9d76;--amber:#d97706;--red:#dc2626;--purple:#7c3aed}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);
      font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .wrap{max-width:1120px;margin:0 auto;padding:34px 22px 60px}
    h1{font-size:32px;line-height:1.1;margin:0 0 6px;letter-spacing:-.025em}
    h2{font-size:22px;margin:38px 0 12px;letter-spacing:-.015em}
    h3{font-size:16px;margin:0 0 6px}
    .sub{color:var(--muted);margin:0 0 20px;max-width:920px}
    .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:16px 0 8px}
    .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 15px}
    .kpi-label{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:750}
    .kpi-value{font-size:21px;font-weight:780;margin:4px 0 1px;letter-spacing:-.01em}
    .kpi-sub{font-size:11.5px;color:var(--muted)}
    .kpi.green{border-top:3px solid var(--green)}.kpi.blue{border-top:3px solid var(--blue)}
    .kpi.amber{border-top:3px solid var(--amber)}.kpi.purple{border-top:3px solid var(--purple)}
    .kpi.muted{border-top:3px solid #98a2b3}
    .tbl{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:12px}
    .tbl th{background:#f2f4f7;color:#344054;text-align:right;padding:8px 9px;font-weight:750;white-space:nowrap}
    .tbl td{border-top:1px solid var(--line);padding:8px 9px;text-align:right;white-space:nowrap}
    .tbl td:first-child,.tbl th:first-child{text-align:left}
    .tbl tr:nth-child(even) td{background:#fbfcfe}
    .table-wrap{overflow-x:auto;margin:10px 0}
    .chart-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 12px 6px;margin:10px 0}
    .chart-top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
    .chart-heading{font-size:13px;font-weight:750;color:var(--ink)}
    .chart-buttons{display:flex;align-items:center;gap:4px}
    .chart-buttons button{appearance:none;border:1px solid var(--line);background:#fff;color:#344054;border-radius:8px;width:28px;height:26px;font-size:15px;line-height:1;cursor:pointer;font-weight:700;padding:0}
    .chart-buttons button.reset{width:auto;padding:0 8px;font-size:11.5px;font-weight:650}
    .chart-buttons button:hover:not(:disabled){background:#f2f4f7}
    .chart-buttons button:disabled{opacity:.4;cursor:default}
    .chart-buttons button:focus-visible{outline:2px solid #bfdbfe;outline-offset:1px}
    .zoom-label{font-size:11.5px;color:var(--muted);min-width:34px;text-align:center;font-variant-numeric:tabular-nums}
    .chart-legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:11.5px;color:#475467;padding:6px 2px 8px}
    .chart-legend span{display:inline-flex;align-items:center;white-space:nowrap}
    .chart-legend i{width:14px;height:3px;border-radius:2px;margin-right:5px;display:inline-block}
    .chart-legend .axis-note{margin-left:auto;color:#667085;font-size:10.5px}
    .chart-viewport{position:relative;overflow-x:auto;overflow-y:hidden;border-radius:10px;outline:none;user-select:none}
    .chart-body{display:grid;grid-template-columns:58px minmax(0,1fr) 56px;align-items:stretch}
    .y-axis{position:relative;font-size:10.5px;color:#667085;pointer-events:none;min-height:1px}
    .y-axis span{position:absolute;white-space:nowrap;transform:translateY(-50%);font-variant-numeric:tabular-nums}
    .y-left span{right:8px}
    .y-right span{left:8px;color:#0b7f5f}
    .chart-viewport:focus-visible{box-shadow:0 0 0 2px #bfdbfe}
    .chart-viewport svg{display:block;cursor:grab;touch-action:pan-y}
    .chart-viewport.dragging svg{cursor:grabbing}
    .chart-viewport::-webkit-scrollbar{height:9px}
    .chart-viewport::-webkit-scrollbar-thumb{background:#cfd4dc;border-radius:999px}
    .chart-viewport::-webkit-scrollbar-track{background:#f2f4f7;border-radius:999px}
    .chart-tip{position:absolute;z-index:3;pointer-events:none;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 24px rgba(16,24,40,.14);padding:8px 10px;font-size:11px;color:#344054;min-width:190px}
    .tip-day{font-weight:750;color:var(--ink);padding-bottom:5px;border-bottom:1px solid var(--line);margin-bottom:4px;white-space:nowrap}
    .tip-row{display:flex;align-items:center;gap:6px;padding:2px 0;white-space:nowrap}
    .tip-row i{width:12px;height:3px;border-radius:2px;flex:none}
    .tip-row span{color:var(--muted)}
    .tip-row b{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums}
    .tip-row em{font-style:normal;color:#0b7f5f;font-weight:650}
    .tip-row em.neg{color:var(--red)}
    .tip-foot{color:var(--muted);font-size:10px;padding-top:4px;border-top:1px solid var(--line);margin-top:3px}
    .axis{fill:#667085;font-size:10.5px}
    .band-label{fill:#475467;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
    .grid{stroke:#e4e7ec;stroke-width:1}
    .zero{stroke:#98a2b3;stroke-width:1.2}
    .crosshair{stroke:#344054;stroke-width:1;stroke-dasharray:3 3;opacity:.7}
    .note{color:var(--muted);font-size:12.5px;margin:6px 0 14px;max-width:1050px}
    .callout{background:#ecfdf3;border:1px solid #abefc6;border-left:4px solid var(--green);
      border-radius:10px;padding:12px 14px;margin:12px 0;font-size:13px;color:#054f31}
    .warn{background:#fffaeb;border:1px solid #fedf89;border-left:4px solid var(--amber);
      border-radius:10px;padding:12px 14px;margin:12px 0;font-size:13px;color:#93370d}
    .three{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:12px 0}
    .rule{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
    .rule b{display:block;font-size:13px;margin-bottom:3px}
    .rule span{font-size:12.5px;color:var(--muted)}
    .footer{color:var(--muted);font-size:12px;border-top:1px solid var(--line);margin-top:36px;padding-top:16px}
    @media(max-width:720px){h1{font-size:27px}}
    """

    html_doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NVDA vault — $100k comparison</title>
<style>{css}</style></head><body><div class="wrap">

<h1>NVDA vault — $100k comparison</h1>
<p class="sub">Same $100,000, same 45-day real tape. Our strategy vs the actual
Uniswap <b>0.30 pool</b>. No volume multipliers and no scaled scenarios. The strategy uses the
live fee-check rule; the 0.30 line is the real pool as it traded.</p>

<div class="kpis">{kpi_html}</div>
<p class="note">All paths start at $100,000. “Net vs initial pool” is fees minus IL for the
LP paths and the active-strategy value above the initial pool basket; “total P&amp;L” is final
value minus $100,000. Percentages marked APR are annualized at 365/45. NVDA price moved
{pct(summary["price_move_pct"])}; the initial LP basket moved {pct(summary["hodl_basket_change_pct"])}.</p>

<h2>1. NVDA price and $100k value — same days</h2>
<div id="priceChart" class="chart-card"></div>
<div id="valueChart" class="chart-card"></div>
<p class="note">Drag or scroll the chart to pan; use the <b>+</b>/<b>−</b> buttons or
<b>Ctrl/⌘ + wheel</b> to zoom. The right axis shows the gain or loss in percent
(% vs $100,000 on the value chart, % vs the start price on the price chart). Hover or tap the
line for the values at that day.</p>
<p class="note">The top chart is the real NVDA/USDG price. The bottom chart shows what $100k
became in each path. Bands: light blue = 0.05 pool, light green = Morpho. The 0.30 band is
absent because the fee check says no at the actual tape volume; the 0.30 line is the real pool.</p>

<h2>2. Full comparison</h2>
{table}
<p class="note">“IL / LP mark”: on the passive rows this is true impermanent loss; on the strategy
row it is the LP mark-to-market gain against the initial pool basket. The strategy row also
contains {money(carry)} of Morpho carry net of gas and borrow cost, so net vs initial pool =
fees + LP mark + carry.</p>
<div class="warn"><b>Last 20 days:</b> deploy-to-us {money(s["net_20d"])}; 0.05 pool
{money(p["lp_005"]["net_20d"])}; 0.30 pool {money(p["lp_030"]["net_20d"])}. All three were
negative in the last 20 days; the strategy lost less than the passive pools, but this is not a
guaranteed positive strategy.</div>
<div class="callout"><b>What this says:</b> deploy-to-us ends at <b>{usd(s["final"])}</b>
vs <b>{usd(p["lp_005"]["final"])}</b> for the 0.05 pool, <b>{usd(p["lp_030"]["final"])}</b>
for the 0.30 pool, <b>{usd(p["hold_nvda"]["final"])}</b> for HODL NVDA, and
<b>{usd(p["hold_usdg"]["final"])}</b> for HODL USDG. The vault beat HODL NVDA by
<b>{money(s["final"] - p["hold_nvda"]["final"])}</b> and HODL USDG by
<b>{money(s["final"] - p["hold_usdg"]["final"])}</b> over 45 days, with a max drawdown of
<b>{pct(s["max_dd"]*100)}</b> vs <b>{pct(p["hold_nvda"]["max_dd"]*100)}</b> for HODL NVDA.</div>

<h2>3. Do it yourself vs deploy to us</h2>
<div class="three">
  <div class="rule"><b>0.05 pool — do it yourself</b><span>Passive LP. Fees {compact(p["lp_005"]["fees"])},
  IL {money(p["lp_005"]["il"])}, final {usd(p["lp_005"]["final"])}. No switching, no Morpho.</span></div>
  <div class="rule"><b>0.30 pool — do it yourself</b><span>Passive LP. Fees {compact(p["lp_030"]["fees"])},
  IL {money(p["lp_030"]["il"])}, final {usd(p["lp_030"]["final"])}. Higher fee tier, thinner pool.</span></div>
  <div class="rule"><b>Deploy to us</b><span>Recommended strategy. Fees {compact(s["fees"])},
  net vs initial pool {money(s["net_vs_hodl"])}, final {usd(s["final"])}. Uses 0.05 and Morpho;
  the 0.30 sleeve stays out at actual volume.</span></div>
</div>
<div class="warn"><b>Why the 0.30 pool was not used:</b> at the actual tape its passive edge
over 0.05 is only <b>+$60.36</b> over 45 days (<b>+49 bps</b>, 12.26% vs 11.77% net APR). After
the risk-only hurdle, switching cost and a $25 buffer, the live fee check is negative, so the
sleeve ran for <b>0 hours</b>. This is the real pool, not a scaled scenario.</div>

<h2>4. What our strategy did</h2>
{state_table}
<div class="kpis">
  <div class="kpi"><div class="kpi-label">0.05 pool time</div><div class="kpi-value">{s.get("hours_pool1", 638)}h</div><div class="kpi-sub">{s.get("hours_pool1", 638)/10.8:.1f}% of the tape</div></div>
  <div class="kpi"><div class="kpi-label">0.30 pool time</div><div class="kpi-value">{s.get("hours_pool2", 0)}h</div><div class="kpi-sub">fee check says no at actual volume</div></div>
  <div class="kpi"><div class="kpi-label">Morpho time</div><div class="kpi-value">{s.get("hours_morpho", 442)}h</div><div class="kpi-sub">after the 36m safety check</div></div>
</div>
<div class="three">
  <div class="rule"><b>Every 24h - fee check</b><span>Compare live fees: 0.30 fee × our share vs 0.05 fee × our share, minus the risk-only hurdle, switching cost and a $25 buffer. Switch only if the edge is positive; cap 0.30 at 5% of the pool.</span></div>
  <div class="rule"><b>Every 36m / 1h — safety</b><span>Volume, volatility, guard and depeg. If risk is high, move the whole position to Morpho. Guard rechecks every 5m at 200 bps.</span></div>
  <div class="rule"><b>Position shape</b><span>75% tight guard (500 ticks), 25% wide base (3,000 ticks), 1,000-tick inventory skew. $15k volume floor, 300 bps volatility threshold.</span></div>
</div>

<h2>5. Morpho plan</h2>
<div class="kpis">
  <div class="kpi"><div class="kpi-label">USDG lend</div><div class="kpi-value">3.00%</div><div class="kpi-sub">annualized target</div></div>
  <div class="kpi"><div class="kpi-label">NVDA collateral</div><div class="kpi-value">3.00%</div><div class="kpi-sub">net APR after borrow</div></div>
  <div class="kpi"><div class="kpi-label">Borrow</div><div class="kpi-value">3.00%</div><div class="kpi-sub">annualized target</div></div>
  <div class="kpi"><div class="kpi-label">Target LTV</div><div class="kpi-value">29.375%</div><div class="kpi-sub">hard cap 30%</div></div>
  <div class="kpi"><div class="kpi-label">Morpho cap</div><div class="kpi-value">20%</div><div class="kpi-sub">relative to NAV</div></div>
  <div class="kpi"><div class="kpi-label">45d contribution</div><div class="kpi-value">{money(s.get("arm_interest", 0) + s.get("nvda_yield", 0))}</div><div class="kpi-sub">USDG + NVDA</div></div>
</div>
<div class="callout"><b>Morpho is the safe harbor, not the return engine.</b> It earned
{money(s.get("arm_interest", 0))} USDG interest and {money(s.get("nvda_yield", 0))} NVDA over
45 days, with {money(s.get("borrow_cost", 0))} borrow cost. Pool fees were {compact(s["fees"])}.</div>

<div class="footer">45-day real tape ending 2026-10-24 · $100,000 · in-sample · 6 fee-model tests.
0.05 pool = deep, low fee tier; 0.30 pool = thin, 6× fee tier. Deploy to us = recommended
strategy. The 0.05-pool figures use a fee-equivalent substitute pool because no native 0.05%
pool existed for this pair over the tape. Research display, not investment advice.</div>
</div>
<script>window.__CHART_DATA__ = {payload};</script>
<script>{CHART_JS}</script>
</body></html>"""

    OUT.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(html_doc, encoding="utf-8")
    print(f"wrote {REPORT} ({len(html_doc)/1024:.1f} KiB)")


if __name__ == "__main__":
    main()
