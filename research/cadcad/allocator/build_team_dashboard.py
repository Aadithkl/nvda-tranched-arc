#!/usr/bin/env python3
"""Build a self-contained team-review dashboard for the NVDA allocator model.

The generator reads only existing cadCAD outputs in ``out/``. It does not run
the model, does not mutate the model, and has no third-party dependencies.

Usage (from the repository root)::

    research\\cadcad\\allocator\\.venv\\Scripts\\python.exe ^
        research\\cadcad\\allocator\\build_team_dashboard.py

Output: ``research/cadcad/allocator/out/team_dashboard.html``.
"""

from __future__ import annotations

import csv
import html
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
TARGET = OUT / "team_dashboard.html"

# ---------------------------------------------------------------------------
# Palette and formatting
# ---------------------------------------------------------------------------

NAVY = "#102a43"
INK = "#243b53"
MUTED = "#486581"
FAINT = "#9fb3c8"
BORDER = "#d9e2ec"
TEAL = "#0f766e"
TEAL_LIGHT = "#5eead4"
BLUE = "#2563eb"
BLUE_LIGHT = "#93c5fd"
AMBER = "#b45309"
AMBER_LIGHT = "#fcd34d"
RED = "#b42318"
RED_LIGHT = "#fca5a5"
SLATE = "#52606d"
SLATE_LIGHT = "#cbd5e1"
IDLE = "#94a3b8"
WHITE = "#ffffff"

CSS = r"""
:root {
  --bg: #f3f6f9;
  --card: #ffffff;
  --navy: #102a43;
  --ink: #243b53;
  --muted: #486581;
  --border: #d9e2ec;
  --teal: #0f766e;
  --blue: #2563eb;
  --amber: #b45309;
  --red: #b42318;
  --shadow: 0 1px 2px rgba(16, 42, 67, .05), 0 14px 34px rgba(16, 42, 67, .07);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue",
    Arial, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--blue); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: "Cascadia Code", Consolas, "SFMono-Regular", monospace;
  font-size: .9em;
  background: #eef4f8;
  border-radius: 5px;
  padding: 1px 5px;
  color: #1f3a56;
}
.topnav {
  position: sticky;
  top: 0;
  z-index: 30;
  background: rgba(255, 255, 255, .92);
  border-bottom: 1px solid rgba(217, 226, 236, .9);
  backdrop-filter: blur(12px);
}
.nav-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: 9px 22px;
  display: flex;
  gap: 6px 16px;
  align-items: center;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: thin;
}
.nav-brand {
  font-weight: 800;
  color: var(--navy);
  letter-spacing: .02em;
  margin-right: 6px;
  font-size: 13px;
}
.nav-inner a {
  color: #486581;
  font-size: 12.5px;
  font-weight: 650;
  padding: 5px 2px;
  border-bottom: 2px solid transparent;
}
.nav-inner a:hover { color: var(--teal); border-bottom-color: #99f6e4; text-decoration: none; }
.wrap { max-width: 1200px; margin: 0 auto; padding: 24px 22px 56px; }
section { margin-top: 34px; scroll-margin-top: 74px; }
.section-head { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 14px; }
.sec-num {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: #e6fffb;
  color: #0f766e;
  border: 1px solid #b2f5ea;
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 850;
  letter-spacing: .04em;
  margin-top: 2px;
}
h1, h2, h3, h4 { color: var(--navy); line-height: 1.2; margin: 0; }
h1 { font-size: clamp(30px, 4.2vw, 52px); letter-spacing: -.035em; font-weight: 850; }
h2 { font-size: clamp(24px, 2.8vw, 34px); letter-spacing: -.025em; font-weight: 820; }
h3 { font-size: 17px; font-weight: 780; letter-spacing: -.01em; }
h4 { font-size: 14px; font-weight: 750; }
.lede { margin: 6px 0 0; color: #52667a; max-width: 880px; font-size: 15px; }
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow);
  padding: 20px;
}
.hero {
  background:
    radial-gradient(900px 340px at 88% -10%, rgba(94, 234, 212, .18), transparent 60%),
    linear-gradient(135deg, #ffffff 0%, #fbfdff 55%, #f2fbf8 100%);
  border: 1px solid #cfe3dd;
  border-radius: 22px;
  box-shadow: 0 2px 3px rgba(16, 42, 67, .04), 0 26px 54px rgba(16, 42, 67, .09);
  padding: 30px 30px 26px;
  position: relative;
  overflow: hidden;
}
.hero::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 7px;
  background: linear-gradient(180deg, #0f766e, #2563eb 55%, #b45309);
}
.hero-top { display: flex; gap: 26px; justify-content: space-between; align-items: flex-start; }
.eyebrow {
  color: #0f766e;
  font-size: 11.5px;
  font-weight: 850;
  letter-spacing: .12em;
  text-transform: uppercase;
  margin-bottom: 8px;
}
.subtitle { margin: 10px 0 14px; color: #486581; font-size: clamp(14px, 1.5vw, 17px); max-width: 880px; }
.chips { display: flex; flex-wrap: wrap; gap: 7px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #f0f7f6;
  border: 1px solid #c8e6e1;
  color: #17635c;
  border-radius: 999px;
  padding: 5px 10px;
  font-size: 11.5px;
  font-weight: 750;
  white-space: nowrap;
}
.chip.blue { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; }
.chip.amber { background: #fffbeb; border-color: #fde68a; color: #92400e; }
.chip.slate { background: #f8fafc; border-color: #e2e8f0; color: #475569; }
.tape-stamp {
  flex: 0 0 190px;
  background: #0f2f46;
  color: #e6fffb;
  border-radius: 15px;
  padding: 14px 15px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .1);
}
.stamp-label { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #99f6e4; font-weight: 800; }
.stamp-value { font-size: 25px; font-weight: 850; line-height: 1.15; margin-top: 3px; }
.stamp-sub { font-size: 12px; color: #cbfbf1; font-weight: 650; }
.stamp-note { font-size: 10.5px; color: #a7c8d8; margin-top: 9px; line-height: 1.35; }
.tape-note {
  margin: 16px 0 0;
  padding: 9px 12px;
  border-radius: 10px;
  background: #fff8e6;
  border: 1px solid #f5d48a;
  color: #7c4a03;
  font-size: 12px;
  font-weight: 600;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(142px, 1fr));
  gap: 11px;
  margin-top: 18px;
}
.kpi {
  background: rgba(255, 255, 255, .88);
  border: 1px solid #e0e9f0;
  border-radius: 14px;
  padding: 13px 14px 12px;
  min-width: 0;
}
.kpi-label { color: var(--muted); font-size: 10.5px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
.kpi-value {
  color: var(--navy);
  font-size: clamp(19px, 2.1vw, 27px);
  font-weight: 860;
  letter-spacing: -.035em;
  line-height: 1.15;
  margin-top: 3px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.kpi-value.pos { color: #0f766e; }
.kpi-value.neg { color: #b42318; }
.kpi-sub { color: #486581; font-size: 11px; margin-top: 3px; line-height: 1.35; }
.secondary { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin-top: 14px; }
.mini-run {
  border: 1px solid #e0e9f0;
  background: #fbfdff;
  border-radius: 14px;
  padding: 13px 15px;
}
.mini-run h4 { font-size: 13px; margin-bottom: 8px; }
.mini-run .mini-label { color: #486581; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; font-weight: 800; }
.mini-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.mini-value { color: var(--navy); font-size: 16px; font-weight: 820; font-variant-numeric: tabular-nums; }
.mini-value.pos { color: #0f766e; }
.mini-value.neg { color: #b42318; }
.what-this-shows {
  margin: 18px 0 0;
  padding: 12px 14px;
  border-left: 4px solid #0f766e;
  background: #f0fdfa;
  border-radius: 0 12px 12px 0;
  color: #134e4a;
  font-size: 14px;
  font-weight: 650;
}
.what-this-shows b { color: #0f2f46; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; margin-top: 16px; }
.grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-top: 16px; }
.section-stack { display: grid; gap: 16px; margin-top: 16px; }
.chart-card { padding: 18px 18px 14px; }
.chart-head { display: flex; justify-content: space-between; gap: 14px; align-items: baseline; margin-bottom: 6px; }
.chart-head p { margin: 0; color: #486581; font-size: 12px; text-align: right; }
.chart-note { margin: 4px 0 0; color: #486581; font-size: 11.5px; }
.chart { width: 100%; height: auto; display: block; overflow: visible; }
.svg-grid { stroke: #e7eef4; stroke-width: 1; }
.svg-axis { stroke: #bcccdc; stroke-width: 1; }
.svg-zero { stroke: #9fb3c8; stroke-width: 1.3; stroke-dasharray: 4 4; }
.svg-tick { fill: #486581; font-size: 10.8px; font-weight: 600; }
.svg-axis-label { fill: #486581; font-size: 11px; font-weight: 700; }
.svg-legend { fill: #334e68; font-size: 11px; font-weight: 650; }
.svg-value { fill: #243b53; font-size: 10px; font-weight: 700; }
.svg-cat { fill: #486581; font-size: 10.5px; font-weight: 650; }
.na {
  border: 1px dashed #cbd5e1;
  border-radius: 12px;
  background: #f8fafc;
  color: #64748b;
  padding: 18px;
  font-size: 13px;
  text-align: center;
}
.callout {
  border-left: 4px solid #b45309;
  background: #fffbeb;
  color: #6b3d00;
  padding: 14px 16px;
  border-radius: 0 12px 12px 0;
  font-size: 13.5px;
  margin-top: 16px;
}
.callout.good { border-left-color: #0f766e; background: #f0fdfa; color: #134e4a; }
.callout.warn { border-left-color: #b42318; background: #fff5f4; color: #7a271a; }
.callout b { color: inherit; }
.callout ul { margin: 7px 0 0; padding-left: 18px; }
.callout li { margin: 4px 0; }
.data-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.data-table th {
  text-align: left;
  color: #52667a;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: .055em;
  border-bottom: 1px solid #cbd5e1;
  padding: 8px 9px;
  white-space: nowrap;
  background: #f8fafc;
}
.data-table td { border-bottom: 1px solid #e7eef4; padding: 8px 9px; vertical-align: top; }
.data-table tr:last-child td { border-bottom: 0; }
.data-table td.num, .data-table th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.data-table .pos { color: #0f766e; font-weight: 700; }
.data-table .neg { color: #b42318; font-weight: 700; }
.table-wrap { overflow-x: auto; border: 1px solid #e7eef4; border-radius: 12px; }
.table-wrap .data-table { min-width: 640px; }
.psub-flow { display: flex; flex-wrap: wrap; align-items: stretch; gap: 7px; margin-top: 12px; }
.psub {
  flex: 1 1 118px;
  min-width: 112px;
  background: #fbfdff;
  border: 1px solid #dbe7ef;
  border-radius: 12px;
  padding: 10px 10px 9px;
  position: relative;
}
.psub-step {
  display: inline-grid;
  place-items: center;
  width: 19px;
  height: 19px;
  border-radius: 6px;
  background: #e6fffb;
  color: #0f766e;
  font-size: 10px;
  font-weight: 850;
  margin-bottom: 5px;
}
.psub b { display: block; font-size: 12.5px; color: #102a43; line-height: 1.2; }
.psub small { display: block; color: #52606d; font-size: 10.5px; margin-top: 2px; }
.psub-arrow { align-self: center; color: #9fb3c8; font-size: 17px; font-weight: 800; flex: 0 0 auto; }
.diagram-card { padding: 14px 14px 10px; }
.diagram { width: 100%; height: auto; display: block; }
.diagram text { font-family: inherit; }
.diagram-box { fill: #ffffff; stroke: #d9e2ec; stroke-width: 1.15; }
.diagram-lane { fill: #486581; font-size: 10px; font-weight: 850; letter-spacing: .12em; }
.diagram-title { fill: #102a43; font-size: 13.5px; font-weight: 800; }
.diagram-label { fill: #486581; font-size: 11px; font-weight: 500; }
.diagram-small { fill: #486581; font-size: 10px; font-weight: 500; }
.diagram-arrow { fill: none; stroke: #52606d; stroke-width: 1.55; }
.diagram-control { fill: none; stroke: #0f766e; stroke-width: 1.55; stroke-dasharray: 5 4; }
.diagram-caption { fill: #52606d; font-size: 9.5px; font-weight: 600; }
.legend-note { display: flex; flex-wrap: wrap; gap: 14px; color: #486581; font-size: 11px; margin-top: 4px; }
.legend-note span { display: inline-flex; gap: 5px; align-items: center; }
.swatch { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
.swatch.line { height: 3px; border-radius: 2px; width: 18px; }
.out-of-scope { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin-top: 14px; }
.out-of-scope .label { color: #486581; font-size: 10.5px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; margin-right: 2px; }
.stat-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 14px; }
.stat {
  border: 1px solid #e7eef4;
  border-radius: 12px;
  padding: 11px 12px;
  background: #fbfdff;
}
.stat .stat-label { color: #486581; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; font-weight: 800; }
.stat .stat-value { color: #102a43; font-size: 19px; font-weight: 830; margin-top: 2px; font-variant-numeric: tabular-nums; }
.stat .stat-sub { color: #52606d; font-size: 10.5px; }
ul.clean { margin: 8px 0 0; padding-left: 19px; }
ul.clean li { margin: 6px 0; }
ul.clean li::marker { color: #0f766e; }
.decision-box {
  border: 1px solid #b2f5ea;
  background: linear-gradient(180deg, #f0fdfa, #ffffff);
  border-radius: 16px;
  padding: 20px;
}
.decision-box h3 { margin-bottom: 6px; }
.future-note {
  border: 1px solid #f5c26b;
  background: #fff9ec;
  border-radius: 14px;
  padding: 16px 18px;
  margin-top: 16px;
  color: #6b3d00;
}
.future-note .fn-title { font-weight: 850; color: #7c2d12; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.future-note p { margin: 6px 0 0; font-size: 13.5px; }
.caveat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; margin-top: 14px; }
.caveat {
  border: 1px solid #e7eef4;
  border-radius: 12px;
  padding: 11px 12px;
  background: #fbfdff;
}
.caveat b { display: block; color: #243b53; font-size: 12px; margin-bottom: 2px; }
.caveat span { color: #486581; font-size: 11.5px; line-height: 1.45; display: block; }
.footer { color: #52606d; font-size: 11px; margin-top: 34px; padding-top: 14px; border-top: 1px solid #d9e2ec; }
.footer code { background: #eef4f8; }
@media (max-width: 760px) {
  .hero { padding: 22px 18px; }
  .hero-top { display: block; }
  .tape-stamp { margin-top: 16px; max-width: 260px; }
  .grid-2 { grid-template-columns: 1fr; }
  .mini-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .chart-head { display: block; }
  .chart-head p { text-align: left; margin-top: 3px; }
  .wrap { padding: 18px 14px 40px; }
  .nav-inner { padding: 8px 14px; }
}
@media print {
  @page { size: A4 landscape; margin: 10mm; }
  body { background: #ffffff; font-size: 10.5pt; }
  .topnav { display: none; }
  .wrap { max-width: none; padding: 0; }
  .card, .kpi, .mini-run, .chart-card, .stat, .caveat, .decision-box, .future-note {
    break-inside: avoid;
    page-break-inside: avoid;
    box-shadow: none;
  }
  section { break-inside: auto; page-break-inside: auto; }
  .hero { box-shadow: none; }
  a { color: inherit; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
"""

