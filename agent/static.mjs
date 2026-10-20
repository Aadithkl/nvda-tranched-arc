// Pure decision logic for the static-fee book agent. The heavy IL-guard work lives onchain
// (PoolGuardHook + PoolGuardSimulator); the agent's job is a small, bounded operational loop:
//   - poke the permissionless recheck when it is due and the market still makes sense,
//   - recenter the guard band when price walks to its edge,
//   - park capital (standby + recall + lending) and resume it, within the controller's bounds.
// No network access here - testable offline.

export const TICK_BASE = 1.0001;
export const BPS = 10_000;

export function tickToPrice(tick) {
  return TICK_BASE ** Number(tick);
}

/** Distance (bps) from price to the nearest guard-band edge, and which edge. */
export function edgeProximityBps(tick, guardLo, guardHi) {
  const price = tickToPrice(tick);
  const lower = tickToPrice(guardLo);
  const upper = tickToPrice(guardHi);
  const lowerBps = ((price - lower) / lower) * BPS;
  const upperBps = ((upper - price) / price) * BPS;
  if (lowerBps <= upperBps) return { edge: "lower", bps: Math.max(0, lowerBps) };
  return { edge: "upper", bps: Math.max(0, upperBps) };
}

/**
 * Decide the next operational action for the static book.
 * Exactly one of: HOLD, RECHECK, RECENTER.
 * parking/resume are allocation policy and remain explicit operator calls (see parkPlan/resumePlan).
 */
export function decideStatic(state) {
  const {
    exited = false,
    recheckDue = false,
    deployEnabled = true,
    guardPresent = false,
    deviationBps = 0,
    recheckMaxDeviationBps = 50,
    edgeBandBps = 250,
  } = state;

  if (exited) return { action: "HOLD", reason: "book exited; settlement path" };

  if (!guardPresent && deployEnabled && recheckDue) {
    if (deviationBps <= recheckMaxDeviationBps) {
      return { action: "RECHECK", reason: "recheck due and deviation within band" };
    }
    return { action: "HOLD", reason: "recheck due but deviation above band; wait" };
  }

  if (guardPresent && Number.isFinite(state.tick) && Number.isFinite(state.guardLo) && Number.isFinite(state.guardHi)) {
    const proximity = edgeProximityBps(state.tick, state.guardLo, state.guardHi);
    if (proximity.bps <= edgeBandBps) {
      return {
        action: "RECENTER",
        reason: `price ${proximity.bps.toFixed(0)}bps from ${proximity.edge} guard edge`,
        edge: proximity,
      };
    }
    return { action: "HOLD", reason: `in range (${proximity.bps.toFixed(0)}bps to ${proximity.edge} edge)` };
  }

  if (!deployEnabled) return { action: "HOLD", reason: "standby: capital parked by allocation policy" };
  return { action: "HOLD", reason: "no action due" };
}

/** Ordered operator calls to park hook capital into the lending venue. */
export function parkPlan() {
  return [
    "controller.submitDeployEnabled(false)",
    "controller.submitRecall()",
    "controller.submitSupplyIdle()",
  ];
}

/** Ordered operator calls to bring capital back from lending and re-arm the guard. */
export function resumePlan({ withdrawQuote, fundQuote, fundEquity }) {
  return [
    `controller.submitWithdrawFromVenue(${withdrawQuote})`,
    `controller.submitFund(${fundQuote}, ${fundEquity})`,
    "controller.submitDeployEnabled(true)",
    "controller.submitRecenter()",
  ];
}

/**
 * Strategy-module decisions (lend adapters + Morpho loop sleeve). One of:
 * HOLD, DEALLOCATE, DELEVERAGE, REALLOCATE, PARK, RESUME.
 * Caps/timelock/HF floors are enforced onchain; this only proposes the bounded next step.
 */
