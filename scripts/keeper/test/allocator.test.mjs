import test from "node:test";
import assert from "node:assert/strict";
import {
  assessBookRisk,
  decideByRisk,
  borrowSize,
  planArmEntry,
  planBookReturn,
  chooseBook,
  decidePoolSwitch,
  guardSafeHarbor,
  ltvRepayAmount,
  loopSpreadBps,
  gasPaybackDays,
  shouldEnterLoop,
  shouldExitLoop,
  surplusSweepPlan,
  decideSwitchConfirmation,
} from "../allocator.mjs";

test("risk: calm book -> NORMAL", () => {
  const r = assessBookRisk({
    feeAprBps: 400,
    volumeUsd: 50_000,
    volatilityBps: 80,
    guardPresent: true,
    depegPaused: false,
  });
  assert.equal(r.risk, "NORMAL");
  assert.deepEqual(r.reasons, []);
});

test("risk: high volatility -> HIGH", () => {
  const r = assessBookRisk({
    feeAprBps: 900,
    volumeUsd: 50_000,
    volatilityBps: 450,
    guardPresent: true,
    depegPaused: false,
  });
  assert.equal(r.risk, "HIGH");
  assert.match(r.reasons.join(","), /volatility/);
});

test("risk: thin volume -> HIGH", () => {
  const r = assessBookRisk({
    feeAprBps: 900,
    volumeUsd: 500,
    volatilityBps: 50,
    guardPresent: true,
    depegPaused: false,
  });
  assert.equal(r.risk, "HIGH");
  assert.match(r.reasons.join(","), /volume/);
});

test("risk: guard absent or depeg -> HIGH", () => {
  assert.equal(
    assessBookRisk({
      feeAprBps: 900,
      volumeUsd: 50_000,
      volatilityBps: 50,
      guardPresent: false,
      depegPaused: false,
    }).risk,
    "HIGH",
  );
  assert.equal(
    assessBookRisk({
      feeAprBps: 900,
      volumeUsd: 50_000,
      volatilityBps: 50,
      guardPresent: true,
      depegPaused: true,
    }).risk,
    "HIGH",
  );
});

test("risk: fee floor is off by default (no APR target)", () => {
  const r = assessBookRisk({
    feeAprBps: 0,
    volumeUsd: 50_000,
    volatilityBps: 50,
    guardPresent: true,
    depegPaused: false,
  });
  assert.equal(r.risk, "NORMAL");
});

test("risk: optional fee floor can be enabled", () => {
  const r = assessBookRisk({
    feeAprBps: 50,
    volumeUsd: 50_000,
    volatilityBps: 50,
    guardPresent: true,
    depegPaused: false,
    thresholds: { minFeeAprBps: 100 },
  });
  assert.equal(r.risk, "HIGH");
  assert.match(r.reasons.join(","), /fee/);
});

test("decision: high risk -> arms", () => {
  assert.deepEqual(decideByRisk({ risk: "HIGH", currentMode: "BOOKS" }), {
    mode: "ARMS",
    action: "MOVE_TO_ARMS",
    reason: "risk high -> safe harbor",
  });
});

test("decision: normal risk -> books", () => {
  assert.deepEqual(decideByRisk({ risk: "NORMAL", currentMode: "ARMS" }), {
    mode: "BOOKS",
    action: "MOVE_TO_BOOKS",
    reason: "risk normal -> book fees",
  });
});

test("decision: already there -> HOLD", () => {
  assert.equal(decideByRisk({ risk: "HIGH", currentMode: "ARMS" }).action, "HOLD");
  assert.equal(decideByRisk({ risk: "NORMAL", currentMode: "BOOKS" }).action, "HOLD");
});

test("borrow size: hard cap keeps LTV below 30%", () => {
  // 1000 USDG collateral, operator asks 50%, market 62.5% -> hard cap 30%.
  assert.equal(borrowSize({ collateralValue: 1000n, ltvBps: 5000, maxLtvBps: 6250 }), 300n);
});

test("borrow size: operator target below hard cap wins", () => {
  assert.equal(borrowSize({ collateralValue: 1000n, ltvBps: 2500, maxLtvBps: 6250 }), 250n);
});

