#!/usr/bin/env python3
"""Build a focused study page: pool returns, IL, Morpho carry, protection.

The page replaces the broad dashboard framing with four questions: which pool
pays, what the Morpho arm adds, what IL costs in dollars, and when capital
leaves the book. It reads only existing cadCAD outputs in ``out/`` plus the
concentrated-liquidity math in ``lp.py``. It does not rerun or mutate the model.

Usage (from the repository root)::

    research\\cadcad\\allocator\\.venv\\Scripts\\python.exe ^
        research\\cadcad\\allocator\\build_pool_il_study.py

Output: ``research/cadcad/allocator/out/pool_il_study.html``.
"""

from __future__ import annotations

import json
import math
import re
import sys
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Sequence

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import build_team_dashboard as base  # noqa: E402  (path bootstrap above)
import lp  # noqa: E402

OUT = base.OUT
TARGET = OUT / "pool_il_study.html"

TEAL = base.TEAL
BLUE = base.BLUE
AMBER = base.AMBER
RED = base.RED
SLATE = base.SLATE

P0 = 225.8  # NVDA entry price for the static IL study
CAPITAL = 10_000.0
RANGES: tuple[tuple[int, str], ...] = ((500, "±5%"), (1000, "±10%"), (2000, "±20%"))
MOVES: tuple[int, ...] = tuple(range(-20, 21, 2))
TABLE_MOVES: tuple[int, ...] = (-20, -10, 0, 10, 20)

# Observed venue range from ARM_REALISM.md (Steakhouse USDG ~3.75%, spUSDG
# ~2.72%); the stress case's 103.73% is not an observed market.
OBSERVED_USDG_LOW = 2.72
OBSERVED_USDG_HIGH = 3.75
OBSERVED_USDG_TOP = 3.8

POOL_SHORT = {
    "USDG/NVDA V3 0.05%": "USDG V3 5bp",
    "USDG/NVDA V4 0.30%": "USDG V4 30bp",
    "USDG/NVDA V4 0.01%": "USDG V4 1bp",
    "ETH/NVDA V3 0.05%": "ETH V3 5bp",
    "ETH/NVDA V3 0.30%": "ETH V3 30bp",
    "ETH/NVDA V4 0.05%": "ETH V4 5bp",
}

CASE_ROWS: tuple[tuple[str, str], ...] = (
    ("Always A", "always_a"),
    ("Always B", "always_b"),
    ("Risk-only A - 1h / 10k / 50", "risk_only_a"),
    ("Risk-only A - 15k floor", "risk_only_a_vol15k"),
    ("A - 2h / 15k / 75", "risk_only_a_2h15k_guard75"),
    ("Always arms", "always_arms"),
)

VARIATION_ROWS: tuple[tuple[str, str], ...] = (
    ("Base - 1h / 10k / 50", "risk_only_a"),
    ("Volume floor 15k", "risk_only_a_vol15k"),
    ("Keeper interval 2h", "risk_only_a_interval2"),
    ("Guard share 75%", "risk_only_a_guard75"),
    ("2h / 15k / 75", "risk_only_a_2h15k_guard75"),
)

ARM_CASES: tuple[tuple[str, str], ...] = (
    ("Base", "risk_only_a"),
    ("Live", "risk_only_a_live"),
    ("Stress", "risk_only_a_stress"),
    ("Always arms", "always_arms"),
)

DD_COMPARE: tuple[tuple[str, str], ...] = (
    ("HODL", "hodl"),
    ("Always A", "always_a"),
    ("Risk-only A", "risk_only_a"),
    ("A 2h/15k/75", "risk_only_a_2h15k_guard75"),
    ("Always arms", "always_arms"),
)

EXTRA_CSS = r"""
.questions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
  margin-top: 16px;
}
.question {
  display: block;
  border: 1px solid #e0e9f0;
  background: rgba(255, 255, 255, .78);
  border-radius: 12px;
  padding: 10px 12px;
  color: #243b53;
}
.question:hover { text-decoration: none; border-color: #99f6e4; background: #ffffff; }
.question .q {
  display: block;
  color: #0f766e;
  font-size: 10.5px;
  font-weight: 850;
  letter-spacing: .075em;
  text-transform: uppercase;
}
.question .a { display: block; font-size: 13px; font-weight: 700; margin-top: 2px; }
.mode-strip {
  display: flex;
  height: 38px;
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid #cbd5e1;
  background: #f1f5f9;
  margin-top: 12px;
}
.mode-seg {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: .03em;
  overflow: hidden;
  white-space: nowrap;
  min-width: 2px;
}
.mode-seg.books { background: #0f766e; }
.mode-seg.arms { background: #b45309; }
.mode-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  color: #486581;
  font-size: 11.5px;
  margin-top: 9px;
}
.mode-legend span { display: inline-flex; align-items: center; gap: 6px; }
.study-table .data-table { font-size: 12px; }
.study-table .data-table th, .study-table .data-table td { padding: 6px 8px; }
.row-best td { background: #f0fdfa; }
.lead-in { margin: 0 0 12px; color: #486581; font-size: 13.5px; }
.nav-inner a.nav-brand { color: var(--navy); text-decoration: none; }
"""

CSS = base.CSS + EXTRA_CSS


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def pf(value: float | None, digits: int = 1) -> str:
    """Format a 0-1 fraction as a percentage."""
    return base.pct_fraction(value, digits)


def pp(value: float | None, digits: int = 1) -> str:
    """Format an already-percentage number."""
    return base.pct_points(value, digits)


def usd(value: float | None, digits: int = 0, signed: bool = False) -> str:
    return base.money(value, digits, signed)


def cell_money(value: float | None, digits: int = 0) -> str:
    tone = base.value_tone(value)
    cls = f"num {tone}" if tone else "num"
    return f'<td class="{cls}">{usd(value, digits, signed=True)}</td>'


def cell_num_text(value: Any) -> str:
    return f'<td class="num">{base.esc(value)}</td>'


def il_cell(value: float, digits: int = 2) -> str:
    """Money cell for IL; a snapped zero renders as ``$0``, not ``-$0.00``."""
    if abs(value) < 0.005:
        return '<td class="num">$0</td>'
    return cell_money(value, digits)


def cell_pct(value: float | None, digits: int = 1, *, fraction: bool = True) -> str:
    rendered = pf(value, digits) if fraction else pp(value, digits)
    return f'<td class="num">{rendered}</td>'


def cell_text(value: Any) -> str:
    return f"<td>{base.esc(value)}</td>"


def table(
    headers: Sequence[tuple[str, bool]],
    rows: Sequence[str],
    *,
    note: str = "",
    cls: str = "study-table",
) -> str:
    head = "".join(
        f'<th class="num">{base.esc(label)}</th>'
        if numeric
        else f"<th>{base.esc(label)}</th>"
        for label, numeric in headers
    )
    note_html = f'<p class="chart-note">{note}</p>' if note else ""
    return (
        f'<div class="table-wrap {cls}"><table class="data-table">'
        f"<thead><tr>{head}</tr></thead><tbody>{''.join(rows)}</tbody></table></div>"
        f"{note_html}"
    )


def chart_card(title: str, side: str, chart: str, note: str, *, style: str = "") -> str:
    style_attr = f' style="{style}"' if style else ""
    return (
        f'<div class="card chart-card"{style_attr}>'
        f'<div class="chart-head"><h3>{base.esc(title)}</h3><p>{base.esc(side)}</p></div>'
        f"{chart}"
        f'<p class="chart-note">{note}</p>'
        "</div>"
    )


def block(number: str, anchor: str, title: str, lede: str, body: str) -> str:
    return (
        f'<section id="{anchor}">'
        f"{base.section_head(number, title, lede)}"
        f"{body}"
        "</section>"
    )


def row(ctx: dict[str, Any], run: str, window: str) -> dict[str, str] | None:
    return base.find_row(ctx, run, window)


def net(ctx: dict[str, Any], run: str, window: str) -> float | None:
    return base.fld(row(ctx, run, window), "net_vs_hodl")


def drawdown(ctx: dict[str, Any], run: str, window: str) -> float | None:
    return base.fld(row(ctx, run, window), "max_drawdown")


def arm_carry(ctx: dict[str, Any], run: str) -> float:
    item = row(ctx, run, "45d")
    interest = base.fld(item, "cum_arm_interest", 0.0) or 0.0
    nvda_yield = base.fld(item, "cum_nvda_yield", 0.0) or 0.0
    borrow = base.fld(item, "cum_borrow_cost", 0.0) or 0.0
    return interest + nvda_yield - borrow


# ---------------------------------------------------------------------------
# Path and IL data
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def eth_compare_rows() -> tuple[dict[str, str], ...]:
    """Pool rows, read once for the whole build."""
    return tuple(base.read_csv_rows("eth_compare.csv"))


@lru_cache(maxsize=8)
def load_focus_path(
    run: str = "risk_only_a", window: str = "45d"
) -> tuple[dict[str, Any], ...]:
    """Read the full path for one run, keeping mode and cum_il_vs_hodl.

    ``base.load_paths`` intentionally drops both fields, so the study reads the
    CSV directly instead of widening the dashboard loader. The result is cached
    because the protection section and the footer both ask for it.
    """
    points: list[dict[str, Any]] = []
    for item in base.read_csv_rows("baseline_paths.csv"):
        if item.get("run") != run or item.get("window") != window:
            continue
        points.append(
            {
                "step": base.fld(item, "step", 0.0) or 0.0,
                "ts": base.fld(item, "ts", 0.0) or 0.0,
                "nav": base.fld(item, "nav", 0.0) or 0.0,
                "hodl_nav": base.fld(item, "hodl_nav", 0.0) or 0.0,
                "drawdown": base.fld(item, "drawdown", 0.0) or 0.0,
                "mode": item.get("mode", "BOOKS"),
                "active_book": int(base.fld(item, "active_book", 0) or 0),
                "book_value": (base.fld(item, "book_a_value", 0.0) or 0.0)
                + (base.fld(item, "book_b_value", 0.0) or 0.0),
                "arm_equity": base.fld(item, "arm_equity", 0.0) or 0.0,
                "idle_value": base.fld(item, "idle_value", 0.0) or 0.0,
                "cum_il_vs_hodl": base.fld(item, "cum_il_vs_hodl", 0.0) or 0.0,
            }
        )
    points.sort(key=lambda item: item["step"])
    for index, point in enumerate(points):
        step = int(point["step"])
        if step != index:
            raise ValueError(
                f"{run}/{window} path is not contiguous at index {index}: "
                f"step {step} (expected {index})"
            )
    return tuple(points)


