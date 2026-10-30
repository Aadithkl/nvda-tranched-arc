"""Book-level ETH/NVDA vs USDG/NVDA decomposition.

The allocator model is USDG-quoted. The ETH/NVDA books are a separate
quote-asset comparison: same NVDA asset, different quote. All numbers are in the
book's quote asset (USDG or WETH); the ETH book's USD translation is a separate
input because the downloaded tapes do not include ETH/USD.

For each book:
  fee_pct   = fees / capital
  il_pct    = (LP value - HODL value) / capital
  net_pct   = fee_pct + il_pct              (strategy return vs HODL)
  hodl_pct  = HODL value / capital - 1      (quote-asset price move on the basket)
  total_pct = net_pct + hodl_pct            (strategy NAV return in the quote)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
OUT = ROOT / "out"

BOOKS = [
    ("USDG/NVDA V3 0.05%", "v3-usdg-nvda-005-fee500-45d.json"),
    ("USDG/NVDA V4 0.30%", "v4-usdg-nvda-030-fee3000-45d.json"),
    ("USDG/NVDA V4 0.01%", "v4-usdg-nvda-001-fee100-45d.json"),
    ("ETH/NVDA V3 0.05%", "v3-weth-nvda-005-fee500-45d.json"),
    ("ETH/NVDA V3 0.30%", "v3-weth-nvda-030-fee3000-45d.json"),
    ("ETH/NVDA V4 0.05%", "v4-weth-nvda-005-fee500-45d.json"),
]


def _load(name: str) -> dict[str, Any] | None:
    path = REPO / "research" / "out" / name
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def compare_books(eth_usd_change_pct: float = 0.0) -> list[dict[str, Any]]:
    """Return one decomposition row per book.

    ``eth_usd_change_pct`` is the ETH/USD move over the book window (e.g. 10 for
    +10%). It only affects the ETH books' USD translation and the total USD
    return; the quote-denominated numbers are unchanged.
    """
    rows: list[dict[str, Any]] = []
    for label, filename in BOOKS:
        d = _load(filename)
        if not d:
            continue
        capital = float(d["capital"])
        fees = float(d["feesUsd"])
        position = float(d["positionValueUsd"])
        hodl = float(d["hodlValueUsd"])
        duration_days = float(d["durationSeconds"]) / 86_400.0
        ann = 365.0 / duration_days
        start = d.get("startNvdaQuote", d.get("startNvdaUsd"))
        end = d.get("endNvdaQuote", d.get("endNvdaUsd"))
        price_change_pct = (float(end) / float(start) - 1.0) * 100.0 if start and end else 0.0

        fee_pct = fees / capital * 100.0
        il_pct = (position - hodl) / capital * 100.0
        net_pct = fee_pct + il_pct
        hodl_pct = (hodl / capital - 1.0) * 100.0
        total_pct = net_pct + hodl_pct
        is_eth = "weth" in filename
        total_usd_pct = (
            ((1.0 + total_pct / 100.0) * (1.0 + eth_usd_change_pct / 100.0) - 1.0) * 100.0
            if is_eth
            else total_pct
        )
        rows.append(
            {
                "book": label,
                "quote": "WETH" if is_eth else "USDG",
                "file": filename,
                "capital": capital,
                "duration_days": duration_days,
                "fees": fees,
                "position_value": position,
                "hodl_value": hodl,
                "fee_pct": fee_pct,
                "fee_apr_pct": fee_pct * ann,
                "il_pct": il_pct,
                "il_apr_pct": il_pct * ann,
                "net_pct": net_pct,
                "net_apr_pct": net_pct * ann,
                "hodl_pct": hodl_pct,
                "hodl_apr_pct": hodl_pct * ann,
                "price_change_pct": price_change_pct,
                "price_change_apr_pct": price_change_pct * ann,
                "total_pct": total_pct,
                "total_apr_pct": total_pct * ann,
                "total_usd_pct": total_usd_pct,
                "total_usd_apr_pct": total_usd_pct * ann,
                "guard_in_pct": float(d.get("inGuardPct", 0.0)),
                "fee_apr_json": float(d.get("feeAprPct", 0.0)),
                "net_apr_json": float(d.get("netAprPct", 0.0)),
                "swaps": int(d.get("swaps", 0)),
            }
        )
    return rows


def write_outputs(eth_usd_change_pct: float = 0.0) -> list[dict[str, Any]]:
    rows = compare_books(eth_usd_change_pct)
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "eth_compare.json", "w", encoding="utf-8") as fh:
        json.dump(
            {"eth_usd_change_pct": eth_usd_change_pct, "books": rows},
            fh,
            indent=2,
        )
    try:
        import pandas as pd

        pd.DataFrame(rows).to_csv(OUT / "eth_compare.csv", index=False)
    except Exception:
        pass
    return rows


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--eth-usd-change", type=float, default=0.0)
    args = parser.parse_args()
    for row in write_outputs(args.eth_usd_change):
        print(
            f"{row['book']:24s} {row['quote']:4s} "
            f"fee {row['fee_apr_pct']:6.1f}%  IL {row['il_apr_pct']:6.1f}%  "
            f"net {row['net_apr_pct']:6.1f}%  price {row['price_change_pct']:6.2f}%  "
            f"total {row['total_pct']:6.2f}%  ({row['total_apr_pct']:6.1f}% APR)  "
            f"guard {row['guard_in_pct']:5.1f}%"
        )