test("borrow size: zero -> 0", () => {
  assert.equal(borrowSize({ collateralValue: 1000n, ltvBps: 0, maxLtvBps: 6250 }), 0n);
});

test("borrow size: hard cap is caller-configurable and targetLtvBps is the new name", () => {
  assert.equal(
    borrowSize({
      collateralValue: 1000n,
      targetLtvBps: 5000,
      maxLtvBps: 6250,
      hardCapBps: 4000,
    }),
    400n,
  );
});

test("borrow size: missing maxLtvBps does not infer a market LLTV", () => {
  assert.equal(borrowSize({ collateralValue: 1000n, targetLtvBps: 3000 }), 0n);
});

test("arm entry: USDG first, then NVDA, then borrow", () => {
  // 10,000 USDG; 100 NVDA at $200; 80% quote, 10% NVDA; 29.375% LTV.
  const p = planArmEntry({
    usdgAvailable: 10_000n * 10n ** 6n,
    nvdaAvailable: 100n * 10n ** 18n,
    nvdaPriceWad: 200n * 10n ** 18n,
    targetLtvBps: 2_937,
    maxLtvBps: 6_250,
    morphoShareBps: 8_000,
    nvdaStepBps: 1_000,
  });
  assert.equal(p.usdgMove, 8_000n * 10n ** 6n);
  assert.equal(p.nvdaMove, 10n * 10n ** 18n);
  // 10 NVDA * $200 = $2,000; 29.37% = $587.40
  assert.equal(p.borrow, 587_400_000n);
  assert.deepEqual(
    p.steps.map((s) => s.action),
    ["ALLOCATE_USDG", "ALLOCATE_NVDA", "BORROW_USDG", "ALLOCATE_USDG"],
  );
});

test("arm entry: quote target met -> quote move stops, NVDA step continues", () => {
  const p = planArmEntry({
    usdgAvailable: 2_000n * 10n ** 6n,
    usdgDeployed: 8_000n * 10n ** 6n,
    nvdaAvailable: 100n * 10n ** 18n,
    nvdaDeployed: 0n,
    nvdaPriceWad: 200n * 10n ** 18n,
    morphoShareBps: 8_000,
    nvdaStepBps: 1_000,
  });
  assert.equal(p.usdgMove, 0n);
  assert.equal(p.nvdaMove, 10n * 10n ** 18n);
  assert.equal(p.steps[0].action, "ALLOCATE_NVDA");
});

test("arm entry: no borrow above the hard 30% cap (legacy ltvBps alias)", () => {
  const p = planArmEntry({
    usdgAvailable: 0n,
    nvdaAvailable: 1_000n * 10n ** 18n,
    nvdaPriceWad: 200n * 10n ** 18n,
    ltvBps: 6_000, // legacy alias, operator asks 60%
    maxLtvBps: 6_250,
    nvdaStepBps: 10_000,
  });
  // 1000 NVDA * $200 = $200,000; 30% hard cap = $60,000.
  assert.equal(p.borrow, 60_000n * 10n ** 6n);
});

test("arm entry: missing maxLtvBps does not infer a market LLTV", () => {
  const p = planArmEntry({
    usdgAvailable: 0n,
    nvdaAvailable: 1_000n * 10n ** 18n,
    nvdaPriceWad: 200n * 10n ** 18n,
    targetLtvBps: 3_000,
    nvdaStepBps: 10_000,
  });
  assert.equal(p.borrow, 0n);
  assert.equal(p.targetLtvBps, 0);
});

test("book return: repay debt first", () => {
  const p = planBookReturn({
    usdgDeployed: 10_000n * 10n ** 6n,
    nvdaCollateral: 100n * 10n ** 18n,
    debt: 5_000n * 10n ** 6n,
    stepBps: 2_500,
  });
  assert.equal(p.steps[0].action, "REPAY_NVDA");
  assert.equal(p.steps[0].repay, 1_250n * 10n ** 6n);
});

