import json
from pathlib import Path

import pytest

from eth_compare import compare_books

HERE = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def books():
    try:
        return compare_books(0.0)
    except FileNotFoundError:
        pytest.skip("research/out ETH/USDG sims not present")


def test_six_books_and_identity(books):
    assert len(books) == 6
    for b in books:
        assert b["fee_apr_pct"] > 0
        assert b["net_pct"] == pytest.approx(b["fee_pct"] + b["il_pct"])
        assert b["total_pct"] == pytest.approx(b["net_pct"] + b["hodl_pct"])
        assert b["total_apr_pct"] == pytest.approx(
            b["total_pct"] * 365.0 / b["duration_days"]
        )
        assert b["guard_in_pct"] > 0
        assert b["price_change_pct"] < 0


def test_eth_books_have_smaller_quote_price_fall(books):
    usdg = next(b for b in books if b["book"] == "USDG/NVDA V3 0.05%")
    eth = next(b for b in books if b["book"] == "ETH/NVDA V3 0.05%")
    assert eth["price_change_pct"] > usdg["price_change_pct"]
    assert eth["fee_apr_pct"] > usdg["fee_apr_pct"]
    assert eth["net_apr_pct"] > usdg["net_apr_pct"]


def test_eth_usd_translation(books):
    eth = next(b for b in books if b["quote"] == "WETH")
    usdg = next(b for b in books if b["quote"] == "USDG")
    assert eth["total_usd_pct"] == pytest.approx(eth["total_pct"])
    shifted = compare_books(10.0)
    eth10 = next(b for b in shifted if b["book"] == eth["book"])
    usdg10 = next(b for b in shifted if b["book"] == usdg["book"])
    expected = ((1 + eth["total_pct"] / 100) * 1.10 - 1) * 100
    assert eth10["total_usd_pct"] == pytest.approx(expected)
    assert usdg10["total_usd_pct"] == pytest.approx(usdg["total_pct"])


def test_eth_compare_outputs_exist():
    out = HERE / "out" / "eth_compare.json"
    if not out.exists():
        pytest.skip("eth_compare output not built")
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["books"]
    assert "eth_usd_change_pct" in data
