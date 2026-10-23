import test from "node:test";
import assert from "node:assert/strict";
import { decideDepeg, decideSleeve, decideGuard, decideArm } from "../decide.mjs";

test("depeg: no previous check -> CHECK", () => {
  assert.equal(decideDepeg({ now: 100, lastCheck: 0, interval: 1800 }).action, "CHECK");
});

test("depeg: fresh -> HOLD", () => {
  assert.equal(decideDepeg({ now: 100, lastCheck: 100, interval: 1800 }).action, "HOLD");
});

test("depeg: elapsed -> CHECK", () => {
  assert.equal(decideDepeg({ now: 1900, lastCheck: 100, interval: 1800 }).action, "CHECK");
});

test("depeg: paused automation -> HOLD", () => {
  assert.equal(
    decideDepeg({ now: 10_000, lastCheck: 0, interval: 1800, automationPaused: true }).action,
    "HOLD",
  );
});

const policy = { maxStockLtvBps: 4000, maxYieldLtvBps: 8500, minHealthBps: 2500, minCarryBps: 300 };
const healthy = {
  stockLtvBps: 3000,
  yieldLtvBps: 5000,
  healthBufferBps: 4000,
  netCarryBps: 800,
  carryKnown: true,
  venuePaused: false,
};

test("sleeve: healthy -> HOLD", () => {
  assert.equal(decideSleeve(healthy, policy).action, "HOLD");
});

test("sleeve: stock LTV over cap -> DERISK", () => {
  assert.equal(decideSleeve({ ...healthy, stockLtvBps: 4500 }, policy).action, "DERISK");
});

test("sleeve: yield LTV over cap -> DERISK", () => {
  assert.equal(decideSleeve({ ...healthy, yieldLtvBps: 9000 }, policy).action, "DERISK");
});

test("sleeve: low health -> DERISK", () => {
  assert.equal(decideSleeve({ ...healthy, healthBufferBps: 1000 }, policy).action, "DERISK");
});

test("sleeve: negative carry -> DERISK", () => {
  assert.equal(decideSleeve({ ...healthy, netCarryBps: -50 }, policy).action, "DERISK");
});

test("sleeve: unknown carry is not treated as zero carry", () => {
  assert.equal(
    decideSleeve({ ...healthy, netCarryBps: 0, carryKnown: false }, policy).action,
    "HOLD",
  );
});

test("sleeve: venue paused -> PAUSE", () => {
  assert.equal(decideSleeve({ ...healthy, venuePaused: true }, policy).action, "PAUSE");
});

test("sleeve: no sleeve -> HOLD", () => {
  assert.equal(decideSleeve(null, policy).action, "HOLD");
});

test("guard: present -> HOLD", () => {
  assert.equal(
    decideGuard({ now: 10_000, pulledAt: 1, recheckInterval: 300, guardPresent: true, deployEnabled: true }).action,
    "HOLD",
  );
});

test("guard: absent + interval elapsed -> RECHECK", () => {
  assert.equal(
    decideGuard({ now: 400, pulledAt: 1, recheckInterval: 300, guardPresent: false, deployEnabled: true }).action,
    "RECHECK",
  );
});

test("guard: deployments disabled -> HOLD", () => {
  assert.equal(
    decideGuard({ now: 400, pulledAt: 1, recheckInterval: 300, guardPresent: false, deployEnabled: false }).action,
    "HOLD",
  );
});

test("arm: no debt -> HOLD", () => {
  assert.equal(
    decideArm({ healthFactorWad: 1e18, debt: 0n, minHealthFactorWad: 1.5e18, borrowAprBps: 9999, maxBorrowAprBps: 3000 }).action,
    "HOLD",
  );
});

test("arm: health below floor -> DELEVERAGE", () => {
  assert.equal(
    decideArm({
      healthFactorWad: 1_200_000_000_000_000_000n,
      debt: 60_000_000n,
      minHealthFactorWad: 1_500_000_000_000_000_000n,
      borrowAprBps: 500,
      maxBorrowAprBps: 3000,
    }).action,
    "DELEVERAGE",
  );
});

test("arm: borrow APR above ceiling -> DELEVERAGE", () => {
  assert.equal(
    decideArm({
      healthFactorWad: 2_000_000_000_000_000_000n,
      debt: 60_000_000n,
      minHealthFactorWad: 1_500_000_000_000_000_000n,
      borrowAprBps: 3_500,
      maxBorrowAprBps: 3000,
    }).action,
    "DELEVERAGE",
  );
});

test("arm: healthy -> HOLD", () => {
  assert.equal(
    decideArm({
      healthFactorWad: 1_800_000_000_000_000_000n,
      debt: 60_000_000n,
      minHealthFactorWad: 1_500_000_000_000_000_000n,
      borrowAprBps: 500,
      maxBorrowAprBps: 3000,
    }).action,
    "HOLD",
  );
});
