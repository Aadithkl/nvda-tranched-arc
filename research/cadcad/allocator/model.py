"""cadCAD model of the NVDA tranched-vault allocator.

Books
  Book A = V4 0.05% (fee-equivalent V3 0.05% tape in the scenario)
  Book B = V4 0.30%

Arms
  Morpho USDG lend arm + Spiral/NVDA collateral arm, with a hard stock LTV
  below 30% and the keeper's one-action-per-hour move semantics.

The model is deliberately a port of scripts/keeper/allocator.mjs and index.mjs,
not a parallel design. The only behavioural switch is
``fix_empty_book_guard``: when False the keeper's literal safe-harbor trigger is
used (an empty book with no guard is HIGH risk); when True the guard-absent
trigger only fires while the book actually has positions. The as-built keeper
has a one-way door into the arms; the fixed variant is the recommended patch.
"""

from __future__ import annotations

import copy
import math
from typing import Any

import pandas as pd
from cadCAD.configuration import Experiment
from cadCAD.configuration.utils import config_sim
from cadCAD.engine import ExecutionContext, ExecutionMode, Executor

from allocator import (
    assess_book_risk,
    borrow_size,
    decide_pool_switch,
    plan_arm_entry,
    plan_book_return,
)
from lp import (
    il_bps_for_ticks,
    js_round,
    liquidity_for_value,
    position_value_usd,
    price_from_tick,
    range_from_half_width,
    token_amounts,
)

HOURS_PER_YEAR = 365 * 24
RISK_WINDOW_HOURS = 36.0 / 60.0
ANN_RISK = HOURS_PER_YEAR / RISK_WINDOW_HOURS
DUST_USD = 1.0
DUST_NVDA = 0.001


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

def default_params() -> dict[str, Any]:
    return {
        "policy": "allocator",
        "fee_a": 500,
        "fee_b": 3_000,
        "initial_nav_usd": 10_000.0,
        "book_capital_usd": 10_000.0,
        "guard_share": 0.5,
        "base_width_ticks": 6_000,
        "guard_width_ticks": 600,
        "range_half_width_bps": 1_000,
        "ltv_bps": 2_937,
        "max_ltv_bps": 6_250,
        "hard_cap_bps": 3_000,
        "morpho_share_bps": 8_000,
        "nvda_step_bps": 1_000,
        "book_step_bps": 2_500,
        "switch_buffer_bps": 500,
        "max_guard_pulls": 2,
        "guard_pull_threshold_bps": 200,
        "guard_cooldown_hours": 0,
        "guard_rearm_delay_hours": 1,
        "risk_max_volatility_bps": 300,
        "risk_min_volume_usd": 10_000,
        "risk_min_fee_apr_bps": 0,
        "min_pool_liquidity_usd": 10_000,
        "arm_usdg_apr": 0.03,
        "arm_nvda_apr": 0.03,
        "arm_borrow_apr": 0.03,
        # If True, arm_nvda_apr is the NET yield after borrowing cost (APR).
        # The model grosses it up by LTV*borrow_apr, then subtracts borrow cost.
        "nvda_apr_is_net": False,
        "arm_abs_cap_usd": 10_000.0,
        "arm_rel_cap_bps": 2_000,
        "usdg_lend_abs_cap_usd": 10_000.0,
        "usdg_lend_rel_cap_bps": 2_000,
        "borrow_liquidity_usd": 15_000.0,
        "max_borrow_per_call_usd": 10_000.0,
        "lltv": 0.625,
        "min_health_factor": 1.5,
        "sentinel_enabled": True,
        "gas_cost_usd": 0.02,
        "switch_cost_bps": 0.0,
        # Funding the book from recalled inventory. "scale" is the current
        # keeper behaviour: use what both sides allow and leave the excess idle.
        # "swap" fills the deficit at swap_cost_bps so the book is fully funded.
        "funding_mode": "scale",
        "swap_cost_bps": 0.0,
        # Inventory-aware base range. "inventory" shifts the base centre so the
        # token ratio matches the recalled inventory and more capital can be
        # re-deployed without a swap. The guard stays centred on the market.
        "base_skew_mode": "none",
        "base_skew_max_ticks": 0,
        # Re-centre the whole book when price has moved this far from entry.
        "recenter_threshold_bps": 0,
        "recenter_gas_multiplier": 2.0,
        # Fee-vs-IL gate. net APR used for switching = fee - hurdle * |IL|.
        # risk_fee_il uses the same gate to decide whether to hold the book.
        "fee_il_hurdle": 1.0,
        "fee_il_window_hours": 0,
        "fee_il_buffer_bps": 500,
        "fee_il_confirm_hours": 1,
        # Guard/re-arm rule. "move" is the 5-minute proxy. "fee_il" pulls the
        # guard when the rolling fee APR no longer covers hurdle * IL APR.
        "guard_rule": "move",
        "guard_fee_il_hurdle": 1.0,
        "rearm_gate": False,
        # Fee-share model. "exact" is required for large books (>= ~$250k):
        # fee = rate * volume * L/(poolL+L), instead of the second-order
        # expansion. The expansion is accurate only while L/poolL is small.
        "fee_share_mode": "expansion",
        # No-swap inventory policy: keep a reserve of both tokens for the next
        # 50/50 guard re-add, sweep the excess NVDA into the Spiral arm, borrow
        # against it, and lend the excess USDG. One action per allocator run.
        "surplus_sweep": False,
        "inventory_reserve_usd": 1_000.0,
        "inventory_reserve_pct": 0.10,
        "surplus_nvda_min_usd": 250.0,
        "surplus_usdg_min_usd": 250.0,
        "surplus_borrow": True,
        "fund_book_bps": 9_000,
        "liquidation_bonus_bps": 500,
        "max_borrow_apr_bps": 3_000,
        "delever_bps": 1_000,
        "risk_window_minutes": 36,
        # If true, risk stats are recomputed from the rolling minute window
        # instead of the scenario's 36m risk row. Default false preserves the
        # keeper-matching results.
        "risk_use_rolling": False,
        "risk_window_scale_floor": True,
        "risk_window_scale_vol": True,
        # Opportunity / risk-up clock. 0 = use the existing 36m net-APR scan.
        "opportunity_window_hours": 0,
        "opportunity_check_hours": 1,
        "opportunity_buffer_bps": 500,
        "opportunity_min_net_apr_bps": 0,
        "book_b_min_volume_window_usd": 0.0,
        "book_b_volume_window_hours": 3,
        "book_b_max_share": 1.0,
        "allocator_interval_hours": 1,
        "warmup_hours": 0,
        "start_book": 0,
        "depeg_mode": "off",
        "depeg_start": 0,
        "depeg_hours": 0,
        "controller_paused": False,
        "switch_frozen": False,
        "fix_empty_book_guard": False,
        "fix_hypothetical_range": False,
        "scenario": [],
    }


# ---------------------------------------------------------------------------
# Book / portfolio accounting
# ---------------------------------------------------------------------------

def book_has_positions(book: dict[str, Any]) -> bool:
    return bool(book.get("deployed")) and (
        book.get("base_L", 0.0) > 0 or (book.get("guard_present") and book.get("guard_L", 0.0) > 0)
    )


def book_value(book: dict[str, Any], sqrt_p: float) -> float:
    if not book.get("deployed"):
        return float(book.get("fees", 0.0))
    value = float(book.get("fees", 0.0))
    if book.get("base_L", 0.0) > 0:
        value += position_value_usd(
            book["base_L"], sqrt_p, book["base_lo"], book["base_hi"]
        )
    if book.get("guard_present") and book.get("guard_L", 0.0) > 0:
        value += position_value_usd(
            book["guard_L"], sqrt_p, book["guard_lo"], book["guard_hi"]
        )
    return value


def book_tokens(book: dict[str, Any], sqrt_p: float) -> tuple[float, float]:
    if not book.get("deployed"):
        return 0.0, 0.0
    usdg = 0.0
    nvda = 0.0
    if book.get("base_L", 0.0) > 0:
        x, y = token_amounts(book["base_L"], sqrt_p, book["base_lo"], book["base_hi"])
        usdg += x
        nvda += y
    if book.get("guard_present") and book.get("guard_L", 0.0) > 0:
        x, y = token_amounts(book["guard_L"], sqrt_p, book["guard_lo"], book["guard_hi"])
        usdg += x
        nvda += y
    return usdg, nvda


def book_active_l(book: dict[str, Any], tick: int) -> float:
    if not book.get("deployed"):
        return 0.0
    active = 0.0
    if book.get("base_L", 0.0) > 0 and book["base_lo"] <= tick < book["base_hi"]:
        active += book["base_L"]
    if (
        book.get("guard_present")
        and book.get("guard_L", 0.0) > 0
        and book["guard_lo"] <= tick < book["guard_hi"]
    ):
        active += book["guard_L"]
    return active


def _slice_minutes(minutes: dict[str, list], start: int, end: int) -> dict[str, list]:
    return {k: list(v[start:end]) for k, v in minutes.items()}


def _rolling_minutes(
    scenario: list[dict[str, Any]],
    step: int,
    window_minutes: int,
    book_key: str,
) -> dict[str, list]:
    """Last N minutes from the scenario, across hour boundaries."""
    window = max(1, min(1_440, int(window_minutes)))
    rows_needed = (window + 59) // 60
    start = max(0, int(step) - rows_needed + 1)
    end = min(int(step), len(scenario) - 1)
    chunks: dict[str, list] = {"tick": [], "volume": [], "volOverL": [], "volOverL2": []}
    for j in range(start, end + 1):
        mins = scenario[j][book_key]["minutes"]
        for key in chunks:
            chunks[key].extend(list(mins.get(key, [])))
    return {k: v[-window:] for k, v in chunks.items()}


def _window_stats(minutes: dict[str, list]) -> tuple[float, float, int, int]:
    """Volume and tick-range volatility (bps approx) for a minute window."""
    ticks = [int(t) for t in minutes.get("tick", []) if t is not None]
    volume = float(sum(float(v) for v in minutes.get("volume", [])))
    if not ticks:
        return volume, 0.0, 0, 0
    tick_first, tick_last = ticks[0], ticks[-1]
    volatility = float(max(ticks) - min(ticks))
    return volume, volatility, tick_first, tick_last


