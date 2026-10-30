from pathlib import Path

import pytest

from lp import price_from_tick, tick_from_price
from scenario import block_bootstrap, load_scenario

HERE = Path(__file__).resolve().parents[1]
SCENARIO = HERE / "data" / "scenario_45d.json"


@pytest.fixture(scope="module")
def real():
    if not SCENARIO.exists():
        pytest.skip("real scenario not built")
    return load_scenario(SCENARIO)


def test_scenario_shape_and_meta(real):
    meta, rows = real
    assert len(rows) == 1080
    assert meta["hours"] == 1080
    assert meta["bookA"]["proxy"] is True
    assert meta["bookB"]["proxy"] is False
    assert meta["bookA"]["feePips"] == 500
    assert meta["bookB"]["feePips"] == 3000
    for row in rows[:5]:
        assert row["price"] > 0
        assert len(row["bookA"]["minutes"]["tick"]) == 60
        assert len(row["bookB"]["minutes"]["tick"]) == 60


def test_scenario_last_20_days(real):
    _, rows = real
    _, rows20 = load_scenario(SCENARIO, hours=480)
    assert len(rows20) == 480
    assert rows20[0]["ts"] == rows[-480]["ts"]


def test_scenario_fee_moments_reproduce_research(real):
    """The minute-level fee moments must reproduce the static research sim."""
    _, rows = real
    refs = {
        "bookA": (0.0006418469159482466, 0.00562879682387296, 500, 245.18959268831065, 222122),
        "bookB": (0.000641514784042553, 0.005625884225574575, 3000, 276.26020450403627, 222111),
    }
    for name, (l_base, l_guard, fee, ref, entry) in refs.items():
        total = 0.0
        for row in rows:
            minutes = row[name]["minutes"]
            v1g = v2g = v1b = v2b = 0.0
            for i, tick in enumerate(minutes["tick"]):
                if tick is None:
                    continue
                v1 = minutes["volOverL"][i]
                v2 = minutes["volOverL2"][i]
                if entry - 6000 <= tick < entry + 6000:
                    v1b += v1
                    v2b += v2
                    if entry - 600 <= tick < entry + 600:
                        v1g += v1
                        v2g += v2
            total += fee / 1e6 * (
                (l_base + l_guard) * v1g
                - (l_base + l_guard) ** 2 * v2g
                + l_base * (v1b - v1g)
                - l_base**2 * (v2b - v2g)
            )
        assert total == pytest.approx(ref, rel=0.01)


def test_block_bootstrap_is_deterministic_and_valid(real):
    _, rows = real
    paths = block_bootstrap(rows, n_paths=3, block_hours=24, seed=7)
    assert len(paths) == 3
    for path in paths:
        assert len(path) == len(rows)
        # Level matching is within one tick; the stored quote is the
        # fractional-tick sqrt price and the bootstrap snaps to the tick grid.
        assert path[0]["price"] == pytest.approx(rows[0]["price"], rel=1e-3)
        for i, row in enumerate(path):
            assert row["price"] > 0
            assert row["tick"] == tick_from_price(row["price"])
            assert row["price"] == price_from_tick(row["tick"])
            assert len(row["bookA"]["minutes"]["tick"]) == 60
            assert row["ts"] == path[0]["ts"] + i * 3600

    paths2 = block_bootstrap(rows, n_paths=3, block_hours=24, seed=7)
    assert [p[10]["price"] for p in paths] == [p[10]["price"] for p in paths2]