test("book return: after debt -> withdraw collateral", () => {
  const p = planBookReturn({
    usdgDeployed: 10_000n * 10n ** 6n,
    nvdaCollateral: 100n * 10n ** 18n,
    debt: 0n,
    stepBps: 2_500,
  });
  assert.equal(p.steps[0].action, "WITHDRAW_NVDA");
  assert.equal(p.steps[0].collateral, 25n * 10n ** 18n);
});

test("book return: after debt/collateral -> deallocate quote", () => {
  const p = planBookReturn({
    usdgDeployed: 10_000n * 10n ** 6n,
    nvdaCollateral: 0n,
    debt: 0n,
    stepBps: 2_500,
  });
  assert.equal(p.steps[0].action, "DEALLOCATE_USDG");
  assert.equal(p.steps[0].amount, 2_500n * 10n ** 6n);
});

test("book return: dust snaps to full", () => {
  const p = planBookReturn({
    usdgDeployed: 2_000_000n, // $2, below the $1 dust? above, but 25% = 0.5 below dust
    nvdaCollateral: 10n ** 15n, // 0.001 NVDA
    debt: 0n,
    stepBps: 2_500,
    dustUsdg: 1_000_000n,
    dustNvda: 1_000_000_000_000_000n,
  });
  assert.equal(p.steps[0].action, "WITHDRAW_NVDA");
  assert.equal(p.steps[0].collateral, 10n ** 15n);
});

test("book return: stepBps 10000 is the urgent full-exit path", () => {
  const p = planBookReturn({
    usdgDeployed: 10_000n * 10n ** 6n,
    nvdaCollateral: 100n * 10n ** 18n,
    debt: 5_000n * 10n ** 6n,
    stepBps: 10_000,
  });
  assert.equal(p.repay, 5_000n * 10n ** 6n);
  assert.equal(p.steps[0].action, "REPAY_NVDA");
});

test("book return: stepBps 10000 pulls the full quote leg", () => {
  const p = planBookReturn({
    usdgDeployed: 10_000n * 10n ** 6n,
    nvdaCollateral: 0n,
    debt: 0n,
    stepBps: 10_000,
  });
  assert.equal(p.usdgOut, 10_000n * 10n ** 6n);
  assert.equal(p.steps[0].action, "DEALLOCATE_USDG");
});

test("book choice: higher fee APR wins; tie keeps active", () => {
  assert.equal(chooseBook({ bookAprA: 100, bookAprB: 200, activeBook: 0 }), 1);
  assert.equal(chooseBook({ bookAprA: 200, bookAprB: 100, activeBook: 1 }), 0);
  assert.equal(chooseBook({ bookAprA: 100, bookAprB: 100, activeBook: 1 }), 1);
});

test("guard gate: recalled book in ARMS is not blocked by an absent guard", () => {
  const g = guardSafeHarbor({
    currentMode: "ARMS",
    bookHasPosition: true,
    guardRecentlyPulled: false,
    guardPulls: 3,
    maxGuardPulls: 2,
  });
  assert.equal(g.blocked, false);
});

test("guard gate: empty book being funded is not blocked by an absent guard", () => {
  const g = guardSafeHarbor({
    currentMode: "BOOKS",
    bookHasPosition: false,
    guardRecentlyPulled: false,
    guardPulls: 3,
    maxGuardPulls: 2,
  });
  assert.equal(g.blocked, false);
});

test("guard gate: funded book with too many pulls -> arms", () => {
  const g = guardSafeHarbor({
    currentMode: "BOOKS",
    bookHasPosition: true,
    guardRecentlyPulled: false,
    guardPulls: 3,
    maxGuardPulls: 2,
  });
  assert.deepEqual(g, { blocked: true, wait: false, reason: "guard-pulls=3" });
});

test("guard gate: funded book with a recent pull waits and re-arms", () => {
  const g = guardSafeHarbor({
    currentMode: "BOOKS",
    bookHasPosition: true,
    guardRecentlyPulled: true,
    guardPulls: 0,
    maxGuardPulls: 2,
  });
  assert.deepEqual(g, { blocked: false, wait: true, reason: "recent-guard-pull-wait" });
});

