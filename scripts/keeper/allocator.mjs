// Allocator building blocks. Pure functions only: no I/O, no market addresses.
//
// The book is the yield venue; the arms are the safe harbor. Risk inputs are
// on-chain over a lookback window:
//   - pool fee APR (fees / NAV)
//   - swap volume (thin volume = fragile book)
//   - price fluctuation (high volatility = risky book)
//   - guard / depeg state (hard safety signals)
//
// Every market parameter (LLTV, price, caps, liquidity) is supplied by the
// caller. The defaults in this file are strategy policy only, never a specific
// market's LLTV or address.

const BPS = 10_000n;
const BPS_NUMBER = 10_000;
const WAD = 10n ** 18n;

export const DEFAULT_RISK_THRESHOLDS = {
  // Price range over the lookback (bps). 300 = 3%.
  maxVolatilityBps: 300,
  // Swap notional over the lookback (USD). Thin book = high risk.
  minVolumeUsd: 10_000,
  // Optional fee floor. 0 disables it, so there is no APR target by default.
  minFeeAprBps: 0,
};

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  const n = finiteNumber(value, fallback);
  return n > 0 ? n : 0;
}

/**
 * Coerce a token amount to a non-negative BigInt. Prefer BigInt/string inputs
 * for values above Number.MAX_SAFE_INTEGER; fractional Numbers are truncated.
 */
function toBigInt(value) {
  if (typeof value === "bigint") return value > 0n ? value : 0n;
  if (value === null || value === undefined) return 0n;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.trunc(n));
}

function clampDecimals(value, fallback) {
  return Math.max(0, Math.min(36, Math.trunc(finiteNumber(value, fallback))));
}

function pow10(decimals) {
  return 10n ** BigInt(clampDecimals(decimals, 0));
}

/** USD -> token base units, rounded to the nearest base unit. */
function usdToBaseUnits(usd, decimals) {
  const d = clampDecimals(decimals, 0);
  const amount = nonNegativeNumber(usd);
  if (amount === 0) return 0n;
  const fixed = amount.toFixed(d);
  if (/^\d+(\.\d+)?$/.test(fixed)) return BigInt(fixed.replace(".", ""));
  // Only reachable for values rendered in exponential notation.
  return toBigInt(amount * Number(pow10(d)));
}

/** USD -> equity base units. `roundUp` keeps the reserve intact. */
function usdToEquityBase(usd, priceWad, equityDecimals, roundUp) {
  const price = toBigInt(priceWad);
  if (price === 0n) return 0n;
  const usdWad = usdToBaseUnits(usd, 18);
  if (usdWad === 0n) return 0n;
  const numerator = usdWad * pow10(equityDecimals);
  return roundUp ? (numerator + price - 1n) / price : numerator / price;
}

/** Quote base units -> equity base units at `priceWad` (USD per equity, 1e18). */
function quoteToEquityBase(amount, priceWad, equityDecimals, quoteDecimals) {
  const quote = toBigInt(amount);
  const price = toBigInt(priceWad);
  if (quote === 0n || price === 0n) return 0n;
  return (quote * pow10(equityDecimals) * WAD) / (pow10(quoteDecimals) * price);
}

/** Equity base units -> human USD at `priceWad` (USD per equity, 1e18). */
function equityToUsd(amount, priceWad, equityDecimals) {
  const equity = toBigInt(amount);
  const price = toBigInt(priceWad);
  if (equity === 0n || price === 0n) return 0;
  // equity (base) * price (USD * 1e18) / 10^decimals = USD * 1e18, so the
  // single /1e18 below is the only WAD unwrap. Dividing here as well would
  // return USD * 1e-18 and make every sweep gate compare against ~0.
  const usdWad = (equity * price) / pow10(equityDecimals);
  return Number(usdWad) / 1e18;
}

function quoteToUsd(amount, quoteDecimals) {
  return Number(toBigInt(amount)) / Number(pow10(quoteDecimals));
}