export function decideStrategy(state) {
  const {
    sessionOpen = true,
    capBreached = false,
    healthFactorWad = null,
    minHealthFactorWad = 1.2e18,
    utilizationBps = 0,
    maxUtilizationBps = 9500,
    guardPresent = false,
    deployEnabled = true,
    loopDebt = 0,
    borrowAprBps = null,
    deployYieldBps = null,
    maxNegativeCarryBps = 0,
  } = state;

  if (capBreached) return { action: "DEALLOCATE", reason: "risk cap breached; sentinel de-risk" };
  if (healthFactorWad !== null && healthFactorWad < minHealthFactorWad) {
    return { action: "DELEVERAGE", reason: `loop health ${healthFactorWad} below floor ${minHealthFactorWad}` };
  }
  // Carry gate: borrowed quote is only worth carrying while its deployed yield beats
  // the borrow APR. `deployYieldBps` is the realized fee + lend yield of the quote
  // currently funded by the loop (operator/keeper input), not the whole book's APR.
  if (loopDebt > 0 && borrowAprBps !== null && deployYieldBps !== null) {
    const netCarryBps = deployYieldBps - borrowAprBps;
    if (netCarryBps < -maxNegativeCarryBps) {
      return {
        action: "DELEVERAGE",
        reason: `negative carry ${netCarryBps}bps (yield ${deployYieldBps} < borrow ${borrowAprBps}); repay and pull collateral`,
        netCarryBps,
      };
    }
  }
  if (!sessionOpen) {
    return deployEnabled || guardPresent
      ? { action: "PARK", reason: "market closed: standby + recall + lend" }
      : { action: "HOLD", reason: "market closed; already parked" };
  }
  if (utilizationBps > maxUtilizationBps) {
    return { action: "REALLOCATE", reason: `venue utilization ${utilizationBps}bps above ${maxUtilizationBps}bps` };
  }
  if (!deployEnabled) return { action: "RESUME", reason: "market open: withdraw + fund + enable + recenter" };
  return { action: "HOLD", reason: "strategy within bounds" };
}

/** Park/resume sequence driven by the session clock (closed -> park, open -> resume). */
export function sessionStandbyPlan(open, amounts = {}) {
  return open ? resumePlan(amounts) : parkPlan();
}

/**
 * Dual-book routing advisory (low-fee book A vs high-fee book B). One of:
 * HOLD, SWITCH (with toBook 0/1).
 * Pure revenue heuristic with hysteresis: compares trailing-24h fee revenue
 * (volume x fee) and only moves when the other book beats the active one by
 * minImprovementBps. Advisory only — the controller still enforces dwell (1h),
 * freeze, expiry and oracle validity onchain, and the switch itself is atomic.
 */
export function decideBookRouting(state) {
  const {
    activeBook = 0,
    feeA_bps = 30,
    feeB_bps = 100,
    volumeA = 0,
    volumeB = 0,
    dwellElapsed = true,
    frozen = false,
    expired = false,
    minImprovementBps = 500,
  } = state;

  if (frozen) return { action: "HOLD", reason: "frozen: wind-down, no new risk" };
  if (expired) return { action: "HOLD", reason: "expired: settlement path" };
  if (activeBook !== 0 && activeBook !== 1) return { action: "HOLD", reason: "unknown active book" };
  if (!dwellElapsed) return { action: "HOLD", reason: "switch dwell not elapsed" };

  const revA = volumeA * feeA_bps;
  const revB = volumeB * feeB_bps;
  const activeRev = activeBook === 0 ? revA : revB;
  const otherRev = activeBook === 0 ? revB : revA;
  const toBook = activeBook === 0 ? 1 : 0;

  if (otherRev > activeRev * (1 + minImprovementBps / BPS)) {
    return {
      action: "SWITCH",
      toBook,
      reason: `book ${toBook} revenue ${otherRev} beats active ${activeRev} beyond ${minImprovementBps}bps hysteresis`,
    };
  }
  return { action: "HOLD", reason: `active book ${activeBook} revenue ${activeRev} holds (other ${otherRev})` };
}

/**
 * Expiry wind-down decisions. One of:
 * HOLD, SOFT_HALT, HALT, PREPARE_SETTLEMENT, HAIRCUT_OR_WAIT, SETTLE.
 * The hard halt (haltIfExpired) is permissionless; everything else is keeper/owner ops.
 */