test("guard gate: 1-2 pulls in the run wait; the third arms", () => {
  const one = guardSafeHarbor({
    currentMode: "BOOKS",
    bookHasPosition: true,
    guardRecentlyPulled: false,
    guardPulls: 1,
    maxGuardPulls: 2,
  });
  const two = guardSafeHarbor({
    currentMode: "BOOKS",
    bookHasPosition: true,
    guardRecentlyPulled: false,
    guardPulls: 2,
    maxGuardPulls: 2,
  });
  assert.equal(one.wait, true);
  assert.equal(one.blocked, false);
  assert.equal(two.wait, true);
  assert.equal(two.blocked, false);
});

test("guard gate: funded book with clear guard history is not blocked (recheck re-arms)", () => {
  const g = guardSafeHarbor({
    currentMode: "BOOKS",
    bookHasPosition: true,
    guardRecentlyPulled: false,
    guardPulls: 0,
    maxGuardPulls: 2,
  });
  assert.equal(g.blocked, false);
  assert.equal(g.wait, false);
});

test("pool switch: best lead below buffer -> HOLD", () => {
  const d = decidePoolSwitch({
    currentPool: "v4-0.05",
    candidates: [
      { name: "v3-0.05", netAprBps: 266, risk: "NORMAL" }, // +0.22% / 30d annualized
      { name: "v4-0.05", netAprBps: 100, risk: "NORMAL" },
    ],
    switchBufferBps: 500,
  });
  assert.equal(d.action, "HOLD");
  assert.equal(d.pool, "v4-0.05");
});

test("pool switch: no eligible pool -> HOLD, or ARMS when carry is enabled", () => {
  const args = {
    currentPool: "v4-0.05",
    candidates: [{ name: "v3-0.05", netAprBps: 900, risk: "HIGH" }],
    switchBufferBps: 500,
  };
  assert.equal(decidePoolSwitch(args).action, "HOLD");
  assert.equal(decidePoolSwitch({ ...args, carryArmEnabled: true }).action, "ARMS");
});

test("pool switch: no positive net edge -> HOLD, or ARMS when carry is enabled", () => {
  const args = {
    currentPool: "v4-0.05",
    candidates: [{ name: "v3-0.05", netAprBps: 0, risk: "NORMAL" }],
    switchBufferBps: 500,
  };
  assert.equal(decidePoolSwitch(args).action, "HOLD");
  assert.equal(decidePoolSwitch({ ...args, carryArmEnabled: true }).action, "ARMS");
});

test("pool switch: best clearly beats buffer and current -> SWITCH", () => {
  const d = decidePoolSwitch({
    currentPool: "v4-0.05",
    candidates: [
      { name: "v3-0.05", netAprBps: 900, risk: "NORMAL" },
      { name: "v4-0.05", netAprBps: 200, risk: "NORMAL" },
    ],
    switchBufferBps: 500,
  });
  assert.equal(d.action, "SWITCH");
  assert.equal(d.pool, "v3-0.05");
});

test("pool switch: best is current -> HOLD", () => {
  const d = decidePoolSwitch({
    currentPool: "v3-0.05",
    candidates: [{ name: "v3-0.05", netAprBps: 900, risk: "NORMAL" }],
    switchBufferBps: 500,
  });
  assert.equal(d.action, "HOLD");
});

test("pool switch: lead below buffer -> HOLD current", () => {
  const d = decidePoolSwitch({
    currentPool: "v4-0.05",
    candidates: [
      { name: "v3-0.05", netAprBps: 650, risk: "NORMAL" },
      { name: "v4-0.05", netAprBps: 500, risk: "NORMAL" },
    ],
    switchBufferBps: 500,
  });
  assert.equal(d.action, "HOLD");
  assert.equal(d.pool, "v4-0.05");
});

test("pool switch: high-risk candidate is skipped, current pool holds", () => {
  const d = decidePoolSwitch({
    currentPool: "v4-0.05",
    candidates: [
      { name: "v3-0.05", netAprBps: 5000, risk: "HIGH" },
      { name: "v4-0.05", netAprBps: 200, risk: "NORMAL" },
    ],
    switchBufferBps: 500,
  });
  assert.equal(d.action, "HOLD");
  assert.equal(d.pool, "v4-0.05");
});