function minBigInt(...values) {
  return values.reduce((min, value) => (value < min ? value : min));
}

function validateLtvBps({ targetLtvBps, maxLtvBps }) {
  const target = finiteNumber(targetLtvBps);
  const max = finiteNumber(maxLtvBps);
  if (target < 0 || max < 0 || max > BPS_NUMBER || target > max) {
    throw new RangeError(
      `invalid LTV: targetLtvBps=${target} maxLtvBps=${max} ` +
        `(need 0 <= targetLtvBps <= maxLtvBps <= ${BPS_NUMBER})`,
    );
  }
  return { targetLtvBps: target, maxLtvBps: max };
}

function sweepGate({ amountUsd, aprBps, minSweepUsd, gasCostUsd, maxPaybackDays }) {
  const amount = nonNegativeNumber(amountUsd);
  const minSweep = nonNegativeNumber(minSweepUsd);
  const gas = nonNegativeNumber(gasCostUsd);
  const maxDays = finiteNumber(maxPaybackDays, Infinity);
  const paybackDays =
    gas <= 0 ? 0 : gasPaybackDays({ amountUsd: amount, aprBps, gasCostUsd: gas });

  if (amount < minSweep) {
    return { ok: false, reason: `sweep $${amount} < min $${minSweep}`, paybackDays };
  }
  if (!Number.isFinite(paybackDays) || paybackDays > maxDays) {
    return { ok: false, reason: `payback ${paybackDays}d > max ${maxDays}d`, paybackDays };
  }
  return { ok: true, reason: "", paybackDays };
}

function noSweep(reason, paybackDays = 0) {
  return { action: "NONE", amount: 0n, amountUsd: 0, reason, paybackDays };
}

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
 * Guard-history safe-harbor gate.
 *
 * Guard absence alone is NOT a gate: a recalled book is guard-less by design.
 * Only guard history on a funded, currently-book-mode position can force arms.
 * This prevents the one-way door where `!guardPresent` traps the allocator in ARMS.
 */
