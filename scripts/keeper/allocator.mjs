// Risk-based allocator. No APR comparison and no min-carry rule.
//
// The book is the yield venue; the Morpho arms are the safe harbor.
// Decision inputs are on-chain, over the last few hours:
//   - pool fee APR (fees / NAV)
//   - swap volume (thin volume = fragile book)
//   - price fluctuation (high volatility = risky book)
//   - guard / depeg state (hard safety signals)
//
// If risk is HIGH, move to the arms. The arms are treated as low-risk
// destinations, not as a yield comparison. Capital moves in steps:
//   1. most of the idle quote to the Morpho USDG lend arm first
//   2. NVDA to the collateral/borrow arm little by little
//   3. borrowed USDG also goes to the Morpho lend arm
// Hard stock LTV cap: < 30%.

const BPS = 10_000n;

export const DEFAULT_RISK_THRESHOLDS = {
  // Price range over the lookback (bps). 300 = 3%.
  maxVolatilityBps: 300,
  // Swap notional over the lookback (USD). Thin book = high risk.
  minVolumeUsd: 10_000,
  // Optional fee floor. 0 disables it, so there is no APR target by default.
  minFeeAprBps: 0,
};

/**
 * Assess book risk from the last few hours of on-chain data.
 * Returns risk HIGH if any hard safety signal fires, otherwise NORMAL.
 */
export function assessBookRisk({
  feeAprBps,
  volumeUsd,
  volatilityBps,
  guardPresent,
  depegPaused,
  thresholds = {},
}) {
  const t = { ...DEFAULT_RISK_THRESHOLDS, ...thresholds };
  const reasons = [];

  if (depegPaused) reasons.push("depeg-paused");
  if (guardPresent === false) reasons.push("guard-absent");
  if (Number(volatilityBps) >= Number(t.maxVolatilityBps)) {
    reasons.push(`volatility ${volatilityBps}bps >= ${t.maxVolatilityBps}bps`);
  }
  if (Number(volumeUsd) < Number(t.minVolumeUsd)) {
    reasons.push(`volume $${volumeUsd} < $${t.minVolumeUsd}`);
  }
  if (Number(t.minFeeAprBps) > 0 && Number(feeAprBps) < Number(t.minFeeAprBps)) {
    reasons.push(`fee ${feeAprBps}bps < ${t.minFeeAprBps}bps`);
  }

  return {
    risk: reasons.length > 0 ? "HIGH" : "NORMAL",
    reasons,
    feeAprBps: Number(feeAprBps ?? 0),
    volumeUsd: Number(volumeUsd ?? 0),
    volatilityBps: Number(volatilityBps ?? 0),
  };
}

/**
 * The only mode decision: high risk -> arms, otherwise books.
 * No fee-vs-arm APR comparison. `currentMode` is used only to avoid a no-op.
 */
export function decideByRisk({ risk, currentMode }) {
  const target = risk === "HIGH" ? "ARMS" : "BOOKS";
  if (currentMode === target) {
    return { mode: target, action: "HOLD", reason: `${target.toLowerCase()} already` };
  }
  return {
    mode: target,
    action: target === "ARMS" ? "MOVE_TO_ARMS" : "MOVE_TO_BOOKS",
    reason: risk === "HIGH" ? "risk high -> safe harbor" : "risk normal -> book fees",
  };
}

/**
 * Borrow size: LTV safety cap only. No carry gate, no yield target.
 * `ltvBps` is the operator target, `maxLtvBps` the market LLTV, and the
 * hard cap keeps the position below 30% LTV.
 */
export function borrowSize({ collateralValue, ltvBps, maxLtvBps, hardCapBps = 3_000 }) {
  const cap = Math.min(Number(ltvBps), Number(maxLtvBps), Number(hardCapBps));
  if (cap <= 0) return 0n;
  return (BigInt(collateralValue) * BigInt(cap)) / BPS;
}

/**
 * Plan one step of the move into the arms.
 *
 * `nvdaPriceWad` is USDG per NVDA scaled by 1e18. The NVDA amount is a small
 * slice of the idle NVDA per tick; the quote goes first and in a larger slice.
 * `ltvBps` default 2937 = 29.375% LTV on a 62.5% LLTV market (< 30%).
 */