# ---------------------------------------------------------------------------
# Formatting and small helpers
# ---------------------------------------------------------------------------


def esc(value: Any) -> str:
    """Escape text for HTML and SVG."""
    return html.escape(str(value), quote=True)


def num(value: Any, default: float | None = None) -> float | None:
    """Parse a number, returning ``default`` for missing or malformed values."""
    if value is None or value == "":
        return default
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def money(value: float | None, digits: int = 0, signed: bool = False) -> str:
    """Format USD with a leading sign where requested."""
    if value is None:
        return "n/a"
    if abs(value) < 0.005 and digits == 0:
        value = 0.0
    sign = "-" if value < 0 else ("+" if signed and value > 0 else "")
    return f"{sign}${abs(value):,.{digits}f}"


def pct_fraction(value: float | None, digits: int = 1) -> str:
    """Format a 0-1 fraction as a percentage."""
    if value is None:
        return "n/a"
    return f"{value * 100:,.{digits}f}%"


def pct_points(value: float | None, digits: int = 1) -> str:
    """Format an already-percentage number."""
    if value is None:
        return "n/a"
    return f"{value:,.{digits}f}%"


def integer(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{int(round(value)):,}"


def axis_money(value: float) -> str:
    if abs(value) >= 1000:
        return f"${value / 1000:,.1f}k"
    return f"${value:,.0f}"


def wrap_label(text: str, width: int = 14, max_lines: int = 2) -> list[str]:
    """Wrap a short label into at most ``max_lines`` lines."""
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) <= width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
            if len(lines) == max_lines - 1:
                break
    if current and len(lines) < max_lines:
        lines.append(current)
    if not lines:
        lines = [text]
    return lines


def nice_ticks(low: float, high: float, count: int = 5) -> list[float]:
    """Return inclusive, human-friendly ticks covering [low, high]."""
    if not math.isfinite(low) or not math.isfinite(high):
        return [0.0, 1.0]
    if high <= low:
        high = low + 1.0
    raw = (high - low) / max(1, count)
    exponent = math.floor(math.log10(raw)) if raw > 0 else 0
    magnitude = 10.0**exponent
    normalized = raw / magnitude
    if normalized <= 1:
        step = magnitude
    elif normalized <= 2:
        step = 2 * magnitude
    elif normalized <= 5:
        step = 5 * magnitude
    else:
        step = 10 * magnitude
    start = math.floor(low / step) * step
    end = math.ceil(high / step) * step
    ticks: list[float] = []
    value = start
    guard = 0
    while value <= end + step * 0.5 and guard < 100:
        ticks.append(round(value, 10))
        value += step
        guard += 1
    return ticks


def sample(points: Sequence[dict[str, float]], every: int = 4) -> list[dict[str, float]]:
    """Downsample hourly paths for display, always keeping the final point."""
    if not points:
        return []
    result = list(points[::every])
    if result[-1] is not points[-1]:
        result.append(points[-1])
    return result


def unavailable(message: str) -> str:
    return f'<div class="na">{esc(message)}</div>'


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------


def read_csv_rows(filename: str) -> list[dict[str, str]]:
    path = OUT / filename
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(filename: str) -> dict[str, Any]:
    path = OUT / filename
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}


def index_rows(rows: Iterable[dict[str, str]], key_names: Sequence[str]) -> dict[Any, dict[str, str]]:
    result: dict[Any, dict[str, str]] = {}
    for row in rows:
        key_values = tuple(row.get(name, "") for name in key_names)
        if all(key_values):
            result[key_values[0] if len(key_values) == 1 else key_values] = row
    return result


def load_paths(rows: Iterable[dict[str, str]]) -> dict[tuple[str, str], list[dict[str, float]]]:
    grouped: dict[tuple[str, str], list[dict[str, float]]] = defaultdict(list)
    for row in rows:
        run = row.get("run", "")
        window = row.get("window", "")
        if not run or not window:
            continue
        item = {
            "step": num(row.get("step"), 0.0) or 0.0,
            "nav": num(row.get("nav"), 0.0) or 0.0,
            "hodl_nav": num(row.get("hodl_nav"), 0.0) or 0.0,
            "drawdown": num(row.get("drawdown"), 0.0) or 0.0,
            "book_a_value": num(row.get("book_a_value"), 0.0) or 0.0,
            "book_b_value": num(row.get("book_b_value"), 0.0) or 0.0,
            "arm_equity": num(row.get("arm_equity"), 0.0) or 0.0,
            "idle_value": num(row.get("idle_value"), 0.0) or 0.0,
        }
        grouped[(run, window)].append(item)
    for key in grouped:
        grouped[key].sort(key=lambda item: item["step"])
    return dict(grouped)


def load_data() -> dict[str, Any]:
    baseline = index_rows(read_csv_rows("baseline_summary.csv"), ("run", "window"))
    optimize = index_rows(read_csv_rows("optimize_summary.csv"), ("run", "window"))
    large_rows = read_csv_rows("large_nav_summary.csv")
    large: dict[tuple[str, str], dict[float, dict[str, str]]] = defaultdict(dict)
    for row in large_rows:
        run = row.get("run", "")
        window = row.get("window", "")
        cap = num(row.get("nav_cap"))
        if run and window and cap is not None:
            large[(run, window)][cap] = row
    return {
        "baseline": baseline,
        "optimize": optimize,
        "large": dict(large),
        "paths": load_paths(read_csv_rows("baseline_paths.csv")),
        "validation": read_json("validation.json"),
        "opt_mc": read_json("optimize_mc.json"),
        "mc": read_json("mc_summary.json"),
    }


def row_at(
    ctx: dict[str, Any], source: str, run: str, window: str
) -> dict[str, str] | None:
    return ctx[source].get((run, window))


def fld(row: dict[str, str] | None, name: str, default: float | None = None) -> float | None:
    if row is None:
        return default
    return num(row.get(name), default)


# ---------------------------------------------------------------------------
# Inline SVG charts
# ---------------------------------------------------------------------------

FormatFn = Callable[[float], str]


def svg_open(width: int, height: int, label: str) -> list[str]:
    return [
        f'<svg class="chart" viewBox="0 0 {width} {height}" role="img" '
        f'aria-label="{esc(label)}" preserveAspectRatio="xMidYMid meet">'
    ]


def chart_legend(
    entries: Sequence[tuple[str, str]], *, x: float = 62, y: float = 18
) -> list[str]:
    parts: list[str] = []
    cursor = x
    for name, color in entries:
        parts.append(
            f'<rect x="{cursor:.1f}" y="{y - 9:.1f}" width="11" height="11" '
            f'rx="2.5" fill="{color}"/>'
        )
        parts.append(
            f'<text class="svg-legend" x="{cursor + 16:.1f}" y="{y:.1f}">{esc(name)}</text>'
        )
        cursor += 16 + 6.4 * len(name) + 20
    return parts