// ---------------------------------------------------------------------------
// LTV / loop / sweep primitives
// ---------------------------------------------------------------------------

const Q6 = 10n ** 6n;
const E18 = 10n ** 18n;
const PRICE_200_WAD = 200n * E18;

test("ltv repay: zero debt or collateral -> 0", () => {
  assert.equal(
    ltvRepayAmount({
      debt: 0n,
      collateralValue: 1000n,
      maxLtvBps: 6250,
      targetLtvBps: 3000,
    }),
    0n,
  );
  assert.equal(
    ltvRepayAmount({
      debt: 700n,
      collateralValue: 0n,
      maxLtvBps: 6250,
      targetLtvBps: 3000,
    }),
    0n,
  );
});

test("ltv repay: at or below max LTV -> 0", () => {
  assert.equal(
    ltvRepayAmount({
      debt: 500n,
      collateralValue: 1000n,
      maxLtvBps: 6250,
      targetLtvBps: 3000,
    }),
    0n,
  );
});

test("ltv repay: over max LTV -> repay down to target", () => {
  // 70% debt on 62.5% LLTV; target 30% -> repay 40% of $1000 = $400.
  assert.equal(
    ltvRepayAmount({
      debt: 700n,
      collateralValue: 1000n,
      maxLtvBps: 6250,
      targetLtvBps: 3000,
    }),
    400n,
  );
});

test("ltv repay: target 0 repays all debt", () => {
  assert.equal(
    ltvRepayAmount({
      debt: 700n,
      collateralValue: 1000n,
      maxLtvBps: 6250,
      targetLtvBps: 0,
    }),
    700n,
  );
});

test("ltv repay: target above max throws (documented contract)", () => {
  assert.throws(
    () =>
      ltvRepayAmount({
        debt: 700n,
        collateralValue: 1000n,
        maxLtvBps: 6250,
        targetLtvBps: 7000,
      }),
    RangeError,
  );
});

test("loop spread: lend minus borrow bps", () => {
  assert.equal(loopSpreadBps({ lendAprBps: 520, borrowAprBps: 310 }), 210);
  assert.equal(loopSpreadBps({ lendAprBps: 100, borrowAprBps: 300 }), -200);
  assert.equal(loopSpreadBps({}), 0);
});

test("gas payback: annual yield recovers gas", () => {
  const days = gasPaybackDays({ amountUsd: 1000, aprBps: 1000, gasCostUsd: 10 });
  assert.ok(Math.abs(days - 36.5) < 1e-9);
});

test("gas payback: documented zero/Infinity edges", () => {
  assert.equal(gasPaybackDays({ amountUsd: 1000, aprBps: 1000, gasCostUsd: 0 }), 0);
  assert.equal(gasPaybackDays({ amountUsd: 0, aprBps: 1000, gasCostUsd: 10 }), Infinity);
  assert.equal(gasPaybackDays({ amountUsd: 1000, aprBps: 0, gasCostUsd: 10 }), Infinity);
});

test("loop entry: spread, size, and gas payback all pass", () => {
  const r = shouldEnterLoop({
    spreadBps: 200,
    minSpreadBps: 100,
    borrowUsd: 1000,
    minBorrowUsd: 100,
    gasCostUsd: 2,
    maxPaybackDays: 60,
  });
  assert.equal(r.enter, true);
  assert.equal(r.reason, "loop-enter");
  assert.ok(Math.abs(r.paybackDays - 36.5) < 1e-9);
});

test("loop entry: spread below minimum blocks", () => {
  const r = shouldEnterLoop({
    spreadBps: 50,
    minSpreadBps: 100,
    borrowUsd: 1000,
    minBorrowUsd: 100,
    gasCostUsd: 0,
    maxPaybackDays: 60,
  });
  assert.equal(r.enter, false);
  assert.match(r.reason, /spread/);
});

