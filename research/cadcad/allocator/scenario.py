"""Scenario loading and block bootstrap for the allocator cadCAD model."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from lp import price_from_tick, tick_from_price


def load_scenario(path: str | Path, hours: int | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Load the hourly scenario. ``hours`` keeps the last N hours (e.g. 480 = 20d)."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    rows = data["hours"]
    if hours is not None:
        if hours <= 0 or hours > len(rows):
            raise ValueError(f"hours must be in 1..{len(rows)}, got {hours}")
        rows = rows[-hours:]
    return data.get("meta", {}), rows


def _shift_row(row: dict[str, Any], factor: float, new_t: int) -> dict[str, Any]:
    """Copy a scenario row, scaling prices by factor and matching ticks."""
    out = dict(row)
    out["t"] = new_t
    new_tick = tick_from_price(row["price"] * factor)
    out["tick"] = new_tick
    out["price"] = price_from_tick(new_tick)
    out["sqrtP"] = math.sqrt(1.0001 ** new_tick)
    shift = new_tick - int(row["tick"])

    for key in ("bookA", "bookB"):
        book = dict(row[key])
        for field in ("priceOpen", "priceClose", "priceHigh", "priceLow", "priceAvg"):
            if field in book and book[field]:
                book[field] = book[field] * factor
        for field in ("tickOpen", "tickClose"):
            if field in book and book[field] is not None:
                book[field] = int(book[field]) + shift
        minutes = book.get("minutes", {})
        book["minutes"] = {
            "tick": [None if t is None else int(t) + shift for t in minutes.get("tick", [])],
            "volume": list(minutes.get("volume", [])),
            "volOverL": list(minutes.get("volOverL", [])),
            "volOverL2": list(minutes.get("volOverL2", [])),
        }
        risk = dict(book.get("risk", {}))
        for field in ("tickFirst", "tickLast"):
            if risk.get(field) is not None:
                risk[field] = int(risk[field]) + shift
        for field in ("priceFirst", "priceLast", "priceAvg", "priceHigh", "priceLow"):
            if risk.get(field):
                risk[field] = risk[field] * factor
        book["risk"] = risk
        out[key] = book
    return out


def block_bootstrap(
    rows: list[dict[str, Any]],
    n_paths: int = 100,
    block_hours: int = 24,
    seed: int = 42,
) -> list[list[dict[str, Any]]]:
    """Fixed-length moving block bootstrap of hourly rows with level matching.

    The price level is rescaled per block so the first row of each block equals
    the previous block's last price. Returns relative to the original path are
    preserved inside a block. Volume, pool liquidity and fee moments come from
    the sampled rows, so the arm/risk state remains tied to real market hours.
    """
    if n_paths <= 0:
        return []
    t_len = len(rows)
    if t_len < block_hours + 1:
        raise ValueError("scenario shorter than the bootstrap block")
    rng = np.random.default_rng(seed)
    paths: list[list[dict[str, Any]]] = []

    for _ in range(n_paths):
        path: list[dict[str, Any]] = []
        prev_price = rows[0]["price"]
        while len(path) < t_len:
            start = int(rng.integers(0, max(1, t_len - block_hours + 1)))
            block = rows[start : start + block_hours]
            factor = prev_price / block[0]["price"] if block[0]["price"] > 0 else 1.0
            for r in block:
                if len(path) >= t_len:
                    break
                shifted = _shift_row(r, factor, len(path))
                # Keep the timestamp monotonic across sampled blocks.
                shifted["ts"] = rows[0]["ts"] + len(path) * 3600
                path.append(shifted)
            prev_price = path[-1]["price"]
        paths.append(path)
    return paths