export function guardSafeHarbor({
  currentMode,
  bookHasPosition,
  guardRecentlyPulled,
  guardPulls,
  maxGuardPulls,
}) {
  if (currentMode !== "BOOKS" || !bookHasPosition) {
    return { blocked: false, wait: false, reason: "guard-state-not-applicable" };
  }
  if (Number(guardPulls) > Number(maxGuardPulls)) {
    return { blocked: true, wait: false, reason: `guard-pulls=${guardPulls}` };
  }
  // A single/recent pull is transient: stay in the allocator, re-fund/stage the
  // book, and let recheckGuard re-arm. Only exceeding the per-run max arms.
  if (Number(guardPulls) > 0 || guardRecentlyPulled) {
    return { blocked: false, wait: true, reason: "recent-guard-pull-wait" };
  }
  return { blocked: false, wait: false, reason: "guard-history-clear" };
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
 * `targetLtvBps` (or its legacy alias `ltvBps`) is the operator target,
 * `maxLtvBps` the market LLTV, and `hardCapBps` an operator policy cap.
 * Missing `maxLtvBps` means 0: no LLTV is inferred.
 */
export function borrowSize({
  collateralValue,
  ltvBps,
  targetLtvBps,
  maxLtvBps,
  hardCapBps = 3_000,
}) {
  const requested = targetLtvBps ?? ltvBps ?? 0;
  const cap = Math.min(
    nonNegativeNumber(requested),
    nonNegativeNumber(maxLtvBps),
    nonNegativeNumber(hardCapBps, 3_000),
    BPS_NUMBER,
  );
  if (cap <= 0) return 0n;
  return (toBigInt(collateralValue) * BigInt(Math.trunc(cap))) / BPS;
}

/**
 * Plan one step of the move into the arms.
 *
 * `nvdaPriceWad` is quote per equity scaled by 1e18. The equity amount is a
 * small slice of the idle equity per tick; the quote goes first and in a larger
 * slice. `targetLtvBps` is required for borrowing (`ltvBps` is a legacy alias),
 * and `maxLtvBps` is the caller-supplied market LLTV. No LLTV is inferred.
 */
export function planArmEntry({
  usdgAvailable,
  nvdaAvailable,
  usdgDeployed = 0n,
  nvdaDeployed = 0n,
  nvdaPriceWad,
  targetLtvBps,
  ltvBps,
  maxLtvBps,
  hardCapBps = 3_000,
  morphoShareBps = 8_000,
  nvdaStepBps = 1_000,
}) {
  const usdg = toBigInt(usdgAvailable);
  const nvda = toBigInt(nvdaAvailable);
  const usdgIn = toBigInt(usdgDeployed);
  const nvdaIn = toBigInt(nvdaDeployed);
  const price = toBigInt(nvdaPriceWad);
  const target = targetLtvBps ?? ltvBps ?? 0;

  // Quote target: `morphoShareBps` of total quote (idle + deployed); move only the gap.
  const shareBps = Math.min(BPS_NUMBER, nonNegativeNumber(morphoShareBps, 8_000));
  const usdgTarget = ((usdg + usdgIn) * BigInt(Math.trunc(shareBps))) / BPS;
  const usdgMove = usdgTarget > usdgIn
    ? (usdgTarget - usdgIn < usdg ? usdgTarget - usdgIn : usdg)
    : 0n;

  // Equity target: a small slice of total equity per tick, capped by what is idle.
  const stepBps = Math.min(BPS_NUMBER, nonNegativeNumber(nvdaStepBps, 1_000));
  const nvdaStep = ((nvda + nvdaIn) * BigInt(Math.trunc(stepBps))) / BPS;
  const nvdaMove = nvdaStep < nvda ? nvdaStep : nvda;

  // Equity base units (18) * quote/equity price (1e18) / 1e30 = quote base units (6).
  const collateralValue = (nvdaMove * price) / 10n ** 30n;
  const borrow = borrowSize({ collateralValue, targetLtvBps: target, maxLtvBps, hardCapBps });

  const steps = [];
  if (usdgMove > 0n) {
    steps.push({
      action: "ALLOCATE_USDG",
      amount: usdgMove,
      note: "Morpho quote arm first (most of the idle quote)",
    });
  }
  if (nvdaMove > 0n) {
    steps.push({
      action: "ALLOCATE_NVDA",
      amount: nvdaMove,
      note: "equity collateral little by little",
    });
  }
  if (borrow > 0n) {
    steps.push({
      action: "BORROW_USDG",
      amount: borrow,
      note: "borrow at the operator LTV cap",
    });
    steps.push({
      action: "ALLOCATE_USDG",
      amount: borrow,
      note: "borrowed quote into the Morpho lend arm",
    });
  }

  const effectiveLtvBps = Math.max(
    0,
    Math.min(
      finiteNumber(target),
      finiteNumber(maxLtvBps),
      finiteNumber(hardCapBps, 3_000),
      BPS_NUMBER,
    ),
  );

  return {
    usdgMove,
    nvdaMove,
    borrow,
    ltvBps: effectiveLtvBps,
    targetLtvBps: effectiveLtvBps,
    steps,
  };
}

/**
 * Plan one step of the return to the book.
 * Risk-first: repay debt, then withdraw collateral, then pull the remaining quote.
 * The quote leg is pulled on demand by `ensureVaultUsdg` when a repayment needs it.
 * `stepBps` may be 10000 for the urgent/full-exit path.
 */
export function planBookReturn({
  usdgDeployed,
  nvdaCollateral,
  debt,
  stepBps = 2_500,
  dustUsdg = 1_000_000n,
  dustNvda = 1_000_000_000_000_000n,
}) {
  const step = BigInt(
    Math.trunc(Math.min(BPS_NUMBER, nonNegativeNumber(stepBps, 2_500))),
  );
  const usdg = toBigInt(usdgDeployed);
  const debt_ = toBigInt(debt);
  const collateral = toBigInt(nvdaCollateral);
  const dustUsdgAmount = toBigInt(dustUsdg);
  const dustNvdaAmount = toBigInt(dustNvda);

  const usdgOut = (usdg * step) / BPS;
  const usdgTake =
    usdg === 0n
      ? 0n
      : usdg <= dustUsdgAmount || usdgOut < dustUsdgAmount
        ? usdg
        : usdgOut;

  const repayRaw = debt_ > 0n ? (debt_ * step) / BPS : 0n;
  const repay = debt_ > 0n && repayRaw < dustUsdgAmount ? debt_ : repayRaw;

  const collateralRaw = collateral > 0n ? (collateral * step) / BPS : 0n;
  const collateralOut =
    collateral === 0n
      ? 0n
      : collateral <= dustNvdaAmount || collateralRaw < dustNvdaAmount
        ? collateral
        : collateralRaw;

  const steps = [];
  if (debt_ > 0n && repay > 0n) {
    steps.push({ action: "REPAY_NVDA", repay, note: "repay debt first (risk-reducing)" });
  } else if (debt_ === 0n && collateralOut > 0n) {
    steps.push({
      action: "WITHDRAW_NVDA",
      collateral: collateralOut,
      note: "then withdraw equity collateral in slices",
    });
  } else if (usdgTake > 0n) {
    steps.push({
      action: "DEALLOCATE_USDG",
      amount: usdgTake,
      note: "then pull the remaining quote lend arm",
    });
  }

  return { steps, usdgOut: usdgTake, repay, collateralOut };
}

/**
 * Repay amount that brings an over-LLTV position back to `targetLtvBps`.
 *
 * All amounts are in the same quote base units. Returns 0n when there is no
 * debt/collateral or the position is already at or below `maxLtvBps`.
 * Throws RangeError when the LTV pair is invalid (target > max, negative, or
 * above 10000); validation happens before the zero-debt shortcut.
 */
export function ltvRepayAmount({
  debt,
  collateralValue,
  maxLtvBps,
  targetLtvBps,
}) {
  const ltv = validateLtvBps({ targetLtvBps, maxLtvBps });
  const debt_ = toBigInt(debt);
  const collateral = toBigInt(collateralValue);

  if (debt_ === 0n || collateral === 0n) return 0n;
  if (debt_ * BPS <= collateral * BigInt(Math.trunc(ltv.maxLtvBps))) return 0n;

  const targetDebt = (collateral * BigInt(Math.trunc(ltv.targetLtvBps))) / BPS;
  if (targetDebt >= debt_) return 0n;
  return debt_ - targetDebt;
}

/** Lend APR minus borrow APR, in bps. */
export function loopSpreadBps({ lendAprBps, borrowAprBps }) {
  return finiteNumber(lendAprBps) - finiteNumber(borrowAprBps);
}

/**
 * Days for the annual yield on `amountUsd` to pay back `gasCostUsd`.
 * Documented edges: gas <= 0 -> 0 (no gas to recover); amount <= 0 or
 * aprBps <= 0 -> Infinity (the position never pays back).
 */
export function gasPaybackDays({ amountUsd, aprBps, gasCostUsd }) {
  const amount = finiteNumber(amountUsd);
  const apr = finiteNumber(aprBps);
  const gas = finiteNumber(gasCostUsd);
  if (gas <= 0) return 0;
  if (amount <= 0 || apr <= 0) return Infinity;
  const annualYieldUsd = (amount * apr) / BPS_NUMBER;
  if (annualYieldUsd <= 0) return Infinity;
  return gas / (annualYieldUsd / 365);
}

/**
 * Loop entry gate: enough spread, enough size, and gas paid back in time.
 * With gasCostUsd <= 0 the payback is treated as 0 days.
 */
export function shouldEnterLoop({
  spreadBps,
  minSpreadBps = 0,
  borrowUsd,
  minBorrowUsd = 0,
  gasCostUsd = 0,
  maxPaybackDays = Infinity,
}) {
  const spread = finiteNumber(spreadBps);
  const minSpread = finiteNumber(minSpreadBps);
  const borrow = finiteNumber(borrowUsd);
  const minBorrow = finiteNumber(minBorrowUsd);
  const gas = finiteNumber(gasCostUsd);
  const maxDays = finiteNumber(maxPaybackDays, Infinity);
  const paybackDays =
    gas <= 0
      ? 0
      : gasPaybackDays({ amountUsd: borrow, aprBps: spread, gasCostUsd: gas });

  if (spread < minSpread) {
    return {
      enter: false,
      reason: `spread ${spread}bps < min ${minSpread}bps`,
      paybackDays,
    };
  }
  if (borrow < minBorrow) {
    return {
      enter: false,
      reason: `borrow $${borrow} < min $${minBorrow}`,
      paybackDays,
    };
  }
  if (!Number.isFinite(paybackDays) || paybackDays > maxDays) {
    return {
      enter: false,
      reason: `payback ${paybackDays}d > max ${maxDays}d`,
      paybackDays,
    };
  }
  return { enter: true, reason: "loop-enter", paybackDays };
}

/** Exit the loop when the live spread falls below the exit threshold. */
export function shouldExitLoop({ spreadBps, exitSpreadBps }) {
  return finiteNumber(spreadBps) < finiteNumber(exitSpreadBps);
}

/**
 * One surplus sweep step, in priority order:
 *   (a) equity surplus -> arm collateral (only when the loop is enabled and
 *       the spread clears its minimum)
 *   (b) borrow toward target LTV (within borrow room and liquidity)
 *   (c) quote surplus -> lend arm (within lend room)
 *
 * Token amounts are base units: `idleQuote`, `armCollateralValue`, `armDebt`,
 * `armCollateralRoom`, `borrowRoom`, `borrowLiquidity`, and `lendRoom` are in
 * quote base units; `idleEquity` is in equity base units. `navUsd`,
 * `reserveUsd`, `minSweepUsd`, `gasCostUsd`, `amountUsd`, and the APRs are
 * human USD / bps. `quotePriceWad` is USD per equity scaled by 1e18.
 * Returns one action and never swaps. Throws RangeError when the LTV pair is
 * invalid (target > max, negative, or above 10000).
 */
export function surplusSweepPlan({
  idleQuote = 0n,
  idleEquity = 0n,
  quotePriceWad = 0n,
  navUsd = 0,
  reserveUsd = 0,
  reservePctBps = 0,
  armCollateralValue = 0n,
  armDebt = 0n,
  maxLtvBps,
  targetLtvBps,
  armCollateralRoom = 0n,
  borrowRoom = 0n,
  borrowLiquidity = 0n,
  lendRoom = 0n,
  minSweepUsd = 0,
  gasCostUsd = 0,
  maxPaybackDays = Infinity,
  loopSpreadBps = 0,
  minSpreadBps = 0,
  loopEnabled = false,
  lendAprBps = 0,
  equityDecimals = 18,
  quoteDecimals = 6,
}) {
  const ltv = validateLtvBps({ targetLtvBps, maxLtvBps });
  const qDecimals = clampDecimals(quoteDecimals, 6);
  const eDecimals = clampDecimals(equityDecimals, 18);

  const reserve = Math.max(
    nonNegativeNumber(reserveUsd),
    (nonNegativeNumber(navUsd) * nonNegativeNumber(reservePctBps)) / BPS_NUMBER,
  );
  const quote = toBigInt(idleQuote);
  const reserveQuote = usdToBaseUnits(reserve, qDecimals);
  const quoteSurplus = quote > reserveQuote ? quote - reserveQuote : 0n;

  const price = toBigInt(quotePriceWad);
  const equity = toBigInt(idleEquity);
  const reserveEquity = price > 0n ? usdToEquityBase(reserve, price, eDecimals, true) : 0n;
  const equitySurplus = equity > reserveEquity ? equity - reserveEquity : 0n;

  const collateralValue = toBigInt(armCollateralValue);
  const debt = toBigInt(armDebt);
  const collateralRoom = toBigInt(armCollateralRoom);
  const borrowRoomAmount = toBigInt(borrowRoom);
  const borrowLiquidityAmount = toBigInt(borrowLiquidity);
  const lendRoomAmount = toBigInt(lendRoom);
  const spread = finiteNumber(loopSpreadBps);
  const minSpread = finiteNumber(minSpreadBps);
  const gas = nonNegativeNumber(gasCostUsd);
  const maxDays = finiteNumber(maxPaybackDays, Infinity);

  // (a) Loop the equity surplus into the arm as collateral.
  if (
    loopEnabled &&
    spread >= minSpread &&
    equitySurplus > 0n &&
    collateralRoom > 0n &&
    borrowLiquidityAmount > 0n &&
    price > 0n
  ) {
    const collateralRoomEquity = quoteToEquityBase(
      collateralRoom,
      price,
      eDecimals,
      qDecimals,
    );
    const liquidityCollateralQuote =
      ltv.targetLtvBps > 0
        ? (borrowLiquidityAmount * BPS) / BigInt(Math.trunc(ltv.targetLtvBps))
        : 0n;
    const liquidityRoomEquity = quoteToEquityBase(
      liquidityCollateralQuote,
      price,
      eDecimals,
      qDecimals,
    );
    const amount = minBigInt(equitySurplus, collateralRoomEquity, liquidityRoomEquity);

    if (amount > 0n) {
      const amountUsd = equityToUsd(amount, price, eDecimals);
      const gate = sweepGate({
        amountUsd,
        aprBps: spread,
        minSweepUsd,
        gasCostUsd: gas,
        maxPaybackDays: maxDays,
      });
      if (!gate.ok) return noSweep(gate.reason, gate.paybackDays);
      return {
        action: "ALLOCATE_EQUITY",
        amount,
        amountUsd,
        reason: "equity surplus -> arm collateral",
        paybackDays: gate.paybackDays,
      };
    }
  }

  // (b) Borrow toward the target LTV, capped by room and liquidity.
  const targetDebt = (collateralValue * BigInt(Math.trunc(ltv.targetLtvBps))) / BPS;
  if (debt < targetDebt && borrowRoomAmount > 0n && borrowLiquidityAmount > 0n) {
    const amount = minBigInt(
      targetDebt - debt,
      borrowRoomAmount,
      borrowLiquidityAmount,
    );

    if (amount > 0n) {
      const amountUsd = quoteToUsd(amount, qDecimals);
      const gate = sweepGate({
        amountUsd,
        aprBps: spread,
        minSweepUsd,
        gasCostUsd: gas,
        maxPaybackDays: maxDays,
      });
      if (!gate.ok) return noSweep(gate.reason, gate.paybackDays);
      return {
        action: "BORROW",
        amount,
        amountUsd,
        reason: "borrow toward target LTV",
        paybackDays: gate.paybackDays,
      };
    }
  }

  // (c) Lend the quote surplus.
  if (quoteSurplus > 0n && lendRoomAmount > 0n) {
    const amount = minBigInt(quoteSurplus, lendRoomAmount);

    if (amount > 0n) {
      const amountUsd = quoteToUsd(amount, qDecimals);
      const gate = sweepGate({
        amountUsd,
        aprBps: lendAprBps,
        minSweepUsd,
        gasCostUsd: gas,
        maxPaybackDays: maxDays,
      });
      if (!gate.ok) return noSweep(gate.reason, gate.paybackDays);
      return {
        action: "ALLOCATE_QUOTE",
        amount,
        amountUsd,
        reason: "quote surplus -> lend arm",
        paybackDays: gate.paybackDays,
      };
    }
  }

  return noSweep("no surplus or room");
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
 *
 * `carryArmEnabled` makes the arms the destination when there is no positive
 * net-APR edge; without it the allocator holds.
 *
 * `candidates`: [{ name, poolId?, netAprBps, risk? }]
 */
export function decidePoolSwitch({
  candidates,
  currentPool,
  switchBufferBps = 500,
  carryArmEnabled = false,
}) {
  const buffer = finiteNumber(switchBufferBps, 500);
  const ranked = (candidates ?? [])
    .filter((c) => c && c.risk !== "HIGH")
    .map((c) => ({ ...c, netAprBps: finiteNumber(c.netAprBps) }))
    .sort((a, b) => b.netAprBps - a.netAprBps);

  const best = ranked[0];
  if (!best) {
    return carryArmEnabled
      ? { action: "ARMS", reason: "no eligible pool -> carry arm", ranked }
      : { action: "HOLD", reason: "no eligible pool candidates", ranked };
  }

  if (best.netAprBps <= 0) {
    return carryArmEnabled
      ? {
          action: "ARMS",
          reason: `best net APR after IL ${best.netAprBps}bps <= 0 -> carry arm`,
          ranked,
        }
      : {
          action: "HOLD",
          reason: `best net APR after IL ${best.netAprBps}bps <= 0`,
          ranked,
        };
  }

  if (currentPool && best.name === currentPool) {
    return { action: "HOLD", pool: best.name, reason: "current pool is best", ranked };
  }

  const current = ranked.find((c) => c.name === currentPool);
  if (current && best.netAprBps <= current.netAprBps + buffer) {
    return { action: "HOLD", pool: currentPool, reason: "best lead below buffer", ranked };
  }

  // Current pool was filtered out (for example HIGH risk): still require the
  // best candidate to clear the buffer on its own.
  if (!current && best.netAprBps <= buffer) {
    return {
      action: "HOLD",
      reason: `best net APR after IL ${best.netAprBps}bps <= buffer ${buffer}bps`,
      ranked,
    };
  }

  return {
    action: "SWITCH",
    pool: best.name,
    netAprBps: best.netAprBps,
    reason: `best net APR after IL ${best.netAprBps}bps > buffer ${buffer}bps`,
    ranked,
  };
}

/**
 * Debounce a pool switch decision over consecutive checks.
 *
 * Returns `{ confirmed, pending }`. A target must persist for
 * `confirmSeconds` before `confirmed` becomes true; confirmation clears
 * `pending`. A falsy target, a changed target, or a non-positive net edge
 * resets/restarts the timer. `netAprBps` updates on every check but `since`
 * stays fixed while the target is unchanged.
 *
 * `allowNonPositive` keeps a target alive when its edge is zero or negative.
 * Only the carry arm (`"ARMS"`) passes it: that destination is negative by
 * construction, so the non-positive reset would never let it confirm.
 */
export function decideSwitchConfirmation({
  pending,
  target,
  netAprBps,
  now,
  confirmSeconds = 0,
  allowNonPositive = false,
}) {
  const net = finiteNumber(netAprBps);
  if (!target || (!allowNonPositive && net <= 0)) {
    return { confirmed: false, pending: null };
  }

  const at = finiteNumber(now);
  const waitSeconds = Math.max(0, finiteNumber(confirmSeconds));
  const prior = pending && pending.target ? pending : null;

  if (prior && prior.target === target) {
    const since = finiteNumber(prior.since, at);
    if (at - since >= waitSeconds) {
      return { confirmed: true, pending: null };
    }
    return { confirmed: false, pending: { target, since, netAprBps: net } };
  }

  return { confirmed: false, pending: { target, since: at, netAprBps: net } };
}