test("loop entry: borrow below minimum blocks", () => {
  const r = shouldEnterLoop({
    spreadBps: 200,
    minSpreadBps: 100,
    borrowUsd: 50,
    minBorrowUsd: 100,
    gasCostUsd: 2,
    maxPaybackDays: 60,
  });
  assert.equal(r.enter, false);
  assert.match(r.reason, /borrow/);
});

test("loop entry: gas payback above maximum blocks", () => {
  const r = shouldEnterLoop({
    spreadBps: 200,
    minSpreadBps: 100,
    borrowUsd: 1000,
    minBorrowUsd: 100,
    gasCostUsd: 200,
    maxPaybackDays: 60,
  });
  assert.equal(r.enter, false);
  assert.match(r.reason, /payback/);
});

test("loop entry: zero gas is treated as zero payback", () => {
  const r = shouldEnterLoop({
    spreadBps: 100,
    minSpreadBps: 100,
    borrowUsd: 1000,
    minBorrowUsd: 1000,
    gasCostUsd: 0,
    maxPaybackDays: 0,
  });
  assert.deepEqual(r, { enter: true, reason: "loop-enter", paybackDays: 0 });
});

test("loop exit: spread below exit threshold", () => {
  assert.equal(shouldExitLoop({ spreadBps: 50, exitSpreadBps: 100 }), true);
  assert.equal(shouldExitLoop({ spreadBps: 100, exitSpreadBps: 100 }), false);
  assert.equal(shouldExitLoop({ spreadBps: 150, exitSpreadBps: 100 }), false);
});

test("surplus sweep: loop equity first, capped by collateral room", () => {
  const p = surplusSweepPlan({
    idleQuote: 0n,
    idleEquity: 10n * E18,
    quotePriceWad: PRICE_200_WAD,
    navUsd: 10_000,
    reserveUsd: 0,
    reservePctBps: 0,
    armCollateralValue: 0n,
    armDebt: 0n,
    maxLtvBps: 8_000,
    targetLtvBps: 3_000,
    armCollateralRoom: 1_000n * Q6, // $1000 room -> 5 equity at $200
    borrowRoom: 0n,
    borrowLiquidity: 5_000n * Q6,
    lendRoom: 0n,
    minSweepUsd: 10,
    gasCostUsd: 1,
    maxPaybackDays: 60,
    loopSpreadBps: 300,
    minSpreadBps: 100,
    loopEnabled: true,
  });
  assert.equal(p.action, "ALLOCATE_EQUITY");
  assert.equal(p.amount, 5n * E18);
  assert.ok(Math.abs(p.amountUsd - 1_000) < 1e-9);
  assert.ok(p.paybackDays > 12 && p.paybackDays < 13);
});

test("surplus sweep: equity allocation capped by borrow liquidity", () => {
  const p = surplusSweepPlan({
    idleQuote: 0n,
    idleEquity: 10n * E18,
    quotePriceWad: PRICE_200_WAD,
    navUsd: 0,
    reserveUsd: 0,
    reservePctBps: 0,
    armCollateralValue: 0n,
    armDebt: 0n,
    maxLtvBps: 8_000,
    targetLtvBps: 3_000,
    armCollateralRoom: 100_000n * Q6,
    borrowRoom: 0n,
    borrowLiquidity: 500n * Q6,
    lendRoom: 0n,
    minSweepUsd: 10,
    gasCostUsd: 0,
    maxPaybackDays: 60,
    loopSpreadBps: 300,
    minSpreadBps: 100,
    loopEnabled: true,
  });
  // $500 liquidity * 10000 / 3000 = $1666.67 collateral -> 8.333... equity.
  assert.equal(p.action, "ALLOCATE_EQUITY");
  assert.equal(p.amount, 8_333_333_330_000_000_000n);
});

