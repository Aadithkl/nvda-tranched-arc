"""Concentrated-liquidity math for the USDG/NVDA books.

All liquidity values are normalised by 1e18 (``L_norm``), so a raw v3/v4
liquidity of 6.4e14 is 0.00064. Prices are USDG per NVDA. The raw pool price is
token1/token0 in base units; ticks use the raw price, so the 1e-12 decimal
factor cancels in every ratio.

Ported from scripts/keeper/stats.mjs and scripts/research/simulate_hook.mjs.
"""

from __future__ import annotations

import math

TOKEN0_DECIMALS = 6  # USDG
TOKEN1_DECIMALS = 18  # NVDA
Q96 = 2**96


def js_round(x: float) -> int:
    """JavaScript Math.round semantics (half toward +Infinity)."""
    return int(math.floor(float(x) + 0.5))


def sqrt_at_tick(tick: int | float) -> float:
    return math.sqrt(1.0001 ** float(tick))


def price_from_tick(tick: int | float) -> float:
    """USDG per NVDA from a raw Uniswap tick."""
    return 1e12 / (1.0001 ** float(tick))


def tick_from_price(price: float) -> int:
    """Inverse of price_from_tick (raw tick, rounded)."""
    if not (price > 0):
        raise ValueError("price must be positive")
    return int(round(math.log(1e12 / price) / math.log(1.0001)))


def price_from_sqrt_x96(sqrt_price_x96: int | float) -> float:
    """USDG per NVDA from a raw sqrtPriceX96."""
    sqrt_p = float(sqrt_price_x96) / Q96
    raw = sqrt_p * sqrt_p  # token1/token0 in base units
    return 1.0 / (raw * 10 ** (TOKEN0_DECIMALS - TOKEN1_DECIMALS))


def _amounts_for_l(
    l_norm: float,
    sqrt_p: float,
    tick_lower: int,
    tick_upper: int,
) -> tuple[float, float]:
    """Raw (token0, token1) amounts for a normalised L at sqrt_p."""
    if not (l_norm > 0) or not (sqrt_p > 0) or tick_upper <= tick_lower:
        return 0.0, 0.0

    liquidity = float(l_norm) * 1e18
    sqrt_a = sqrt_at_tick(tick_lower)
    sqrt_b = sqrt_at_tick(tick_upper)
    if not (sqrt_b > sqrt_a):
        return 0.0, 0.0

    if sqrt_p <= sqrt_a:
        x = liquidity * (1.0 / sqrt_a - 1.0 / sqrt_b)
        y = 0.0
    elif sqrt_p >= sqrt_b:
        x = 0.0
        y = liquidity * (sqrt_b - sqrt_a)
    else:
        x = liquidity * (1.0 / sqrt_p - 1.0 / sqrt_b)
        y = liquidity * (sqrt_p - sqrt_a)
    return x, y


def position_value_usd(
    l_norm: float,
    sqrt_p: float,
    tick_lower: int,
    tick_upper: int,
) -> float:
    """USDG value of a normalised L position at sqrt_p."""
    x, y = _amounts_for_l(l_norm, sqrt_p, tick_lower, tick_upper)
    return (x + y / (sqrt_p * sqrt_p)) / 10**TOKEN0_DECIMALS


def token_amounts(
    l_norm: float,
    sqrt_p: float,
    tick_lower: int,
    tick_upper: int,
) -> tuple[float, float]:
    """Human (USDG, NVDA) amounts of a normalised L position."""
    x, y = _amounts_for_l(l_norm, sqrt_p, tick_lower, tick_upper)
    return x / 10**TOKEN0_DECIMALS, y / 10**TOKEN1_DECIMALS


def liquidity_for_value(
    value_usd: float,
    sqrt_p: float,
    tick_lower: int,
    tick_upper: int,
) -> float:
    """Normalised L that is worth ``value_usd`` in the range at sqrt_p."""
    if not (value_usd > 0):
        return 0.0
    per_l = position_value_usd(1.0, sqrt_p, tick_lower, tick_upper)
    if not (per_l > 0):
        return 0.0
    return float(value_usd) / per_l


def _il_for_range(p0: float, p1: float, pa: float, pb: float) -> int:
    if not (p0 > 0 and p1 > 0 and pa > 0 and pb > pa):
        return 0
    sqrt_a = math.sqrt(pa)
    sqrt_b = math.sqrt(pb)

    def amounts(price: float) -> tuple[float, float]:
        sqrt_price = math.sqrt(price)
        if price <= pa:
            return 1.0 / sqrt_a - 1.0 / sqrt_b, 0.0
        if price >= pb:
            return 0.0, sqrt_b - sqrt_a
        return 1.0 / sqrt_price - 1.0 / sqrt_b, sqrt_price - sqrt_a

    x0, y0 = amounts(p0)
    x1, y1 = amounts(p1)
    hodl = x0 + y0 / p1
    lp = x1 + y1 / p1
    if not (hodl > 0):
        return 0
    return js_round((lp / hodl - 1.0) * 10_000)


def il_bps_for_ticks(
    tick_start: int | float,
    tick_end: int | float,
    tick_lower: int | float,
    tick_upper: int | float,
) -> int:
    """IL in bps (<=0) for a position held from tick_start to tick_end."""
    values = [tick_start, tick_end, tick_lower, tick_upper]
    if any(v is None or not math.isfinite(float(v)) for v in values):
        return 0
    lo = float(tick_lower)
    hi = float(tick_upper)
    if hi <= lo:
        return 0
    p = lambda t: 1.0001 ** float(t)
    return _il_for_range(p(tick_start), p(tick_end), p(lo), p(hi))


def il_bps_for_half_width(
    price_start: float,
    price_end: float,
    half_width_bps: int = 1_000,
) -> int:
    """Static-range IL for a range centred on price_start."""
    p0 = float(price_start)
    p1 = float(price_end)
    if not (p0 > 0 and p1 > 0):
        return 0
    w = float(half_width_bps) / 10_000.0
    if w >= 1.0:
        r = p1 / p0
        return js_round(((2.0 * math.sqrt(r)) / (1.0 + r) - 1.0) * 10_000)
    return _il_for_range(p0, p1, p0 * (1.0 - w), p0 * (1.0 + w))


def range_from_half_width(
    current_tick: int | float,
    half_width_bps: int = 1_000,
) -> tuple[int, int]:
    """Tick range around the current tick for a price half-width in bps."""
    w = min(0.99, float(half_width_bps) / 10_000.0)
    ticks = max(1, int(round(math.log(1.0 + w) / math.log(1.0001))))
    center = int(current_tick)
    return center - ticks, center + ticks


def width_to_ticks(half_width_ticks: int) -> int:
    return int(half_width_ticks)