def book_fee_parts(
    book: dict[str, Any],
    minutes: dict[str, list],
    fee_pips: float,
    fee_share_mode: str = "expansion",
) -> tuple[float, float, float]:
    """Fee revenue for one book, split into (total, guard, base).

    Default: second-order share expansion
        L/(poolL+L) ~= L/poolL - (L/poolL)^2
    on minute-level sum(volume/poolL) and sum(volume/poolL^2). At large book
    sizes use ``fee_share_mode="exact"``:
        fee = rate * volume * L/(poolL+L),  poolL = volume/volOverL
    which caps the book at the pool's fee revenue instead of understating it.
    """
    if not book_has_positions(book):
        return 0.0, 0.0, 0.0
    tick = minutes.get("tick", [])
    if not tick:
        return 0.0, 0.0, 0.0

    base_l = float(book.get("base_L", 0.0))
    guard_l = float(book.get("guard_L", 0.0)) if book.get("guard_present") else 0.0
    both_l = base_l + guard_l
    v1_both = v2_both = 0.0
    v1_base_only = v2_base_only = 0.0
    v1_guard_only = v2_guard_only = 0.0
    rate = float(fee_pips) / 1e6
    volumes = minutes.get("volume", [])
    exact_ok = fee_share_mode == "exact" and len(volumes) >= len(tick)
    exact_both = exact_guard_only = exact_base_only = 0.0

    for i, t in enumerate(tick):
        if t is None:
            continue
        v1 = float(minutes.get("volOverL", [])[i])
        v2 = float(minutes.get("volOverL2", [])[i])
        base_in = base_l > 0 and book["base_lo"] <= t < book["base_hi"]
        guard_in = guard_l > 0 and book["guard_lo"] <= t < book["guard_hi"]
        if guard_in and base_in:
            v1_both += v1
            v2_both += v2
        elif guard_in:
            # The guard can be re-centred outside a stale base range.
            v1_guard_only += v1
            v2_guard_only += v2
        elif base_in:
            v1_base_only += v1
            v2_base_only += v2

        if exact_ok:
            vol = float(volumes[i])
            if vol > 0 and v1 > 0:
                pool_l = vol / v1
                if guard_in and base_in and both_l > 0:
                    exact_both += rate * vol * both_l / (pool_l + both_l)
                elif guard_in and guard_l > 0:
                    exact_guard_only += rate * vol * guard_l / (pool_l + guard_l)
                elif base_in and base_l > 0:
                    exact_base_only += rate * vol * base_l / (pool_l + base_l)

    if exact_ok:
        total = exact_both + exact_guard_only + exact_base_only
        return max(0.0, total), max(0.0, exact_both), max(0.0, exact_base_only)

    both_fee = rate * (both_l * v1_both - both_l * both_l * v2_both)
    guard_only_fee = rate * (guard_l * v1_guard_only - guard_l * guard_l * v2_guard_only)
    base_only_fee = rate * (base_l * v1_base_only - base_l * base_l * v2_base_only)
    total = both_fee + guard_only_fee + base_only_fee
    return max(0.0, total), max(0.0, both_fee), max(0.0, base_only_fee)


def book_fee_for_hour(
    book: dict[str, Any],
    minutes: dict[str, list],
    fee_pips: float,
    first_pull_bin: int | None = None,
    fee_share_mode: str = "expansion",
) -> tuple[float, float, float]:
    """Hourly fees, splitting the both-in component and prorating the guard.

    ``book_fee_parts`` returns the total, the both-in-range component and the
    base-only component. The guard-only component is the remainder. When a pull
    happens in ``first_pull_bin``, the guard's both-in share is prorated to the
    fraction of the hour before that bin; the base's both-in share is not.
    """
    total, both_fee, base_only_fee = book_fee_parts(
        book, minutes, fee_pips, fee_share_mode
    )
    if not book_has_positions(book):
        return 0.0, 0.0, 0.0
    base_l = float(book.get("base_L", 0.0))
    guard_l = float(book.get("guard_L", 0.0)) if book.get("guard_present") else 0.0
    both_l = base_l + guard_l
    if both_l <= 0:
        return total, 0.0, total
    guard_share = both_fee * guard_l / both_l
    base_share = both_fee * base_l / both_l
    guard_only = max(0.0, total - both_fee - base_only_fee)
    if first_pull_bin is not None:
        fraction = max(0.0, min(1.0, float(first_pull_bin) / 12.0))
        guard_fee = guard_only + guard_share * fraction
    else:
        guard_fee = guard_only + guard_share
    base_fee = base_only_fee + base_share
    return guard_fee + base_fee, guard_fee, base_fee


def portfolio_nav(pf: dict[str, Any], sqrt_p: float, price: float) -> float:
    nav = float(pf["idle_usdg"]) + float(pf["idle_nvda"]) * price
    for book in pf["books"]:
        nav += book_value(book, sqrt_p)
    arm = pf["arm"]
    nav += (
        float(arm["nvda"]) * price
        + float(arm["usdg_lent"])
        - float(arm["debt"])
        - float(arm.get("bad_debt", 0.0))
    )
    return nav


def _mode(pf: dict[str, Any]) -> str:
    arm = pf["arm"]
    return (
        "ARMS"
        if (
            arm["nvda"] > 0
            or arm["debt"] > 0
            or arm["usdg_lent"] > 0
            or arm.get("bad_debt", 0.0) > 0
        )
        else "BOOKS"
    )


def _arm_caps(pf: dict[str, Any], params: dict[str, Any], sqrt_p: float, price: float) -> tuple[float, float]:
    nav = portfolio_nav(pf, sqrt_p, price)
    collateral_cap = min(
        float(params["arm_abs_cap_usd"]),
        float(params["arm_rel_cap_bps"]) * nav / 10_000.0,
    )
    lend_cap = min(
        float(params["usdg_lend_abs_cap_usd"]),
        float(params["usdg_lend_rel_cap_bps"]) * nav / 10_000.0,
    )
    return max(0.0, collateral_cap), max(0.0, lend_cap)


def first_guard_pull_bin(moves: list[int], threshold_bps: float) -> int | None:
    """First 5-minute bin above the pull proxy, or None."""
    for i, move in enumerate(moves):
        if float(move) > float(threshold_bps):
            return i
    return None


def count_guard_pulls(moves: list[int], threshold_bps: float) -> int:
    """Pull events in the hour, not triggering bins.

    The hook emits one GuardPulled event per pull. The model can pull at most
    once per hour (the re-arm is next hour), so this is 0 or 1. The 5-minute
    bins remain available for the fee-timing calculation.
    """
    return 1 if first_guard_pull_bin(moves, threshold_bps) is not None else 0


def _depeg_flag(params: dict[str, Any], step: int, row: dict[str, Any]) -> int:
    mode = str(params.get("depeg_mode", "off"))
    if mode == "proxy":
        return int(row.get("bookA", {}).get("depegProxy", 0))
    if mode == "shock":
        start = int(params.get("depeg_start", 0))
        hours = int(params.get("depeg_hours", 0))
        return 1 if start <= step < start + hours else 0
    return 0


# ---------------------------------------------------------------------------
# Initial state
# ---------------------------------------------------------------------------

def _book_template(
    tick: int,
    sqrt_p: float,
    base_capital: float,
    guard_capital: float,
    params: dict[str, Any],
) -> dict[str, Any]:
    base_lo = tick - int(params["base_width_ticks"])
    base_hi = tick + int(params["base_width_ticks"])
    guard_lo = tick - int(params["guard_width_ticks"])
    guard_hi = tick + int(params["guard_width_ticks"])
    base_l = liquidity_for_value(base_capital, sqrt_p, base_lo, base_hi)
    guard_l = liquidity_for_value(guard_capital, sqrt_p, guard_lo, guard_hi)
    return {
        "deployed": False,
        "base_L": 0.0,
        "guard_L": 0.0,
        "base_lo": base_lo,
        "base_hi": base_hi,
        "guard_lo": guard_lo,
        "guard_hi": guard_hi,
        "entry_tick": tick,
        "fees": 0.0,
        "guard_present": False,
        "last_pull_step": -1,
        "target_base_L": base_l,
        "target_guard_L": guard_l,
        "cum_fees": 0.0,
    }


def build_initial_state(scenario: list[dict[str, Any]], params: dict[str, Any]) -> dict[str, Any]:
    if not scenario:
        raise ValueError("scenario is empty")
    row = scenario[0]
    tick = int(row["tick"])
    sqrt_p = float(row["sqrtP"])
    # Use one mark convention everywhere: the integer tick. The scenario quote
    # is the fractional-tick sqrt price rounded to 6 dp; mixing the two leaks
    # value on every recall/fund.
    price = price_from_tick(tick)

    initial_nav = float(params["initial_nav_usd"])
    book_capital = min(float(params["book_capital_usd"]), initial_nav)
    guard_share = float(params["guard_share"])
    template = _book_template(
        tick,
        sqrt_p,
        book_capital * (1.0 - guard_share),
        book_capital * guard_share,
        params,
    )
    books = [copy.deepcopy(template), copy.deepcopy(template)]
    policy = str(params.get("policy", "allocator"))
    active_book = 1 if policy == "always_b" else int(params.get("start_book", 0))
    active_book = 1 if active_book == 1 else 0

    initial_idle_usd = max(0.0, initial_nav - book_capital)
    idle_usdg = initial_idle_usd
    idle_nvda = 0.0
    arm = {"nvda": 0.0, "debt": 0.0, "usdg_lent": 0.0, "bad_debt": 0.0}

    # HODL tokens: the LP tokens at t0 plus any un-deployed quote.
    hold_book = copy.deepcopy(template)
    hold_book["deployed"] = True
    hold_book["base_L"] = hold_book["target_base_L"]
    hold_book["guard_L"] = hold_book["target_guard_L"]
    hold_book["guard_present"] = True
    hold_usdg, hold_nvda = book_tokens(hold_book, sqrt_p)
    hold_usdg += initial_idle_usd

    if policy == "hodl":
        # Start already in the HODL basket.
        idle_usdg = hold_usdg
        idle_nvda = hold_nvda
    elif policy == "always_arms":
        # Start with the book recalled and the tokens idle; the policy allocates
        # to the arms over the next ticks (one action per tick).
        idle_usdg = hold_usdg
        idle_nvda = hold_nvda
        book_capital = 0.0
    else:
        book = books[active_book]
        book["deployed"] = True
        book["base_L"] = book["target_base_L"]
        book["guard_L"] = book["target_guard_L"]
        book["guard_present"] = True
        book["entry_tick"] = tick

    pf = {
        "active_book": active_book,
        "books": books,
        "idle_usdg": idle_usdg,
        "idle_nvda": idle_nvda,
        "arm": arm,
        "mode": "ARMS" if policy == "always_arms" else "BOOKS",
        "last_action": "INIT",
        "last_reason": "initial state",
        "last_events": [],
        "last_costs": 0.0,
        "nav_before": initial_nav,
        "nav_after": initial_nav,
        "hodl": {"usdg": hold_usdg, "nvda": hold_nvda},
        "cum": {
            "fees": 0.0,
            "guard_fees": 0.0,
            "arm_interest": 0.0,
            "borrow_cost": 0.0,
            "nvda_yield": 0.0,
            "gas": 0.0,
            "switch_cost": 0.0,
            "swap_cost": 0.0,
            "liquidation_loss": 0.0,
            "guard_pulls": 0.0,
            "actions": 0.0,
        },
    }

    env = dict(row)
    env["price"] = price
    env["depeg_paused"] = _depeg_flag(params, 0, row)
    env["controller_paused"] = bool(params.get("controller_paused", False))
    env["switch_frozen"] = bool(params.get("switch_frozen", False))

    return {
        "step": 0,
        "env": env,
        "portfolio": pf,
        "book_metrics": [],
        "decision": {"action": "INIT", "reason": "initial state"},
        "nav": initial_nav,
        "hodl_nav": initial_nav,
        "peak_nav": initial_nav,
        "metrics": {},
        "last_events": [],
        "event_count": 0,
    }


# ---------------------------------------------------------------------------
# Policies
# ---------------------------------------------------------------------------

def p_market(params, substep, sH, s, additional_objs=None, **kwargs):
    step = int(s["step"])
    scenario = params["scenario"]
    row = scenario[min(step, len(scenario) - 1)]
    env = dict(row)
    env["price"] = price_from_tick(int(env["tick"]))
    env["depeg_paused"] = _depeg_flag(params, step, row)
    env["controller_paused"] = bool(params.get("controller_paused", False))
    env["switch_frozen"] = bool(params.get("switch_frozen", False))
    return {"env": env}


