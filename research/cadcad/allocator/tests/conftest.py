"""Shared fixtures for the allocator cadCAD tests."""

from __future__ import annotations

import math
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lp import price_from_tick, tick_from_price  # noqa: E402


def make_scenario(
    n_hours: int = 48,
    price: float = 225.0,
    volume_per_min: float = 100_000.0,
    pool_l: float = 10.0,
    risk_high_hours: int = 0,
    guard_pull_hour: int | None = None,
    volatility_bps: int = 10,
) -> list[dict]:
    """Synthetic hourly scenario with valid minutes/risk/fee moments.

    The price is flat unless ``guard_pull_hour`` is set, in which case that
    hour gets a 300 bps five-minute move.
    """
    tick = tick_from_price(price)
    # Make the quoted price exactly consistent with the integer tick, as the
    # real scenario does. Otherwise a 6-dp price and a rounded tick disagree by
    # a few tenths of a dollar on a $10k book.
    price = price_from_tick(tick)
    sqrt_p = math.sqrt(1.0001**tick)
    v1_min = volume_per_min / pool_l
    v2_min = volume_per_min / (pool_l * pool_l)

    def book_row(hour_price: float, hour_tick: int, thin: bool = False) -> dict:
        vol = volume_per_min * (0.01 if thin else 1.0)
        v1 = vol / pool_l
        v2 = vol / (pool_l * pool_l)
        return {
            "volumeUsd": vol * 60,
            "poolFeesUsd": vol * 60 * 0.0005,
            "volOverL": v1 * 60,
            "volOverL2": v2 * 60,
            "poolLMean": pool_l,
            "poolLLast": pool_l,
            "poolLiquidityUsd": 100_000_000.0,
            "swaps": 60,
            "priceOpen": hour_price,
            "priceClose": hour_price,
            "priceHigh": hour_price,
            "priceLow": hour_price,
            "priceAvg": hour_price,
            "tickOpen": hour_tick,
            "tickClose": hour_tick,
            "fiveMinMoves": [0] * 12,
            "guardPulls": 0,
            "max5mMoveBps": 0,
            "depegProxy": 0,
            "minutes": {
                "tick": [hour_tick] * 60,
                "volume": [vol] * 60,
                "volOverL": [v1] * 60,
                "volOverL2": [v2] * 60,
            },
            "risk": {
                "volumeUsd": 1_000.0 if thin else vol * 60,
                "volatilityBps": volatility_bps,
                "volOverL": v1 * 60,
                "volOverL2": v2 * 60,
                "tickFirst": hour_tick,
                "tickLast": hour_tick,
                "priceFirst": hour_price,
                "priceLast": hour_price,
                "priceAvg": hour_price,
                "priceHigh": hour_price,
                "priceLow": hour_price,
                "poolLMean": pool_l,
                "poolLiquidityUsd": 100_000_000.0,
                "swaps": 60,
            },
        }

    rows = []
    for h in range(n_hours):
        hour_price = price
        hour_tick = tick
        if guard_pull_hour is not None and h == guard_pull_hour:
            hour_tick = tick_from_price(price * 1.03)
            hour_price = price_from_tick(hour_tick)
        row = {
            "t": h,
            "ts": 1_700_000_000 + h * 3600,
            "price": hour_price,
            "tick": hour_tick,
            "sqrtP": math.sqrt(1.0001**hour_tick),
            "bookA": book_row(hour_price, hour_tick),
            "bookB": book_row(hour_price, hour_tick),
        }
        if guard_pull_hour is not None and h == guard_pull_hour:
            row["bookA"]["fiveMinMoves"] = [300] + [0] * 11
            row["bookA"]["guardPulls"] = 1
            row["bookA"]["max5mMoveBps"] = 300
        if h < risk_high_hours:
            row["bookA"]["risk"]["volumeUsd"] = 1_000.0
            row["bookB"]["risk"]["volumeUsd"] = 1_000.0
        rows.append(row)
    return rows


@pytest.fixture(scope="session")
def synthetic_scenario() -> list[dict]:
    return make_scenario(n_hours=48)


@pytest.fixture(scope="session")
def real_scenario() -> list[dict]:
    path = ROOT / "data" / "scenario_45d.json"
    if not path.exists():
        pytest.skip("real 45-day scenario not built")
    from scenario import load_scenario

    _, rows = load_scenario(path)
    return rows
