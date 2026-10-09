import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideStatic,
  decideStrategy,
  decideWinddown,
  edgeProximityBps,
  parkPlan,
  resumePlan,
  sessionStandbyPlan,
  tickToPrice,
} from "../static.mjs";

test("tickToPrice and edgeProximityBps measure distance to the nearest edge", () => {
  const mid = 196260;
  const lo = mid - 600;
  const hi = mid + 600;

  assert.ok(Math.abs(tickToPrice(mid) - 1.0001 ** mid) < 1e-9);

  const center = edgeProximityBps(mid, lo, hi);
  // Band is tick-symmetric, so both edges are ~equidistant; assert the distance magnitude.
  assert.ok(Math.abs(center.bps - 618) < 5, `center bps ${center.bps}`);
  assert.ok(center.edge === "lower" || center.edge === "upper");

  const nearHi = edgeProximityBps(hi - 100, lo, hi);
  assert.equal(nearHi.edge, "upper");
  assert.ok(nearHi.bps < 110, `near upper bps ${nearHi.bps}`);
});

test("decideStatic: exited book holds", () => {
  assert.equal(decideStatic({ exited: true }).action, "HOLD");
});

test("decideStatic: recheck due within band pokes, outside band holds", () => {
  const due = decideStatic({
    guardPresent: false,
    deployEnabled: true,
    recheckDue: true,
    deviationBps: 10,
    recheckMaxDeviationBps: 50,
  });
  assert.equal(due.action, "RECHECK");

  const dislocated = decideStatic({
    guardPresent: false,
    deployEnabled: true,
    recheckDue: true,
    deviationBps: 400,
    recheckMaxDeviationBps: 50,
  });
  assert.equal(dislocated.action, "HOLD");
});

test("decideStatic: guard near edge recenters, center holds", () => {
  const base = { guardPresent: true, guardLo: 195_660, guardHi: 196_860, edgeBandBps: 250 };

  const center = decideStatic({ ...base, tick: 196_260 });
  assert.equal(center.action, "HOLD");

  const edge = decideStatic({ ...base, tick: 196_840 });
  assert.equal(edge.action, "RECENTER");
  assert.equal(edge.edge.edge, "upper");
});

test("decideStatic: standby without guard holds", () => {
  const res = decideStatic({ guardPresent: false, deployEnabled: false, recheckDue: true, deviationBps: 0 });
  assert.equal(res.action, "HOLD");
  assert.match(res.reason, /standby/);
});

test("park/resume plans keep the required ordering", () => {
  const park = parkPlan();
  assert.deepEqual(park, [
    "controller.submitDeployEnabled(false)",
    "controller.submitRecall()",
    "vault.supplyIdle()",
  ]);

  const resume = resumePlan({ withdrawQuote: 1000e6, fundQuote: 200e6, fundEquity: 1e17 });
  assert.equal(resume.length, 4);
  assert.match(resume[0], /withdrawFromVenue/);
  assert.match(resume[1], /submitFund/);
  assert.match(resume[2], /submitDeployEnabled\(true\)/);
  assert.match(resume[3], /submitRecenter/);
});

test("decideStrategy: cap breach deallocates, low health deleverages", () => {
  assert.equal(decideStrategy({ capBreached: true }).action, "DEALLOCATE");
  assert.equal(decideStrategy({ healthFactorWad: 1.05e18 }).action, "DELEVERAGE");
  assert.equal(decideStrategy({ healthFactorWad: 2.5e18 }).action, "HOLD");
});

test("decideStrategy: closed session parks when deployed, holds when parked", () => {
  assert.equal(decideStrategy({ sessionOpen: false, deployEnabled: true }).action, "PARK");
  assert.equal(decideStrategy({ sessionOpen: false, deployEnabled: false, guardPresent: false }).action, "HOLD");
  assert.equal(decideStrategy({ sessionOpen: false, guardPresent: true }).action, "PARK");
});

test("decideStrategy: high utilization reallocates, standby resumes on open", () => {
  assert.equal(decideStrategy({ utilizationBps: 9700 }).action, "REALLOCATE");
  assert.equal(decideStrategy({ utilizationBps: 9000 }).action, "HOLD");
  assert.equal(decideStrategy({ sessionOpen: true, deployEnabled: false }).action, "RESUME");
});

test("sessionStandbyPlan maps the session clock to park/resume", () => {
  assert.deepEqual(sessionStandbyPlan(false), parkPlan());
  const resume = sessionStandbyPlan(true, { withdrawQuote: 500e6, fundQuote: 100e6, fundEquity: 0 });
  assert.equal(resume.length, 4);
  assert.match(resume[3], /submitRecenter/);
});

test("decideWinddown: halt at expiry, then settle when ready", () => {
  assert.equal(decideWinddown({}).action, "HOLD");
  assert.equal(decideWinddown({ expired: true }).action, "HALT");
  assert.equal(
    decideWinddown({ expired: true, halted: true, usdcUnits: 1_050e6, seniorGuarantee: 1_050e6 }).action,
    "SETTLE",
  );
});

test("decideWinddown: loop debt and shortfall gate settlement", () => {
  assert.equal(
    decideWinddown({ expired: true, halted: true, usdcUnits: 0, seniorGuarantee: 100e6, loopDebtUsdg: 5e6 }).action,
    "PREPARE_SETTLEMENT",
  );
  assert.equal(
    decideWinddown({ expired: true, halted: true, usdcUnits: 40e6, seniorGuarantee: 100e6 }).action,
    "HAIRCUT_OR_WAIT",
  );
  assert.equal(decideWinddown({ expired: true, settled: true }).action, "HOLD");
});

test("decideWinddown: soft halt inside the wind-down window", () => {
  assert.equal(decideWinddown({ inWinddownWindow: true, deployEnabled: true }).action, "SOFT_HALT");
  assert.equal(
    decideWinddown({ inWinddownWindow: true, deployEnabled: false, guardPresent: true }).action,
    "HOLD",
  );
});