test("surplus sweep: loop disabled skips the equity leg and borrows next", () => {
  const common = {
    idleQuote: 10_000n * Q6,
    idleEquity: 10n * E18,
    quotePriceWad: PRICE_200_WAD,
    navUsd: 20_000,
    reserveUsd: 0,
    reservePctBps: 0,
    armCollateralValue: 10_000n * Q6,
    maxLtvBps: 6_250,
    targetLtvBps: 3_000,
    armCollateralRoom: 1_000n * Q6,
    borrowRoom: 500n * Q6,
    borrowLiquidity: 5_000n * Q6,
    lendRoom: 10_000n * Q6,
    minSweepUsd: 100,
    gasCostUsd: 1,
    maxPaybackDays: 60,
    loopSpreadBps: 300,
    minSpreadBps: 100,
    loopEnabled: false,
    lendAprBps: 500,
  };

  const borrow = surplusSweepPlan({ ...common, armDebt: 1_000n * Q6 });
  assert.equal(borrow.action, "BORROW");
  assert.equal(borrow.amount, 500n * Q6);

  const quote = surplusSweepPlan({ ...common, armDebt: 3_000n * Q6 });
  assert.equal(quote.action, "ALLOCATE_QUOTE");
  assert.equal(quote.amount, 10_000n * Q6);
});

test("surplus sweep: quote surplus uses the larger cash/pct reserve", () => {
  const p = surplusSweepPlan({
    idleQuote: 10_000n * Q6,
    idleEquity: 0n,
    quotePriceWad: PRICE_200_WAD,
    navUsd: 50_000,
    reserveUsd: 1_000,
    reservePctBps: 500, // 5% of NAV = $2500, larger than $1000
    armCollateralValue: 0n,
    armDebt: 0n,
    maxLtvBps: 6_250,
    targetLtvBps: 3_000,
    armCollateralRoom: 0n,
    borrowRoom: 0n,
    borrowLiquidity: 0n,
    lendRoom: 10_000n * Q6,
    minSweepUsd: 0,
    gasCostUsd: 0,
    maxPaybackDays: 60,
    lendAprBps: 500,
  });
  assert.equal(p.action, "ALLOCATE_QUOTE");
  assert.equal(p.amount, 7_500n * Q6);
});

test("surplus sweep: zero surplus -> NONE", () => {
  const p = surplusSweepPlan({
    idleQuote: 1_000n * Q6,
    idleEquity: 0n,
    quotePriceWad: PRICE_200_WAD,
    reserveUsd: 1_000,
    reservePctBps: 0,
    armCollateralValue: 0n,
    armDebt: 0n,
    maxLtvBps: 6_250,
    targetLtvBps: 3_000,
    lendRoom: 10_000n * Q6,
    minSweepUsd: 0,
    gasCostUsd: 0,
    lendAprBps: 500,
  });
  assert.equal(p.action, "NONE");
  assert.match(p.reason, /no surplus/);
});

test("surplus sweep: minimum sweep gate returns NONE", () => {
  const p = surplusSweepPlan({
    idleQuote: 0n,
    idleEquity: 10n * E18,
    quotePriceWad: PRICE_200_WAD,
    armCollateralValue: 0n,
    armDebt: 0n,
    maxLtvBps: 8_000,
    targetLtvBps: 3_000,
    armCollateralRoom: 1_000n * Q6,
    borrowLiquidity: 5_000n * Q6,
    minSweepUsd: 2_000,
    gasCostUsd: 0,
    maxPaybackDays: 60,
    loopSpreadBps: 300,
    minSpreadBps: 100,
    loopEnabled: true,
  });
  assert.equal(p.action, "NONE");
  assert.match(p.reason, /min/);
});

test("surplus sweep: gas payback gate returns NONE with payback", () => {
  const p = surplusSweepPlan({
    idleQuote: 0n,
    idleEquity: 10n * E18,
    quotePriceWad: PRICE_200_WAD,
    armCollateralValue: 0n,
    armDebt: 0n,
    maxLtvBps: 8_000,
    targetLtvBps: 3_000,
    armCollateralRoom: 1_000n * Q6,
    borrowLiquidity: 5_000n * Q6,
    minSweepUsd: 0,
    gasCostUsd: 1_000,
    maxPaybackDays: 60,
    loopSpreadBps: 300,
    minSpreadBps: 100,
    loopEnabled: true,
  });
  assert.equal(p.action, "NONE");
  assert.match(p.reason, /payback/);
  assert.ok(p.paybackDays > 60);
});