def s_env(params, substep, sH, s, _input, **kwargs):
    return "env", _input["env"]


def _candidate(
    book: dict[str, Any],
    name: str,
    active: bool,
    row: dict[str, Any],
    env: dict[str, Any],
    nav_total: float,
    hypo_capital: float,
    params: dict[str, Any],
    step: int = 0,
) -> dict[str, Any]:
    fee_pips = float(params["fee_a"] if name == "bookA" else params["fee_b"])
    book_key = "bookA" if name == "bookA" else "bookB"
    sqrt_p = float(env["sqrtP"])
    tick = int(env["tick"])
    has_positions = book_has_positions(book)
    actual_value = book_value(book, sqrt_p)
    risk_row = row["risk"]
    risk_window = max(1, int(params.get("risk_window_minutes", 36)))
    risk_use_rolling = bool(params.get("risk_use_rolling", False))
    scenario = params.get("scenario", [])
    if risk_use_rolling and scenario:
        minutes_window = _rolling_minutes(scenario, step, risk_window, book_key)
        volume_window, volatility_window, tick_first, tick_last = _window_stats(minutes_window)
    else:
        risk_minutes = max(1, min(60, risk_window))
        minutes_window = _slice_minutes(row["minutes"], 60 - risk_minutes, 60)
        volume_window = float(risk_row["volumeUsd"])
        volatility_window = float(risk_row["volatilityBps"])
        tick_first = int(risk_row["tickFirst"])
        tick_last = int(risk_row["tickLast"])
    ann_risk = HOURS_PER_YEAR / (risk_window / 60.0)
    vol_scale = (
        math.sqrt(risk_window / 36.0)
        if risk_use_rolling and params.get("risk_window_scale_vol", True)
        else 1.0
    )
    floor_scale = (
        risk_window / 36.0
        if risk_use_rolling and params.get("risk_window_scale_floor", True)
        else 1.0
    )

    if has_positions:
        book_value_usd = max(actual_value, 1e-9)
        fee_window, _, _ = book_fee_parts(
            book, minutes_window, fee_pips, params.get("fee_share_mode", "expansion")
        )
        fee_apr_bps = js_round(fee_window * ann_risk / book_value_usd * 10_000)
        if book.get("base_L", 0.0) > 0:
            il_lo, il_hi = book["base_lo"], book["base_hi"]
        else:
            il_lo, il_hi = book["guard_lo"], book["guard_hi"]
        il_bps = il_bps_for_ticks(tick_first, tick_last, il_lo, il_hi)
        active_l = book_active_l(book, tick)
        pool_l = float(row.get("poolLMean") or row.get("poolLLast") or 0.0)
        share = active_l / (pool_l + active_l) if active_l > 0 and pool_l >= 0 else 0.0
        deployed = True
        guard_present = bool(book.get("guard_present"))
    elif params.get("fix_hypothetical_range"):
        # Use the actual target sleeve and the real base/guard widths for the
        # empty-book scan. The literal keeper uses a +/-10% hypothetical range
        # and the full NAV, which annualizes a much larger IL and makes the
        # empty book look permanently uninvestable.
        base_lo = tick - int(params["base_width_ticks"])
        base_hi = tick + int(params["base_width_ticks"])
        guard_lo = tick - int(params["guard_width_ticks"])
        guard_hi = tick + int(params["guard_width_ticks"])
        base_l = float(book.get("target_base_L", 0.0))
        guard_l = float(book.get("target_guard_L", 0.0))
        temp = {
            "deployed": True,
            "base_L": base_l,
            "guard_L": guard_l,
            "base_lo": base_lo,
            "base_hi": base_hi,
            "guard_lo": guard_lo,
            "guard_hi": guard_hi,
            "guard_present": True,
        }
        fee_window, _, _ = book_fee_parts(
            temp, minutes_window, fee_pips, params.get("fee_share_mode", "expansion")
        )
        book_value_usd = (
            position_value_usd(base_l, sqrt_p, base_lo, base_hi)
            + position_value_usd(guard_l, sqrt_p, guard_lo, guard_hi)
        )
        book_value_usd = max(book_value_usd, 1e-9)
        fee_apr_bps = js_round(fee_window * ann_risk / book_value_usd * 10_000)
        il_bps = il_bps_for_ticks(tick_first, tick_last, base_lo, base_hi)
        active_l = base_l + guard_l
        pool_l = float(row.get("poolLMean") or row.get("poolLLast") or 0.0)
        share = active_l / (pool_l + active_l) if active_l > 0 and pool_l >= 0 else 0.0
        deployed = False
        guard_present = False
    else:
        capital = max(float(hypo_capital), 1.0)
        lo, hi = range_from_half_width(tick, int(params["range_half_width_bps"]))
        l_hypo = liquidity_for_value(capital, sqrt_p, lo, hi)
        fee_window = fee_pips / 1e6 * (
            l_hypo * sum(float(v) for v in minutes_window.get("volOverL", []))
            - l_hypo * l_hypo * sum(float(v) for v in minutes_window.get("volOverL2", []))
        )
        book_value_usd = capital
        fee_apr_bps = js_round(fee_window * ann_risk / capital * 10_000)
        il_bps = il_bps_for_ticks(tick_first, tick_last, lo, hi)
        pool_l = float(row.get("poolLMean") or row.get("poolLLast") or 0.0)
        share = l_hypo / (pool_l + l_hypo) if l_hypo > 0 else 0.0
        deployed = False
        guard_present = False

    il_apr_bps = js_round(il_bps * ann_risk)
    net_apr_bps = fee_apr_bps - float(params.get("fee_il_hurdle", 1.0)) * abs(il_apr_bps)

    if has_positions:
        guard_for_risk = guard_present
    elif active:
        # An empty active book will deploy a guard on funding. The literal
        # keeper uses the hook's current guardPresent=false and gets stuck in
        # the arms; the fixed/risk-only variants assume the funding guard.
        guard_for_risk = True if params.get("fix_empty_book_guard") else False
    else:
        # scanCandidate(): the inactive book's guard is not deployed yet, so
        # assume it will be present on switch.
        guard_for_risk = True
    depeg_for_risk = bool(env.get("depeg_paused", False)) if active else False

    thresholds = {
        "maxVolatilityBps": float(params["risk_max_volatility_bps"]) * vol_scale,
        "minVolumeUsd": float(params["risk_min_volume_usd"]) * floor_scale,
        "minFeeAprBps": params["risk_min_fee_apr_bps"],
    }
    risk = assess_book_risk(
        fee_apr_bps,
        volume_window,
        volatility_window,
        guard_for_risk,
        depeg_for_risk,
        thresholds,
    )
    eligible = float(risk_row.get("poolLiquidityUsd", 0.0)) >= float(
        params["min_pool_liquidity_usd"]
    )
    if not eligible:
        risk["risk"] = "HIGH"
        risk["reasons"] = ["thin-active-liquidity"]

    opportunity_fee = 0.0
    opportunity_il = 0.0
    opportunity_net = 0.0
    opportunity_volume = 0.0
    opp_hours = int(params.get("opportunity_window_hours", 0) or 0)
    if opp_hours > 0 and scenario:
        if has_positions:
            window_book = book
        else:
            base_lo = tick - int(params["base_width_ticks"])
            base_hi = tick + int(params["base_width_ticks"])
            guard_lo = tick - int(params["guard_width_ticks"])
            guard_hi = tick + int(params["guard_width_ticks"])
            window_book = {
                "deployed": True,
                "base_L": float(book.get("target_base_L", 0.0)),
                "guard_L": float(book.get("target_guard_L", 0.0)),
                "base_lo": base_lo,
                "base_hi": base_hi,
                "guard_lo": guard_lo,
                "guard_hi": guard_hi,
                "guard_present": True,
            }
        opportunity_fee, opportunity_il, _, _, _ = _book_fee_il_window(
            window_book,
            scenario,
            step,
            opp_hours,
            fee_pips,
            book_key,
            params.get("fee_share_mode", "expansion"),
        )
        opportunity_net = opportunity_fee - float(
            params.get("fee_il_hurdle", 1.0)
        ) * abs(opportunity_il)
        opp_start = max(0, step - opp_hours + 1)
        opportunity_volume = sum(
            float(scenario[j][book_key].get("volumeUsd", 0.0))
            for j in range(opp_start, step + 1)
        )
        net_apr_bps = opportunity_net
        if name == "bookB":
            b_hours = max(opp_hours, int(params.get("book_b_volume_window_hours", 3)))
            b_start = max(0, step - b_hours + 1)
            b_volume = sum(
                float(scenario[j][book_key].get("volumeUsd", 0.0))
                for j in range(b_start, step + 1)
            )
            if (
                float(params.get("book_b_min_volume_window_usd", 0.0)) > 0
                and b_volume < float(params["book_b_min_volume_window_usd"])
            ):
                risk["risk"] = "HIGH"
                risk["reasons"].append("book-b-volume")
            if share > float(params.get("book_b_max_share", 1.0)):
                risk["risk"] = "HIGH"
                risk["reasons"].append("book-b-share")

    return {
        "name": name,
        "book": 0 if name == "bookA" else 1,
        "active": active,
        "bookDeployed": deployed,
        "guardPresent": guard_present,
        "bookValueUsd": book_value_usd,
        "bookShare": share,
        "feeAprBps": fee_apr_bps,
        "ilBps": il_bps,
        "ilAprBps": il_apr_bps,
        "netAprBps": net_apr_bps,
        "opportunityFeeAprBps": opportunity_fee,
        "opportunityIlAprBps": opportunity_il,
        "opportunityNetAprBps": opportunity_net,
        "opportunityVolumeUsd": opportunity_volume,
        "risk": risk["risk"],
        "riskReasons": risk["reasons"],
        "volumeUsd": volume_window,
        "volatilityBps": volatility_window,
        "poolLiquidityUsd": float(risk_row.get("poolLiquidityUsd", 0.0)),
        "eligible": eligible,
    }


def p_marks(params, substep, sH, s, additional_objs=None, **kwargs):
    pf = s["portfolio"]
    env = s["env"]
    sqrt_p = float(env["sqrtP"])
    price = float(env["price"])
    nav_total = portfolio_nav(pf, sqrt_p, price)
    active = int(pf["active_book"])
    active_value = book_value(pf["books"][active], sqrt_p)
    hypo_capital = active_value if active_value > 0 else nav_total

    candidates = []
    for i, name in enumerate(("bookA", "bookB")):
        candidates.append(
            _candidate(
                pf["books"][i],
                name,
                active=(active == i),
                row=env[name],
                env=env,
                nav_total=nav_total,
                hypo_capital=hypo_capital,
                params=params,
                step=int(s["step"]),
            )
        )
    return {"book_metrics": candidates}


def s_book_metrics(params, substep, sH, s, _input, **kwargs):
    return "book_metrics", _input["book_metrics"]


def _book_by_name(pf: dict[str, Any], name: str) -> tuple[int, dict[str, Any]]:
    idx = 0 if name == "bookA" else 1
    return idx, pf["books"][idx]