def grouped_bar_chart(
    categories: Sequence[str],
    series: Sequence[tuple[str, Sequence[float | None], str]],
    *,
    height: int = 340,
    value_format: FormatFn = axis_money,
    label_format: FormatFn | None = None,
    show_values: bool = True,
    label: str = "Grouped comparison chart",
) -> str:
    """Vertical grouped bars with an optional zero line and value labels."""
    width = 860
    left, right, top, bottom = 64, 18, 46, 64
    plot_w = width - left - right
    plot_h = height - top - bottom
    flat = [value for _, values, _ in series for value in values if value is not None]
    if not flat or not categories:
        return unavailable("Chart data is not available for these runs.")

    low = min(0.0, min(flat))
    high = max(0.0, max(flat))
    ticks = nice_ticks(low, high, 5)
    low, high = ticks[0], ticks[-1]
    span = (high - low) or 1.0

    def y_of(value: float) -> float:
        return top + (high - value) / span * plot_h

    fmt = label_format or value_format
    parts = svg_open(width, height, label)
    parts.extend(chart_legend([(name, color) for name, _, color in series]))
    for tick in ticks:
        y = y_of(tick)
        parts.append(
            f'<line class="svg-grid" x1="{left}" x2="{width - right}" y1="{y:.1f}" y2="{y:.1f}"/>'
        )
        parts.append(
            f'<text class="svg-tick" x="{left - 9}" y="{y + 3.6:.1f}" text-anchor="end">'
            f"{esc(value_format(tick))}</text>"
        )
    if low < 0 < high:
        parts.append(
            f'<line class="svg-zero" x1="{left}" x2="{width - right}" '
            f'y1="{y_of(0):.1f}" y2="{y_of(0):.1f}"/>'
        )
    parts.append(
        f'<line class="svg-axis" x1="{left}" x2="{left}" y1="{top}" y2="{top + plot_h}"/>'
    )

    count = len(categories)
    group_w = plot_w / count
    gap = 3.0
    bar_w = min(36.0, max(6.0, (group_w * 0.74 - gap * (len(series) - 1)) / len(series)))
    cluster_w = bar_w * len(series) + gap * (len(series) - 1)
    dense = count * len(series) > 16
    for index, category in enumerate(categories):
        cluster_x = left + index * group_w + (group_w - cluster_w) / 2
        for slot, (name, values, color) in enumerate(series):
            value = values[index] if index < len(values) else None
            if value is None:
                continue
            x = cluster_x + slot * (bar_w + gap)
            top_y = y_of(max(value, 0.0))
            bottom_y = y_of(min(value, 0.0))
            bar_h = max(1.2, bottom_y - top_y)
            parts.append(
                f'<rect x="{x:.1f}" y="{top_y:.1f}" width="{bar_w:.1f}" height="{bar_h:.1f}" '
                f'rx="3" fill="{color}"><title>{esc(name)} · {esc(category)}: '
                f"{esc(fmt(value))}</title></rect>"
            )
            if show_values and not dense and abs(value) > 0.01:
                if value >= 0:
                    ty = top_y - 5
                else:
                    ty = bottom_y + 12
                parts.append(
                    f'<text class="svg-value" x="{x + bar_w / 2:.1f}" y="{ty:.1f}" '
                    f'text-anchor="middle">{esc(fmt(value))}</text>'
                )
        lines = wrap_label(category, 16, 2)
        base_y = height - bottom + 19
        for line_index, line in enumerate(lines):
            parts.append(
                f'<text class="svg-cat" x="{left + index * group_w + group_w / 2:.1f}" '
                f'y="{base_y + line_index * 12:.1f}" text-anchor="middle">{esc(line)}</text>'
            )
    parts.append("</svg>")
    return "\n".join(parts)


EVENT_COLORS = {
    "guard": RED,
    "guard-absent": "#94a3b8",
    "recall": AMBER,
    "return": BLUE,
    "switch": NAVY,
}

# Events closer than this many pixels share a visual cluster; their dots stack
# upward so adjacent hours (for example 585 and 586) stay distinguishable.
EVENT_STAGGER_PX = 6.0
EVENT_STAGGER_LEVELS = 3