test("surplus sweep: invalid LTV pair throws", () => {
  assert.throws(
    () =>
      surplusSweepPlan({
        maxLtvBps: 6_250,
        targetLtvBps: 7_000,
      }),
    RangeError,
  );
});

test("switch confirmation: same target must persist before confirming", () => {
  const first = decideSwitchConfirmation({
    pending: null,
    target: "v3-0.05",
    netAprBps: 800,
    now: 1_000,
    confirmSeconds: 60,
  });
  assert.deepEqual(first, {
    confirmed: false,
    pending: { target: "v3-0.05", since: 1_000, netAprBps: 800 },
  });

  const early = decideSwitchConfirmation({
    pending: first.pending,
    target: "v3-0.05",
    netAprBps: 900,
    now: 1_030,
    confirmSeconds: 60,
  });
  assert.equal(early.confirmed, false);
  assert.equal(early.pending.since, 1_000);
  assert.equal(early.pending.netAprBps, 900);

  const confirmed = decideSwitchConfirmation({
    pending: early.pending,
    target: "v3-0.05",
    netAprBps: 900,
    now: 1_060,
    confirmSeconds: 60,
  });
  assert.deepEqual(confirmed, { confirmed: true, pending: null });
});

test("switch confirmation: target change restarts the timer", () => {
  const first = decideSwitchConfirmation({
    pending: null,
    target: "v3-0.05",
    netAprBps: 800,
    now: 1_000,
    confirmSeconds: 60,
  });
  const changed = decideSwitchConfirmation({
    pending: first.pending,
    target: "v4-0.05",
    netAprBps: 850,
    now: 1_010,
    confirmSeconds: 60,
  });
  assert.equal(changed.confirmed, false);
  assert.deepEqual(changed.pending, {
    target: "v4-0.05",
    since: 1_010,
    netAprBps: 850,
  });
});

test("switch confirmation: falsy target or non-positive edge resets", () => {
  const pending = { target: "v3-0.05", since: 1_000, netAprBps: 800 };
  assert.deepEqual(
    decideSwitchConfirmation({
      pending,
      target: null,
      netAprBps: 800,
      now: 1_100,
      confirmSeconds: 60,
    }),
    { confirmed: false, pending: null },
  );
  assert.deepEqual(
    decideSwitchConfirmation({
      pending,
      target: "v3-0.05",
      netAprBps: 0,
      now: 1_100,
      confirmSeconds: 60,
    }),
    { confirmed: false, pending: null },
  );
});

test("switch confirmation: ARMS target confirms on a negative edge when allowNonPositive", () => {
  const first = decideSwitchConfirmation({
    pending: null,
    target: "ARMS",
    netAprBps: -100,
    now: 1_000,
    confirmSeconds: 60,
    allowNonPositive: true,
  });
  assert.deepEqual(first, {
    confirmed: false,
    pending: { target: "ARMS", since: 1_000, netAprBps: -100 },
  });

  const confirmed = decideSwitchConfirmation({
    pending: first.pending,
    target: "ARMS",
    netAprBps: -100,
    now: 1_060,
    confirmSeconds: 60,
    allowNonPositive: true,
  });
  assert.deepEqual(confirmed, { confirmed: true, pending: null });
});

test("switch confirmation: ARMS target resets on a negative edge without allowNonPositive", () => {
  const pending = { target: "ARMS", since: 1_000, netAprBps: -100 };
  assert.deepEqual(
    decideSwitchConfirmation({
      pending,
      target: "ARMS",
      netAprBps: -100,
      now: 1_060,
      confirmSeconds: 60,
    }),
    { confirmed: false, pending: null },
  );
});

test("switch confirmation: switch target still resets at a zero edge with allowNonPositive", () => {
  const pending = { target: "v3-0.05", since: 1_000, netAprBps: 800 };
  assert.deepEqual(
    decideSwitchConfirmation({
      pending,
      target: "v3-0.05",
      netAprBps: 0,
      now: 1_060,
      confirmSeconds: 60,
      allowNonPositive: false,
    }),
    { confirmed: false, pending: null },
  );
});