# ---------------------------------------------------------------------------
# Event data: guard pulls and book changes
# ---------------------------------------------------------------------------

# Book capital above this counts as funded; the crossing is the event.
BOOK_CAPITAL_FLOOR = 1.0

# Hours where the 50 bps guard proxy fires but the model records no pull. 473
# and 1001 sit inside the keeper re-arm lag after a pull; 808 and 832 have no
# book capital to guard. Naming them keeps the coverage claim honest.
GUARD_NO_PULL_50 = frozenset({473, 808, 832, 1001})


@lru_cache(maxsize=1)
def scenario_hours() -> tuple[dict[str, Any], ...]:
    """Per-hour scenario rows, read once because the file is ~6 MB."""
    path = HERE / "data" / "scenario_45d.json"
    try:
        with path.open(encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return ()
    if not isinstance(payload, dict):
        return ()
    return tuple(payload.get("hours") or ())


def guard_hits(run_row: dict[str, str] | None) -> list[tuple[int, float]]:
    """Hours the run's guard threshold is crossed, as ``(step, move)``.

    The guard watches the book the run starts in, so only that book's
    ``max5mMoveBps`` series counts. Empty when the scenario is unavailable.
    """
    hours = scenario_hours()
    if not hours:
        return []
    threshold = base.fld(run_row, "guard_pull_threshold_bps", 200.0) or 200.0
    start_book = int(base.fld(run_row, "start_book", 0.0) or 0.0)
    key = "bookB" if start_book else "bookA"
    hits: list[tuple[int, float]] = []
    for hour in hours:
        move = float((hour.get(key) or {}).get("max5mMoveBps") or 0.0)
        if move > threshold:
            hits.append((int(hour.get("t", 0) or 0), move))
    return hits


def book_events(points: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Book capital crossings and active-book switches along one path.

    Mode flips are deliberately ignored: they follow the guard, not the book,
    so ``book_value`` is the only trigger. A step can yield two rows when the
    book crosses and the active book switches in the same hour.
    """
    letters = {0: "A", 1: "B"}
    events: list[dict[str, Any]] = []
    for prev, curr in zip(points, points[1:]):
        before = float(prev.get("book_value", 0.0))
        after = float(curr.get("book_value", 0.0))
        common = {
            "step": int(curr["step"]),
            "nav": float(curr.get("nav", 0.0)),
            "drawdown": float(curr.get("drawdown", 0.0)),
            "ts": float(curr.get("ts", 0.0)),
            "mode": str(curr.get("mode") or "BOOKS"),
        }
        if before > BOOK_CAPITAL_FLOOR and after <= BOOK_CAPITAL_FLOOR:
            events.append(
                {
                    **common,
                    "kind": "recall",
                    "label": "Recall to arms",
                    "detail": "book -> 0",
                }
            )
        elif before <= BOOK_CAPITAL_FLOOR and after > BOOK_CAPITAL_FLOOR:
            events.append(
                {
                    **common,
                    "kind": "return",
                    "label": "Fund the book",
                    "detail": "book -> >$1",
                }
            )
        prev_book = int(prev.get("active_book", 0))
        curr_book = int(curr.get("active_book", 0))
        if prev_book != curr_book:
            before_name = letters.get(prev_book, str(prev_book))
            after_name = letters.get(curr_book, str(curr_book))
            events.append(
                {
                    **common,
                    "kind": "switch",
                    "label": f"Switch {before_name}->{after_name}",
                    "detail": f"active book {before_name} -> {after_name}",
                }
            )
    return events


def event_time(points: Sequence[dict[str, Any]], step: float | int) -> str:
    """UTC timestamp for an event hour, falling back to the bare step."""
    target = int(step)
    for point in points:
        if int(point.get("step", 0)) != target:
            continue
        ts = float(point.get("ts", 0.0) or 0.0)
        if ts > 0:
            return datetime.fromtimestamp(ts, timezone.utc).strftime("%b %d, %H:%M")
        break
    return f"Hour {target}"


def event_markers(events: Sequence[dict[str, Any]]) -> list[tuple[float, str, str]]:
    """``base.line_chart`` markers for a list of book events."""
    return [
        (float(event["step"]), str(event["kind"]), str(event["label"]))
        for event in events
    ]


def guard_status(
    raw_hits: Sequence[tuple[int, float]], threshold: float
) -> list[dict[str, Any]]:
    """Tag raw threshold hits as model pulls or no-pull proxy hours."""
    fifty = math.isclose(float(threshold), 50.0)
    statuses: list[dict[str, Any]] = []
    for step, move in raw_hits:
        absent = fifty and step in GUARD_NO_PULL_50
        statuses.append(
            {
                "step": step,
                "move": move,
                "status": "no pull" if absent else "pull",
            }
        )
    return statuses


def guard_markers(
    statuses: Sequence[dict[str, Any]],
) -> tuple[list[tuple[int, str, str]], list[tuple[int, str, str]]]:
    """Split proxy hours into model pulls (red) and no-pull hours (gray)."""
    actual: list[tuple[int, str, str]] = []
    absent: list[tuple[int, str, str]] = []
    for item in statuses:
        step = int(item["step"])
        move = float(item["move"])
        if item["status"] == "pull":
            actual.append((step, "guard", f"Model guard pull - {move:.0f} bps 5-min move"))
        else:
            absent.append(
                (step, "guard-absent", f"No guard pull - {move:.0f} bps 5-min move")
            )
    return actual, absent


def guard_proxy_rows(
    points: Sequence[dict[str, Any]], statuses: Sequence[dict[str, Any]]
) -> list[str]:
    """Table rows for the 50 bps proxy, one per raw threshold hour.

    ``points[step]`` is safe because ``load_focus_path`` rejects any gap in the
    hourly steps, so the list index is the step.
    """
    rows: list[str] = []
    for item in statuses:
        step = int(item["step"])
        point = points[step]
        rows.append(
            "<tr>"
            + cell_text(event_time(points, step))
            + cell_num_text(f"{float(item['move']):.0f} bps")
            + cell_text(str(item["status"]))
            + cell_money(float(point["nav"]))
            + cell_pct(float(point["drawdown"]), 2)
            + "</tr>"
        )
    return rows


# (bps, run) in threshold order; 200 bps is the deploy setting, not a stress.
GUARD_THRESHOLDS: tuple[tuple[int, str], ...] = (
    (50, "risk_only_a_guard50"),
    (100, "risk_only_a_guard100"),
    (200, "risk_only_a"),
)


def guard_threshold_rows(ctx: dict[str, Any]) -> list[str]:
    """One table row per guard proxy: model pulls, raw hours, net, DD, actions."""
    rows: list[str] = []
    for bps, run in GUARD_THRESHOLDS:
        item = row(ctx, run, "45d")
        rows.append(
            "<tr>"
            + cell_text(f"{bps} bps")
            + cell_num_text(base.integer(base.fld(item, "guard_pulls", 0.0)))
            + cell_num_text(len(guard_hits(item)))
            + cell_money(net(ctx, run, "45d"), 2)
            + cell_money(net(ctx, run, "20d"), 2)
            + cell_pct(drawdown(ctx, run, "45d"), 2)
            + cell_num_text(base.integer(base.fld(item, "actions", 0.0)))
            + "</tr>"
        )
    return rows


def display_indexes(points: Sequence[dict[str, Any]], every: int = 6) -> list[int]:
    """Indexes of the one downsampled point list every 45d chart shares."""
    if not points:
        return []
    indexes = list(range(0, len(points), every))
    if indexes[-1] != len(points) - 1:
        indexes.append(len(points) - 1)
    return indexes


def sampled_series(
    points: Sequence[dict[str, Any]], field: str, indexes: Sequence[int]
) -> list[tuple[float, float]]:
    """One field at the shared display indexes, so every series shares an x axis."""
    return [
        (float(points[index]["step"]), float(points[index][field])) for index in indexes
    ]


def hodl_drawdown(points: Sequence[dict[str, Any]]) -> list[float]:
    """Running drawdown of the HODL NAV, one value per input point."""
    if not points:
        return []
    peak = points[0]["hodl_nav"]
    curve: list[float] = []
    for item in points:
        peak = max(peak, item["hodl_nav"])
        curve.append(item["hodl_nav"] / peak - 1.0 if peak else 0.0)
    return curve


def assert_same_x(series: dict[str, Sequence[tuple[float, float]]]) -> None:
    """Every 45d chart must be drawn on the same sampled hours."""
    reference_name, reference = next(iter(series.items()))
    reference_x = [x for x, _ in reference]
    for name, points in series.items():
        if [x for x, _ in points] != reference_x:
            raise ValueError(f"{name} x axis differs from {reference_name}")


def check_allocation(points: Sequence[dict[str, Any]], indexes: Sequence[int]) -> None:
    """Books A+B plus arm equity plus idle must reconcile to NAV."""
    for index in indexes:
        item = points[index]
        total = item["book_value"] + item["arm_equity"] + item["idle_value"]
        if not math.isclose(total, item["nav"], rel_tol=1e-9, abs_tol=1e-9):
            raise ValueError(
                f"allocation does not reconcile at step {item['step']}: "
                f"{total!r} != {item['nav']!r}"
            )


def mode_segments(points: Sequence[dict[str, Any]]) -> list[tuple[str, int, int]]:
    """Contiguous mode runs as ``(mode, first_step, last_step)``."""
    segments: list[tuple[str, int, int]] = []
    for point in points:
        mode = str(point.get("mode") or "BOOKS")
        step = int(point["step"])
        if segments and segments[-1][0] == mode:
            first, _ = segments[-1][1], segments[-1][2]
            segments[-1] = (mode, first, step)
        else:
            segments.append((mode, step, step))
    return segments


def mode_strip(points: Sequence[dict[str, Any]]) -> str:
    segments = mode_segments(points)
    total = max(1, len(points))
    parts: list[str] = []
    books_hours = 0
    arms_hours = 0
    for mode, first, last in segments:
        hours = last - first + 1
        share = hours / total * 100.0
        cls = "books" if mode.upper() == "BOOKS" else "arms"
        if cls == "books":
            books_hours += hours
        else:
            arms_hours += hours
        label = f"{mode} {hours}h" if share >= 7.0 else ""
        title = f"{mode}: hour {first}-{last} ({hours}h, {share:.1f}%)"
        parts.append(
            f'<div class="mode-seg {cls}" style="width:{share:.3f}%" '
            f'title="{base.esc(title)}">{base.esc(label)}</div>'
        )
    legend = (
        '<div class="mode-legend">'
        f'<span><i class="swatch" style="background:{TEAL}"></i>BOOKS</span>'
        f'<span><i class="swatch" style="background:{AMBER}"></i>ARMS</span>'
        f"<span>{len(segments)} contiguous segments</span>"
        f"<span>BOOKS {books_hours}h ({books_hours / total * 100:.0f}%)</span>"
        f"<span>ARMS {arms_hours}h ({arms_hours / total * 100:.0f}%)</span>"
        "</div>"
    )
    return (
        f'<div class="mode-strip" role="img" aria-label="Hourly keeper mode: '
        f'BOOKS {books_hours} hours, ARMS {arms_hours} hours">'
        f"{''.join(parts)}</div>{legend}"
    )


def snap_zero(value: float, tolerance: float = 0.005) -> float:
    """Collapse sub-cent noise so tables never print ``-$0.00``."""
    return 0.0 if abs(value) < tolerance else value


@lru_cache(maxsize=None)
def il_by_move(half_width_bps: int) -> tuple[tuple[int, float], ...]:
    """Static IL in USD for a $10,000 position, by price move.

    Returns ``(move_pct, il_usd)`` rows. The position is opened at ``P0`` with a
    raw-tick range from ``lp.range_from_half_width``; the HODL leg is the same
    entry basket held unmanaged.
    """
    tick = lp.tick_from_price(P0)
    lower, upper = lp.range_from_half_width(tick, half_width_bps)
    sqrt_p0 = 1e6 / math.sqrt(P0)  # lp.py works in raw token1/token0 units
    liquidity = lp.liquidity_for_value(CAPITAL, sqrt_p0, lower, upper)
    x0, y0 = lp.token_amounts(liquidity, sqrt_p0, lower, upper)
    rows: list[tuple[int, float]] = []
    for move in MOVES:
        price = P0 * (1.0 + move / 100.0)
        lp_value = lp.position_value_usd(liquidity, 1e6 / math.sqrt(price), lower, upper)
        hodl_value = x0 + y0 * price
        rows.append((move, snap_zero(lp_value - hodl_value)))
    return tuple(rows)


def il_loss(half_width_bps: int, move: int) -> float:
    for point_move, loss in il_by_move(half_width_bps):
        if point_move == move:
            return loss
    raise ValueError(f"move {move} is outside the study grid")


# ---------------------------------------------------------------------------
# 1. Hero
# ---------------------------------------------------------------------------


def section_hero(ctx: dict[str, Any]) -> str:
    focus = "risk_only_a_2h15k_guard75"
    focus45 = row(ctx, focus, "45d")
    focus20 = row(ctx, focus, "20d")
    hodl45 = row(ctx, "hodl", "45d")
    hodl20 = row(ctx, "hodl", "20d")

    pools = [item for item in eth_compare_rows() if item.get("quote") == "USDG"]
    best_pool = max(pools, key=lambda item: base.fld(item, "net_apr_pct", -1e9) or -1e9)

    live = row(ctx, "risk_only_a_live", "45d")
    stress = row(ctx, "risk_only_a_stress", "45d")
    lend_low = base.fld(live, "arm_usdg_apr")
    borrow_low = base.fld(live, "arm_borrow_apr")
    borrow_high = base.fld(stress, "arm_borrow_apr")

    focus_net45 = base.fld(focus45, "net_vs_hodl")
    focus_net20 = base.fld(focus20, "net_vs_hodl")
    focus_dd45 = base.fld(focus45, "max_drawdown")
    best_net = base.fld(best_pool, "net_apr_pct")
    best_fee = base.fld(best_pool, "fee_apr_pct")
    best_il = base.fld(best_pool, "il_apr_pct")
    risk_dd45 = drawdown(ctx, "risk_only_a", "45d")
    risk_dd20 = drawdown(ctx, "risk_only_a", "20d")
    hodl_dd45 = base.fld(hodl45, "max_drawdown")
    hodl_dd20 = base.fld(hodl20, "max_drawdown")

    kpis = "".join(
        [
            base.kpi_card(
                "Case that wins - A 2h/15k/75",
                usd(focus_net45, 2, signed=True),
                f"45d net vs HODL - 20d {usd(focus_net20, 2, signed=True)} - "
                f"max DD {pf(focus_dd45, 2)}",
                "pos" if (focus_net45 or 0) > 0 else "neg",
            ),
            base.kpi_card(
                "Which pool pays? - USDG V4 0.30%",
                pp(best_net, 1),
                f"best USDG net APR - fee {pp(best_fee, 1)} plus IL of "
                f"{pp(best_il, 1)} = {pp(best_net, 1)}",
                "pos" if (best_net or 0) > 0 else "neg",
            ),
            base.kpi_card(
                "What does Morpho add?",
                f"{pf(lend_low, 1)}-{pp(OBSERVED_USDG_TOP, 1)}",
                f"USDG lend: live case to observed venue top - NVDA borrow "
                f"{pf(borrow_low, 2)}-{pf(borrow_high, 2)}",
            ),
            base.kpi_card(
                "When do we leave? - Risk-only A",
                pf(risk_dd45, 2),
                f"45d max DD vs HODL {pf(hodl_dd45, 2)} - 20d {pf(risk_dd20, 2)} "
                f"vs {pf(hodl_dd20, 2)}",
                "neg",
            ),
        ]
    )

    questions = "".join(
        [
            '<a class="question" href="#pools">'
            '<span class="q">1 - Which pool pays?</span>'
            '<span class="a">Fee APR minus IL, not fee APR.</span></a>',
            '<a class="question" href="#morpho">'
            '<span class="q">2 - What does Morpho add?</span>'
            '<span class="a">A small, conditional carry.</span></a>',
            '<a class="question" href="#il">'
            '<span class="q">3 - What does IL cost?</span>'
            f'<span class="a">{usd(il_loss(500, -20))} on $10k at a 20% move.</span></a>',
            '<a class="question" href="#protection">'
            '<span class="q">4 - When do we leave?</span>'
            '<span class="a">Guard first, recall second.</span></a>',
        ]
    )

    chips = "".join(
        [
            '<span class="chip">36-minute risk window</span>',
            '<span class="chip blue">$10k NAV</span>',
            '<span class="chip amber">5-minute pull proxy</span>',
            '<span class="chip slate">in-sample</span>',
        ]
    )

    return f"""<section id="study">
  <div class="hero">
    <div class="hero-top">
      <div>
        <div class="eyebrow">NVDA tranched allocator - focused study</div>
        <h1>Pool returns, IL, and capital protection</h1>
        <p class="subtitle">Four questions, six pools, four arm cases and one tape.
        Fees are not return, the arm is not the engine, and protection is conditional.</p>
        <div class="chips">{chips}</div>
      </div>
      <div class="tape-stamp">
        <div class="stamp-label">Risk window</div>
        <div class="stamp-value">36-minute</div>
        <div class="stamp-sub">$15k floor - 200 bps</div>
        <div class="stamp-note">5-minute pull proxy. The 45d and 20d windows are cuts of
        one tape, not 45 minutes. Guard 75 is a fee share, not a width.</div>
      </div>
    </div>
    <div class="questions">{questions}</div>
    <div class="kpi-grid">{kpis}</div>
    <p class="tape-note">Focus run: <b>Risk-only A - 2h keeper - $15k floor - 75% guard</b>.
    The 20-day cut is the honesty check: {usd(focus_net45, 2, signed=True)} over 45 days,
    {usd(focus_net20, 2, signed=True)} over 20.</p>
    <div class="what-this-shows"><b>The book is the business; the arm is a safe harbor.</b>
    Pool fees supply the carry. The Morpho arm keeps capital productive when the book is not
    worth the IL. Neither is free: IL is always a drag on the entry basket, and the guard is
    a proxy.</div>
  </div>
</section>"""


# ---------------------------------------------------------------------------
# 2. Pool return study
# ---------------------------------------------------------------------------


def section_pools(_ctx: dict[str, Any]) -> str:
    pools = eth_compare_rows()
    usdg = [item for item in pools if item.get("quote") == "USDG"]
    best = max(usdg, key=lambda item: base.fld(item, "net_apr_pct", -1e9) or -1e9)
    best_name = best.get("book", "")

    table_rows: list[str] = []
    for item in pools:
        name = item.get("book", "")
        fee = base.fld(item, "fee_apr_pct")
        il = base.fld(item, "il_apr_pct")
        net = base.fld(item, "net_apr_pct")
        hodl = base.fld(item, "hodl_apr_pct")
        total = base.fld(item, "total_apr_pct")
        guard = base.fld(item, "guard_in_pct")
        swaps = base.fld(item, "swaps")
        row_class = ' class="row-best"' if name == best_name else ""
        table_rows.append(
            f"<tr{row_class}>"
            f"{cell_text(name)}"
            f"{cell_text(item.get('quote', ''))}"
            f"{cell_pct(fee, 2, fraction=False)}"
            f"{cell_pct(il, 2, fraction=False)}"
            f"{cell_pct(net, 2, fraction=False)}"
            f"{cell_pct(hodl, 2, fraction=False)}"
            f"{cell_pct(total, 2, fraction=False)}"
            f"{cell_pct(guard, 1, fraction=False)}"
            f'<td class="num">{base.integer(swaps)}</td>'
            "</tr>"
        )

    pools_table = table(
        (
            ("Pool", False),
            ("Quote", False),
            ("Fee APR", True),
            ("IL APR", True),
            ("Net APR", True),
            ("HODL APR", True),
            ("Total APR", True),
            ("Guard in range", True),
            ("Swaps", True),
        ),
        table_rows,
        note="Net = fee + IL versus HODL. Total = net + the HODL leg, so it is the "
        "return in the quote asset. ETH totals are in WETH; USDG totals are in USDG. "
        "Windows differ slightly (41.8-45.0 days) because each tape ends at its own "
        "timestamp.",
    )

    chart = base.grouped_bar_chart(
        [POOL_SHORT.get(item.get("book", ""), item.get("book", "")) for item in pools],
        [
            ("Fee APR", [base.fld(item, "fee_apr_pct") for item in pools], TEAL),
            ("IL APR", [base.fld(item, "il_apr_pct") for item in pools], RED),
            ("Net APR", [base.fld(item, "net_apr_pct") for item in pools], BLUE),
        ],
        height=330,
        value_format=lambda value: f"{value:,.1f}%",
        label="Pool fee, IL and net APR",
    )

    usdg_low = min(usdg, key=lambda item: base.fld(item, "fee_apr_pct", 1e9) or 1e9)
    v4_30 = next((item for item in pools if item.get("book") == "USDG/NVDA V4 0.30%"), None)
    eth_best = max(
        (item for item in pools if item.get("quote") == "WETH"),
        key=lambda item: base.fld(item, "net_apr_pct", -1e9) or -1e9,
    )
    total_best = base.fld(best, "total_apr_pct")

    callout = base.callout(
        "<b>Read the columns in order.</b> "
        f"USDG V4 0.30% earns {pp(base.fld(v4_30, 'fee_apr_pct'), 1)} of fees and gives "
        f"back {pp(abs(base.fld(v4_30, 'il_apr_pct') or 0.0), 1)} to IL, for "
        f"{pp(base.fld(v4_30, 'net_apr_pct'), 1)} net versus HODL. That net is not the "
        f"return: the HODL leg is {pp(base.fld(v4_30, 'hodl_apr_pct'), 1)}, so total APR "
        f"is {pp(base.fld(v4_30, 'total_apr_pct'), 1)}. "
        f"The lowest-fee USDG pool ({usdg_low.get('book', '')}) has the best total APR "
        f"({pp(base.fld(usdg_low, 'total_apr_pct'), 1)}), which shows that fee APR does "
        "not order the outcomes. "
        f"The ETH book is a different quote: its best net APR is "
        f"{pp(base.fld(eth_best, 'net_apr_pct'), 1)} and its total is "
        f"{pp(base.fld(eth_best, 'total_apr_pct'), 1)} in WETH, not USD. "
        f"The best USDG net pool is {best_name} at {pp(base.fld(best, 'net_apr_pct'), 1)} "
        f"net, {pp(total_best, 1)} total.",
        "warn",
    )

    body = (
        '<div class="section-stack">'
        + chart_card(
            "Fee, IL and net APR by pool",
            "Percentage points of APR - 45-day book tapes",
            chart,
            "IL is negative in every pool. Net is fee + IL; the tallest fee bar is not "
            "the tallest net bar once IL is removed.",
        )
        + f'<div class="card">{pools_table}</div>'
        + callout
        + "</div>"
    )
    return block(
        "02",
        "pools",
        "Pool return study",
        "Six pools, one decomposition: fee APR, IL APR, net APR, then the HODL leg. "
        "Fees are gross of the inventory loss that earns them.",
        body,
    )


# ---------------------------------------------------------------------------
# 3. Morpho and arm return
# ---------------------------------------------------------------------------


def section_morpho(ctx: dict[str, Any]) -> str:
    table_rows: list[str] = []
    labels: list[str] = []
    net45: list[float | None] = []
    net20: list[float | None] = []
    for label, run in ARM_CASES:
        labels.append(label)
        item45 = row(ctx, run, "45d")
        item20 = row(ctx, run, "20d")
        net45.append(base.fld(item45, "net_vs_hodl"))
        net20.append(base.fld(item20, "net_vs_hodl"))
        table_rows.append(
            "<tr>"
            f"{cell_text(label)}"
            f"{cell_pct(base.fld(item45, 'arm_usdg_apr'), 3)}"
            f"{cell_pct(base.fld(item45, 'arm_nvda_apr'), 3)}"
            f"{cell_pct(base.fld(item45, 'arm_borrow_apr'), 3)}"
            f"{cell_money(base.fld(item45, 'net_vs_hodl'), 2)}"
            f"{cell_money(base.fld(item20, 'net_vs_hodl'), 2)}"
            f"{cell_money(arm_carry(ctx, run), 2)}"
            f"{cell_pct(base.fld(item45, 'max_arm_ltv'), 1)}"
            "</tr>"
        )

    arm_table = table(
        (
            ("Case", False),
            ("USDG lend APR", True),
            ("NVDA yield", True),
            ("Borrow APR", True),
            ("45d net", True),
            ("20d net", True),
            ("Gross arm carry", True),
            ("Max LTV", True),
        ),
        table_rows,
        note="Net is NAV minus HODL for the whole strategy, not arm-only P&L. Gross arm "
        "carry = arm interest + NVDA yield - borrow over 45d, before gas. Max LTV is the "
        "45d peak on the arm.",
    )

    chart = base.grouped_bar_chart(
        labels,
        [
            ("45d net", net45, TEAL),
            ("20d net", net20, BLUE),
        ],
        height=300,
        value_format=lambda value: usd(value, 0, signed=True),
        label="Arm case net versus HODL",
    )

    base_case = row(ctx, "risk_only_a", "45d")
    live = row(ctx, "risk_only_a_live", "45d")
    stress = row(ctx, "risk_only_a_stress", "45d")
    stress20 = row(ctx, "risk_only_a_stress", "20d")
    arms = row(ctx, "always_arms", "45d")
    borrow_live = base.fld(live, "arm_borrow_apr")
    borrow_stress = base.fld(stress, "arm_borrow_apr")
    lend_live = base.fld(live, "arm_usdg_apr")

    callout = base.callout(
        "<b>The arm is a safe harbor, not the engine.</b> "
        f"Observed USDG lending sits at {OBSERVED_USDG_LOW:.2f}-{OBSERVED_USDG_HIGH:.2f}% "
        f"across venues; the base case uses {pf(base.fld(base_case, 'arm_usdg_apr'), 2)} "
        f"and the live case {pf(lend_live, 3)}. "
        f"NVDA borrow is the tail: {pf(borrow_live, 3)} in the live case versus "
        f"{pf(borrow_stress, 2)} in stress. The stress run still nets "
        f"{usd(base.fld(stress, 'net_vs_hodl'), 2, signed=True)} over 45d but "
        f"{usd(base.fld(stress20, 'net_vs_hodl'), 2, signed=True)} over 20d, because a "
        "high-utilization borrow market is a liquidity and exit trap, not free yield. "
        f"The 3% NVDA line is a Spiral total-yield assumption, APR after borrow, not a "
        "native Morpho collateral yield. "
        f"Gross arm carry is {usd(arm_carry(ctx, 'risk_only_a'), 2)} in risk-only A and "
        f"{usd(arm_carry(ctx, 'always_arms'), 2)} in always-arms: roughly $1-$15 over 45 "
        f"days. Fees are {usd(base.fld(base_case, 'cum_fees'), 0)} in the same run.",
        "warn",
    )

    body = (
        '<div class="section-stack">'
        + chart_card(
            "Arm cases - net versus HODL",
            "45d and 20d cuts of one tape",
            chart,
            "Base and live share one path; the stress rates change the keeper's "
            "decisions, so stress is a separate path. The 20d cut is negative in three "
            "of four cases.",
        )
        + f'<div class="card">{arm_table}</div>'
        + callout
        + "</div>"
    )
    return block(
        "03",
        "morpho",
        "Morpho and the arm",
        "What the USDG lend and NVDA borrow sleeve adds after the borrow cost - and why "
        "the headline rate is not the carry.",
        body,
    )


# ---------------------------------------------------------------------------
# 4. Strategy cases
# ---------------------------------------------------------------------------


def section_cases(ctx: dict[str, Any]) -> str:
    labels: list[str] = []
    net45: list[float | None] = []
    net20: list[float | None] = []
    dd45: list[float | None] = []
    dd20: list[float | None] = []
    table_rows: list[str] = []
    for label, run in CASE_ROWS:
        labels.append(label.replace(" - ", " "))
        item45 = row(ctx, run, "45d")
        item20 = row(ctx, run, "20d")
        net45.append(base.fld(item45, "net_vs_hodl"))
        net20.append(base.fld(item20, "net_vs_hodl"))
        dd45.append(base.fld(item45, "max_drawdown"))
        dd20.append(base.fld(item20, "max_drawdown"))
        table_rows.append(
            "<tr>"
            f"{cell_text(label)}"
            f"{cell_money(base.fld(item45, 'net_vs_hodl'), 2)}"
            f"{cell_money(base.fld(item20, 'net_vs_hodl'), 2)}"
            f"{cell_money(base.fld(item45, 'cum_fees'), 2)}"
            f"{cell_money(arm_carry(ctx, run), 2)}"
            f"{cell_pct(base.fld(item45, 'max_drawdown'), 2)}"
            f"{cell_pct(base.fld(item20, 'max_drawdown'), 2)}"
            f"{cell_pct(base.fld(item45, 'funded_pct'), 1)}"
            f'<td class="num">{base.integer(base.fld(item45, "actions"))}</td>'
            "</tr>"
        )

    cases_table = table(
        (
            ("Case", False),
            ("45d net", True),
            ("20d net", True),
            ("Fees 45d", True),
            ("Gross arm carry", True),
            ("DD 45d", True),
            ("DD 20d", True),
            ("Funded", True),
            ("Actions", True),
        ),
        table_rows,
        note="DD is peak-to-trough NAV. Funded is the share of hours with book inventory "
        "above $1. Actions count fund, recall and switch events, not swaps. The base "
        "risk-only row is the 1h keeper, $10k floor, 50% guard share.",
    )

    net_chart = base.grouped_bar_chart(
        labels,
        [("45d net", net45, TEAL), ("20d net", net20, BLUE)],
        height=320,
        value_format=lambda value: usd(value, 0, signed=True),
        label="Strategy case net versus HODL",
    )
    dd_chart = base.grouped_bar_chart(
        labels,
        [("DD 45d", dd45, AMBER), ("DD 20d", dd20, RED)],
        height=300,
        value_format=lambda value: pf(value, 1),
        label="Strategy case maximum drawdown",
    )

    base45_net = net(ctx, "risk_only_a", "45d")
    base20_net = net(ctx, "risk_only_a", "20d")
    vol45_net = net(ctx, "risk_only_a_vol15k", "45d")
    vol20_net = net(ctx, "risk_only_a_vol15k", "20d")
    focus45_net = net(ctx, "risk_only_a_2h15k_guard75", "45d")
    focus20_net = net(ctx, "risk_only_a_2h15k_guard75", "20d")
    always45_net = net(ctx, "always_a", "45d")
    always20_net = net(ctx, "always_a", "20d")
    base45_dd = drawdown(ctx, "risk_only_a", "45d")
    vol45_dd = drawdown(ctx, "risk_only_a_vol15k", "45d")

    callout = base.callout(
        "<b>What moves the result.</b> "
        f"The $15k volume floor is the biggest single fix on the 20-day cut: "
        f"{usd(base20_net, 2, signed=True)} to {usd(vol20_net, 2, signed=True)}, and "
        f"45d drawdown {pf(base45_dd, 2)} to {pf(vol45_dd, 2)}. "
        f"The 2h interval alone is similar ({usd(net(ctx, 'risk_only_a_interval2', '20d'), 2, signed=True)} "
        "on 20d); stacked with 15k and the 75% guard it is the best row in this tape. "
        f"Always A is the risk-adjusted benchmark: {usd(always45_net, 2, signed=True)} / "
        f"{usd(always20_net, 2, signed=True)} and DD "
        f"{pf(drawdown(ctx, 'always_a', '45d'), 2)} / "
        f"{pf(drawdown(ctx, 'always_a', '20d'), 2)}. "
        f"The base risk-only A is {usd(base45_net, 2, signed=True)} over 45d but "
        f"{usd(base20_net, 2, signed=True)} over 20d: the 45-day win does not repeat at "
        f"20 days. The focus case is {usd(focus45_net, 2, signed=True)} / "
        f"{usd(focus20_net, 2, signed=True)} in-sample, not a forecast.",
        "good",
    )

    body = (
        '<div class="section-stack">'
        + chart_card(
            "Six strategy cases - net versus HODL",
            "45d and 20d",
            net_chart,
            "Bars are net of fees, IL, gas and arm carry. The 20-day cut is the honesty "
            "check on every 45-day winner.",
        )
        + chart_card(
            "Same cases - maximum drawdown",
            "Peak-to-trough NAV",
            dd_chart,
            "A shallower drawdown is the risk-adjusted case for the keeper. Negative is "
            "a loss; bars are not scaled to net.",
        )
        + f'<div class="card">{cases_table}</div>'
        + callout
        + "</div>"
    )
    return block(
        "04",
        "cases",
        "Our strategy in a few cases",
        "Six rows answer the practical question: which configuration would we defend, "
        "and what does it give up in the 20-day cut?",
        body,
    )


# ---------------------------------------------------------------------------
# 5. Simple variations
# ---------------------------------------------------------------------------


def section_variation(ctx: dict[str, Any]) -> str:
    labels: list[str] = []
    net45: list[float | None] = []
    net20: list[float | None] = []
    table_rows: list[str] = []
    for label, run in VARIATION_ROWS:
        labels.append(label.replace(" - ", " "))
        item45 = row(ctx, run, "45d")
        item20 = row(ctx, run, "20d")
        net45.append(base.fld(item45, "net_vs_hodl"))
        net20.append(base.fld(item20, "net_vs_hodl"))
        table_rows.append(
            "<tr>"
            f"{cell_text(label)}"
            f"{cell_money(base.fld(item45, 'net_vs_hodl'), 2)}"
            f"{cell_money(base.fld(item20, 'net_vs_hodl'), 2)}"
            f"{cell_pct(base.fld(item45, 'max_drawdown'), 2)}"
            f"{cell_pct(base.fld(item20, 'max_drawdown'), 2)}"
            "</tr>"
        )

    variations_table = table(
        (
            ("Variation", False),
            ("45d net", True),
            ("20d net", True),
            ("DD 45d", True),
            ("DD 20d", True),
        ),
        table_rows,
        note="One change at a time from the 1h / 10k / 50 base, except the last row, which "
        "combines the 2h interval, $15k floor and 75% guard share.",
    )
    chart = base.grouped_bar_chart(
        labels,
        [("45d net", net45, TEAL), ("20d net", net20, BLUE)],
        height=300,
        value_format=lambda value: usd(value, 0, signed=True),
        label="Simple variations net versus HODL",
    )

    base20_net = net(ctx, "risk_only_a", "20d")
    guard20_net = net(ctx, "risk_only_a_guard75", "20d")
    combined20_net = net(ctx, "risk_only_a_2h15k", "20d")
    combo20_net = net(ctx, "risk_only_a_2h15k_guard75", "20d")
    callout = base.callout(
        "<b>Do not stack levers without fresh tape.</b> "
        f"From the base 20-day net of {usd(base20_net, 2, signed=True)}, the 75% guard "
        f"alone is worse ({usd(guard20_net, 2, signed=True)}). The 2h interval and $15k "
        f"floor together fix the 20-day cut ({usd(combined20_net, 2, signed=True)}); "
        f"adding the 75% guard gives {usd(combo20_net, 2, signed=True)}. "
        "Every row here is one tape, in-sample, and the interactions are large: a lever "
        "that helps alone can hurt when combined.",
        "warn",
    )

    body = (
        '<div class="section-stack">'
        + chart_card(
            "One lever at a time",
            "Net versus HODL - 45d and 20d",
            chart,
            "Volume floor, keeper interval and guard share are the three levers a keeper "
            "can actually turn. The chart reads left to right as base, single levers, "
            "then the combination.",
        )
        + f'<div class="card">{variations_table}</div>'
        + callout
        + "</div>"
    )
    return block(
        "05",
        "variation",
        "Simple variations",
        "Five rows, one change at a time. The point is not to optimise; it is to see "
        "which lever survives the 20-day cut.",
        body,
    )


# ---------------------------------------------------------------------------
# 6. How IL works
# ---------------------------------------------------------------------------


def section_il(_ctx: dict[str, Any]) -> str:
    series: list[tuple[str, list[tuple[float, float]], str]] = []
    colors = (RED, AMBER, TEAL)
    for (half_width, label), color in zip(RANGES, colors, strict=True):
        series.append(
            (label, [(float(move), loss) for move, loss in il_by_move(half_width)], color)
        )

    chart = base.line_chart(
        [(name, points, color, False) for name, points, color in series],
        height=340,
        x_label="NVDA price move from $225.80 (%)",
        y_format=lambda value: usd(value, 0, signed=True),
        y_zero=True,
        label="Static IL in USD for a $10,000 position",
    )

    table_rows: list[str] = []
    by_range = {
        half_width: dict(il_by_move(half_width)) for half_width, _ in RANGES
    }
    for move in TABLE_MOVES:
        price = P0 * (1.0 + move / 100.0)
        move_label = f"{move:+d}%" if move else "0%"
        table_rows.append(
            "<tr>"
            f"{cell_num_text(move_label)}"
            f"{cell_num_text(f'${price:,.2f}')}"
            + "".join(il_cell(by_range[half_width][move]) for half_width, _ in RANGES)
            + "</tr>"
        )

    il_table = table(
        (
            ("Move", True),
            ("NVDA price", True),
            ("±5% range", True),
            ("±10% range", True),
            ("±20% range", True),
        ),
        table_rows,
        note="IL = LP value - HODL value for the same entry basket, in USD on a $10,000 "
        "position. Static range, no fees, no rebalancing. Negative means the LP is behind "
        "the unmanaged basket.",
    )

    narrow_loss = il_loss(500, -20)
    wide_loss = il_loss(2000, -20)
    narrow_up = il_loss(500, 20)
    callout = base.callout(
        "<b>IL is the price of being useful.</b> "
        f"At a 20% fall the IL on a ±5% range is {usd(narrow_loss, 2, signed=True)} on "
        f"$10,000 versus holding; on a ±20% range it is {usd(wide_loss, 2, signed=True)}. "
        f"At a 20% rise the ±5% range IL is {usd(narrow_up, 2, signed=True)}. "
        "Narrower ranges earn more fees and lose more to IL on the same move, so fees must "
        "cover IL before the book beats HODL. The guard and recall protect the tail, not "
        "this trade-off: they can take you out of the book, but they do not make a narrow "
        "range cheap. The model's LP mark versus HODL can still be positive in a down tape "
        "because the book is underweight NVDA and sits out part of the fall; that is a "
        "timing and allocation effect, not free alpha.",
        "warn",
    )

    body = (
        '<div class="section-stack">'
        + chart_card(
            "Static IL in USD - $10,000 at NVDA $225.80",
            "Ranges ±5%, ±10%, ±20% - price moves -20% to +20%",
            chart,
            "Every line is zero at entry and below zero on both sides. The narrower the "
            "range, the steeper the loss for the same price move.",
        )
        + f'<div class="card">{il_table}</div>'
        + callout
        + "</div>"
    )
    return block(
        "06",
        "il",
        "How IL works, in dollars",
        "Impermanent loss is a ratio, so it is easy to quote and hard to feel. Here it is "
        "a dollar loss against holding the same entry basket.",
        body,
    )


# ---------------------------------------------------------------------------
# 7. Drawdown, exits, and protection
# ---------------------------------------------------------------------------


def section_protection(ctx: dict[str, Any]) -> str:
    points = load_focus_path()
    indexes = display_indexes(points)
    check_allocation(points, indexes)
    hodl_curve = hodl_drawdown(points)

    # Book changes are the capital crossings; the guard proxy hours are the
    # threshold crossings, split into model pulls and no-pull hours.
    events = book_events(points)
    prod_row = row(ctx, "risk_only_a", "45d")
    prod_guard = guard_hits(prod_row)
    stress_row = row(ctx, "risk_only_a_guard50", "45d")
    stress_points = load_focus_path("risk_only_a_guard50", "45d")
    stress_indexes = display_indexes(stress_points)
    check_allocation(stress_points, stress_indexes)
    stress_raw = guard_hits(stress_row)
    stress_status = guard_status(stress_raw, 50)
    model_pulls = int(base.fld(stress_row, "guard_pulls", 0) or 0)
    actual_pulls = sum(1 for item in stress_status if item["status"] == "pull")
    if actual_pulls != model_pulls:
        raise ValueError(
            f"guard proxy mismatch: {actual_pulls} pulls vs {model_pulls} model pulls"
        )
    stress_events = book_events(stress_points)
    stress_actual, stress_absent = guard_markers(stress_status)

    nav_series = [
        ("Risk-only A", sampled_series(points, "nav", indexes), TEAL, False),
        ("HODL", sampled_series(points, "hodl_nav", indexes), SLATE, True),
    ]
    dd_series = [
        ("Risk-only A", sampled_series(points, "drawdown", indexes), AMBER, False),
        (
            "HODL",
            [(float(points[index]["step"]), hodl_curve[index]) for index in indexes],
            SLATE,
            True,
        ),
    ]
    il_series = [
        ("LP mark vs HODL", sampled_series(points, "cum_il_vs_hodl", indexes), TEAL, False)
    ]
    allocation_series = [
        ("Books A+B", sampled_series(points, "book_value", indexes), TEAL),
        ("Arm equity", sampled_series(points, "arm_equity", indexes), AMBER),
        ("Idle value", sampled_series(points, "idle_value", indexes), SLATE),
    ]
    assert_same_x(
        {
            "NAV": nav_series[0][1],
            "drawdown": dd_series[0][1],
            "HODL drawdown": dd_series[1][1],
            "LP mark": il_series[0][1],
            "allocation": allocation_series[0][1],
            "arm equity": allocation_series[1][1],
            "idle": allocation_series[2][1],
        }
    )

    nav_chart = base.line_chart(
        nav_series,
        height=300,
        x_label="Hour of the 45-day window",
        y_format=base.axis_money,
        label="NAV versus HODL over 45 days",
        events=event_markers(events),
    )
    dd_chart = base.line_chart(
        dd_series,
        height=300,
        x_label="Hour of the 45-day window",
        y_format=lambda value: pf(value, 1),
        y_zero=True,
        label="Drawdown over 45 days",
        events=event_markers(events),
    )

    stress_nav_series = [
        ("Guard stress 50 bps", sampled_series(stress_points, "nav", stress_indexes), TEAL, False),
        ("HODL", sampled_series(stress_points, "hodl_nav", stress_indexes), SLATE, True),
    ]
    assert_same_x(
        {"stress NAV": stress_nav_series[0][1], "stress HODL": stress_nav_series[1][1]}
    )
    stress_nav_chart = base.line_chart(
        stress_nav_series,
        height=300,
        x_label="Hour of the 45-day window",
        y_format=base.axis_money,
        label="Guard stress 50 bps NAV versus HODL",
        events=stress_actual + stress_absent + event_markers(stress_events),
    )
    il_chart = base.line_chart(
        il_series,
        height=300,
        x_label="Hour of the 45-day window",
        y_format=lambda value: usd(value, 0, signed=True),
        y_zero=True,
        label="Cumulative LP mark versus HODL",
    )

    allocation_chart = base.stacked_area_chart(
        allocation_series,
        height=320,
        x_label="Hour of the 45-day window",
        y_format=base.axis_money,
        label="Risk-only A allocation over 45 days",
    )

    dd_labels: list[str] = []
    dd45: list[float | None] = []
    dd20: list[float | None] = []
    for label, run in DD_COMPARE:
        dd_labels.append(label)
        dd45.append(drawdown(ctx, run, "45d"))
        dd20.append(drawdown(ctx, run, "20d"))
    dd_compare_chart = base.grouped_bar_chart(
        dd_labels,
        [("DD 45d", dd45, AMBER), ("DD 20d", dd20, RED)],
        height=300,
        value_format=lambda value: pf(value, 1),
        label="Maximum drawdown comparison including HODL",
    )

    risk_dd45 = drawdown(ctx, "risk_only_a", "45d")
    risk_dd20 = drawdown(ctx, "risk_only_a", "20d")
    hodl_dd45 = drawdown(ctx, "hodl", "45d")
    hodl_dd20 = drawdown(ctx, "hodl", "20d")
    vol_dd20 = drawdown(ctx, "risk_only_a_vol15k", "20d")
    focus_dd20 = drawdown(ctx, "risk_only_a_2h15k_guard75", "20d")
    recall_count = base.fld(row(ctx, "risk_only_a", "45d"), "recalls")
    guard_pulls = base.fld(row(ctx, "risk_only_a", "45d"), "guard_pulls")

    callout = base.callout(
        "<b>Protection is conditional.</b> "
        "The guard is designed as the first line and the allocator recall as the second. "
        f"In this run it did not pull (guard_pulls = {base.integer(guard_pulls)}), so the "
        f"allocator recall did the work: {base.integer(recall_count)} recalls in risk-only A. "
        "The mode strip and allocation stack show capital leaving the book. "
        f"Over 45 days the strategy drawdown is "
        f"{-abs(risk_dd45 or 0.0) * 100:.2f}% versus HODL "
        f"{-abs(hodl_dd45 or 0.0) * 100:.2f}%, but over 20 days it is "
        f"{-abs(risk_dd20 or 0.0) * 100:.2f}% versus {-abs(hodl_dd20 or 0.0) * 100:.2f}%. "
        f"The $15k floor improves the 20-day cut to {-abs(vol_dd20 or 0.0) * 100:.2f}% and "
        f"the focus case to {-abs(focus_dd20 or 0.0) * 100:.2f}%, still not better than "
        "HODL in that window. Do not claim unconditional protection.",
        "warn",
    )

    how_we_leave = f"""<div class="card">
  <h3>How we leave</h3>
  <ol class="clean">
    <li><b>Risk HIGH.</b> Depeg, guard absent, or a volatility and volume blowout: stop
    adding and let the keeper act.</li>
    <li><b>Guard pull (designed first line).</b> The 200 bps five-minute proxy is meant to
    pull the guard before the whole book is closed. It is a proxy, not a live auction; in
    this run it did not fire, so the recall below did the work.</li>
    <li><b>Allocator recall second.</b> Capital leaves the book for the arm or idle when
    the book is not worth the IL. In this tape that is {base.integer(recall_count)}
    recalls.</li>
    <li><b>Re-arm when calm.</b> The keeper re-enters when risk normalizes; a recall is
    not an exit from the strategy.</li>
  </ol>
  <p class="chart-note">Guard share 75 means the guard holds 75% of book capital, not a
  75 bps width.</p>
</div>"""

    event_stats = (
        '<div class="card"><h3>Guard hits and book changes</h3><div class="grid-2">'
        + base.mini_run(
            "Production 200 bps",
            [
                base.mini_kpi("Guard pulls", base.integer(len(prod_guard))),
                base.mini_kpi("Recalls", base.integer(base.fld(prod_row, "recalls"))),
                base.mini_kpi("Fundings", base.integer(base.fld(prod_row, "fundings"))),
                base.mini_kpi("Switches", base.integer(base.fld(prod_row, "switches"))),
                base.mini_kpi("Actions", base.integer(base.fld(prod_row, "actions"))),
            ],
            "The 200 bps proxy did not fire; the book moved on recall and fund.",
        )
        + base.mini_run(
            "Guard stress 50 bps",
            [
                base.mini_kpi("Model pulls", base.integer(base.fld(stress_row, "guard_pulls"))),
                base.mini_kpi("Raw proxy hours", base.integer(len(stress_raw))),
                base.mini_kpi("Recalls", base.integer(base.fld(stress_row, "recalls"))),
                base.mini_kpi("Fundings", base.integer(base.fld(stress_row, "fundings"))),
                base.mini_kpi("Actions", base.integer(base.fld(stress_row, "actions"))),
            ],
            "24 raw 5-min proxy hours; 20 model pulls; 4 did not produce a pull "
            "(2 re-arm lag, 2 book capital at zero): 473, 808, 832, 1001.",
        )
        + '</div><p class="chart-note">Red = model pull; gray = no pull; amber = recall; blue = fund. Production 200 bps has 0 guard hits.</p></div>'
    )
    book_rows = [
        "<tr>"
        + cell_text(event_time(points, event["step"]))
        + cell_text(event["label"])
        + cell_text(event["detail"])
        + cell_money(event["nav"])
        + cell_pct(event["drawdown"], 2)
        + "</tr>"
        for event in events
    ]
    book_table = table(
        (
            ("When", False),
            ("Event", False),
            ("Detail", False),
            ("NAV", True),
            ("Drawdown", True),
        ),
        book_rows,
        note="Book changes are anchored on book capital crossing $1; the 8 mode flips include arm funding states, not separate recalls.",
    )
    proxy_table = table(
        (
            ("When", False),
            ("5-min move", True),
            ("Status", False),
            ("NAV", True),
            ("Drawdown", True),
        ),
        guard_proxy_rows(stress_points, stress_status),
        note="24 raw 5-min proxy hours at 50 bps; 20 model pulls; 4 did not produce a pull (2 re-arm lag, 2 book capital at zero): 473, 808, 832, 1001.",
    )
    threshold_table = table(
        (
            ("Proxy", False),
            ("Model pulls", True),
            ("Raw proxy hours", True),
            ("45d net", True),
            ("20d net", True),
            ("DD 45d", True),
            ("Actions", True),
        ),
        guard_threshold_rows(ctx),
        note="50 bps is a stress; 200 bps is the production proxy and recorded 0 hits on this tape. The real hook pull is EV-based.",
    )
    guard_callout = base.callout(
        "<b>The guard is a proxy, not a metronome.</b> The 200 bps production proxy recorded 0 pulls "
        "on this tape; the 50 bps stress recorded 24 raw 5-min moves and 20 model pulls. Four raw "
        "hours did not produce a pull (2 re-arm lag, 2 book capital at zero): 473, 808, 832, 1001. "
        "The 50 bps churns 602 actions and loses the 45d; "
        "the 200 bps keeps the book in the fee window. The hook's real EV pull is not observable here.",
        "warn",
    )

    body = (
        event_stats
        + '<div class="grid-2" style="margin-top:16px">'
        + chart_card(
            "NAV versus HODL - 45d",
            "Risk-only A - start $10,000",
            nav_chart,
            "Amber = recall; blue = fund; red = guard pull; gray = no pull. Downsampled every 6 hours.",
        )
        + chart_card(
            "Drawdown - 45d",
            "Peak-to-trough NAV",
            dd_chart,
            "The strategy path is shallower than HODL after the guard and recalls, but the 20-day cut is not.",
        )
        + "</div>"
        + '<div style="margin-top:16px">'
        + chart_card(
            "Guard stress 50 bps - NAV",
            "24 raw proxy hours; 20 model pulls",
            stress_nav_chart,
            "Red = model pull; gray = no pull; amber/blue = book recall/fund. This is a "
            "stress (risk_only_a_guard50), not the deploy setting.",
        )
        + "</div>"
        + f'<div class="card">{book_table}</div>'
        + f'<div class="card">{proxy_table}</div>'
        + f'<div class="card">{threshold_table}</div>'
        + guard_callout
        + '<div class="card chart-card" style="margin-top:16px">'
        + '<div class="chart-head"><h3>LP mark versus HODL - 45d</h3>'
        + "<p>Residual after net carry, USD</p></div>"
        + il_chart
        + '<p class="chart-note">Read directly from <code>cum_il_vs_hodl</code> in '
        "<code>baseline_paths.csv</code>. Positive is possible in a down tape when the "
        "book is underweight NVDA and sits out part of the fall; it is not static IL.</p>"
        + "</div>"
        + '<div class="card" style="margin-top:16px">'
        + "<h3>Where capital sits - risk-only A, 45d</h3>"
        + '<p class="lead-in">Mode is the hourly keeper state; the allocation stack is the '
        "same hour in dollars.</p>"
        + mode_strip(points)
        + '<div style="margin-top:14px">'
        + allocation_chart
        + "</div>"
        + '<p class="chart-note">Books are marked at pool value; arm equity is collateral '
        "minus debt; idle is uninvested USDG plus NVDA. Stack height should track NAV.</p>"
        + "</div>"
        + '<div class="grid-2" style="margin-top:16px">'
        + chart_card(
            "Maximum drawdown - 45d and 20d",
            "Including HODL",
            dd_compare_chart,
            "The 45d cut flatters the strategy; the 20d cut does not. HODL is the dashed "
            "line in the charts above and the first pair of bars here.",
        )
        + how_we_leave
        + "</div>"
        + callout
    )
    return block(
        "07",
        "protection",
        "Drawdown, exits, and capital protection",
        "A protection claim needs a path, not just a final NAV. The guard is designed as the "
        "first line and the allocator recall as the second; in this tape the recall did the "
        "work, and the 20-day window is the stress case.",
        body,
    )


# ---------------------------------------------------------------------------
# 8. Takeaways
# ---------------------------------------------------------------------------


def section_takeaways(ctx: dict[str, Any]) -> str:
    focus = "risk_only_a_2h15k_guard75"
    pools = eth_compare_rows()
    v430 = next(
        (item for item in pools if item.get("book") == "USDG/NVDA V4 0.30%"),
        None,
    )
    eth_best = max(
        (item for item in pools if item.get("quote") == "WETH"),
        key=lambda item: base.fld(item, "net_apr_pct", -1e9) or -1e9,
    )
    bullets = [
        (
            "Pool returns",
            f"Fee APR is not return. The best USDG net APR is "
            f"{pp(base.fld(v430, 'net_apr_pct'), 1)} "
            f"({base.esc(v430.get('book', ''))}: {pp(base.fld(v430, 'fee_apr_pct'), 1)} "
            f"fees minus {pp(abs(base.fld(v430, 'il_apr_pct') or 0.0), 1)} IL), but total "
            f"APR is {pp(base.fld(v430, 'total_apr_pct'), 1)} in a falling tape. The ETH "
            f"book's {pp(base.fld(eth_best, 'net_apr_pct'), 1)} net is in WETH.",
        ),
        (
            "Morpho and the arm",
            f"Arm carry is {usd(arm_carry(ctx, 'risk_only_a'), 2)} in risk-only A and "
            f"{usd(arm_carry(ctx, 'always_arms'), 2)} in always-arms over 45 days: a safe "
            "harbor, not the engine. The 107.29% borrow stress is a liquidity and exit "
            "trap, not free yield.",
        ),
        (
            "Strategy cases",
            f"A 2h/15k/75 nets {usd(net(ctx, focus, '45d'), 2, signed=True)} / "
            f"{usd(net(ctx, focus, '20d'), 2, signed=True)}. The base risk-only A nets "
            f"{usd(net(ctx, 'risk_only_a', '45d'), 2, signed=True)} / "
            f"{usd(net(ctx, 'risk_only_a', '20d'), 2, signed=True)}; the $15k floor flips "
            "the 20-day cut.",
        ),
        (
            "IL",
            f"A $10,000 position in a ±5% range carries "
            f"{usd(il_loss(500, -20), 2, signed=True)} of IL at a 20% fall and "
            f"{usd(il_loss(500, 20), 2, signed=True)} at a 20% rise versus holding. Wider "
            "ranges carry less; narrower ranges earn more fees and lose more to IL.",
        ),
        (
            "Protection",
            "The guard is designed as the first line, the recall as the second; in this tape "
            "the recall did the work. The 45d drawdown is "
            f"{pf(drawdown(ctx, 'risk_only_a', '45d'), 2)} versus HODL "
            f"{pf(drawdown(ctx, 'hodl', '45d'), 2)}, but the 20d cut is "
            f"{pf(drawdown(ctx, 'risk_only_a', '20d'), 2)} versus "
            f"{pf(drawdown(ctx, 'hodl', '20d'), 2)}: protection is conditional.",
        ),
    ]
    items = "".join(
        f"<li><b>{base.esc(title)}.</b> {text}</li>" for title, text in bullets
    )
    body = (
        '<div class="card"><ul class="clean">'
        + items
        + "</ul></div>"
        + '<div class="future-note">'
        + '<div class="fn-title">Not in this tape</div>'
        + "<p>A 45-minute keeper, no volume floor, a 24-hour recall, and a low-fee exit "
        "variant are not in this tape. Re-run the model on fresh tape before sizing any "
        "of them. The numbers here are decision support from one down regime, not a "
        "track record.</p>"
        + "</div>"
    )
    return block(
        "08",
        "takeaways",
        "Takeaways",
        "Five things to carry into the next review, with the caveat attached.",
        body,
    )


# ---------------------------------------------------------------------------
# 9. Caveats
# ---------------------------------------------------------------------------


def section_caveats(ctx: dict[str, Any]) -> str:
    hodl45 = row(ctx, "hodl", "45d")
    hodl20 = row(ctx, "hodl", "20d")
    hodl_move45 = (base.fld(hodl45, "final_hodl") or 0.0) / (base.fld(hodl45, "initial_nav") or 1.0) - 1.0
    hodl_move20 = (base.fld(hodl20, "final_hodl") or 0.0) / (base.fld(hodl20, "initial_nav") or 1.0) - 1.0
    actions = base.fld(row(ctx, "risk_only_a", "45d"), "actions") or 0.0
    caveats = [
        (
            "45-day down regime",
            f"NVDA fell over both windows; the HODL basket fell {pf(abs(hodl_move45), 2)} "
            f"over 45d and {pf(abs(hodl_move20), 2)} over 20d. A rally would reorder the "
            "pool, arm and guard results.",
        ),
        (
            "Book A is a V3 0.05% proxy",
            "No V4 USDG/NVDA 0.05% pool was available. Book A fees use the V3 pool as a "
            "fee-equivalent proxy; the model-to-research fee match is +0.19%.",
        ),
        (
            "Guard pull is a proxy",
            "200 bps on five-minute moves, not a live auction or a Chainlink depeg. Guard "
            "75 is a 75% fee share, not a width.",
        ),
        (
            "Arm rates are scenarios",
            "3% USDG, 3% NVDA and 3% borrow are flat assumptions. The live and stress "
            "cases bracket observed USDG lending and borrow tails; they are not a rate "
            "history.",
        ),
        (
            "3% NVDA is a Spiral assumption",
            "It is APR after borrowing cost, not a native Morpho collateral yield. The "
            "model grosses it up by LTV times borrow APR and subtracts borrow; the net "
            "NVDA contribution is 3% of collateral.",
        ),
        (
            "Gas is $0.02 per action",
            f"{base.integer(actions)} actions cost about {usd(actions * 0.02, 2)}. A "
            "congested chain or a larger action count changes the small-alpha runs.",
        ),
        (
            "No MEV or price impact",
            "Fills are at the tape price. Book B depth and swap routing are not simulated; "
            "both would reduce net.",
        ),
        (
            "In-sample, not a forecast",
            "One tape, two overlapping windows. No out-of-sample validation and no "
            "bootstrap on this page; the old dashboard's bootstrap p05 was negative for "
            "the focus run.",
        ),
        (
            "ETH quote is separate",
            "ETH/NVDA totals are in WETH. There is no ETH/USD tape here, so they cannot be "
            "added to the USDG totals.",
        ),
    ]
    cards = "".join(
        f'<div class="caveat"><b>{base.esc(title)}</b><span>{text}</span></div>'
        for title, text in caveats
    )
    body = (
        f'<div class="caveat-grid">{cards}</div>'
        + base.callout(
            "<b>Headline honesty.</b> The focus case is "
            f"{usd(net(ctx, 'risk_only_a_2h15k_guard75', '45d'), 2, signed=True)} over 45 "
            f"days and {usd(net(ctx, 'risk_only_a_2h15k_guard75', '20d'), 2, signed=True)} "
            "over 20. The second number is the one to defend: the edge is small, the "
            "20-day base case is negative, and none of this is out-of-sample.",
        )
    )
    return block(
        "09",
        "caveats",
        "Caveats",
        "Read these before quoting any number on this page.",
        body,
    )


# ---------------------------------------------------------------------------
# Assembly and checks
# ---------------------------------------------------------------------------


def build_html(ctx: dict[str, Any]) -> str:
    sections = [
        section_hero(ctx),
        section_pools(ctx),
        section_morpho(ctx),
        section_cases(ctx),
        section_variation(ctx),
        section_il(ctx),
        section_protection(ctx),
        section_takeaways(ctx),
        section_caveats(ctx),
    ]
    nav_items = [
        ("pools", "Pools"),
        ("morpho", "Morpho & arms"),
        ("cases", "Cases"),
        ("variation", "Variations"),
        ("il", "IL"),
        ("protection", "Protection"),
        ("takeaways", "Takeaways"),
    ]
    nav_links = "".join(
        f'<a href="#{anchor}">{base.esc(label)}</a>' for anchor, label in nav_items
    )
    path_points = len(load_focus_path())
    pool_count = len(eth_compare_rows())

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pool returns, IL, and capital protection - NVDA allocator study</title>
<style>{CSS}</style>
</head>
<body>
<nav class="topnav" aria-label="Section navigation">
  <div class="nav-inner">
    <a class="nav-brand" href="#study">Pool returns - IL - protection</a>
    {nav_links}
  </div>
</nav>
<main class="wrap">
{''.join(sections)}
<div class="footer">
  Generated from existing <code>out/</code> artifacts: {pool_count} pool rows from
  <code>eth_compare.csv</code>, baseline rows from <code>baseline_summary.csv</code>
  (<code>risk_only_a</code>, <code>risk_only_a_vol15k</code> and the variation runs), and
  {path_points:,} hourly points from <code>baseline_paths.csv</code> for
  <code>risk_only_a</code>.
  Static IL uses <code>lp.py</code> at NVDA $225.80 and $10,000 capital. No model rerun.
  Tape: 36-minute risk window, $15k floor, 200 bps five-minute pull proxy; 45d = 1,080
  hours, 20d = 480 hours. Built by <code>build_pool_il_study.py</code>.
</div>
</main>
</body>
</html>
"""


BAD_VALUE_RE = re.compile(r"\b(?:None|NaN|nan|undefined)\b")
REQUIRED_SECTIONS = (
    "study",
    "pools",
    "morpho",
    "cases",
    "variation",
    "il",
    "protection",
    "takeaways",
    "caveats",
)
REQUIRED_TOKENS = ("+$431.36", "+$314.17", "+$28.26")
REQUIRED_EVENT_TOKENS = (
    "Guard hits and book changes",
    "24 raw",
    "20 model",
    "no pull",
    "risk_only_a_guard50",
    "Guard stress 50 bps",
    "Recall to arms",
    "Fund the book",
)


def il_sanity_problems() -> list[str]:
    """Static IL must be zero at entry and worse for narrower ranges."""
    problems: list[str] = []
    widths = [half_width for half_width, _ in RANGES]
    for half_width, label in RANGES:
        if abs(il_loss(half_width, 0)) > 1e-9:
            problems.append(f"{label} range IL is not zero at a 0% move")
        for move in (-20, -10, 10, 20):
            if il_loss(half_width, move) >= 0:
                problems.append(f"{label} range IL is not negative at {move:+d}%")
    for move in (-20, -10, 10, 20):
        losses = [il_loss(width, move) for width in widths]
        for narrow, wide in zip(losses, losses[1:]):
            if not narrow < wide:
                problems.append(f"narrower range is not worse at {move:+d}%")
    return problems


def verify(document: str) -> list[str]:
    problems: list[str] = []
    for anchor in REQUIRED_SECTIONS:
        if f'id="{anchor}"' not in document:
            problems.append(f"missing section #{anchor}")
    if 'class="na"' in document:
        problems.append('document contains class="na"')
    if "not available" in document.lower():
        problems.append('document contains "not available"')
    bad = sorted(set(BAD_VALUE_RE.findall(document)))
    if bad:
        problems.append(f"document contains placeholder values: {', '.join(bad)}")
    if "\\$" in document:
        problems.append("document contains an escaped dollar sign")
    if "+0%" in document:
        problems.append('document contains "+0%"')
    if "-$0.00" in document:
        problems.append('document contains "-$0.00"')
    if document.count("<svg") < 12:
        problems.append("fewer than 12 inline charts")
    if "mode-strip" not in document or "mode-seg" not in document:
        problems.append("mode strip missing")
    if "Static IL in USD" not in document:
        problems.append("IL curve missing")
    for token in REQUIRED_TOKENS:
        if token not in document:
            problems.append(f"missing required token {token}")
    for token in REQUIRED_EVENT_TOKENS:
        if token not in document:
            problems.append(f"missing protection-event token {token}")
    for anchor in ("risk_only_a", "risk_only_a_vol15k"):
        if f"<code>{anchor}</code>" not in document:
            problems.append(f"footer source line does not cite {anchor}")
    if "BOOKS" not in document or "ARMS" not in document:
        problems.append("mode legend missing BOOKS/ARMS")
    if len(document.encode("utf-8")) < 30_000:
        problems.append("document is smaller than 30 KB")
    problems.extend(il_sanity_problems())
    return problems


def print_il_table() -> None:
    labels = [label for _, label in RANGES]
    print("IL sanity (USD on $10,000 at NVDA $225.80):")
    print(f"  {'move':>5} " + " ".join(f"{label:>11}" for label in labels))
    for move in TABLE_MOVES:
        cells = " ".join(f"{il_loss(width, move):>11,.2f}" for width, _ in RANGES)
        print(f"  {move:>4}% {cells}")


def main() -> None:
    ctx = base.load_data()
    document = build_html(ctx)
    OUT.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(document, encoding="utf-8")
    problems = verify(document)
    size_kb = TARGET.stat().st_size / 1024
    section_ids = re.findall(r'<section id="([^"]+)"', document)
    print(f"wrote {TARGET} ({size_kb:.1f} KB)")
    print(f"sections ({len(section_ids)}): {', '.join(section_ids)}")
    print(f"charts: {document.count('<svg')} inline SVG")
    print_il_table()
    if problems:
        for problem in problems:
            print(f"CHECK FAILED: {problem}")
        raise SystemExit(1)
    print("checks: ok")


if __name__ == "__main__":
    main()