def _deploy_to_arms_action(pf: dict[str, Any], env: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    price = float(env["price"])
    sqrt_p = float(env["sqrtP"])
    arm = pf["arm"]
    collateral_cap, lend_cap = _arm_caps(pf, params, sqrt_p, price)
    plan = plan_arm_entry(
        usdg_available=pf["idle_usdg"],
        nvda_available=pf["idle_nvda"],
        nvda_price=price,
        usdg_deployed=arm["usdg_lent"],
        nvda_deployed=arm["nvda"],
        ltv_bps=params["ltv_bps"],
        max_ltv_bps=params["max_ltv_bps"],
        morpho_share_bps=params["morpho_share_bps"],
        nvda_step_bps=params["nvda_step_bps"],
    )
    lend_room = max(0.0, lend_cap - arm["usdg_lent"])
    usdg_move = min(plan["usdgMove"], pf["idle_usdg"], lend_room)
    collateral_room = max(0.0, collateral_cap - arm["nvda"] * price)
    nvda_move = min(plan["nvdaMove"], pf["idle_nvda"], collateral_room / price if price > 0 else 0.0)
    desired_debt = borrow_size(
        arm["nvda"] * price,
        params["ltv_bps"],
        params["max_ltv_bps"],
        params["hard_cap_bps"],
    )
    borrow_room = max(0.0, float(params["borrow_liquidity_usd"]) - arm["debt"])
    borrow_amount = min(
        max(0.0, desired_debt - arm["debt"]),
        borrow_room,
        float(params["max_borrow_per_call_usd"]),
    )

    if usdg_move > DUST_USD:
        return {
            "action": "ALLOCATE_USDG",
            "amount": usdg_move,
            "reason": "safe harbor: quote to lend arm first",
        }
    if nvda_move > DUST_NVDA:
        return {
            "action": "ALLOCATE_NVDA",
            "amount": nvda_move,
            "reason": "safe harbor: NVDA to collateral arm",
        }
    if arm["nvda"] > DUST_NVDA and borrow_amount > DUST_USD:
        return {
            "action": "BORROW_USDG",
            "amount": borrow_amount,
            "reason": "safe harbor: borrow at <30% LTV",
        }
    active = int(pf["active_book"])
    if book_has_positions(pf["books"][active]):
        return {"action": "RECALL_BOOK", "reason": "safe harbor: recall the book"}
    return {"action": "HOLD", "reason": "arms already deployed; nothing to recall"}


def _return_to_books_action(pf: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    arm = pf["arm"]
    plan = plan_book_return(
        usdg_deployed=arm["usdg_lent"],
        nvda_collateral=arm["nvda"],
        debt=arm["debt"],
        step_bps=params["book_step_bps"],
        dust_usdg=DUST_USD,
        dust_nvda=DUST_NVDA,
    )
    if arm["debt"] > DUST_USD:
        available = pf["idle_usdg"] + arm["usdg_lent"]
        repay = min(plan["repay"], max(0.0, available), arm["debt"])
        if repay > DUST_USD:
            return {"action": "REPAY", "amount": repay, "reason": "return: repay debt first"}
        # The keeper never withdraws collateral while debt is outstanding; the
        # adapter would revert on the health floor anyway.
        return {"action": "HOLD", "reason": "return: debt outstanding, no USDG to repay"}
    if arm["nvda"] > DUST_NVDA:
        return {
            "action": "WITHDRAW_NVDA",
            "amount": max(0.0, plan["collateralOut"]),
            "reason": "return: withdraw NVDA collateral",
        }
    if arm["usdg_lent"] > DUST_USD:
        return {
            "action": "DEALLOCATE_USDG",
            "amount": max(0.0, plan["usdgOut"]),
            "reason": "return: pull the USDG lend arm",
        }
    if not book_has_positions(pf["books"][int(pf["active_book"])]):
        return {"action": "FUND_BOOK", "book": int(pf["active_book"]), "reason": "return: fund the book"}
    return {"action": "HOLD", "reason": "book already funded"}


def _sentinel_action(
    pf: dict[str, Any],
    arm: dict[str, Any],
    price: float,
    params: dict[str, Any],
) -> dict[str, Any] | None:
    """Keeper deleverage: HF floor or borrow-APR ceiling, 10% of debt per tick."""
    if not params.get("sentinel_enabled"):
        return None
    if arm["debt"] <= DUST_USD or arm["nvda"] <= DUST_NVDA:
        return None
    collateral_value = arm["nvda"] * price
    hf = float(params["lltv"]) * collateral_value / arm["debt"]
    borrow_apr_bps = float(params["arm_borrow_apr"]) * 10_000.0
    hf_trigger = hf < float(params["min_health_factor"])
    apr_trigger = borrow_apr_bps > float(params["max_borrow_apr_bps"])
    if not (hf_trigger or apr_trigger):
        return None
    repay = arm["debt"] * float(params["delever_bps"]) / 10_000.0
    repay = min(repay, pf["idle_usdg"] + arm["usdg_lent"], arm["debt"])
    if repay <= DUST_USD:
        return None
    why = (
        f"sentinel: borrow APR {borrow_apr_bps:.0f}bps > {params['max_borrow_apr_bps']}bps"
        if apr_trigger
        else f"sentinel: HF {hf:.2f} < {params['min_health_factor']}"
    )
    return {"action": "REPAY", "amount": repay, "reason": why}


def _recenter_action(
    pf: dict[str, Any],
    env: dict[str, Any],
    params: dict[str, Any],
) -> dict[str, Any] | None:
    """Re-centre the whole book after a large move from its entry tick."""
    threshold = float(params.get("recenter_threshold_bps", 0.0))
    if threshold <= 0:
        return None
    active = int(pf["active_book"])
    book = pf["books"][active]
    if not book_has_positions(book):
        return None
    entry_tick = int(book.get("entry_tick", int(env["tick"])))
    entry_price = price_from_tick(entry_tick)
    price = float(env["price"])
    if entry_price <= 0:
        return None
    move_bps = abs(price / entry_price - 1.0) * 10_000.0
    if move_bps >= threshold:
        return {
            "action": "RECENTER_BOOK",
            "reason": f"recenter: {move_bps:.0f}bps from entry",
        }
    return None


def _surplus_action(
    pf: dict[str, Any],
    env: dict[str, Any],
    params: dict[str, Any],
    book: dict[str, Any],
) -> dict[str, Any] | None:
    """No-swap inventory sweep, one action per allocator run.

    Keep a reserve of both tokens for the next 50/50 guard re-add. If idle NVDA
    exceeds the reserve, push the excess to the Spiral collateral arm; then
    borrow at the LTV target; then lend excess USDG. The book itself is never
    swapped or force-balanced.
    """
    if not params.get("surplus_sweep"):
        return None
    price = float(env["price"])
    sqrt_p = float(env["sqrtP"])
    if price <= 0:
        return None
    nav = portfolio_nav(pf, sqrt_p, price)
    reserve = max(
        float(params.get("inventory_reserve_usd", 1_000.0)),
        float(params.get("inventory_reserve_pct", 0.10)) * nav,
    )
    reserve_nvda = reserve / price
    arm = pf["arm"]
    collateral_cap, lend_cap = _arm_caps(pf, params, sqrt_p, price)

    # 1. Excess NVDA -> collateral arm.
    if pf["idle_nvda"] > reserve_nvda + float(params.get("surplus_nvda_min_usd", 250.0)) / price:
        room = max(0.0, collateral_cap - arm["nvda"] * price)
        excess = min(pf["idle_nvda"] - reserve_nvda, room / price)
        if excess > DUST_NVDA:
            return {
                "action": "ALLOCATE_NVDA",
                "amount": excess,
                "reason": "surplus: idle NVDA to Spiral collateral",
            }

    # 2. Borrow against the collateral at the target LTV.
    if params.get("surplus_borrow", True) and arm["nvda"] > DUST_NVDA:
        desired = borrow_size(
            arm["nvda"] * price,
            params["ltv_bps"],
            params["max_ltv_bps"],
            params["hard_cap_bps"],
        )
        borrow_room = max(0.0, float(params["borrow_liquidity_usd"]) - arm["debt"])
        borrow_amount = min(
            max(0.0, desired - arm["debt"]),
            borrow_room,
            float(params["max_borrow_per_call_usd"]),
        )
        if borrow_amount > DUST_USD:
            return {
                "action": "BORROW_USDG",
                "amount": borrow_amount,
                "reason": "surplus: borrow against idle NVDA collateral",
            }

    # 3. Excess USDG -> Morpho lend arm.
    if pf["idle_usdg"] > reserve + float(params.get("surplus_usdg_min_usd", 250.0)):
        room = max(0.0, lend_cap - arm["usdg_lent"])
        amount = min(pf["idle_usdg"] - reserve, room)
        if amount > DUST_USD:
            return {
                "action": "ALLOCATE_USDG",
                "amount": amount,
                "reason": "surplus: idle USDG to Morpho lend",
            }
    return None


def p_decision(params, substep, sH, s, additional_objs=None, **kwargs):
    pf = s["portfolio"]
    env = s["env"]
    metrics = s["book_metrics"]
    step = int(s["step"])
    policy = str(params["policy"])
    price = float(env["price"])
    sqrt_p = float(env["sqrtP"])
    active = int(pf["active_book"])
    book = pf["books"][active]
    current = metrics[active] if active < len(metrics) else {}
    arm = pf["arm"]

    if step < int(params["warmup_hours"]) and policy not in ("hodl", "always_arms"):
        return {"decision": {"action": "HOLD", "reason": "warmup"}}

    interval = max(1, int(params.get("allocator_interval_hours", 1)))
    if (
        policy in ("allocator", "risk_only")
        and interval > 1
        and step % interval != 0
    ):
        return {
            "decision": {
                "action": "HOLD",
                "reason": f"outside {interval}h allocator interval",
            }
        }

    if policy == "hodl":
        return {"decision": {"action": "HOLD", "reason": "HODL basket"}}

    if policy == "always_arms":
        action = _deploy_to_arms_action(pf, env, params)
        return {"decision": action}

    if policy in ("risk_only", "risk_fee_il"):
        # The documented allocator design: risk is the only mode switch. No
        # net-APR comparison and no min-carry gate. The active book is held
        # while risk is NORMAL and the guard is present; the arms are the
        # safe harbor. This is the variant the header of allocator.mjs
        # describes, but tickAllocator() does not actually run.
        # risk_fee_il adds one extra gate: hold the book only while the rolling
        # fee APR covers fee_il_hurdle * IL APR plus a buffer.
        if env.get("depeg_paused") or env.get("controller_paused") or env.get("switch_frozen"):
            if book_has_positions(book):
                return {
                    "decision": {
                        "action": "RECALL_BOOK",
                        "reason": "depeg/controller paused -> recall only",
                    }
                }
            return {"decision": {"action": "HOLD", "reason": "paused; book already recalled"}}

        sentinel = _sentinel_action(pf, arm, price, params)
        if sentinel:
            return {"decision": sentinel}

        book_deployed = book_has_positions(book)
        pulls = count_guard_pulls(
            env["bookA" if active == 0 else "bookB"]["fiveMinMoves"],
            params["guard_pull_threshold_bps"],
        )
        guard_recently_pulled = (
            book.get("last_pull_step", -1) >= 0
            and step - int(book["last_pull_step"]) < int(params["guard_cooldown_hours"])
        )
        guard_trigger = book_deployed and (
            not book.get("guard_present")
            or guard_recently_pulled
            or pulls > int(params["max_guard_pulls"])
        )
        risk_high = current.get("risk") == "HIGH"
        if active == 1 and risk_high and metrics and metrics[0].get("risk") != "HIGH":
            return {
                "decision": {
                    "action": "SWITCH_BOOK",
                    "book": 0,
                    "reason": "book B risk: switch back to book A",
                }
            }
        if guard_trigger or risk_high:
            return {
                "decision": {
                    **_deploy_to_arms_action(pf, env, params),
                    "reason": (
                        "risk-only: "
                        + (
                            f"guard-pulls={pulls}"
                            if pulls > int(params["max_guard_pulls"])
                            else ("guard-absent" if not book.get("guard_present") else "risk high")
                        )
                    ),
                }
            }
        recenter = _recenter_action(pf, env, params)
        if recenter:
            return {"decision": recenter}
        if policy == "risk_fee_il" and book_deployed:
            gate_hours = int(params.get("fee_il_window_hours", 0)) or 4
            fee_pips = float(params["fee_a"] if active == 0 else params["fee_b"])
            book_key = "bookA" if active == 0 else "bookB"
            hurdle = float(params.get("fee_il_hurdle", 1.0))
            buffer_bps = float(params.get("fee_il_buffer_bps", 500))
            confirm = max(1, int(params.get("fee_il_confirm_hours", 1)))
            streak = _fee_il_streak(
                book,
                params.get("scenario", []),
                step,
                gate_hours,
                fee_pips,
                book_key,
                hurdle,
                buffer_bps,
                confirm,
                params.get("fee_share_mode", "expansion"),
            )
            if streak >= confirm:
                gate_fee, gate_il, _, _, _ = _book_fee_il_window(
                    book,
                    params.get("scenario", []),
                    step,
                    gate_hours,
                    fee_pips,
                    book_key,
                    params.get("fee_share_mode", "expansion"),
                )
                return {
                    "decision": {
                        **_deploy_to_arms_action(pf, env, params),
                        "reason": (
                            f"fee/IL gate {streak}/{confirm}h: {gate_fee:.0f}bps fee vs "
                            f"{gate_il:.0f}bps IL < {buffer_bps}bps buffer"
                        ),
                    }
                }
        if book_deployed and pf["mode"] == "BOOKS":
            surplus = _surplus_action(pf, env, params, book)
            if surplus:
                return {"decision": surplus}
        opp_window = int(params.get("opportunity_window_hours", 0) or 0)
        opp_check = max(1, int(params.get("opportunity_check_hours", 1)))
        if (
            opp_window > 0
            and book_deployed
            and pf["mode"] == "BOOKS"
            and step % opp_check == 0
        ):
            cur = metrics[active] if active < len(metrics) else {}
            other = metrics[1 - active] if 1 - active < len(metrics) else {}
            other_net = float(other.get("netAprBps", 0.0))
            cur_net = float(cur.get("netAprBps", 0.0))
            floor = float(params.get("opportunity_min_net_apr_bps", 0.0))
            buffer = float(params.get("opportunity_buffer_bps", 500.0))
            if (
                other.get("risk") != "HIGH"
                and other_net > max(floor, cur_net + buffer)
            ):
                return {
                    "decision": {
                        "action": "SWITCH_BOOK",
                        "book": int(other.get("book", 1 - active)),
                        "reason": (
                            f"opportunity {opp_window}h: "
                            f"{other.get('name')} {other_net:.0f}bps > "
                            f"{cur.get('name')} {cur_net:.0f}bps + {buffer:.0f}bps"
                        ),
                    }
                }
        if pf["mode"] == "ARMS":
            return {"decision": _return_to_books_action(pf, params)}
        if not book_deployed:
            return {"decision": _return_to_books_action(pf, params)}
        return {"decision": {"action": "HOLD", "reason": "risk normal -> book fees"}}

    if policy in ("always_a", "always_b"):
        target = 0 if policy == "always_a" else 1
        target_book = pf["books"][target]
        if target != active and book_has_positions(pf["books"][active]):
            return {
                "decision": {
                    "action": "SWITCH_BOOK",
                    "book": target,
                    "reason": f"{policy}: switch to target",
                }
            }
        if target == active and book_has_positions(target_book):
            return {"decision": {"action": "HOLD", "reason": f"{policy}: already funded"}}
        return {
            "decision": {"action": "FUND_BOOK", "book": target, "reason": f"{policy}: fund target"}
        }

    # ---- allocator -------------------------------------------------------
    if env.get("depeg_paused") or env.get("controller_paused") or env.get("switch_frozen"):
        if book_has_positions(book):
            return {
                "decision": {
                    "action": "RECALL_BOOK",
                    "reason": "depeg/controller paused -> recall only",
                }
            }
        return {"decision": {"action": "HOLD", "reason": "paused; book already recalled"}}

    # Sentinel: deleverage on HF floor or borrow-APR ceiling.
    sentinel = _sentinel_action(pf, arm, price, params)
    if sentinel:
        return {"decision": sentinel}

    book_deployed = book_has_positions(book)
    pulls = count_guard_pulls(
        env["bookA" if active == 0 else "bookB"]["fiveMinMoves"],
        params["guard_pull_threshold_bps"],
    )
    guard_recently_pulled = (
        book.get("last_pull_step", -1) >= 0
        and step - int(book["last_pull_step"]) < int(params["guard_cooldown_hours"])
    )

    if params.get("fix_empty_book_guard"):
        guard_trigger = book_deployed and (
            not book.get("guard_present")
            or guard_recently_pulled
            or pulls > int(params["max_guard_pulls"])
        )
    else:
        guard_trigger = (
            not book.get("guard_present")
            or guard_recently_pulled
            or pulls > int(params["max_guard_pulls"])
        )
    risk_high = current.get("risk") == "HIGH"

    if guard_trigger or risk_high:
        return {
            "decision": {
                **_deploy_to_arms_action(pf, env, params),
                "reason": (
                    "safe-harbor trigger: "
                    + (
                        f"guard-pulls={pulls}"
                        if pulls > int(params["max_guard_pulls"])
                        else ("guard-absent" if not book.get("guard_present") else "risk high")
                    )
                ),
            }
        }

    if pf["mode"] != "ARMS":
        recenter = _recenter_action(pf, env, params)
        if recenter:
            return {"decision": recenter}

    opp_check = max(1, int(params.get("opportunity_check_hours", 1)))
    if pf["mode"] != "ARMS" and opp_check > 1 and step % opp_check != 0:
        return {
            "decision": {
                "action": "HOLD",
                "reason": f"outside {opp_check}h opportunity check",
            }
        }

    decision = decide_pool_switch(
        metrics,
        current_pool="bookA" if active == 0 else "bookB",
        switch_buffer_bps=params["switch_buffer_bps"],
    )
    if decision["action"] == "ARMS":
        return {
            "decision": {
                **_deploy_to_arms_action(pf, env, params),
                "reason": decision["reason"],
            }
        }
    if decision["action"] == "HOLD":
        if pf["mode"] == "ARMS":
            return {"decision": _return_to_books_action(pf, params)}
        if not book_deployed:
            return {"decision": _return_to_books_action(pf, params)}
        return {"decision": {"action": "HOLD", "reason": decision["reason"]}}

    # SWITCH
    best = decision["ranked"][0] if decision.get("ranked") else None
    if not best:
        return {"decision": {"action": "HOLD", "reason": "no switch candidate"}}
    if pf["mode"] == "ARMS":
        return {"decision": _return_to_books_action(pf, params)}
    return {
        "decision": {
            "action": "SWITCH_BOOK",
            "book": int(best["book"]),
            "reason": decision["reason"],
        }
    }


def s_decision(params, substep, sH, s, _input, **kwargs):
    return "decision", _input["decision"]


# ---------------------------------------------------------------------------
# Income (book fees, guard pulls/rearms, arm interest, liquidation)
# ---------------------------------------------------------------------------

def _pay_gas(pf: dict[str, Any], gas: float) -> None:
    if gas <= 0:
        return
    remaining = float(gas)
    if pf["idle_usdg"] > 0:
        take = min(remaining, pf["idle_usdg"])
        pf["idle_usdg"] -= take
        remaining -= take
    if remaining > 0 and pf["arm"]["usdg_lent"] > 0:
        take = min(remaining, pf["arm"]["usdg_lent"])
        pf["arm"]["usdg_lent"] -= take
        remaining -= take
    if remaining > 0:
        for book in pf["books"]:
            if book["fees"] > 0:
                take = min(remaining, book["fees"])
                book["fees"] -= take
                remaining -= take
    pf["cum"]["gas"] += float(gas) - max(0.0, remaining)


def _close_book(pf: dict[str, Any], index: int, sqrt_p: float) -> float:
    book = pf["books"][index]
    if not book.get("deployed"):
        return 0.0
    x, y = book_tokens(book, sqrt_p)
    fee_cash = float(book.get("fees", 0.0))
    pf["idle_usdg"] += x + fee_cash
    pf["idle_nvda"] += y
    realized = x + fee_cash + y * (1e12 / (sqrt_p * sqrt_p))
    book["deployed"] = False
    book["base_L"] = 0.0
    book["guard_L"] = 0.0
    book["guard_present"] = False
    book["fees"] = 0.0
    book["last_pull_step"] = -1
    return realized


def _swap_deficit(
    pf: dict[str, Any],
    x_req: float,
    y_req: float,
    price: float,
    cost_bps: float,
) -> float:
    """Fill a one-sided funding deficit with a swap; return the USD cost.

    The cost is already reflected in the token balances: selling V of value
    yields V*(1-c) of the other token, so NAV falls by V*c.
    """
    if price <= 0:
        return 0.0
    c = max(0.0, min(0.99, float(cost_bps) / 10_000.0))
    if c >= 0.99:
        return 0.0
    cost = 0.0
    x_avail = float(pf["idle_usdg"])
    y_avail = float(pf["idle_nvda"])

    if x_avail < x_req and y_avail > y_req:
        short = x_req - x_avail
        sell_value = short / (1.0 - c)
        nvda_sell = sell_value / price
        if nvda_sell <= y_avail - y_req + 1e-9:
            pf["idle_nvda"] -= nvda_sell
            pf["idle_usdg"] += short
            cost = sell_value * c
            pf["cum"]["swap_cost"] += cost
    elif y_avail < y_req and x_avail > x_req:
        short_nvda = y_req - y_avail
        sell_value = short_nvda * price / (1.0 - c)
        if sell_value <= x_avail - x_req + 1e-9:
            pf["idle_usdg"] -= sell_value
            pf["idle_nvda"] += short_nvda
            cost = sell_value * c
            pf["cum"]["swap_cost"] += cost
    return cost


def _choose_base_skew(
    pf: dict[str, Any],
    book: dict[str, Any],
    tick: int,
    env: dict[str, Any],
    params: dict[str, Any],
) -> int:
    """Pick a base-range centre offset that uses the recalled inventory.

    A negative offset puts more of the base below the current price (NVDA
    heavy); a positive offset puts more above (USDG heavy). The guard stays
    centred so the active fee sleeve is unchanged. The objective is deployed
    book value, with a symmetric-range tie-break.
    """
    max_skew = int(params.get("base_skew_max_ticks", 0))
    if max_skew <= 0:
        return 0
    wb = int(params["base_width_ticks"])
    wg = int(params["guard_width_ticks"])
    tb = float(book.get("target_base_L", 0.0))
    tg = float(book.get("target_guard_L", 0.0))
    if tb <= 0 and tg <= 0:
        return 0
    price = float(env["price"])
    sqrt_p = float(env["sqrtP"])
    xa = float(pf["idle_usdg"])
    ya = float(pf["idle_nvda"])
    step = max(1, max_skew // 40)
    offsets = sorted(set([0] + list(range(-max_skew, max_skew + 1, step))))
    best_off = 0
    best_dep = -1.0
    for off in offsets:
        blo, bhi = tick + off - wb, tick + off + wb
        glo, ghi = tick - wg, tick + wg
        xb, yb = token_amounts(tb, sqrt_p, blo, bhi)
        xg, yg = token_amounts(tg, sqrt_p, glo, ghi)
        xr, yr = xb + xg, yb + yg
        scale = 1.0
        if xr > 0:
            scale = min(scale, xa / xr)
        if yr > 0:
            scale = min(scale, ya / yr)
        dep = scale * (xr + yr * price)
        if dep > best_dep + 1e-9 or (
            abs(dep - best_dep) <= 1e-9 and abs(off) < abs(best_off)
        ):
            best_dep = dep
            best_off = off
    return int(best_off)


def _book_fee_il_window(
    book: dict[str, Any],
    scenario: list[dict[str, Any]],
    step: int,
    hours: int,
    fee_pips: float,
    book_key: str = "bookA",
    fee_share_mode: str = "expansion",
) -> tuple[float, float, float, float, float]:
    """Rolling fee/IL signal for the guard gate.

    Returns (fee_apr_bps, il_apr_bps, fee_usd, il_bps, book_value_usd). The
    current L/range is applied to the whole window (a short-window
    approximation) and the IL is marked from the window's first tick to now.
    """
    if not book_has_positions(book) or hours <= 0 or not scenario:
        return 0.0, 0.0, 0.0, 0.0, 0.0
    end = min(int(step), len(scenario) - 1)
    start = max(0, end - int(hours))
    if end <= start:
        return 0.0, 0.0, 0.0, 0.0, 0.0
    total = 0.0
    for j in range(start, end):
        total += book_fee_for_hour(
            book, scenario[j][book_key]["minutes"], fee_pips, None, fee_share_mode
        )[0]
    sqrt_p = float(scenario[end]["sqrtP"])
    value = max(book_value(book, sqrt_p), 1e-9)
    if book.get("base_L", 0.0) > 0:
        lo, hi = book["base_lo"], book["base_hi"]
    else:
        lo, hi = book["guard_lo"], book["guard_hi"]
    il_bps = il_bps_for_ticks(
        int(scenario[start]["tick"]), int(scenario[end]["tick"]), lo, hi
    )
    ann = HOURS_PER_YEAR / float(hours)
    fee_apr_bps = total / value * ann * 10_000.0
    il_apr_bps = abs(float(il_bps)) * ann
    return fee_apr_bps, il_apr_bps, total, float(il_bps), value


def _guard_fee_il_window(
    book: dict[str, Any],
    scenario: list[dict[str, Any]],
    step: int,
    hours: int,
    fee_pips: float,
    book_key: str = "bookA",
    fee_share_mode: str = "expansion",
) -> tuple[float, float, float, float, float]:
    """Rolling fee/IL signal for the narrow guard sleeve only.

    The guard is the marginal fee earner; pulling it should depend on the
    guard's own fee density vs the IL of its range, not the wide base's.
    """
    if (
        not book.get("guard_present")
        or float(book.get("guard_L", 0.0)) <= 0
        or hours <= 0
        or not scenario
    ):
        return 0.0, 0.0, 0.0, 0.0, 0.0
    end = min(int(step), len(scenario) - 1)
    start = max(0, end - int(hours))
    if end <= start:
        return 0.0, 0.0, 0.0, 0.0, 0.0
    total = 0.0
    for j in range(start, end):
        total += book_fee_for_hour(
            book, scenario[j][book_key]["minutes"], fee_pips, None, fee_share_mode
        )[1]
    sqrt_p = float(scenario[end]["sqrtP"])
    value = max(
        position_value_usd(
            float(book["guard_L"]), sqrt_p, book["guard_lo"], book["guard_hi"]
        ),
        1e-9,
    )
    il_bps = il_bps_for_ticks(
        int(scenario[start]["tick"]),
        int(scenario[end]["tick"]),
        book["guard_lo"],
        book["guard_hi"],
    )
    ann = HOURS_PER_YEAR / float(hours)
    fee_apr_bps = total / value * ann * 10_000.0
    il_apr_bps = abs(float(il_bps)) * ann
    return fee_apr_bps, il_apr_bps, total, float(il_bps), value


def _fee_il_streak(
    book: dict[str, Any],
    scenario: list[dict[str, Any]],
    step: int,
    hours: int,
    fee_pips: float,
    book_key: str,
    hurdle: float,
    buffer_bps: float,
    confirm_hours: int,
    fee_share_mode: str = "expansion",
) -> int:
    """Consecutive hours where fee - hurdle*IL is below the buffer."""
    if confirm_hours <= 1:
        fee, il, _, _, _ = _book_fee_il_window(
            book, scenario, step, hours, fee_pips, book_key, fee_share_mode
        )
        return 1 if fee - hurdle * il < buffer_bps else 0
    streak = 0
    for k in range(int(confirm_hours)):
        s = int(step) - k
        if s < 0:
            break
        fee, il, _, _, _ = _book_fee_il_window(
            book, scenario, s, hours, fee_pips, book_key, fee_share_mode
        )
        if fee - hurdle * il < buffer_bps:
            streak += 1
        else:
            break
    return streak


def _fund_book(
    pf: dict[str, Any],
    target: int,
    env: dict[str, Any],
    params: dict[str, Any],
) -> float:
    book = pf["books"][target]
    tick = int(env["tick"])
    sqrt_p = float(env["sqrtP"])
    price = float(env["price"])
    skew = 0
    if params.get("base_skew_mode") == "inventory":
        skew = _choose_base_skew(pf, book, tick, env, params)
    base_lo = tick + skew - int(params["base_width_ticks"])
    base_hi = tick + skew + int(params["base_width_ticks"])
    guard_lo = tick - int(params["guard_width_ticks"])
    guard_hi = tick + int(params["guard_width_ticks"])

    target_base = float(book.get("target_base_L", 0.0))
    target_guard = float(book.get("target_guard_L", 0.0))
    x_b, y_b = token_amounts(target_base, sqrt_p, base_lo, base_hi)
    x_g, y_g = token_amounts(target_guard, sqrt_p, guard_lo, guard_hi)
    x_req = x_b + x_g
    y_req = y_b + y_g
    if x_req <= 0 and y_req <= 0:
        return 0.0

    # The keeper funds 90% of the idle quote/equity, not 100% of the target.
    fund_bps = min(10_000.0, max(0.0, float(params.get("fund_book_bps", 9_000))))
    swap_mode = str(params.get("funding_mode", "scale")) == "swap"
    if swap_mode:
        # Aim for fund_bps of the target, swap any one-sided deficit, then
        # scale only if total inventory is still short.
        x_goal = x_req * fund_bps / 10_000.0
        y_goal = y_req * fund_bps / 10_000.0
        _swap_deficit(
            pf,
            x_goal,
            y_goal,
            price,
            float(params.get("swap_cost_bps", 0.0)),
        )
        avail_usdg = pf["idle_usdg"]
        avail_nvda = pf["idle_nvda"]
        l_scale = fund_bps / 10_000.0
    else:
        avail_usdg = pf["idle_usdg"] * fund_bps / 10_000.0
        avail_nvda = pf["idle_nvda"] * fund_bps / 10_000.0
        l_scale = 1.0

    scale = l_scale
    if x_req > 0:
        scale = min(scale, avail_usdg / x_req)
    if y_req > 0:
        scale = min(scale, avail_nvda / y_req)
    if scale <= 0:
        return 0.0

    book["deployed"] = True
    book["base_L"] = target_base * scale
    book["guard_L"] = target_guard * scale
    book["base_lo"] = base_lo
    book["base_hi"] = base_hi
    book["guard_lo"] = guard_lo
    book["guard_hi"] = guard_hi
    book["entry_tick"] = tick
    book["base_skew_ticks"] = skew
    book["fees"] = 0.0
    book["guard_present"] = True
    book["last_pull_step"] = -1
    pf["idle_usdg"] -= x_req * scale
    pf["idle_nvda"] -= y_req * scale
    pf["active_book"] = target
    return x_req * scale + y_req * scale * price


def _liquidate(
    pf: dict[str, Any],
    sqrt_p: float,
    price: float,
    step: int,
    params: dict[str, Any],
) -> None:
    """Liquidate an HF<1 arm without creating NAV.

    A Morpho liquidation repays debt and seizes collateral at a bonus, not the
    whole position. The vault keeps any residual collateral; any shortfall
    beyond the lend arm is carried as ``bad_debt`` (a liability), not forgiven.
    """
    arm = pf["arm"]
    if arm["debt"] <= DUST_USD:
        return
    collateral_value = arm["nvda"] * price
    if collateral_value <= 0:
        collateral_value = 0.0
    hf = float(params["lltv"]) * collateral_value / arm["debt"]
    if hf >= 1.0:
        return

    debt_before = arm["debt"]
    nav_before = portfolio_nav(pf, sqrt_p, price)
    bonus = float(params["liquidation_bonus_bps"]) / 10_000.0
    seized = min(collateral_value, arm["debt"] * (1.0 + bonus))
    repaid = seized / (1.0 + bonus) if seized > 0 else 0.0
    remaining_debt = max(0.0, arm["debt"] - repaid)
    remaining_collateral = max(0.0, collateral_value - seized)

    if collateral_value > 0:
        arm["nvda"] *= remaining_collateral / collateral_value
    else:
        arm["nvda"] = 0.0

    lend_before = arm["usdg_lent"]
    impair = min(lend_before, remaining_debt)
    arm["usdg_lent"] = lend_before - impair
    arm["bad_debt"] = float(arm.get("bad_debt", 0.0)) + (remaining_debt - impair)
    arm["debt"] = 0.0

    nav_after = portfolio_nav(pf, sqrt_p, price)
    loss = max(0.0, nav_before - nav_after)
    pf["cum"]["liquidation_loss"] += loss
    pf["last_events"].append(
        {
            "step": step,
            "type": "LIQUIDATION",
            "hf": hf,
            "collateral_value_usd": collateral_value,
            "debt_usd": debt_before,
            "seized_usd": seized,
            "repaid_usd": repaid,
            "remaining_collateral_usd": remaining_collateral,
            "bad_debt_usd": arm["bad_debt"],
            "liquidation_loss_usd": loss,
        }
    )


def s_portfolio_income(params, substep, sH, s, _input, **kwargs):
    pf = copy.deepcopy(s["portfolio"])
    env = s["env"]
    step = int(s["step"])
    sqrt_p = float(env["sqrtP"])
    price = float(env["price"])
    pf["last_events"] = []

    for i, key in enumerate(("bookA", "bookB")):
        book = pf["books"][i]
        if not book.get("deployed"):
            continue
        fee_pips = float(params["fee_a"] if i == 0 else params["fee_b"])
        row = env[key]
        scenario = params.get("scenario", [])
        gate_hours = int(params.get("fee_il_window_hours", 0)) or 4
        gate_hurdle = float(params.get("guard_fee_il_hurdle", 1.0))
        guard_rule = str(params.get("guard_rule", "move"))
        guard_gate_fee, guard_gate_il = 0.0, 0.0
        rearm_fee, rearm_il = 0.0, 0.0
        if guard_rule == "fee_il":
            guard_gate_fee, guard_gate_il, _, _, _ = _guard_fee_il_window(
                book, scenario, step, gate_hours, fee_pips, key,
                params.get("fee_share_mode", "expansion"),
            )
        if params.get("rearm_gate"):
            rearm_fee, rearm_il, _, _, _ = _book_fee_il_window(
                book, scenario, step, gate_hours, fee_pips, key,
                params.get("fee_share_mode", "expansion"),
            )
        fee_il_pull = (
            guard_rule == "fee_il"
            and book.get("guard_present")
            and guard_gate_il > 0
            and guard_gate_fee < gate_hurdle * guard_gate_il
        )
        first_bin = first_guard_pull_bin(
            row["fiveMinMoves"], params["guard_pull_threshold_bps"]
        )
        if fee_il_pull:
            # Signal-based pull at the start of the hour; be conservative and
            # give the guard no fee for this hour.
            first_bin = 0
        pulls = 1 if first_bin is not None else 0

        if pulls > 0 and book.get("guard_present") and book.get("guard_L", 0.0) > 0:
            # The guard is pulled at the first triggering 5-minute bin. It earns
            # only the fraction of the hour before that bin; the base keeps its
            # share of the both-in-range fee.
            total, guard_fee, base_fee = book_fee_for_hour(
                book, row["minutes"], fee_pips, first_bin,
                params.get("fee_share_mode", "expansion"),
            )
            x, y = token_amounts(book["guard_L"], sqrt_p, book["guard_lo"], book["guard_hi"])
            pf["idle_usdg"] += x
            pf["idle_nvda"] += y
            book["guard_L"] = 0.0
            book["guard_present"] = False
            book["last_pull_step"] = step
            pf["cum"]["guard_pulls"] += pulls
            pf["last_events"].append(
                {
                    "step": step,
                    "type": "GUARD_PULLED",
                    "book": key,
                    "pulls": pulls,
                    "guard_value_usd": x + y * price,
                    "reason": "fee-il" if fee_il_pull else "5m-move",
                }
            )
        else:
            total, guard_fee, base_fee = book_fee_for_hour(
                book, row["minutes"], fee_pips, None,
                params.get("fee_share_mode", "expansion"),
            )

        book["fees"] += total
        book["cum_fees"] += total
        pf["cum"]["fees"] += total
        pf["cum"]["guard_fees"] += guard_fee

        # Re-arm after the hook's recheck delay if the book still has a base.
        if (
            not book.get("guard_present")
            and book.get("base_L", 0.0) > 0
            and int(params["guard_rearm_delay_hours"]) >= 0
            and step - int(book.get("last_pull_step", -1)) >= int(params["guard_rearm_delay_hours"])
        ):
            base_scale = (
                book["base_L"] / book["target_base_L"] if book.get("target_base_L", 0.0) > 0 else 0.0
            )
            target_guard = book["target_guard_L"] * base_scale
            rearm_signal_ok = (
                not params.get("rearm_gate")
                or rearm_il <= 0
                or rearm_fee >= gate_hurdle * rearm_il
            )
            if target_guard > 0 and rearm_signal_ok:
                guard_lo = int(env["tick"]) - int(params["guard_width_ticks"])
                guard_hi = int(env["tick"]) + int(params["guard_width_ticks"])
                x_req, y_req = token_amounts(target_guard, sqrt_p, guard_lo, guard_hi)
                if str(params.get("funding_mode", "scale")) == "swap":
                    _swap_deficit(
                        pf,
                        x_req,
                        y_req,
                        price,
                        float(params.get("swap_cost_bps", 0.0)),
                    )
                scale = 1.0
                if x_req > 0:
                    scale = min(scale, pf["idle_usdg"] / x_req)
                if y_req > 0:
                    scale = min(scale, pf["idle_nvda"] / y_req)
                if scale > 0:
                    book["guard_L"] = target_guard * scale
                    book["guard_lo"] = guard_lo
                    book["guard_hi"] = guard_hi
                    book["guard_present"] = True
                    book["last_pull_step"] = -1
                    pf["idle_usdg"] -= x_req * scale
                    pf["idle_nvda"] -= y_req * scale
                    pf["last_events"].append(
                        {
                            "step": step,
                            "type": "GUARD_REARMED",
                            "book": key,
                            "guard_value_usd": x_req * scale + y_req * scale * price,
                        }
                    )

    # Arm interest. Hourly compounding; rates are annualized.
    arm = pf["arm"]
    hp_year = float(HOURS_PER_YEAR)
    usdg_rate = float(params["arm_usdg_apr"]) / hp_year
    borrow_rate = float(params["arm_borrow_apr"]) / hp_year
    nvda_apr = float(params["arm_nvda_apr"])
    if params.get("nvda_apr_is_net") and arm["nvda"] > 0 and price > 0:
        collateral_value = arm["nvda"] * price
        ltv = arm["debt"] / collateral_value if collateral_value > 0 else 0.0
        # 3% net of borrow => gross it up by the debt cost attributed to the
        # collateral, then subtract borrow cost below.
        nvda_apr += ltv * float(params["arm_borrow_apr"])
    nvda_rate = nvda_apr / hp_year
    usdg_interest = arm["usdg_lent"] * usdg_rate
    borrow_cost = arm["debt"] * borrow_rate
    nvda_yield = arm["nvda"] * nvda_rate
    arm["usdg_lent"] += usdg_interest
    arm["debt"] += borrow_cost
    arm["nvda"] += nvda_yield
    pf["cum"]["arm_interest"] += usdg_interest
    pf["cum"]["borrow_cost"] += borrow_cost
    pf["cum"]["nvda_yield"] += nvda_yield * price

    # Liquidation at HF < 1.0. The sentinel is expected to act first.
    _liquidate(pf, sqrt_p, price, step, params)

    pf["mode"] = _mode(pf)
    pf["nav_before"] = portfolio_nav(pf, sqrt_p, price)
    return "portfolio", pf


# ---------------------------------------------------------------------------
# Execute (one keeper action per hour)
# ---------------------------------------------------------------------------

def _execute_action(
    pf: dict[str, Any],
    env: dict[str, Any],
    params: dict[str, Any],
    action: dict[str, Any],
    step: int,
) -> dict[str, Any]:
    pf = copy.deepcopy(pf)
    sqrt_p = float(env["sqrtP"])
    price = float(env["price"])
    arm = pf["arm"]
    name = str(action.get("action", "HOLD"))
    reason = str(action.get("reason", ""))
    nav_before = portfolio_nav(pf, sqrt_p, price)
    cost = 0.0
    event: dict[str, Any] | None = None

    if name == "ALLOCATE_USDG":
        _, lend_cap = _arm_caps(pf, params, sqrt_p, price)
        amount = min(float(action.get("amount", 0.0)), pf["idle_usdg"], max(0.0, lend_cap - arm["usdg_lent"]))
        if amount > DUST_USD:
            pf["idle_usdg"] -= amount
            arm["usdg_lent"] += amount
            event = {"step": step, "type": name, "amount_usd": amount, "reason": reason}
        else:
            name = "HOLD"

    elif name == "ALLOCATE_NVDA":
        collateral_cap, _ = _arm_caps(pf, params, sqrt_p, price)
        room = max(0.0, collateral_cap - arm["nvda"] * price)
        amount = min(float(action.get("amount", 0.0)), pf["idle_nvda"], room / price if price > 0 else 0.0)
        if amount > DUST_NVDA:
            pf["idle_nvda"] -= amount
            arm["nvda"] += amount
            event = {"step": step, "type": name, "amount_nvda": amount, "value_usd": amount * price, "reason": reason}
        else:
            name = "HOLD"

    elif name == "BORROW_USDG":
        max_debt = borrow_size(
            arm["nvda"] * price,
            params["ltv_bps"],
            params["max_ltv_bps"],
            params["hard_cap_bps"],
        )
        borrow_room = max(0.0, float(params["borrow_liquidity_usd"]) - arm["debt"])
        amount = min(
            float(action.get("amount", 0.0)),
            max(0.0, max_debt - arm["debt"]),
            borrow_room,
            float(params["max_borrow_per_call_usd"]),
        )
        if amount > DUST_USD:
            pf["idle_usdg"] += amount
            arm["debt"] += amount
            event = {"step": step, "type": name, "amount_usd": amount, "reason": reason}
        else:
            name = "HOLD"

    elif name in ("RECALL_BOOK", "RECALL_ONLY"):
        active = int(pf["active_book"])
        realized = _close_book(pf, active, sqrt_p)
        event = {"step": step, "type": "RECALL_BOOK", "value_usd": realized, "reason": reason}

    elif name == "REPAY":
        amount = min(float(action.get("amount", 0.0)), pf["idle_usdg"] + arm["usdg_lent"], arm["debt"])
        if amount > DUST_USD:
            from_idle = min(amount, pf["idle_usdg"])
            from_lend = min(amount - from_idle, arm["usdg_lent"])
            pf["idle_usdg"] -= from_idle
            arm["usdg_lent"] -= from_lend
            arm["debt"] -= amount
            event = {
                "step": step,
                "type": name,
                "amount_usd": amount,
                "from_idle_usd": from_idle,
                "from_lend_usd": from_lend,
                "reason": reason,
            }
        else:
            name = "HOLD"

    elif name == "WITHDRAW_NVDA":
        if arm["debt"] > DUST_USD:
            # Backstop for the adapter's health floor: never withdraw past the
            # collateral needed to keep HF >= min_health_factor.
            min_collateral = (
                arm["debt"] * float(params["min_health_factor"])
                / (float(params["lltv"]) * price)
                if price > 0 and float(params["lltv"]) > 0
                else 0.0
            )
            allowed = max(0.0, arm["nvda"] - min_collateral)
        else:
            allowed = arm["nvda"]
        amount = min(float(action.get("amount", 0.0)), allowed, arm["nvda"])
        if amount > DUST_NVDA:
            arm["nvda"] -= amount
            pf["idle_nvda"] += amount
            event = {"step": step, "type": name, "amount_nvda": amount, "value_usd": amount * price, "reason": reason}
        else:
            name = "HOLD"

    elif name == "DEALLOCATE_USDG":
        amount = min(float(action.get("amount", 0.0)), arm["usdg_lent"])
        if amount > DUST_USD:
            arm["usdg_lent"] -= amount
            pf["idle_usdg"] += amount
            event = {"step": step, "type": name, "amount_usd": amount, "reason": reason}
        else:
            name = "HOLD"

    elif name == "FUND_BOOK":
        target = int(action.get("book", pf["active_book"]))
        if arm["debt"] > DUST_USD or book_has_positions(pf["books"][target]):
            name = "HOLD"
        else:
            funded = _fund_book(pf, target, env, params)
            if funded > DUST_USD:
                event = {"step": step, "type": name, "book": "bookA" if target == 0 else "bookB", "value_usd": funded, "reason": reason}
            else:
                name = "HOLD"

    elif name == "RECENTER_BOOK":
        active = int(pf["active_book"])
        if not book_has_positions(pf["books"][active]):
            name = "HOLD"
        else:
            _close_book(pf, active, sqrt_p)
            funded = _fund_book(pf, active, env, params)
            if funded > DUST_USD:
                extra = float(params["gas_cost_usd"]) * max(
                    0.0, float(params.get("recenter_gas_multiplier", 2.0)) - 1.0
                )
                if extra > 0:
                    before = float(pf["cum"]["gas"])
                    _pay_gas(pf, extra)
                    cost += float(pf["cum"]["gas"]) - before
                event = {
                    "step": step,
                    "type": name,
                    "book": "bookA" if active == 0 else "bookB",
                    "value_usd": funded,
                    "reason": reason,
                }
            else:
                name = "HOLD"

    elif name == "SWITCH_BOOK":
        target = int(action.get("book", pf["active_book"]))
        old_active = int(pf["active_book"])
        if arm["debt"] > DUST_USD or (target == old_active and book_has_positions(pf["books"][target])):
            name = "HOLD"
        else:
            if target != old_active and book_has_positions(pf["books"][target]):
                _close_book(pf, target, sqrt_p)
            if book_has_positions(pf["books"][old_active]):
                _close_book(pf, old_active, sqrt_p)
            funded = _fund_book(pf, target, env, params)
            if funded > DUST_USD:
                switch_cost = funded * float(params["switch_cost_bps"]) / 10_000.0
                if switch_cost > 0:
                    pf["idle_usdg"] = max(0.0, pf["idle_usdg"] - switch_cost)
                    pf["cum"]["switch_cost"] += switch_cost
                    cost += switch_cost
                event = {
                    "step": step,
                    "type": name,
                    "book": "bookA" if target == 0 else "bookB",
                    "value_usd": funded,
                    "switch_cost_usd": switch_cost,
                    "reason": reason,
                }
            else:
                name = "HOLD"

    elif name == "HODL_RECALL":
        active = int(pf["active_book"])
        realized = _close_book(pf, active, sqrt_p)
        pf["hodl_mode"] = True
        event = {"step": step, "type": name, "value_usd": realized, "reason": reason}

    elif name == "HOLD":
        event = None
    else:
        event = {"step": step, "type": "UNKNOWN", "action": name, "reason": reason}

    if name not in ("HOLD", "INIT"):
        gas = float(params["gas_cost_usd"])
        _pay_gas(pf, gas)
        cost += gas
        pf["cum"]["actions"] += 1

    pf["mode"] = _mode(pf)
    pf["last_action"] = name
    pf["last_reason"] = reason
    pf["nav_before"] = nav_before
    pf["nav_after"] = portfolio_nav(pf, sqrt_p, price)
    pf["last_costs"] = cost
    if event:
        pf["last_events"].append(event)
    return pf


def s_portfolio_execute(params, substep, sH, s, _input, **kwargs):
    pf = _execute_action(
        s["portfolio"],
        s["env"],
        params,
        s["decision"],
        int(s["step"]),
    )
    return "portfolio", pf


# ---------------------------------------------------------------------------
# NAV / metrics
# ---------------------------------------------------------------------------

def s_nav(params, substep, sH, s, _input, **kwargs):
    pf = s["portfolio"]
    return "nav", portfolio_nav(pf, float(s["env"]["sqrtP"]), float(s["env"]["price"]))


def s_hodl_nav(params, substep, sH, s, _input, **kwargs):
    hold = s["portfolio"]["hodl"]
    return "hodl_nav", float(hold["usdg"]) + float(hold["nvda"]) * float(s["env"]["price"])


def s_peak_nav(params, substep, sH, s, _input, **kwargs):
    nav = portfolio_nav(s["portfolio"], float(s["env"]["sqrtP"]), float(s["env"]["price"]))
    return "peak_nav", max(float(s["peak_nav"]), nav)


def s_metrics(params, substep, sH, s, _input, **kwargs):
    pf = s["portfolio"]
    env = s["env"]
    step = int(s["step"])
    sqrt_p = float(env["sqrtP"])
    price = float(env["price"])
    nav = float(s["nav"])
    hodl_nav = float(s["hodl_nav"])
    peak = float(s["peak_nav"])
    arm = pf["arm"]
    active = int(pf["active_book"])
    candidates = {c["name"]: c for c in s["book_metrics"]}
    a = candidates.get("bookA", {})
    b = candidates.get("bookB", {})
    collateral = arm["nvda"] * price
    ltv = arm["debt"] / collateral if collateral > 0 else 0.0
    hf = (float(params["lltv"]) / ltv) if ltv > 0 else math.inf
    pulls = sum(
        1 for e in pf.get("last_events", []) if e.get("type") == "GUARD_PULLED"
    )
    metrics = {
        "step": step,
        "price": price,
        "tick": int(env["tick"]),
        "nav": nav,
        "hodl_nav": hodl_nav,
        "net_vs_hodl": nav - hodl_nav,
        "drawdown": nav / peak - 1.0 if peak > 0 else 0.0,
        "mode": pf["mode"],
        "active_book": active,
        "book_a_value": book_value(pf["books"][0], sqrt_p),
        "book_b_value": book_value(pf["books"][1], sqrt_p),
        "idle_usdg": pf["idle_usdg"],
        "idle_nvda": pf["idle_nvda"],
        "arm_nvda": arm["nvda"],
        "arm_debt": arm["debt"],
        "arm_usdg_lent": arm["usdg_lent"],
        "arm_bad_debt": float(arm.get("bad_debt", 0.0)),
        "arm_equity": (
            arm["nvda"] * price
            + arm["usdg_lent"]
            - arm["debt"]
            - float(arm.get("bad_debt", 0.0))
        ),
        "arm_ltv": ltv,
        "health_factor": hf,
        "cum_fees": pf["cum"]["fees"],
        "cum_guard_fees": pf["cum"]["guard_fees"],
        "book_a_fees": float(pf["books"][0].get("cum_fees", 0.0)),
        "book_b_fees": float(pf["books"][1].get("cum_fees", 0.0)),
        "cum_arm_interest": pf["cum"]["arm_interest"],
        "cum_borrow_cost": pf["cum"]["borrow_cost"],
        "cum_nvda_yield": pf["cum"]["nvda_yield"],
        "cum_gas": pf["cum"]["gas"],
        "cum_switch_cost": pf["cum"]["switch_cost"],
        "cum_swap_cost": pf["cum"]["swap_cost"],
        "cum_liquidation_loss": pf["cum"]["liquidation_loss"],
        "cum_net_carry": (
            pf["cum"]["fees"]
            + pf["cum"]["arm_interest"]
            + pf["cum"]["nvda_yield"]
            - pf["cum"]["borrow_cost"]
            - pf["cum"]["gas"]
            - pf["cum"]["switch_cost"]
            - pf["cum"]["swap_cost"]
        ),
        "cum_il_vs_hodl": (
            (nav - hodl_nav)
            - (
                pf["cum"]["fees"]
                + pf["cum"]["arm_interest"]
                + pf["cum"]["nvda_yield"]
                - pf["cum"]["borrow_cost"]
                - pf["cum"]["gas"]
                - pf["cum"]["switch_cost"]
                - pf["cum"]["swap_cost"]
            )
            + pf["cum"]["liquidation_loss"]
        ),
        "idle_value": pf["idle_usdg"] + pf["idle_nvda"] * price,
        "base_skew_a": int(pf["books"][0].get("base_skew_ticks", 0)),
        "base_skew_b": int(pf["books"][1].get("base_skew_ticks", 0)),
        "cum_guard_pulls": pf["cum"]["guard_pulls"],
        "cum_actions": pf["cum"]["actions"],
        "fee_apr_a": a.get("feeAprBps", 0),
        "fee_apr_b": b.get("feeAprBps", 0),
        "net_apr_a": a.get("netAprBps", 0),
        "net_apr_b": b.get("netAprBps", 0),
        "risk_a": a.get("risk", "n/a"),
        "risk_b": b.get("risk", "n/a"),
        "book_share_a": a.get("bookShare", 0),
        "book_share_b": b.get("bookShare", 0),
        "guard_present_a": bool(pf["books"][0].get("guard_present")),
        "guard_present_b": bool(pf["books"][1].get("guard_present")),
        "guard_pulls_hour": pulls,
        "decision_action": s["decision"].get("action", ""),
        "decision_reason": s["decision"].get("reason", ""),
        "last_action": pf.get("last_action", ""),
        "last_reason": pf.get("last_reason", ""),
        "nav_before": pf.get("nav_before", nav),
        "nav_after": pf.get("nav_after", nav),
        "last_costs": pf.get("last_costs", 0.0),
    }
    return "metrics", metrics


def s_last_events(params, substep, sH, s, _input, **kwargs):
    return "last_events", list(s["portfolio"].get("last_events", []))


def s_event_count(params, substep, sH, s, _input, **kwargs):
    return "event_count", int(s["event_count"]) + len(s["portfolio"].get("last_events", []))


def s_step(params, substep, sH, s, _input, **kwargs):
    return "step", int(s["step"]) + 1


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------

PSUBS = [
    {
        "policies": {"market": p_market},
        "variables": {"env": s_env},
    },
    {
        "policies": {},
        "variables": {"portfolio": s_portfolio_income},
    },
    {
        "policies": {"marks": p_marks},
        "variables": {"book_metrics": s_book_metrics},
    },
    {
        "policies": {"decision": p_decision},
        "variables": {"decision": s_decision},
    },
    {
        "policies": {},
        "variables": {"portfolio": s_portfolio_execute},
    },
    {
        "policies": {},
        "variables": {
            "nav": s_nav,
            "hodl_nav": s_hodl_nav,
            "peak_nav": s_peak_nav,
        },
    },
    {
        "policies": {},
        "variables": {
            "metrics": s_metrics,
            "last_events": s_last_events,
            "event_count": s_event_count,
            "step": s_step,
        },
    },
]


def run_model(
    scenario: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
    T: int | None = None,
) -> pd.DataFrame:
    """Run one cadCAD configuration and return the tidy event table."""
    p = default_params()
    if params:
        p.update(params)
    p["scenario"] = scenario
    if T is None:
        T = len(scenario)

    initial_state = build_initial_state(scenario, p)
    exp = Experiment()
    exp.append_model(
        model_id="allocator",
        sim_configs=config_sim(
            {
                "N": 1,
                "T": range(T),
                "M": {k: [v] for k, v in p.items()},
            }
        ),
        initial_state=initial_state,
        partial_state_update_blocks=PSUBS,
    )
    context = ExecutionContext(context=ExecutionMode.single_mode)
    executor = Executor(exec_context=context, configs=exp.configs, supress_print=True)
    records, _, _ = executor.execute()
    return pd.DataFrame(records)


def metrics_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Return one row per timestep (the last PSUB), with metric columns expanded."""
    last = df[df["substep"] == len(PSUBS)].copy()
    if last.empty:
        return last
    expanded = pd.json_normalize(last["metrics"]).reset_index(drop=True)
    keep = last[["timestep", "subset", "run"]].reset_index(drop=True)
    return pd.concat([keep, expanded], axis=1)
