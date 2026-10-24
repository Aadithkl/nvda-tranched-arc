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

test("arm entry: USDG first, then NVDA, then borrow", () => {
  // 10,000 USDG; 100 NVDA at $200; 80% quote, 10% NVDA; 29.375% LTV.
  const p = planArmEntry({
    usdgAvailable: 10_000n * 10n ** 6n,
    nvdaAvailable: 100n * 10n ** 18n,
    nvdaPriceWad: 200n * 10n ** 18n,
    ltvBps: 2_937,
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

test("arm entry: no borrow above the hard 30% cap", () => {
  const p = planArmEntry({
    usdgAvailable: 0n,
    nvdaAvailable: 1_000n * 10n ** 18n,
    nvdaPriceWad: 200n * 10n ** 18n,
    ltvBps: 6_000, // operator asks 60%
    maxLtvBps: 6_250,
    nvdaStepBps: 10_000,
  });
  // 1000 NVDA * $200 = $200,000; 30% hard cap = $60,000.
  assert.equal(p.borrow, 60_000n * 10n ** 6n);
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

test("pool switch: no pool beating the fee-vs-IL buffer -> arms", () => {
  const d = decidePoolSwitch({
    currentPool: "v4-0.05",
    candidates: [
      { name: "v3-0.05", netAprBps: 266, risk: "NORMAL" }, // +0.22% / 30d annualized
      { name: "v4-0.05", netAprBps: 100, risk: "NORMAL" },
    ],
    switchBufferBps: 500,
  });
  assert.equal(d.action, "ARMS");
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

test("pool switch: high-risk candidate is skipped", () => {
  const d = decidePoolSwitch({
    currentPool: "v4-0.05",
    candidates: [
      { name: "v3-0.05", netAprBps: 5000, risk: "HIGH" },
      { name: "v4-0.05", netAprBps: 200, risk: "NORMAL" },
    ],
    switchBufferBps: 500,
  });
  assert.equal(d.action, "ARMS");
});