export function decideWinddown(state) {
  const {
    expired = false,
    settled = false,
    halted = false,
    deployEnabled = true,
    guardPresent = false,
    usdcUnits = 0,
    seniorGuarantee = 0,
    loopDebtUsdg = 0,
    inWinddownWindow = false,
  } = state;

  if (settled) return { action: "HOLD", reason: "book settled" };

  if (expired) {
    if (!halted) return { action: "HALT", reason: "expired: haltIfExpired() pulls base + guard to the vault" };
    const shortfall = seniorGuarantee > usdcUnits ? seniorGuarantee - usdcUnits : 0;
    if (loopDebtUsdg > 0) {
      return { action: "PREPARE_SETTLEMENT", reason: `unwind loop debt (${loopDebtUsdg}) before settling` };
    }
    if (shortfall > 0) {
      return { action: "HAIRCUT_OR_WAIT", reason: `senior shortfall ${shortfall}; fund or finalizeSettlementHaircut()` };
    }
    return { action: "SETTLE", reason: "readiness ok: finalizeSettlement() (pending requests flow post-settlement)" };
  }

  if (inWinddownWindow) {
    if (deployEnabled) return { action: "SOFT_HALT", reason: "T-delta: disable deployments (+ optional guard recall)" };
    if (guardPresent) return { action: "HOLD", reason: "soft halt done; guard pulled at T by haltIfExpired" };
  }
  return { action: "HOLD", reason: "pre-expiry" };
}

// ---------- CLI (dry-run) ----------

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("static.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(`usage:
  node agent/static.mjs --state '<json>'      # guard decision (recheck/recenter)
  node agent/static.mjs --strategy '<json>'   # strategy decision (park/resume/de leverage/...)
  node agent/static.mjs --winddown '<json>'   # expiry wind-down decision (soft halt/halt/settle)
  node agent/static.mjs --route '<json>'      # dual-book routing advisory (hold/switch)
state fields: exited, recheckDue, deployEnabled, guardPresent, deviationBps,
              recheckMaxDeviationBps, tick, guardLo, guardHi, edgeBandBps
strategy fields: sessionOpen, capBreached, healthFactorWad, minHealthFactorWad,
                 utilizationBps, maxUtilizationBps, guardPresent, deployEnabled,
                 loopDebt, borrowAprBps, deployYieldBps, maxNegativeCarryBps
winddown fields: expired, settled, halted, deployEnabled, guardPresent, usdcUnits,
                  seniorGuarantee, loopDebtUsdg, inWinddownWindow
route fields: activeBook, feeA_bps, feeB_bps, volumeA, volumeB, dwellElapsed,
                  frozen, expired, minImprovementBps
example:
  node agent/static.mjs --state '{"guardPresent":true,"tick":196500,"guardLo":195660,"guardHi":196860}'`);
    process.exit(0);
  }
  const winddownIdx = args.indexOf("--winddown");
  if (winddownIdx !== -1 && args[winddownIdx + 1]) {
    console.log(JSON.stringify(decideWinddown(JSON.parse(args[winddownIdx + 1])), null, 2));
    process.exit(0);
  }
  const strategyIdx = args.indexOf("--strategy");
  if (strategyIdx !== -1 && args[strategyIdx + 1]) {
    console.log(JSON.stringify(decideStrategy(JSON.parse(args[strategyIdx + 1])), null, 2));
    process.exit(0);
  }
  const routeIdx = args.indexOf("--route");
  if (routeIdx !== -1 && args[routeIdx + 1]) {
    console.log(JSON.stringify(decideBookRouting(JSON.parse(args[routeIdx + 1])), null, 2));
    process.exit(0);
  }
  const stateIdx = args.indexOf("--state");
  if (stateIdx === -1 || !args[stateIdx + 1]) {
    console.error("missing --state '<json>' (see --help)");
    process.exit(1);
  }
  const state = JSON.parse(args[stateIdx + 1]);
  console.log(JSON.stringify(decideStatic(state), null, 2));
}