def line_chart(
    series: Sequence[tuple[str, Sequence[tuple[float, float]], str, bool]],
    *,
    height: int = 360,
    x_label: str = "Hour",
    y_format: FormatFn = axis_money,
    y_zero: bool = False,
    markers: bool = False,
    label: str = "Line chart",
    events: Sequence[tuple[float, str, str]] = (),
) -> str:
    """Multi-series line chart from ``(name, points, color, dashed)`` tuples.

    ``events`` adds thin dashed vertical rules with a dot on the top axis, one per
    ``(x, kind, text)`` tuple; ``kind`` picks the colour (guard, guard-absent,
    recall, return, switch) and ``text`` becomes the hover label. Dots for events
    within ``EVENT_STAGGER_PX`` of each other stack upward in three levels, so two
    adjacent hours still read as two marks. The default keeps every existing
    caller unchanged.
    """
    width = 860
    left, right, top, bottom = 66, 20, 48, 58
    plot_w = width - left - right
    plot_h = height - top - bottom
    points = [point for _, pts, _, _ in series for point in pts]
    if not points:
        return unavailable("Path data is not available for this run.")

    x_low = min(point[0] for point in points)
    x_high = max(point[0] for point in points)
    y_values = [point[1] for point in points]
    y_low = min(y_values)
    y_high = max(y_values)
    if y_zero:
        y_low = min(0.0, y_low)
        y_high = max(0.0, y_high)
    pad = (y_high - y_low) * 0.06 or 0.5
    ticks = nice_ticks(y_low - pad, y_high + pad, 5)
    y_low, y_high = ticks[0], ticks[-1]
    y_span = (y_high - y_low) or 1.0
    x_span = (x_high - x_low) or 1.0

    def x_of(value: float) -> float:
        return left + (value - x_low) / x_span * plot_w

    def y_of(value: float) -> float:
        return top + (y_high - value) / y_span * plot_h

    parts = svg_open(width, height, label)
    parts.extend(chart_legend([(name, color) for name, _, color, _ in series]))
    for tick in ticks:
        y = y_of(tick)
        parts.append(
            f'<line class="svg-grid" x1="{left}" x2="{width - right}" y1="{y:.1f}" y2="{y:.1f}"/>'
        )
        parts.append(
            f'<text class="svg-tick" x="{left - 9}" y="{y + 3.6:.1f}" text-anchor="end">'
            f"{esc(y_format(tick))}</text>"
        )
    if y_low < 0 < y_high:
        parts.append(
            f'<line class="svg-zero" x1="{left}" x2="{width - right}" '
            f'y1="{y_of(0):.1f}" y2="{y_of(0):.1f}"/>'
        )
    for tick in nice_ticks(x_low, x_high, 6):
        if tick < x_low - 1e-9 or tick > x_high + 1e-9:
            continue
        x = x_of(tick)
        parts.append(
            f'<line class="svg-axis" x1="{x:.1f}" x2="{x:.1f}" y1="{top}" y2="{top + plot_h}" '
            f'stroke-opacity=".45"/>'
        )
        parts.append(
            f'<text class="svg-tick" x="{x:.1f}" y="{top + plot_h + 18:.1f}" '
            f'text-anchor="middle">{tick:,.0f}</text>'
        )
    parts.append(
        f'<text class="svg-axis-label" x="{left + plot_w / 2:.1f}" '
        f'y="{height - 8}" text-anchor="middle">{esc(x_label)}</text>'
    )

    visible_events = [
        (x_of(float(event_x)), kind, text)
        for event_x, kind, text in events
        if x_low - 1e-9 <= event_x <= x_high + 1e-9
    ]
    visible_events.sort(key=lambda item: item[0])
    previous_x: float | None = None
    level = 0
    rendered_events: list[tuple[float, str, str, float]] = []
    for ex, kind, text in visible_events:
        if previous_x is not None and abs(ex - previous_x) < EVENT_STAGGER_PX:
            level = (level + 1) % EVENT_STAGGER_LEVELS
        else:
            level = 0
        previous_x = ex
        rendered_events.append((ex, kind, text, top - 4 - level * 5))

    for ex, kind, text, dot_y in rendered_events:
        color = EVENT_COLORS.get(str(kind).lower(), SLATE)
        parts.append(
            f'<g class="svg-event" data-event="{esc(kind)}">'
            f"<title>{esc(text)}</title>"
            f'<line x1="{ex:.1f}" x2="{ex:.1f}" y1="{top}" y2="{top + plot_h}" '
            f'stroke="{color}" stroke-width="1.1" stroke-dasharray="3 3" '
            f'stroke-opacity=".72"/>'
            f'<circle cx="{ex:.1f}" cy="{dot_y:.1f}" r="2.7" fill="{color}" '
            f'stroke="{WHITE}" stroke-width=".9"/>'
            "</g>"
        )

    for name, pts, color, dashed in series:
        if not pts:
            continue
        commands = []
        for index, (px, py) in enumerate(pts):
            prefix = "M" if index == 0 else "L"
            commands.append(f"{prefix}{x_of(px):.1f},{y_of(py):.1f}")
        dash = ' stroke-dasharray="6 4"' if dashed else ""
        parts.append(
            f'<path d="{" ".join(commands)}" fill="none" stroke="{color}" '
            f'stroke-width="{1.7 if dashed else 2.2}" stroke-linejoin="round" '
            f'stroke-linecap="round"{dash}><title>{esc(name)}</title></path>'
        )
        if markers:
            step = max(1, len(pts) // 16)
            for index in range(0, len(pts), step):
                px, py = pts[index]
                parts.append(
                    f'<circle cx="{x_of(px):.1f}" cy="{y_of(py):.1f}" r="2.6" fill="{color}" '
                    f'stroke="#ffffff" stroke-width="1"/>'
                )
        last_x, last_y = pts[-1]
        parts.append(
            f'<circle cx="{x_of(last_x):.1f}" cy="{y_of(last_y):.1f}" r="3.4" fill="{color}" '
            f'stroke="#ffffff" stroke-width="1.4"/>'
        )
    parts.append("</svg>")
    return "\n".join(parts)


def waterfall_chart(
    items: Sequence[tuple[str, float, str]],
    *,
    height: int = 350,
    value_format: FormatFn = money,
    label: str = "Waterfall chart",
) -> str:
    """Floating waterfall. ``kind`` is ``delta``, ``subtotal`` or ``total``."""
    width = 860
    left, right, top, bottom = 68, 22, 30, 66
    plot_w = width - left - right
    plot_h = height - top - bottom
    if not items:
        return unavailable("Waterfall inputs are not available for this run.")

    bars: list[tuple[str, float, str, float, float]] = []
    running = 0.0
    for name, value, kind in items:
        if kind == "delta":
            start, end = running, running + value
            running = end
        else:
            start, end = 0.0, value
            running = value
        bars.append((name, value, kind, start, end))

    edges = [edge for _, _, _, start, end in bars for edge in (start, end)]
    low = min(0.0, min(edges))
    high = max(0.0, max(edges))
    ticks = nice_ticks(low, high, 5)
    low, high = ticks[0], ticks[-1]
    span = (high - low) or 1.0

    def y_of(value: float) -> float:
        return top + (high - value) / span * plot_h

    parts = svg_open(width, height, label)
    for tick in ticks:
        y = y_of(tick)
        parts.append(
            f'<line class="svg-grid" x1="{left}" x2="{width - right}" y1="{y:.1f}" y2="{y:.1f}"/>'
        )
        parts.append(
            f'<text class="svg-tick" x="{left - 9}" y="{y + 3.6:.1f}" text-anchor="end">'
            f"{esc(value_format(tick))}</text>"
        )
    if low < 0 < high:
        parts.append(
            f'<line class="svg-zero" x1="{left}" x2="{width - right}" '
            f'y1="{y_of(0):.1f}" y2="{y_of(0):.1f}"/>'
        )

    group_w = plot_w / len(bars)
    bar_w = min(88.0, group_w * 0.58)
    centers = [left + index * group_w + group_w / 2 for index in range(len(bars))]
    for index, (name, value, kind, start, end) in enumerate(bars):
        color = TEAL if kind == "delta" and value >= 0 else (
            RED if kind == "delta" else (NAVY if kind == "total" else BLUE)
        )
        top_y = y_of(max(start, end))
        bar_h = max(1.5, abs(y_of(end) - y_of(start)))
        x = centers[index] - bar_w / 2
        parts.append(
            f'<rect x="{x:.1f}" y="{top_y:.1f}" width="{bar_w:.1f}" height="{bar_h:.1f}" '
            f'rx="4" fill="{color}"><title>{esc(name)}: {esc(value_format(value))}</title></rect>'
        )
        text_y = top_y - 7 if max(start, end) >= min(start, end) else top_y + bar_h + 13
        if kind != "delta" or value >= 0:
            text_y = top_y - 7
        else:
            text_y = y_of(end) + 13
        parts.append(
            f'<text class="svg-value" x="{centers[index]:.1f}" y="{text_y:.1f}" '
            f'text-anchor="middle">{esc(value_format(value))}</text>'
        )
        if index < len(bars) - 1:
            level = end
            parts.append(
                f'<line x1="{x + bar_w:.1f}" x2="{centers[index + 1] - bar_w / 2:.1f}" '
                f'y1="{y_of(level):.1f}" y2="{y_of(level):.1f}" stroke="{SLATE}" '
                f'stroke-width="1" stroke-dasharray="3 3"/>'
            )
        lines = wrap_label(name, 15, 2)
        for line_index, line in enumerate(lines):
            parts.append(
                f'<text class="svg-cat" x="{centers[index]:.1f}" '
                f'y="{height - bottom + 19 + line_index * 12:.1f}" '
                f'text-anchor="middle">{esc(line)}</text>'
            )
    parts.append("</svg>")
    return "\n".join(parts)


def stacked_area_chart(
    series: Sequence[tuple[str, Sequence[tuple[float, float]], str]],
    *,
    height: int = 330,
    x_label: str = "Hour",
    y_format: FormatFn = axis_money,
    label: str = "Stacked allocation chart",
) -> str:
    """Stacked areas over a shared, index-aligned set of x points."""
    width = 860
    left, right, top, bottom = 66, 20, 48, 58
    plot_w = width - left - right
    plot_h = height - top - bottom
    if not series or not series[0][1]:
        return unavailable("Allocation path is not available for this run.")

    base = series[0][1]
    count = len(base)
    xs = [point[0] for point in base]
    bottoms = [0.0] * count
    layers: list[tuple[str, list[float], list[float], str]] = []
    for name, pts, color in series:
        values = [pts[index][1] if index < len(pts) else 0.0 for index in range(count)]
        tops = [bottoms[index] + max(0.0, values[index]) for index in range(count)]
        layers.append((name, list(bottoms), tops, color))
        bottoms = tops

    x_low, x_high = xs[0], xs[-1]
    x_span = (x_high - x_low) or 1.0
    y_high = max(bottoms) if bottoms else 0.0
    ticks = nice_ticks(0.0, max(y_high, 1.0), 5)
    y_high = ticks[-1]
    y_span = y_high or 1.0

    def x_of(value: float) -> float:
        return left + (value - x_low) / x_span * plot_w

    def y_of(value: float) -> float:
        return top + (y_high - value) / y_span * plot_h

    parts = svg_open(width, height, label)
    parts.extend(chart_legend([(name, color) for name, _, _, color in layers]))
    for tick in ticks:
        y = y_of(tick)
        parts.append(
            f'<line class="svg-grid" x1="{left}" x2="{width - right}" y1="{y:.1f}" y2="{y:.1f}"/>'
        )
        parts.append(
            f'<text class="svg-tick" x="{left - 9}" y="{y + 3.6:.1f}" text-anchor="end">'
            f"{esc(y_format(tick))}</text>"
        )
    for tick in nice_ticks(x_low, x_high, 6):
        if tick < x_low - 1e-9 or tick > x_high + 1e-9:
            continue
        x = x_of(tick)
        parts.append(
            f'<text class="svg-tick" x="{x:.1f}" y="{top + plot_h + 18:.1f}" '
            f'text-anchor="middle">{tick:,.0f}</text>'
        )
    parts.append(
        f'<text class="svg-axis-label" x="{left + plot_w / 2:.1f}" '
        f'y="{height - 8}" text-anchor="middle">{esc(x_label)}</text>'
    )

    for name, low_edge, high_edge, color in layers:
        forward = [
            f"{'M' if index == 0 else 'L'}{x_of(xs[index]):.1f},{y_of(high_edge[index]):.1f}"
            for index in range(count)
        ]
        backward = [
            f"L{x_of(xs[index]):.1f},{y_of(low_edge[index]):.1f}"
            for index in range(count - 1, -1, -1)
        ]
        parts.append(
            f'<path d="{" ".join(forward + backward)} Z" fill="{color}" fill-opacity=".82" '
            f'stroke="{color}" stroke-width="1"><title>{esc(name)}</title></path>'
        )
    parts.append("</svg>")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Section and content helpers
# ---------------------------------------------------------------------------


def section_head(number: str, title: str, lede: str) -> str:
    """Render the numbered heading used by every section."""
    return (
        '<div class="section-head">'
        f'<div class="sec-num">{esc(number)}</div>'
        f'<div><h2>{esc(title)}</h2><p class="lede">{lede}</p></div>'
        "</div>"
    )


def value_tone(value: float | None) -> str:
    if value is None:
        return ""
    if value > 0:
        return "pos"
    if value < 0:
        return "neg"
    return ""


def kpi_card(label: str, value: str, sub: str = "", tone: str = "") -> str:
    tone_class = f" {tone}" if tone else ""
    return (
        '<div class="kpi">'
        f'<div class="kpi-label">{esc(label)}</div>'
        f'<div class="kpi-value{tone_class}">{value}</div>'
        f'<div class="kpi-sub">{sub}</div>'
        "</div>"
    )


def mini_kpi(label: str, value: str, tone: str = "") -> str:
    tone_class = f" {tone}" if tone else ""
    return (
        "<div>"
        f'<div class="mini-label">{esc(label)}</div>'
        f'<div class="mini-value{tone_class}">{value}</div>'
        "</div>"
    )


def mini_run(title: str, cells: Sequence[tuple[str, str]], note: str = "") -> str:
    body = "".join(cell for cell in cells)
    note_html = f'<p class="chart-note">{note}</p>' if note else ""
    return (
        '<div class="mini-run">'
        f"<h4>{esc(title)}</h4>"
        f'<div class="mini-kpis">{body}</div>'
        f"{note_html}"
        "</div>"
    )


def stat_box(label: str, value: str, sub: str = "") -> str:
    return (
        '<div class="stat">'
        f'<div class="stat-label">{esc(label)}</div>'
        f'<div class="stat-value">{value}</div>'
        f'<div class="stat-sub">{sub}</div>'
        "</div>"
    )


def callout(body: str, kind: str = "") -> str:
    kind_class = f" {kind}" if kind else ""
    return f'<div class="callout{kind_class}">{body}</div>'


def net_cell(value: float | None, digits: int = 0) -> str:
    if value is None:
        return '<td class="num">n/a</td>'
    return f'<td class="num {value_tone(value)}">{money(value, digits, signed=True)}</td>'


def pct_cell(value: float | None, digits: int = 2, fraction: bool = True) -> str:
    if value is None:
        return '<td class="num">n/a</td>'
    rendered = pct_fraction(value, digits) if fraction else pct_points(value, digits)
    return f'<td class="num">{rendered}</td>'


def find_row(
    ctx: dict[str, Any], run: str, window: str, source: str | None = None
) -> dict[str, str] | None:
    """Look a run up in the baseline table, then the optimize table."""
    sources = (source,) if source else ("baseline", "optimize")
    for name in sources:
        row = row_at(ctx, name, run, window)
        if row is not None:
            return row
    return None


def net_run(ctx: dict[str, Any], run: str, window: str) -> float | None:
    return fld(find_row(ctx, run, window), "net_vs_hodl")


def waterfall_items(row: dict[str, str] | None) -> list[tuple[str, float, str]]:
    """Build a carry waterfall that reconciles to the recorded net."""
    if row is None:
        return []
    fees = fld(row, "cum_fees", 0.0) or 0.0
    arm_interest = fld(row, "cum_arm_interest", 0.0) or 0.0
    nvda_yield = fld(row, "cum_nvda_yield", 0.0) or 0.0
    borrow = fld(row, "cum_borrow_cost", 0.0) or 0.0
    gas = fld(row, "cum_gas", 0.0) or 0.0
    swap = fld(row, "cum_swap_cost", 0.0) or 0.0
    carry = fld(row, "cum_net_carry", 0.0) or 0.0
    liquidation = fld(row, "cum_liquidation_loss", 0.0) or 0.0
    il = fld(row, "cum_il_vs_hodl", 0.0) or 0.0
    net = fld(row, "net_vs_hodl", carry - liquidation + il) or 0.0
    switch = fees + arm_interest + nvda_yield - borrow - gas - swap - carry
    items: list[tuple[str, float, str]] = [
        ("Fees", fees, "delta"),
        ("Arm interest", arm_interest, "delta"),
        ("NVDA yield", nvda_yield, "delta"),
        ("Borrow", -borrow, "delta"),
        ("Gas", -gas, "delta"),
        ("Swap", -swap, "delta"),
    ]
    if abs(switch) > 0.005:
        items.append(("Switch", -switch, "delta"))
    items.extend(
        [
            ("Net carry", carry, "subtotal"),
            ("Liquidation", -liquidation, "delta"),
            ("LP mark / timing", il, "delta"),
            ("Net", net, "total"),
        ]
    )
    return items


def path_points(
    ctx: dict[str, Any], run: str, window: str, field: str, every: int = 6
) -> list[tuple[float, float]]:
    points = sample(ctx["paths"].get((run, window), []), every)
    return [(point["step"], point[field]) for point in points]


# ---------------------------------------------------------------------------
# 1. Hero
# ---------------------------------------------------------------------------


def section_hero(ctx: dict[str, Any]) -> str:
    run = "risk_only_a_2h15k_guard75"
    row45 = find_row(ctx, run, "45d")
    row20 = find_row(ctx, run, "20d")
    head = section_head(
        "01",
        "Executive read",
        "One tape, two windows, one question: does the tranched book beat holding NVDA "
        "after fees, IL, gas and arm funding?",
    )
    if row45 is None:
        return f'<section id="overview">{head}{unavailable("Focus run is missing from baseline_summary.csv.")}</section>'

    hodl45 = find_row(ctx, "hodl", "45d")
    hodl_dd = fld(hodl45, "max_drawdown")
    net45 = fld(row45, "net_vs_hodl")
    net20 = fld(row20, "net_vs_hodl")
    dd45 = fld(row45, "max_drawdown")
    fee_apr = fld(row45, "book_fee_apr_pct")
    funded = fld(row45, "funded_pct")
    actions = fld(row45, "actions")
    max_ltv = fld(row45, "max_arm_ltv")

    kpis = "".join(
        [
            kpi_card(
                "45-day net",
                money(net45, 2, signed=True),
                f'NAV {money(fld(row45, "final_nav"))} vs HODL '
                f'{money(fld(row45, "final_hodl"))}',
                value_tone(net45),
            ),
            kpi_card(
                "20-day net",
                money(net20, 2, signed=True),
                f'NAV {money(fld(row20, "final_nav"))} vs HODL '
                f'{money(fld(row20, "final_hodl"))}',
                value_tone(net20),
            ),
            kpi_card(
                "Max drawdown",
                pct_fraction(dd45, 2),
                f"HODL {pct_fraction(hodl_dd, 2)} over 45d",
                "neg" if dd45 is not None else "",
            ),
            kpi_card(
                "Book fee APR",
                pct_points(fee_apr, 2),
                "Book fees on NAV (Book A-only in this run)",
            ),
            kpi_card(
                "Book funded",
                pct_fraction(funded, 2),
                "share of hours with Book A + B value > $1",
            ),
            kpi_card("Actions", integer(actions), "fund / recall / switch events"),
            kpi_card(
                "Max arm LTV",
                pct_fraction(max_ltv, 2),
                "borrow-time target 30% on a 62.5% LLTV market; 35% is a separate sweep",
            ),
        ]
    )

    secondary = "".join(
        [
            mini_run(
                "Risk-only A · baseline",
                [
                    mini_kpi("45d net", money(net_run(ctx, "risk_only_a", "45d"), 2, True), "pos" if (net_run(ctx, "risk_only_a", "45d") or 0) > 0 else "neg"),
                    mini_kpi("20d net", money(net_run(ctx, "risk_only_a", "20d"), 2, True), "neg"),
                    mini_kpi(
                        "45d drawdown",
                        pct_fraction(fld(find_row(ctx, "risk_only_a", "45d"), "max_drawdown"), 2),
                    ),
                    mini_kpi(
                        "Fee APR",
                        pct_points(fld(find_row(ctx, "risk_only_a", "45d"), "book_fee_apr_pct"), 1),
                    ),
                ],
                "Knows when to stand aside: book-only for part of the tape.",
            ),
            mini_run(
                "Always A · benchmark",
                [
                    mini_kpi("45d net", money(net_run(ctx, "always_a", "45d"), 2, True), "pos"),
                    mini_kpi("20d net", money(net_run(ctx, "always_a", "20d"), 2, True), "neg"),
                    mini_kpi(
                        "45d drawdown",
                        pct_fraction(fld(find_row(ctx, "always_a", "45d"), "max_drawdown"), 2),
                    ),
                    mini_kpi(
                        "Fee APR",
                        pct_points(fld(find_row(ctx, "always_a", "45d"), "book_fee_apr_pct"), 1),
                    ),
                ],
                "No keeper timing: always in Book A, always paying IL.",
            ),
        ]
    )

    chips = "".join(
        f'<span class="chip {cls}">{esc(text)}</span>'.replace(' class="chip "', ' class="chip"')
        for text, cls in [
            ("45d + 20d", ""),
            ("$10k NAV", "blue"),
            ("Book A 0.05%", ""),
            ("Book B 0.30%", "blue"),
            ("Morpho USDG + Spiral NVDA", ""),
            ("20-path bootstrap", "amber"),
            ("in-sample", "slate"),
        ]
    )

    return f"""<section id="overview">
  <div class="hero">
    <div class="hero-top">
      <div>
        <div class="eyebrow">NVDA tranched allocator · team review</div>
        <h1>Book first. Arms second.</h1>
        <p class="subtitle">A 45-day and 20-day replay of the allocator: Book A/B fee carry,
        Morpho USDG lending, Spiral NVDA collateral and a keeper that switches between books
        and arms. Decision support, not a forecast.</p>
        <div class="chips">{chips}</div>
      </div>
      <div class="tape-stamp">
        <div class="stamp-label">Tape</div>
        <div class="stamp-value">36m risk</div>
        <div class="stamp-sub">$15k floor · 200 bps</div>
        <div class="stamp-note">5-minute pull proxy. The 45d and 20d windows are cuts of the
        same tape. Guard 75 means a 75% fee share, not 75 bps.</div>
      </div>
    </div>
    <div class="kpi-grid">{kpis}</div>
    <div class="secondary">{secondary}</div>
    <p class="tape-note">Focus run: <b>Risk-only A · 2h keeper · $15k floor · 75% guard</b>.
    The 20-day cut is the honesty check: +$46.95 net, against +$431.36 over 45 days.</p>
    <div class="what-this-shows"><b>The book is the business; arms are a safe harbor.</b>
    Fees supply essentially all of carry. The arm is a small, conditional income stream that
    keeps capital productive when the book is not worth the IL.</div>
  </div>
</section>"""


# ---------------------------------------------------------------------------
# 2. Model
# ---------------------------------------------------------------------------


def model_diagram() -> str:
    parts = [
        '<svg class="diagram" viewBox="0 0 860 392" role="img" '
        'aria-label="Model map: tape to books and arms to outcomes">',
        "<defs>",
        f'<marker id="arrowhead" viewBox="0 0 10 10" refX="9" refY="5" '
        f'markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
        f'<path d="M0,0 L10,5 L0,10 z" fill="{SLATE}"/></marker>',
        "</defs>",
        '<text class="diagram-lane" x="20" y="20">1 · MARKET</text>',
        '<text class="diagram-lane" x="250" y="20">2 · BOOKS</text>',
        '<text class="diagram-lane" x="550" y="20">3 · INCOME</text>',
        '<text class="diagram-lane" x="20" y="172">4 · VENUE</text>',
        '<text class="diagram-lane" x="250" y="172">5 · ARMS</text>',
        '<text class="diagram-lane" x="550" y="172">6 · DECISION</text>',
        '<text class="diagram-lane" x="20" y="318">7 · OUTCOMES</text>',
        f'<rect class="diagram-box" x="20" y="34" width="190" height="104" rx="12" style="fill:#f8fafc"/>',
        '<text class="diagram-title" x="36" y="58">Market tape</text>',
        '<text class="diagram-label" x="36" y="80">45d / 20d, 5-min bins</text>',
        '<text class="diagram-label" x="36" y="98">USDG/NVDA swaps</text>',
        '<text class="diagram-label" x="36" y="116">36m risk · $15k floor</text>',
        f'<rect class="diagram-box" x="250" y="34" width="260" height="104" rx="12" style="fill:#f0fdfa"/>',
        '<text class="diagram-title" x="266" y="58">Books A / B</text>',
        '<text class="diagram-label" x="266" y="80">A 0.05% V3 proxy · B 0.30% V4</text>',
        '<text class="diagram-label" x="266" y="98">base + guard share 0–75%</text>',
        '<text class="diagram-label" x="266" y="116">fee share L/(poolL+L)</text>',
        f'<rect class="diagram-box" x="550" y="34" width="290" height="104" rx="12" style="fill:#eff6ff"/>',
        '<text class="diagram-title" x="566" y="58">Fees + IL</text>',
        '<text class="diagram-label" x="566" y="80">book fee APR varies; focus 22.7%</text>',
        '<text class="diagram-label" x="566" y="98">LP mark / timing −$97 to +$153</text>',
        '<text class="diagram-label" x="566" y="116">carry = fees + arm − costs</text>',
        f'<rect class="diagram-box" x="20" y="180" width="190" height="112" rx="12" style="fill:#f8fafc"/>',
        '<text class="diagram-title" x="36" y="204">Vault + venue</text>',
        '<text class="diagram-label" x="36" y="226">Morpho USDG lend</text>',
        '<text class="diagram-label" x="36" y="244">Spiral NVDA collateral</text>',
        '<text class="diagram-label" x="36" y="262">borrow USDG vs NVDA</text>',
        f'<rect class="diagram-box" x="250" y="180" width="260" height="112" rx="12" style="fill:#fffbeb"/>',
        '<text class="diagram-title" x="266" y="204">Arms · safe harbor</text>',
        '<text class="diagram-label" x="266" y="226">NVDA collateral / USDG debt</text>',
        '<text class="diagram-label" x="266" y="244">interest − borrow − gas</text>',
        '<text class="diagram-label" x="266" y="262">LTV guard 30% / 35%</text>',
        f'<rect class="diagram-box" x="550" y="180" width="290" height="112" rx="12" style="fill:#eef2ff"/>',
        '<text class="diagram-title" x="566" y="204">Keeper decision</text>',
        '<text class="diagram-label" x="566" y="226">book / arms / switch</text>',
        '<text class="diagram-label" x="566" y="244">fund if LTV and guard pass</text>',
        '<text class="diagram-label" x="566" y="262">recall on guard or LTV</text>',
        f'<rect class="diagram-box" x="20" y="326" width="820" height="52" rx="12" style="fill:#f8fafc"/>',
        '<text class="diagram-title" x="36" y="348">Outcomes</text>',
        '<text class="diagram-label" x="36" y="366">NAV vs HODL · max drawdown · max LTV · '
        'funded % · actions · fee/IL attribution</text>',
        '<line class="diagram-arrow" x1="210" y1="86" x2="244" y2="86" '
        'marker-end="url(#arrowhead)"/>',
        '<text class="diagram-caption" x="227" y="78" text-anchor="middle">swaps</text>',
        '<line class="diagram-arrow" x1="510" y1="86" x2="544" y2="86" '
        'marker-end="url(#arrowhead)"/>',
        '<text class="diagram-caption" x="527" y="78" text-anchor="middle">fees</text>',
        '<line class="diagram-arrow" x1="210" y1="236" x2="244" y2="236" '
        'marker-end="url(#arrowhead)"/>',
        '<text class="diagram-caption" x="227" y="228" text-anchor="middle">borrow</text>',
        '<line class="diagram-arrow" x1="510" y1="236" x2="544" y2="236" '
        'marker-end="url(#arrowhead)"/>',
        '<text class="diagram-caption" x="527" y="228" text-anchor="middle">LTV</text>',
        '<path class="diagram-control" d="M695 180 L695 162 L380 162 L380 142" '
        'marker-end="url(#arrowhead)"/>',
        '<text class="diagram-caption" x="470" y="156" text-anchor="middle">mode switch</text>',
        '<line class="diagram-arrow" x1="700" y1="292" x2="700" y2="320" '
        'marker-end="url(#arrowhead)"/>',
        '<text class="diagram-caption" x="708" y="312">measures</text>',
        "</svg>",
    ]
    return "\n".join(parts)


def psub_flow() -> str:
    steps = [
        ("1", "Market", "tape, price"),
        ("2", "Income", "fee share, interest"),
        ("3", "Marks", "pool marks, IL"),
        ("4", "Decision", "book / arms / switch"),
        ("5", "Execute", "fund, recall, switch"),
        ("6", "NAV", "cash + books + equity"),
        ("7", "Metrics", "DD, LTV, APR, funded"),
    ]
    parts: list[str] = []
    for index, (number, title, subtitle) in enumerate(steps):
        if index:
            parts.append('<div class="psub-arrow">→</div>')
        parts.append(
            '<div class="psub">'
            f'<span class="psub-step">{number}</span>'
            f"<b>{esc(title)}</b><small>{esc(subtitle)}</small>"
            "</div>"
        )
    return '<div class="psub-flow">' + "".join(parts) + "</div>"


def section_model(ctx: dict[str, Any]) -> str:
    state_rows = [
        (
            "step",
            "s_step",
            "one increment per hour; scenario not mutated",
        ),
        (
            "env",
            "s_env",
            "exogenous tape row; price/volume from the scenario",
        ),
        (
            "portfolio",
            "s_portfolio_income, s_portfolio_execute",
            "balances ≥ 0; bad debt is a liability; NAV = cash + books + equity − debt",
        ),
        (
            "book_metrics",
            "s_book_metrics",
            "book value ≥ 0; guard earns only while present and in range",
        ),
        (
            "decision",
            "p_decision, s_decision",
            "one mode/action per step; risk high → arms, normal → book",
        ),
        (
            "nav, hodl_nav, peak_nav",
            "s_nav, s_hodl_nav, s_peak_nav",
            "NAV_after = NAV_before − costs; HODL is the benchmark",
        ),
        (
            "metrics",
            "s_metrics",
            "drawdown, LTV, APR, funded; audit counters",
        ),
        (
            "last_events, event_count",
            "s_metrics, s_last_events, s_event_count",
            "event log; step increments exactly once",
        ),
    ]
    state_html = "".join(
        f"<tr><td><code>{state}</code></td><td>{policy}</td><td>{invariant}</td></tr>"
        for state, policy, invariant in state_rows
    )
    out_of_scope = [
        "MEV",
        "price impact",
        "timelocks",
        "full Morpho rate history",
        "depeg calibration",
    ]
    chips = "".join(f'<span class="chip slate">{esc(item)}</span>' for item in out_of_scope)
    meta = ctx.get("validation", {}).get("meta", {}) if isinstance(ctx.get("validation"), dict) else {}
    risk_minutes = meta.get("riskMinutes", 36)
    guard_bps = meta.get("guardThresholdBps", 200)
    hours = meta.get("hours", 1080)

    return f"""<section id="model">
  {section_head("02", "Model & tape", "The model is seven PSUBs: tape, income, marks, decision, execute, NAV, metrics. The dashboard reads the outputs; it does not rerun the model.")}
  <div class="card diagram-card">
    <div class="chart-head"><h3>Model map</h3><p>TVL: {integer(hours)} hours · {risk_minutes}m risk · {guard_bps} bps guard</p></div>
    {model_diagram()}
    <div class="legend-note">
      <span><i class="swatch line" style="background:{SLATE}"></i>value flow</span>
      <span><i class="swatch line" style="background:{TEAL}"></i>keeper control (dashed)</span>
      <span>Books earn fees; arms earn a small interest spread; both carry IL and gas.</span>
    </div>
    <p class="chart-note"><b>PSUB order.</b> Income and marks are written before the keeper
    reads them; execution is written before NAV; metrics read the post-execution state.</p>
    {psub_flow()}
  </div>
  <div class="grid-2">
    <div class="card">
      <h3>State, policies, invariants</h3>
      <div class="table-wrap" style="margin-top:10px">
        <table class="data-table">
          <thead><tr><th>State</th><th>Written by</th><th>Invariant</th></tr></thead>
          <tbody>{state_html}</tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <h3>What this dashboard does not model</h3>
      <p class="chart-note">The tape is a 5-minute proxy. It does not pretend to be an
      execution simulator.</p>
      <div class="out-of-scope"><span class="label">Out of scope</span>{chips}</div>
      <ul class="clean">
        <li>Fills are at the tape price; no queue, MEV or price impact.</li>
        <li>Guard pulls use 200 bps on 5-minute moves, not a live guard auction.</li>
        <li>Morpho and Spiral rates are scenarios, not a full rate history.</li>
        <li>Depeg is exogenous and off by default; calibration is future work.</li>
      </ul>
    </div>
  </div>
</section>"""


# ---------------------------------------------------------------------------
# 3. Book economics
# ---------------------------------------------------------------------------


def section_book(ctx: dict[str, Any]) -> str:
    run_labels = [
        ("HODL", "hodl"),
        ("Always A", "always_a"),
        ("Always B", "always_b"),
        ("Risk-only A", "risk_only_a"),
        ("A 2h/15k/75", "risk_only_a_2h15k_guard75"),
        ("C · guard 500", "optimize_C_guard500"),
        ("Always arms", "always_arms"),
    ]
    values45 = [net_run(ctx, run, "45d") for _, run in run_labels]
    values20 = [net_run(ctx, run, "20d") for _, run in run_labels]
    if all(value is None for value in values45 + values20):
        return (
            f'<section id="book">{section_head("03", "Book economics", "Net vs HODL by run.")}'
            f'{unavailable("Summary rows are missing; cannot build the book chart.")}</section>'
        )

    categories = [label for label, _ in run_labels]
    book_chart = grouped_bar_chart(
        categories,
        [("45d", values45, TEAL), ("20d", values20, BLUE)],
        height=370,
        value_format=axis_money,
        label_format=lambda value: money(value, 0, signed=True),
        label="Net vs HODL by run and window",
    )

    risk_row = find_row(ctx, "risk_only_a", "45d")
    focus_row = find_row(ctx, "risk_only_a_2h15k_guard75", "45d")
    fee_share = None
    if focus_row is not None:
        net_carry = fld(focus_row, "cum_net_carry")
        fees = fld(focus_row, "cum_fees")
        if net_carry and fees is not None and net_carry > 0:
            fee_share = fees / net_carry

    return f"""<section id="book">
  {section_head("03", "Book economics", "Where the money comes from. Fees are the engine; the arm is a small, conditional contributor.")}
  <div class="card chart-card">
    <div class="chart-head"><h3>Net vs HODL · 45d and 20d</h3><p>Positive = allocator beat holding NVDA</p></div>
    {book_chart}
    <p class="chart-note">Net of book fees, IL vs HODL, arm interest, borrow, gas and swap
    costs. HODL is the zero line. C is the best of the runs shown; the 80% guard variant is
    higher in-sample but has the same tail.</p>
  </div>
  <div class="section-stack">
    <div class="card chart-card">
      <div class="chart-head"><h3>Risk-only A · carry waterfall (45d)</h3><p>Fees dominate; IL is the swing factor</p></div>
      {waterfall_chart(
          waterfall_items(risk_row),
          height=330,
          value_format=lambda value: money(value, 0, signed=True),
          label="Risk-only A carry waterfall",
      )}
      <p class="chart-note">LP mark / timing is the book's mark vs HODL, not a cash flow;
      liquidation is zero in these runs.</p>
    </div>
    <div class="card chart-card">
      <div class="chart-head"><h3>A 2h/15k/75 · carry waterfall (45d)</h3><p>Better fees, more IL, more net</p></div>
      {waterfall_chart(
          waterfall_items(focus_row),
          height=330,
          value_format=lambda value: money(value, 0, signed=True),
          label="A 2h/15k/75 carry waterfall",
      )}
      <p class="chart-note">The 75% guard routes more fees to the reserve; the 15k volume
      floor keeps the book out of thin hours; the 2h keeper interval reduces churn.</p>
    </div>
  </div>
  {callout(
      "<b>Book fees are 99%+ of net carry.</b> In the focus run, fees are "
      f"{money(fld(focus_row, 'cum_fees'), 2)} against {money(fld(focus_row, 'cum_net_carry'), 2)} "
      "of net carry"
      + (f" ({pct_fraction(fee_share, 1)} of carry)" if fee_share is not None else "")
      + ". The arm's gross contribution is small relative to book fees; in the risk-only runs "
      "it is a few dollars over 45 days, and gas is shared with the book. Treat the arm as "
      "optionality, not the carry engine.",
      "good",
  )}
</section>"""


# ---------------------------------------------------------------------------
# 4. NAV and drawdown
# ---------------------------------------------------------------------------


def section_nav(ctx: dict[str, Any]) -> str:
    runs = [
        ("HODL", "hodl", SLATE, True),
        ("Always A", "always_a", BLUE, False),
        ("Risk-only A", "risk_only_a", TEAL, False),
        ("A 2h/15k/75", "risk_only_a_2h15k_guard75", AMBER, False),
    ]
    nav_series = [
        (label, path_points(ctx, run, "45d", "nav"), color, dashed)
        for label, run, color, dashed in runs
    ]
    dd_series = [
        (label, path_points(ctx, run, "45d", "drawdown"), color, dashed)
        for label, run, color, dashed in runs
    ]
    if not any(points for _, points, _, _ in nav_series):
        return (
            f'<section id="nav">{section_head("04", "NAV &amp; drawdown", "Path view.")}'
            f'{unavailable("baseline_paths.csv is missing for the 45d window.")}</section>'
        )

    nav_chart = line_chart(
        nav_series,
        height=380,
        x_label="Hour of the 45-day window",
        y_format=axis_money,
        label="NAV vs HODL over 45 days",
    )
    dd_chart = line_chart(
        dd_series,
        height=320,
        x_label="Hour of the 45-day window",
        y_format=lambda value: pct_fraction(value, 0),
        y_zero=True,
        label="Drawdown over 45 days",
    )

    table_rows = []
    for label, run, _, _ in runs:
        row = find_row(ctx, run, "45d")
        table_rows.append(
            "<tr>"
            f"<td>{esc(label)}</td>"
            f'<td class="num">{money(fld(row, "final_nav"))}</td>'
            f"{net_cell(fld(row, 'net_vs_hodl'))}"
            f"{pct_cell(fld(row, 'max_drawdown'))}"
            f"{pct_cell(fld(row, 'funded_pct'))}"
            f'<td class="num">{integer(fld(row, "actions"))}</td>'
            f"{pct_cell(fld(row, 'max_arm_ltv'))}"
            "</tr>"
        )

    alloc_points = sample(ctx["paths"].get(("risk_only_a", "45d"), []), 6)
    alloc_series = [
        (
            "Books A+B",
            [
                (point["step"], point["book_a_value"] + point["book_b_value"])
                for point in alloc_points
            ],
            TEAL,
        ),
        ("Arm equity", [(point["step"], point["arm_equity"]) for point in alloc_points], AMBER),
        ("Idle value", [(point["step"], point["idle_value"]) for point in alloc_points], IDLE),
    ]
    alloc_chart = stacked_area_chart(
        alloc_series,
        height=320,
        x_label="Hour of the 45-day window",
        y_format=axis_money,
        label="Risk-only A allocation over 45 days",
    )

    return f"""<section id="nav">
  {section_head("04", "NAV & drawdown", "The path, not just the endpoint. A 45-day win can hide a 20-day loss; drawdown is where the keeper earns its keep.")}
  <div class="section-stack">
    <div class="card chart-card">
      <div class="chart-head"><h3>NAV vs HODL · 45d</h3><p>Start $10,000 · hourly marks</p></div>
      {nav_chart}
      <p class="chart-note">Downsampled every 6 hours for display; endpoints are the recorded
      final NAV. HODL is dashed because it is the benchmark, not a strategy.</p>
    </div>
    <div class="card chart-card">
      <div class="chart-head"><h3>Drawdown · 45d</h3><p>Peak-to-trough on NAV</p></div>
      {dd_chart}
      <p class="chart-note">Risk-only A and A 2h/15k/75 keep drawdown shallower than Always A
      in the selloff; the focus run is the shallowest of the four.</p>
    </div>
  </div>
  <div class="card" style="margin-top:16px">
    <h3>Final NAV and risk table</h3>
    <div class="table-wrap" style="margin-top:10px">
      <table class="data-table">
        <thead><tr><th>Run</th><th class="num">Final NAV</th><th class="num">Net vs HODL</th>
        <th class="num">Max DD</th><th class="num">Funded</th><th class="num">Actions</th>
        <th class="num">Max LTV</th></tr></thead>
        <tbody>{''.join(table_rows)}</tbody>
      </table>
    </div>
    <p class="chart-note">Funded % is the share of hours with book inventory > $1. Actions are fund,
    recall and switch events, not individual swaps.</p>
  </div>
  <div class="card chart-card" style="margin-top:16px">
    <div class="chart-head"><h3>Risk-only A allocation · 45d</h3><p>Where NAV sits hour by hour</p></div>
    {alloc_chart}
    <p class="chart-note">Books A+B are marked at pool value; arm equity is collateral minus
    debt; idle is uninvested USDG plus NVDA. Stack height should track NAV.</p>
  </div>
</section>"""


# ---------------------------------------------------------------------------
# 5. Bootstrap risk
# ---------------------------------------------------------------------------


def mc_block(
    ctx: dict[str, Any], name: str, window: str
) -> dict[str, Any]:
    payload = ctx.get("opt_mc", {})
    if name == "always_a":
        block = payload.get("always_a", {}).get(window, {})
    else:
        block = payload.get("configs", {}).get(name, {}).get(window, {})
    return block if isinstance(block, dict) else {}


def mc_metric(
    ctx: dict[str, Any], name: str, window: str, metric: str, stat: str
) -> float | None:
    block = mc_block(ctx, name, window).get(metric, {})
    if not isinstance(block, dict):
        return None
    return num(block.get(stat))


def section_risk(ctx: dict[str, Any]) -> str:
    configs = [
        ("Risk-only 1h/10k/50", "risk_only_1h10k50"),
        ("A 2h/15k/75", "A_2h15k75"),
        ("C 3k skew + 500 guard", "C_3k_skew2500_guard500"),
        ("D 3k skew + 500/80", "D_3k_skew2500_guard500_80"),
        ("Always A", "always_a"),
    ]
    categories = [label for label, _ in configs]
    series = [
        (
            "45d median",
            [mc_metric(ctx, name, "45d", "net_vs_hodl", "median") for _, name in configs],
            TEAL,
        ),
        (
            "45d p05",
            [mc_metric(ctx, name, "45d", "net_vs_hodl", "p05") for _, name in configs],
            RED_LIGHT,
        ),
        (
            "20d median",
            [mc_metric(ctx, name, "20d", "net_vs_hodl", "median") for _, name in configs],
            BLUE,
        ),
        (
            "20d p05",
            [mc_metric(ctx, name, "20d", "net_vs_hodl", "p05") for _, name in configs],
            AMBER_LIGHT,
        ),
    ]
    if all(value is None for _, values, _ in series for value in values):
        return (
            f'<section id="risk">{section_head("05", "Risk: bootstrap", "Tail check.")}'
            f'{unavailable("optimize_mc.json is missing or empty.")}</section>'
        )

    chart = grouped_bar_chart(
        categories,
        series,
        height=380,
        value_format=axis_money,
        label_format=lambda value: money(value, 0, signed=True),
        show_values=False,
        label="20-path bootstrap net vs HODL",
    )

    table_rows = []
    for label, name in configs:
        win45 = mc_block(ctx, name, "45d")
        win20 = mc_block(ctx, name, "20d")
        mean45 = mc_metric(ctx, name, "45d", "net_vs_hodl", "mean")
        win_rate = win45.get("paired_win_rate")
        table_rows.append(
            "<tr>"
            f"<td>{esc(label)}</td>"
            f"{net_cell(mc_metric(ctx, name, '45d', 'net_vs_hodl', 'median'))}"
            f"{net_cell(mc_metric(ctx, name, '45d', 'net_vs_hodl', 'p05'))}"
            f"{net_cell(mc_metric(ctx, name, '20d', 'net_vs_hodl', 'median'))}"
            f"{net_cell(mc_metric(ctx, name, '20d', 'net_vs_hodl', 'p05'))}"
            f"{net_cell(mean45)}"
            f'<td class="num">{pct_fraction(num(win_rate), 0) if win_rate is not None else "n/a"}</td>'
            "</tr>"
        )

    mc30 = ctx.get("mc", {})
    risk30 = mc30.get("risk_only_net_vs_hodl", {})
    always30 = mc30.get("always_a_net_vs_hodl", {})
    paired = mc30.get("paired_win_rate")
    footnote = (
        "30-path summary (<code>mc_summary.json</code>): risk-only median "
        f"{money(num(risk30.get('median')), 0, True)} [p05 {money(num(risk30.get('p05')), 0)}] "
        f"vs always-A median {money(num(always30.get('median')), 0, True)} "
        f"[p05 {money(num(always30.get('p05')), 0)}]; paired win rate "
        f"{pct_fraction(num(paired), 0)}. The two tails are similar; the means are not."
    )

    return f"""<section id="risk">
  {section_head("05", "Risk: bootstrap", "Twenty bootstrapped 24-hour blocks, seed 42. The in-sample ranking is a median ranking, not a risk-adjusted ranking.")}
  <div class="card chart-card">
    <div class="chart-head"><h3>Bootstrap net vs HODL</h3><p>45d and 20d · median and p05</p></div>
    {chart}
    <p class="chart-note">Each bar is a bootstrap summary, not a path. p05 is the 5th
    percentile of net vs HODL; a strategy with a good median and a bad p05 is not
    risk-adjusted better.</p>
  </div>
  <div class="card" style="margin-top:16px">
    <h3>Bootstrap detail</h3>
    <div class="table-wrap" style="margin-top:10px">
      <table class="data-table">
        <thead><tr><th>Configuration</th><th class="num">45d median</th><th class="num">45d p05</th>
        <th class="num">20d median</th><th class="num">20d p05</th><th class="num">45d mean</th>
        <th class="num">Paired win</th></tr></thead>
        <tbody>{''.join(table_rows)}</tbody>
      </table>
    </div>
    <p class="chart-note">Paired win is the share of bootstrap paths where the configuration
    beats always-A on net, not the share of profitable paths.</p>
  </div>
  {callout(
      "<b>Always A is the risk-adjusted benchmark, not the in-sample winner.</b> "
      "C and D win on median (+$221 / +$218 over 45d) but carry the fattest left tails "
      "(−$607 / −$626 at p05). Always-A has the best mean and p05 of the A/C/D set; the base "
      "risk-only 1h/10k/50 has a slightly better p05 (−$473) but a negative mean. Twenty paths "
      "are enough to rank, not enough to certify a tail.",
      "warn",
  )}
  <p class="chart-note">{footnote}</p>
</section>"""


# ---------------------------------------------------------------------------
# 6. Scaling
# ---------------------------------------------------------------------------


def large_points(
    ctx: dict[str, Any], run: str, window: str = "45d"
) -> list[tuple[float, float]]:
    rows = ctx["large"].get((run, window), {})
    points: list[tuple[float, float]] = []
    for cap, row in sorted(rows.items()):
        apr = fld(row, "simple_net_apr_pct")
        if apr is not None:
            points.append((cap, apr))
    return points


def large_at(
    ctx: dict[str, Any], run: str, cap: float, window: str = "45d"
) -> dict[str, str] | None:
    return ctx["large"].get((run, window), {}).get(cap)


def section_scaling(ctx: dict[str, Any]) -> str:
    series = [
        ("Always A", large_points(ctx, "large_always_a"), BLUE),
        ("Always B", large_points(ctx, "large_always_b"), SLATE),
        ("C · 3k skew", large_points(ctx, "large_C_3k_skew"), TEAL),
    ]
    if not any(points for _, points, _ in series):
        return (
            f'<section id="scaling">{section_head("06", "Scaling", "NAV sensitivity.")}'
            f'{unavailable("large_nav_summary.csv is missing.")}</section>'
        )

    chart = line_chart(
        [(name, points, color, False) for name, points, color in series],
        height=360,
        x_label="NAV cap (USD)",
        y_format=lambda value: pct_points(value, 0),
        markers=True,
        label="Net APR vs NAV cap",
    )

    caps = sorted(
        {
            cap
            for run in ("large_always_a", "large_always_b", "large_C_3k_skew")
            for cap in ctx["large"].get((run, "45d"), {})
        }
    )
    table_rows = []
    for cap in caps:
        cells = [f'<td class="num">{money(cap)}</td>']
        for run in ("large_always_a", "large_always_b", "large_C_3k_skew"):
            row = large_at(ctx, run, cap)
            cells.append(net_cell(fld(row, "net_vs_hodl")))
            cells.append(pct_cell(fld(row, "simple_net_apr_pct"), fraction=False))
        table_rows.append("<tr>" + "".join(cells) + "</tr>")

    return f"""<section id="scaling">
  {section_head("06", "Scaling", "The book has capacity; the arm does not rescue a saturated book. Net APR is 45-day net vs HODL annualized on NAV.")}
  <div class="card chart-card">
    <div class="chart-head"><h3>45d net APR vs NAV</h3><p>$100k → $2M · Book A, Book B, C</p></div>
    {chart}
    <p class="chart-note">APR = 45d net ÷ NAV cap × 365/45. The y-axis is net of fees, IL,
    gas and arm funding. It is not a forward yield.</p>
  </div>
  <div class="card" style="margin-top:16px">
    <h3>Net dollars and APR by cap</h3>
    <div class="table-wrap" style="margin-top:10px">
      <table class="data-table">
        <thead><tr><th class="num">NAV cap</th>
        <th class="num">A net</th><th class="num">A APR</th>
        <th class="num">B net</th><th class="num">B APR</th>
        <th class="num">C net</th><th class="num">C APR</th></tr></thead>
        <tbody>{''.join(table_rows)}</tbody>
      </table>
    </div>
  </div>
  {callout(
      "<b>Book A scales; Book B saturates.</b> Always-A APR falls from 11.8% at $100k to "
      "7.7% at $2M but stays positive. Always-B peaks near $100k (12.3%) and turns negative "
      "at $2M (−1.5%) as its exact fee share saturates; price impact is not modeled. C holds "
      "~31% because it is the best of the runs shown, not because it has infinite capacity. "
      "Cap Book B at $250k–$500k and size the arm at <1% of NAV; at the $10k base that is "
      "under $1k of net.",
      "warn",
  )}
</section>"""


# ---------------------------------------------------------------------------
# 7. Controls
# ---------------------------------------------------------------------------


def section_controls(ctx: dict[str, Any]) -> str:
    guard_runs = [
        ("0%", "risk_only_a_guard0"),
        ("25%", "risk_only_a_guard25"),
        ("50%", "risk_only_a_guard50"),
        ("75%", "risk_only_a_guard75"),
    ]
    interval_runs = [
        ("1h", "risk_only_a"),
        ("2h", "risk_only_a_interval2"),
        ("4h", "risk_only_a_interval4"),
        ("8h", "risk_only_a_interval8"),
    ]

    guard_chart = grouped_bar_chart(
        [label for label, _ in guard_runs],
        [
            ("45d", [net_run(ctx, run, "45d") for _, run in guard_runs], TEAL),
            ("20d", [net_run(ctx, run, "20d") for _, run in guard_runs], BLUE),
        ],
        height=320,
        value_format=axis_money,
        label_format=lambda value: money(value, 0, signed=True),
        label="Guard share sensitivity",
    )
    interval_chart = grouped_bar_chart(
        [label for label, _ in interval_runs],
        [
            ("45d", [net_run(ctx, run, "45d") for _, run in interval_runs], TEAL),
            ("20d", [net_run(ctx, run, "20d") for _, run in interval_runs], BLUE),
        ],
        height=320,
        value_format=axis_money,
        label_format=lambda value: money(value, 0, signed=True),
        label="Keeper interval sensitivity",
    )

    ltv_runs = [
        ("Risk-only A · LTV target 30%", "risk_only_a_ltv30"),
        ("Risk-only A · LTV target 35%", "risk_only_a_ltv35"),
        ("Always arms · LTV target 30%", "always_arms_ltv30"),
        ("Always arms · LTV target 35%", "always_arms_ltv35"),
    ]
    ltv_rows = []
    for label, run in ltv_runs:
        row = find_row(ctx, run, "45d")
        ltv_rows.append(
            "<tr>"
            f"<td>{esc(label)}</td>"
            f"{pct_cell(fld(row, 'max_arm_ltv'))}"
            f"{net_cell(fld(row, 'net_vs_hodl'))}"
            f"{net_cell(net_run(ctx, run, '20d'))}"
            "</tr>"
        )

    return f"""<section id="controls">
  {section_head("07", "Controls", "Guard share, keeper interval and LTV. The controls change the shape of the P&amp;L, not just its level.")}
  <p class="chart-note">Sensitivity bars are against the risk-only 1h/$10k/50 base; the focus
  run is 2h/$15k/75.</p>
  <div class="section-stack">
    <div class="card chart-card">
      <div class="chart-head"><h3>Guard share · 0 / 25 / 50 / 75%</h3><p>75 = 75% share, not 75 bps</p></div>
      {guard_chart}
      <p class="chart-note">Higher guard share keeps more fees in the reserve and reduces
      book risk. It is a fee/IL trade-off: the 45d window rewards 75%, the 20d window
      punishes it.</p>
    </div>
    <div class="card chart-card">
      <div class="chart-head"><h3>Keeper interval · 1 / 2 / 4 / 8h</h3><p>Rebalance cadence, not guard cadence</p></div>
      {interval_chart}
      <p class="chart-note">2h is the best in-sample interval in both windows, but the
      20d spread (+$30 vs −$130) says the ranking is fragile. The 200 bps guard is
      evaluated on 5-minute moves and is separate from this interval.</p>
    </div>
  </div>
  <div class="card" style="margin-top:16px">
    <h3>LTV 30% vs 35%</h3>
    <div class="table-wrap" style="margin-top:10px">
      <table class="data-table">
        <thead><tr><th>Configuration</th><th class="num">Max observed LTV</th>
        <th class="num">Net 45d</th><th class="num">Net 20d</th></tr></thead>
        <tbody>{''.join(ltv_rows)}</tbody>
      </table>
    </div>
    <p class="chart-note">The hero's 29.4% is the guard-75 risk-only run under a 30% LTV
    target; the market LLTV is 62.5%. Always-arms reaches 40.1% under a 35% LTV target.
    The extra headroom buys no net in either family, so 30% is the better default.</p>
  </div>
  {callout(
      "<b>75% guard is a regime bet.</b> Over 45 days it is the best of the four guard "
      "settings (+$273.69); over 20 days it is the worst (−$127.14). Do not read the 75% "
      "share as 75 bps, and do not confuse the 5-minute guard threshold with the keeper "
      "interval.",
  )}
</section>"""


# ---------------------------------------------------------------------------
# 8. Validation
# ---------------------------------------------------------------------------


def section_validation(ctx: dict[str, Any]) -> str:
    validation = ctx.get("validation", {})
    results = validation.get("results", []) if isinstance(validation, dict) else []
    if not results:
        return (
            f'<section id="validation">{section_head("08", "Validation", "Fee match.")}'
            f'{unavailable("validation.json is missing or has no results.")}</section>'
        )

    labels = {
        "bookA": "Book A · 0.05% V3 proxy",
        "bookB": "Book B · 0.30% V4 native",
    }
    cards = []
    for result in results:
        book = str(result.get("book", ""))
        fee_model = num(result.get("fee_model"))
        fee_research = num(result.get("fee_research"))
        diff = num(result.get("fee_diff_pct"))
        net_model = num(result.get("net_model"))
        net_research = num(result.get("net_research"))
        cards.append(
            '<div class="card">'
            f"<h3>{esc(labels.get(book, book))}</h3>"
            f'<div class="stat-strip">'
            f'{stat_box("Model fee", money(fee_model, 2), "45d replay")}'
            f'{stat_box("Research fee", money(fee_research, 2), "independent fee calc")}'
            f'{stat_box("Fee delta", f"+{diff:.2f}%" if diff is not None else "n/a", "model vs research")}'
            f'{stat_box("Net match", money(num(result.get("net_diff_usd")), 2, True), "model − research")}'
            f"</div>"
            f'<p class="chart-note">Model net {money(net_model, 2)} vs research '
            f"{money(net_research, 2)}. Fees reconcile to within {pct_points(diff, 2)}; "
            "the residual is rounding and fee-share path timing.</p>"
            "</div>"
        )

    meta = validation.get("meta", {})
    hours = meta.get("hours", 1080)
    risk_minutes = meta.get("riskMinutes", 36)
    guard_bps = meta.get("guardThresholdBps", 200)

    return f"""<section id="validation">
  {section_head("08", "Validation", "The fee engine is checked against an independent calculation. The dashboard reports the result; it does not rerun the test suite.")}
  <div class="grid-2">{''.join(cards)}</div>
  <div class="stat-strip">
    {stat_box("76", "tests green", "policy · SUF · wiring · determinism · golden")}
    {stat_box("2", "windows replayed", f"{hours}h 45d + 480h 20d from one tape")}
    {stat_box("0", "NAV conservation breaks", "cash + books + arm equity − debt")}
    {stat_box("Deterministic", "replay", "same seed and inputs → same NAV path")}
  </div>
  <div class="card" style="margin-top:16px">
    <h3>What would change our mind</h3>
    <ul class="clean">
      <li><b>A fresh tape.</b> This is one 45-day down regime; a different regime can reorder
      the guard and interval settings.</li>
      <li><b>A larger bootstrap.</b> Twenty paths can rank medians; it cannot certify a p05.
      Require a 100+ path p05 before sizing.</li>
      <li><b>Book B depth.</b> The 0.30% pool is thin; a depth and price-impact model could
      erase the Book B advantage at size.</li>
      <li><b>Arm rate verification.</b> The 3% USDG / 3% NVDA / 3% borrow scenarios are flat
      assumptions, not a full Morpho rate history.</li>
      <li><b>Guard EV calibration.</b> The 200 bps pull proxy needs a realized-loss study
      before the 75% guard share is promoted.</li>
    </ul>
    <p class="chart-note">Tape metadata: {risk_minutes}-minute risk window; {guard_bps} bps
    guard threshold; {integer(hours)} hours. The 5-minute moves are a proxy, not a live
    auction.</p>
  </div>
</section>"""


# ---------------------------------------------------------------------------
# 9. Team decision
# ---------------------------------------------------------------------------


def section_team(ctx: dict[str, Any]) -> str:
    vol15_45 = fld(find_row(ctx, "risk_only_a_vol15k", "45d"), "net_vs_hodl")
    vol15_20 = fld(find_row(ctx, "risk_only_a_vol15k", "20d"), "net_vs_hodl")
    if vol15_45 is not None and vol15_20 is not None:
        floor_windows = (
            f" ({money(vol15_45, 2, True)} over 45d, {money(vol15_20, 2, True)} over 20d)"
        )
    else:
        floor_windows = ""
    floor_line = (
        "<b>Risk-only A at a $15k floor</b> is positive in both windows"
        f"{floor_windows}; the 1h/$10k baseline is +$191.04 / −$105.62. "
        "The floor is doing real work. It also has a shallower drawdown than Always A "
        "(run <code>risk_only_a_vol15k</code>)."
    )
    return f"""<section id="team">
  {section_head("09", "Team decision", "What the team should take away, and what to do next.")}
  <div class="decision-box">
    <h3>Five things to agree on</h3>
    <ul class="clean">
      <li><b>The book is the business.</b> Fees are 99%+ of net carry. Optimize the book
      before optimizing the arm.</li>
      <li>{floor_line}</li>
      <li><b>A 2h/15k/75 is the best in-sample run</b> (+$431.36 / +$46.95), but its bootstrap
      p05 is worse than Always A. C/D are higher in-sample but have worse p05; do not deploy
      them without a tail hedge or a smaller skew. Do not promote the focus run on the point
      estimate alone.</li>
      <li><b>Always A is the risk-adjusted benchmark.</b> It is the configuration every new
      idea has to beat on mean and p05, not just on median.</li>
      <li><b>Book B is thin.</b> Cap it at $250k–$500k and do not let a 45-day fee number
      justify uncapped depth. Next is a fresh tape plus paper trading, not live capital.</li>
    </ul>
    <p class="chart-note"><b>Ask:</b> approve a fresh-tape and paper-trading phase. Do not
    move live capital on a 20-path, in-sample dashboard.</p>
  </div>
  <div class="future-note">
    <div class="fn-title">Future change not in this tape</div>
    <p>The target design — <b>45-minute risk window, no volume floor, 24-hour A/B split and
    a low-fee exit</b> — is <b>not</b> in this tape. The current run is a 36-minute risk
    window, $15k volume floor and 200 bps 5-minute pull proxy. Re-run the allocator after
    the tape update; until then, treat every 45m / no-floor result as unmeasured. The 45d
    and 20d labels are window lengths, not the 45-minute risk setting.</p>
  </div>
</section>"""


# ---------------------------------------------------------------------------
# 10. Caveats
# ---------------------------------------------------------------------------


def section_caveats(ctx: dict[str, Any]) -> str:
    caveats = [
        (
            "45-day down regime",
            "NVDA fell over both windows (HODL −3.2% / −5.0%). A rally would reorder the "
            "book/arm and guard results.",
        ),
        (
            "Book A is a V3 0.05% proxy",
            "No V4 USDG/NVDA 0.05% pool was available. Book A fees use the V3 pool as a "
            "fee-equivalent proxy; the fee match is +0.19%.",
        ),
        (
            "Guard pull proxy",
            "Guard pulls are 200 bps on 5-minute moves, not a live auction or a Chainlink "
            "depeg. Guard 75 is a 75% fee share.",
        ),
        (
            "Arm rates are scenarios",
            "3% USDG, 3% NVDA and 3% borrow are flat assumptions. No full Morpho rate "
            "history and no liquidity crunch.",
        ),
        (
            "3% NVDA is a Spiral total-yield assumption",
            "It is APR after borrowing cost, not a native Morpho collateral yield. The model "
            "grosses it up by LTV × borrow APR and subtracts borrow; the net NVDA contribution "
            "is 3% of collateral.",
        ),
        (
            "Gas is $0.02 per action",
            "210 actions cost about $4.20. A congested chain or a larger action count would "
            "change the small-alpha runs.",
        ),
        (
            "No MEV or price impact",
            "Fills are at the tape price. Book B depth and swap routing are not simulated; "
            "both would reduce net.",
        ),
        (
            "Depeg is off",
            "The depeg proxy is exogenous and not calibrated. A real USDG depeg would hit "
            "the vault and the books at the same time.",
        ),
        (
            "In-sample, not a forecast",
            "One tape, two windows, 20-path and 30-path bootstraps. The dashboard is "
            "decision support; it is not an out-of-sample track record.",
        ),
    ]
    cards = "".join(
        f'<div class="caveat"><b>{esc(title)}</b><span>{text}</span></div>'
        for title, text in caveats
    )
    return f"""<section id="caveats">
  {section_head("10", "Caveats", "Read these before quoting any number.")}
  <div class="caveat-grid">{cards}</div>
  {callout(
      "<b>Headline honesty.</b> The focus run is +$431.36 over 45 days and +$46.95 over "
      "20 days. The second number is the one to defend in a risk meeting: the edge is "
      "positive but small, and the bootstrap p05 is negative.",
  )}
</section>"""


# ---------------------------------------------------------------------------
# HTML assembly
# ---------------------------------------------------------------------------


def build_html(ctx: dict[str, Any]) -> str:
    sections = [
        section_hero(ctx),
        section_model(ctx),
        section_book(ctx),
        section_nav(ctx),
        section_risk(ctx),
        section_scaling(ctx),
        section_controls(ctx),
        section_validation(ctx),
        section_team(ctx),
        section_caveats(ctx),
    ]
    nav_items = [
        ("overview", "Overview"),
        ("model", "Model"),
        ("book", "Book"),
        ("nav", "NAV"),
        ("risk", "Risk"),
        ("scaling", "Scaling"),
        ("controls", "Controls"),
        ("validation", "Validation"),
        ("team", "Team"),
        ("caveats", "Caveats"),
    ]
    nav_links = "".join(f'<a href="#{anchor}">{esc(label)}</a>' for anchor, label in nav_items)
    baseline_count = len(ctx.get("baseline", {}))
    optimize_count = len(ctx.get("optimize", {}))
    large_count = sum(len(rows) for rows in ctx.get("large", {}).values())
    path_count = sum(len(points) for points in ctx.get("paths", {}).values())

    document = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NVDA tranched allocator · team dashboard</title>
<style>{CSS}</style>
</head>
<body>
<nav class="topnav" aria-label="Section navigation">
  <div class="nav-inner">
    <span class="nav-brand">NVDA allocator · team review</span>
    {nav_links}
  </div>
</nav>
<main class="wrap">
{''.join(sections)}
<div class="footer">
  Generated from existing <code>out/</code> artifacts: {baseline_count} baseline summary rows,
  {optimize_count} optimize rows, {large_count} large-NAV rows, {path_count:,} path points,
  plus <code>validation.json</code>, <code>optimize_mc.json</code> and
  <code>mc_summary.json</code>. No model rerun. Bootstrap seeds: 42. 45d = 1,080 hours;
  20d = 480 hours. Built by <code>build_team_dashboard.py</code>.
</div>
</main>
</body>
</html>
"""
    return document


def main() -> None:
    ctx = load_data()
    document = build_html(ctx)
    OUT.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(document, encoding="utf-8")
    size_kb = TARGET.stat().st_size / 1024
    print(f"wrote {TARGET} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