export function planArmEntry({
  usdgAvailable,
  nvdaAvailable,
  usdgDeployed = 0n,
  nvdaDeployed = 0n,
  nvdaPriceWad,
  ltvBps = 2_937,
  maxLtvBps = 6_250,
  morphoShareBps = 8_000,
  nvdaStepBps = 1_000,
}) {
  const usdg = BigInt(usdgAvailable ?? 0);
  const nvda = BigInt(nvdaAvailable ?? 0);
  const usdgIn = BigInt(usdgDeployed ?? 0);
  const nvdaIn = BigInt(nvdaDeployed ?? 0);
  const price = BigInt(nvdaPriceWad ?? 0);

  // Quote target: 80% of total quote (idle + already deployed); move only the gap.
  const usdgTarget = ((usdg + usdgIn) * BigInt(Math.min(10_000, Number(morphoShareBps)))) / BPS;
  const usdgMove = usdgTarget > usdgIn
    ? (usdgTarget - usdgIn < usdg ? usdgTarget - usdgIn : usdg)
    : 0n;

  // NVDA target: a small slice of total NVDA per tick, capped by what is idle.
  const nvdaStep = ((nvda + nvdaIn) * BigInt(Math.min(10_000, Number(nvdaStepBps)))) / BPS;
  const nvdaMove = nvdaStep < nvda ? nvdaStep : nvda;

  // NVDA base units (18) * USDG/NVDA price (1e18) / 1e30 = USDG base units (6).
  const collateralValue = (nvdaMove * price) / 10n ** 30n;
  const borrow = borrowSize({ collateralValue, ltvBps, maxLtvBps });

  const steps = [];
  if (usdgMove > 0n) {
    steps.push({
      action: "ALLOCATE_USDG",
      amount: usdgMove,
      note: "Morpho USDG arm first (most of the idle quote)",
    });
  }
  if (nvdaMove > 0n) {
    steps.push({
      action: "ALLOCATE_NVDA",
      amount: nvdaMove,
      note: "NVDA arm little by little",
    });
  }
  if (borrow > 0n) {
    steps.push({
      action: "BORROW_USDG",
      amount: borrow,
      note: "stock LTV cap < 30%",
    });
    steps.push({
      action: "ALLOCATE_USDG",
      amount: borrow,
      note: "borrowed USDG into the Morpho lend arm",
    });
  }

  return {
    usdgMove,
    nvdaMove,
    borrow,
    ltvBps: Math.min(Number(ltvBps), Number(maxLtvBps), 3_000),
    steps,
  };
}

/**
 * Plan one step of the return to the book.
 * Risk-first: repay debt, then withdraw collateral, then pull the remaining quote.
 * The quote leg is pulled on demand by `ensureVaultUsdg` when a repayment needs it.
 */
export function planBookReturn({
  usdgDeployed,
  nvdaCollateral,
  debt,
  stepBps = 2_500,
  dustUsdg = 1_000_000n,
  dustNvda = 1_000_000_000_000_000n,
}) {
  const step = BigInt(Math.min(10_000, Number(stepBps)));
  const usdg = BigInt(usdgDeployed ?? 0);
  const debt_ = BigInt(debt ?? 0);
  const collateral = BigInt(nvdaCollateral ?? 0);

  const usdgOut = (usdg * step) / BPS;
  const usdgTake =
    usdg === 0n
      ? 0n
      : usdg <= BigInt(dustUsdg) || usdgOut < BigInt(dustUsdg)
        ? usdg
        : usdgOut;

  const repayRaw = debt_ > 0n ? (debt_ * step) / BPS : 0n;
  const repay = debt_ > 0n && repayRaw < BigInt(dustUsdg) ? debt_ : repayRaw;

  const collateralRaw = collateral > 0n ? (collateral * step) / BPS : 0n;
  const collateralOut =
    collateral === 0n
      ? 0n
      : collateral <= BigInt(dustNvda) || collateralRaw < BigInt(dustNvda)
        ? collateral
        : collateralRaw;

  const steps = [];
  if (debt_ > 0n && repay > 0n) {
    steps.push({ action: "REPAY_NVDA", repay, note: "repay debt first (risk-reducing)" });
  } else if (debt_ === 0n && collateralOut > 0n) {
    steps.push({
      action: "WITHDRAW_NVDA",
      collateral: collateralOut,
      note: "then withdraw NVDA collateral in slices",
    });
  } else if (usdgTake > 0n) {
    steps.push({
      action: "DEALLOCATE_USDG",
      amount: usdgTake,
      note: "then pull the remaining USDG lend arm",
    });
  }

  return { steps, usdgOut: usdgTake, repay, collateralOut };
}

/** Choose the book with the higher realized fee APR. Keep the active one on a tie. */
export function chooseBook({ bookAprA, bookAprB, activeBook }) {
  const a = Number(bookAprA ?? 0);
  const b = Number(bookAprB ?? 0);
  if (b > a) return 1;
  if (a > b) return 0;
  return Number(activeBook ?? 0);
}

/**
 * Cross-pool switch: rank candidates by **net APR after IL** (fee APR minus
 * the book's IL), not raw fee APR. A candidate is eligible only if its
 * on-chain risk is not HIGH. The best candidate must beat the switch buffer,
 * and must beat the current pool by the same buffer, before capital moves.
 * If none does, the arms are the safe harbor.
 *
 * `candidates`: [{ name, poolId?, netAprBps, risk? }]
 */
export function decidePoolSwitch({ candidates, currentPool, switchBufferBps = 500 }) {
  const ranked = (candidates ?? [])
    .filter((c) => c.risk !== "HIGH")
    .map((c) => ({ ...c, netAprBps: Number(c.netAprBps ?? 0) }))
    .sort((a, b) => b.netAprBps - a.netAprBps);

  const best = ranked[0];
  if (!best || best.netAprBps <= Number(switchBufferBps)) {
    return {
      action: "ARMS",
      reason: `no pool with net APR after IL > ${switchBufferBps}bps`,
      ranked,
    };
  }

  if (currentPool && best.name === currentPool) {
    return { action: "HOLD", pool: best.name, reason: "current pool is best", ranked };
  }

  const current = ranked.find((c) => c.name === currentPool);
  if (current && best.netAprBps <= current.netAprBps + Number(switchBufferBps)) {
    return { action: "HOLD", pool: currentPool, reason: "best lead below buffer", ranked };
  }

  return {
    action: "SWITCH",
    pool: best.name,
    netAprBps: best.netAprBps,
    reason: `best net APR after IL ${best.netAprBps}bps > buffer ${switchBufferBps}bps`,
    ranked,
  };
}
