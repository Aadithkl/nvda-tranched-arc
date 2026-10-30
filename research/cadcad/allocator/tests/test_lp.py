import math

import pytest

from lp import (
    il_bps_for_half_width,
    il_bps_for_ticks,
    js_round,
    liquidity_for_value,
    position_value_usd,
    price_from_sqrt_x96,
    price_from_tick,
    range_from_half_width,
    tick_from_price,
    token_amounts,
)


def test_js_round_matches_js_semantics():
    assert js_round(2.4) == 2
    assert js_round(2.5) == 3
    assert js_round(2.6) == 3
    assert js_round(-2.5) == -2
    assert js_round(-2.6) == -3


def test_price_tick_round_trip():
    for tick in (0, 222_122, 222_780, -50_000):
        price = price_from_tick(tick)
        assert tick_from_price(price) == tick


def test_price_from_sqrt_x96_matches_tick_price():
    tick = 222_122
    sqrt_x96 = int(math.sqrt(1.0001**tick) * 2**96)
    p = price_from_sqrt_x96(sqrt_x96)
    assert p == pytest.approx(price_from_tick(tick), rel=1e-9)


def test_position_value_and_liquidity_inverse():
    tick = 222_122
    sqrt_p = math.sqrt(1.0001**tick)
    lo, hi = tick - 6_000, tick + 6_000
    l_norm = liquidity_for_value(5_000.0, sqrt_p, lo, hi)
    assert l_norm > 0
    assert position_value_usd(l_norm, sqrt_p, lo, hi) == pytest.approx(5_000.0, rel=1e-9)


def test_token_amounts_sum_to_position_value():
    tick = 222_122
    sqrt_p = math.sqrt(1.0001**tick)
    lo, hi = tick - 600, tick + 600
    l_norm = liquidity_for_value(5_000.0, sqrt_p, lo, hi)
    x, y = token_amounts(l_norm, sqrt_p, lo, hi)
    value = x + y * price_from_tick(tick)
    assert value == pytest.approx(5_000.0, rel=1e-6)


def test_research_sim_liquidity_values():
    # From research/out/v3-usdg-nvda-005-fee500-45d.json: LBaseRaw / LGuardRaw.
    tick = 222_122
    sqrt_p = math.sqrt(1.0001**tick)
    base = liquidity_for_value(5_000.0, sqrt_p, tick - 6_000, tick + 6_000)
    guard = liquidity_for_value(5_000.0, sqrt_p, tick - 600, tick + 600)
    assert base == pytest.approx(0.0006418469159482466, rel=1e-5)
    assert guard == pytest.approx(0.00562879682387296, rel=1e-5)


def test_il_zero_when_price_unchanged():
    assert il_bps_for_ticks(222_122, 222_122, 216_122, 228_122) == 0


def test_il_negative_when_price_moves():
    il = il_bps_for_ticks(222_122, 223_500, 216_122, 228_122)
    assert il < 0


def test_il_full_range_matches_closed_form():
    p0, p1 = 100.0, 110.0
    expected = js_round(((2 * math.sqrt(p1 / p0)) / (1 + p1 / p0) - 1) * 10_000)
    assert il_bps_for_half_width(p0, p1, 10_000) == expected


def test_range_from_half_width():
    lo, hi = range_from_half_width(100_000, 1_000)
    assert lo < 100_000 < hi
    assert hi - lo == 2 * round(math.log(1.1) / math.log(1.0001))
