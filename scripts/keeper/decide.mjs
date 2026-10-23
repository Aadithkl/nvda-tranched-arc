// Pure keeper decisions. No I/O, no chain access — mirrors Yearn's keeper split
// (trigger checks are pure; the runner executes). Unit-tested in ./test.

/**
 * Depeg heartbeat: call the vault's depeg check when the heartbeat interval has elapsed.
 * The vault itself enforces the TWAP/duration gate, so a call is always safe.
 */
export function decideDepeg({ now, lastCheck, interval, automationPaused = false }) {
  if (automationPaused) return { action: "HOLD", reason: "automation paused" };
  const last = BigInt(lastCheck ?? 0);
  if (last === 0n) return { action: "CHECK", reason: "no check recorded yet" };
  if (BigInt(now) >= last + BigInt(interval)) return { action: "CHECK", reason: "heartbeat due" };
  return { action: "HOLD", reason: "heartbeat fresh" };
}

/**
 * Sleeve risk: only de-risk or pause. Never opens, adds collateral, or borrows.
 * `state` is the sleeve's riskState() tuple/object; `policy` is the configured limits.
 */
export function decideSleeve(state, policy) {
  if (!state) return { action: "HOLD", reason: "no sleeve configured" };

  const stockLtv = Number(state.stockLtvBps ?? 0);
  const yieldLtv = Number(state.yieldLtvBps ?? 0);
  const health = Number(state.healthBufferBps ?? 0);
  const carry = Number(state.netCarryBps ?? 0);

  if (state.venuePaused) return { action: "PAUSE", reason: "venue paused" };
  if (stockLtv > policy.maxStockLtvBps) return { action: "DERISK", reason: `stock LTV ${stockLtv} > ${policy.maxStockLtvBps}` };
  if (yieldLtv > policy.maxYieldLtvBps) return { action: "DERISK", reason: `yield LTV ${yieldLtv} > ${policy.maxYieldLtvBps}` };
  if (health < policy.minHealthBps) return { action: "DERISK", reason: `health ${health} < ${policy.minHealthBps}` };
  // Carry is an off-chain economic input. Only enforce it when the caller marks it known;
  // an on-chain 0 means "unknown", not "zero carry".
  if (state.carryKnown !== false && carry < policy.minCarryBps) {
    return { action: "DERISK", reason: `carry ${carry} < ${policy.minCarryBps}` };
  }
  return { action: "HOLD", reason: "within policy" };
}

/**
 * Guard re-arm: permissionless `recheckGuard()` once the interval has elapsed and the
 * guard is still absent. Mirrors Yearn's `tendTrigger`-style check.
 */
export function decideGuard({ now, pulledAt, recheckInterval, guardPresent, deployEnabled }) {
  if (guardPresent) return { action: "HOLD", reason: "guard present" };
  if (!deployEnabled) return { action: "HOLD", reason: "deployments disabled" };
  const pulled = BigInt(pulledAt ?? 0);
  if (pulled === 0n) return { action: "HOLD", reason: "never pulled" };
  if (BigInt(now) >= pulled + BigInt(recheckInterval)) return { action: "RECHECK", reason: "recheck due" };
  return { action: "HOLD", reason: "recheck not due" };
}

/**
 * Morpho loop arm (Spiral NVDA strategy): de-risk when the health factor falls below the
 * floor or the borrow APR exceeds the carry ceiling. Never borrows or adds collateral.
 */
export function decideArm({ healthFactorWad, debt, minHealthFactorWad, borrowAprBps, maxBorrowAprBps }) {
  const debt_ = BigInt(debt ?? 0);
  if (debt_ === 0n) return { action: "HOLD", reason: "no debt" };

  const hf = BigInt(healthFactorWad ?? 0);
  const minHf = BigInt(minHealthFactorWad ?? 0);
  if (minHf !== 0n && hf < minHf) {
    return { action: "DELEVERAGE", reason: `health ${hf} < ${minHf}` };
  }

  if (maxBorrowAprBps !== undefined && maxBorrowAprBps !== null) {
    const apr = Number(borrowAprBps ?? 0);
    if (apr > Number(maxBorrowAprBps)) {
      return { action: "DELEVERAGE", reason: `borrow APR ${apr} > ${maxBorrowAprBps}` };
    }
  }

  return { action: "HOLD", reason: "arm within policy" };
}
