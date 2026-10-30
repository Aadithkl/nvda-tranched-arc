"""Pure port of scripts/keeper/allocator.mjs.

The keeper is the source of truth. This module keeps the same decision order,
thresholds, and one-action-per-run semantics. Amounts are USD / token units
(floats) instead of base units, because the cadCAD model is an economic model,
not a transaction encoder.
"""

from __future__ import annotations

from typing import Any, Iterable

BPS = 10_000.0

DEFAULT_RISK_THRESHOLDS = {
    "maxVolatilityBps": 300,
    "minVolumeUsd": 10_000,
    "minFeeAprBps": 0,
}


def assess_book_risk(
    fee_apr_bps: float,
    volume_usd: float,
    volatility_bps: float,
    guard_present: bool,
    depeg_paused: bool,
    thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return NORMAL/HIGH plus the fired reasons, exactly as the keeper does."""
    t = {**DEFAULT_RISK_THRESHOLDS, **(thresholds or {})}
    reasons: list[str] = []

    if depeg_paused:
        reasons.append("depeg-paused")
    if guard_present is False:
        reasons.append("guard-absent")
    if float(volatility_bps) >= float(t["maxVolatilityBps"]):
        reasons.append(f"volatility {volatility_bps}bps >= {t['maxVolatilityBps']}bps")
    if float(volume_usd) < float(t["minVolumeUsd"]):
        reasons.append(f"volume ${volume_usd} < ${t['minVolumeUsd']}")
    if float(t["minFeeAprBps"]) > 0 and float(fee_apr_bps) < float(t["minFeeAprBps"]):
        reasons.append(f"fee {fee_apr_bps}bps < {t['minFeeAprBps']}bps")

    return {
        "risk": "HIGH" if reasons else "NORMAL",
        "reasons": reasons,
        "feeAprBps": float(fee_apr_bps or 0),
        "volumeUsd": float(volume_usd or 0),
        "volatilityBps": float(volatility_bps or 0),
    }


def decide_by_risk(risk: str, current_mode: str) -> dict[str, str]:
    target = "ARMS" if risk == "HIGH" else "BOOKS"
    if current_mode == target:
        return {"mode": target, "action": "HOLD", "reason": f"{target.lower()} already"}
    return {
        "mode": target,
        "action": "MOVE_TO_ARMS" if target == "ARMS" else "MOVE_TO_BOOKS",
        "reason": "risk high -> safe harbor" if risk == "HIGH" else "risk normal -> book fees",
    }


def borrow_size(
    collateral_value: float,
    ltv_bps: float,
    max_ltv_bps: float,
    hard_cap_bps: float = 3_000,
) -> float:
    """Debt for a collateral value, clamped by the operator target, LLTV and 30%."""
    cap = min(float(ltv_bps), float(max_ltv_bps), float(hard_cap_bps))
    if cap <= 0:
        return 0.0
    return float(collateral_value) * cap / BPS


def plan_arm_entry(
    usdg_available: float,
    nvda_available: float,
    nvda_price: float,
    usdg_deployed: float = 0.0,
    nvda_deployed: float = 0.0,
    ltv_bps: float = 2_937,
    max_ltv_bps: float = 6_250,
    morpho_share_bps: float = 8_000,
    nvda_step_bps: float = 1_000,
) -> dict[str, Any]:
    """One keeper-sized slice of the move into the arms.

    Quote goes first (80% of total quote), NVDA is a small slice (10% of total
    NVDA), and the borrow is 29.375% of the NVDA slice's value (hard-capped at
    30%).
    """
    usdg = max(0.0, float(usdg_available or 0))
    nvda = max(0.0, float(nvda_available or 0))
    usdg_in = max(0.0, float(usdg_deployed or 0))
    nvda_in = max(0.0, float(nvda_deployed or 0))
    price = max(0.0, float(nvda_price or 0))

    usdg_target = (usdg + usdg_in) * min(10_000.0, float(morpho_share_bps)) / BPS
    usdg_move = min(usdg_target - usdg_in, usdg) if usdg_target > usdg_in else 0.0
    usdg_move = max(0.0, usdg_move)

    nvda_step = (nvda + nvda_in) * min(10_000.0, float(nvda_step_bps)) / BPS
    nvda_move = min(nvda_step, nvda)

    collateral_value = nvda_move * price
    borrow = borrow_size(collateral_value, ltv_bps, max_ltv_bps)

    steps: list[dict[str, Any]] = []
    if usdg_move > 0:
        steps.append(
            {
                "action": "ALLOCATE_USDG",
                "amount": usdg_move,
                "note": "Morpho USDG arm first (most of the idle quote)",
            }
        )
    if nvda_move > 0:
        steps.append(
            {
                "action": "ALLOCATE_NVDA",
                "amount": nvda_move,
                "note": "NVDA arm little by little",
            }
        )
    if borrow > 0:
        steps.append(
            {
                "action": "BORROW_USDG",
                "amount": borrow,
                "note": "stock LTV cap < 30%",
            }
        )
        steps.append(
            {
                "action": "ALLOCATE_USDG",
                "amount": borrow,
                "note": "borrowed USDG into the Morpho lend arm",
            }
        )

    return {
        "usdgMove": usdg_move,
        "nvdaMove": nvda_move,
        "borrow": borrow,
        "ltvBps": min(float(ltv_bps), float(max_ltv_bps), 3_000.0),
        "steps": steps,
    }


def plan_book_return(
    usdg_deployed: float,
    nvda_collateral: float,
    debt: float,
    step_bps: float = 2_500,
    dust_usdg: float = 1.0,
    dust_nvda: float = 0.001,
) -> dict[str, Any]:
    """One keeper-sized slice of the return to the books: repay, withdraw, deallocate."""
    step = min(10_000.0, float(step_bps)) / BPS
    usdg = max(0.0, float(usdg_deployed or 0))
    debt_ = max(0.0, float(debt or 0))
    collateral = max(0.0, float(nvda_collateral or 0))

    usdg_out = usdg * step
    if usdg == 0:
        usdg_take = 0.0
    elif usdg <= dust_usdg or usdg_out < dust_usdg:
        usdg_take = usdg
    else:
        usdg_take = usdg_out

    repay_raw = debt_ * step if debt_ > 0 else 0.0
    repay = debt_ if debt_ > 0 and repay_raw < dust_usdg else repay_raw

    collateral_raw = collateral * step if collateral > 0 else 0.0
    if collateral == 0:
        collateral_out = 0.0
    elif collateral <= dust_nvda or collateral_raw < dust_nvda:
        collateral_out = collateral
    else:
        collateral_out = collateral_raw

    steps: list[dict[str, Any]] = []
    if debt_ > 0 and repay > 0:
        steps.append(
            {"action": "REPAY_NVDA", "repay": repay, "note": "repay debt first (risk-reducing)"}
        )
    elif debt_ == 0 and collateral_out > 0:
        steps.append(
            {
                "action": "WITHDRAW_NVDA",
                "collateral": collateral_out,
                "note": "then withdraw NVDA collateral in slices",
            }
        )
    elif usdg_take > 0:
        steps.append(
            {
                "action": "DEALLOCATE_USDG",
                "amount": usdg_take,
                "note": "then pull the remaining USDG lend arm",
            }
        )

    return {
        "steps": steps,
        "usdgOut": usdg_take,
        "repay": repay,
        "collateralOut": collateral_out,
    }


def choose_book(book_apr_a: float, book_apr_b: float, active_book: int = 0) -> int:
    a = float(book_apr_a or 0)
    b = float(book_apr_b or 0)
    if b > a:
        return 1
    if a > b:
        return 0
    return int(active_book or 0)


def decide_pool_switch(
    candidates: Iterable[dict[str, Any]],
    current_pool: str | None,
    switch_buffer_bps: float = 500,
) -> dict[str, Any]:
    """Rank by net APR after IL, skip HIGH-risk candidates, require the buffer."""
    ranked = [
        {**c, "netAprBps": float(c.get("netAprBps") or 0)}
        for c in (candidates or [])
        if c.get("risk") != "HIGH"
    ]
    ranked.sort(key=lambda c: c["netAprBps"], reverse=True)

    best = ranked[0] if ranked else None
    if not best or best["netAprBps"] <= float(switch_buffer_bps):
        return {
            "action": "ARMS",
            "reason": f"no pool with net APR after IL > {switch_buffer_bps}bps",
            "ranked": ranked,
        }

    if current_pool and best.get("name") == current_pool:
        return {
            "action": "HOLD",
            "pool": best["name"],
            "reason": "current pool is best",
            "ranked": ranked,
        }

    current = next((c for c in ranked if c.get("name") == current_pool), None)
    if current and best["netAprBps"] <= current["netAprBps"] + float(switch_buffer_bps):
        return {
            "action": "HOLD",
            "pool": current_pool,
            "reason": "best lead below buffer",
            "ranked": ranked,
        }

    return {
        "action": "SWITCH",
        "pool": best["name"],
        "netAprBps": best["netAprBps"],
        "reason": (
            f"best net APR after IL {best['netAprBps']}bps > buffer {switch_buffer_bps}bps"
        ),
        "ranked": ranked,
    }
