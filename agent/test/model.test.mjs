import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeTvl,
  bandToTicks,
  decide,
  feeMetrics,
  logReturns,
  hourlyVolatility,
  pInRange,
  simulateRange,
  tickSpacingForFee,
  tokenUsdPrices,
} from "../model.mjs";

const close = (x) => Math.abs(x) < 1e-12;

test("logReturns computes hourly log returns", () => {
  const returns = logReturns([100, 110, 99]);
  assert.equal(returns.length, 2);
  assert.ok(close(returns[0] - Math.log(1.1)));
  assert.ok(close(returns[1] - Math.log(0.9)));
});

test("hourlyVolatility is zero for flat prices and matches rms for alternating returns", () => {
  assert.equal(hourlyVolatility(logReturns([5, 5, 5])), 0);
  const sigma = hourlyVolatility([0.01, -0.01, 0.01, -0.01]);
  assert.ok(close(sigma - 0.01));
});

test("feeMetrics computes effective fee bps, APR and per-hour yield", () => {
  const rows = [
    { volumeUSD: "1000", feesUSD: "3" },
    { volumeUSD: "1000", feesUSD: "3" },
    { volumeUSD: "0", feesUSD: "0" },
  ];
  const m = feeMetrics(rows, 100_000);
  assert.equal(m.hours, 3);
  assert.equal(m.volumeUsd, 2000);
  assert.equal(m.feesUsd, 6);
  assert.ok(close(m.effectiveFeeBps - 30));
  assert.ok(close(m.feeApr - (6 / 100_000) * (8760 / 3)));
  assert.ok(close(m.feePerHourPerUsd - 6 / 3 / 100_000));
});

test("bandToTicks maps bps to ticks", () => {
  assert.equal(bandToTicks(100), 100);
  assert.equal(bandToTicks(25), 25);
  assert.equal(bandToTicks(10_000), 6932);
});

test("pInRange matches two-sided normal probability", () => {
  const p = pInRange(100, 0.01, 1); // k = ln(1.01)/0.01 = 0.995
  assert.ok(p > 0.67 && p < 0.69);
});

test("tickSpacingForFee maps standard tiers", () => {
  assert.equal(tickSpacingForFee(100), 1);
  assert.equal(tickSpacingForFee(500), 10);
  assert.equal(tickSpacingForFee(3000), 60);
  assert.equal(tickSpacingForFee(10000), 200);
});

test("tokenUsdPrices solves from TVL and amounts", () => {
  const prices = tokenUsdPrices(1000, 500, 500, 2);
  assert.ok(close(prices.price1 - 1000 / 1500));
  assert.ok(close(prices.price0 - 2000 / 1500));
});

test("activeTvl values the in-range liquidity band", () => {
  const pool = {
    liquidity: "1000000000000000000",
    tick: 0,
    feeTier: 3000,
    sqrtPrice: String(2n ** 96n),
    totalValueLockedUSD: "1000",
    totalValueLockedToken0: "500",
    totalValueLockedToken1: "500",
    token0: { decimals: "18" },
    token1: { decimals: "18" },
  };
  const active = activeTvl(pool);
  assert.ok(active);
  assert.ok(close(active.price1Per0 - 1));
  assert.ok(active.activeTvlUsd > 0);
  assert.ok(active.activeShare > 0 && active.activeShare <= 1);
});

test("simulateRange with zero volatility has zero IL and fees-only edge", () => {
  const r = simulateRange({
    price: 100,
    bandBps: 100,
    sigmaHourly: 0,
    horizonHours: 1,
    feePerHourPerUsd: 1e-5,
    tvlUsd: 0,
    paths: 256,
    seed: 1,
  });
  assert.ok(close(r.expectedIlBps));
  assert.ok(r.netEdgeBps > 0);
  assert.equal(r.pProfitable, 1);
});

test("simulateRange regression: out-of-range paths never give positive IL", () => {
  const r = simulateRange({
    price: 0.00456,
    bandBps: 25,
    sigmaHourly: 0.02,
    horizonHours: 1,
    feePerHourPerUsd: 1e-5,
    tvlUsd: 50_000,
    activeTvlUsd: 2_500,
    paths: 4000,
    seed: 7,
  });
  assert.ok(r.expectedIlBps < 0, `expected negative IL, got ${r.expectedIlBps}`);
});

test("active TVL share dilutes fee yield but stays positive", () => {
  const base = {
    price: 1,
    bandBps: 500,
    sigmaHourly: 0.001,
    horizonHours: 1,
    paths: 512,
    seed: 3,
  };
  const deep = simulateRange({ ...base, feePerHourPerUsd: 1e-5, tvlUsd: 1_000_000, activeTvlUsd: 1_000_000 });
  const shallow = simulateRange({ ...base, feePerHourPerUsd: 1e-5, tvlUsd: 1_000_000, activeTvlUsd: 5_000 });
  assert.ok(shallow.expectedFeeBps > deep.expectedFeeBps);
});

test("decide flags LP when edge clears the threshold", () => {
  const pool = {
    available: true,
    price: 1,
    tvlUsd: 1_000_000,
    active: { activeTvlUsd: 5_000 },
    volatility: { h3: 0.0005, h14d: 0.003 },
    metrics: { feePerHourPerUsd: 1e-5 },
  };
  const decision = decide(pool, [25, 50, 100], { horizonHours: 1, minEdgeBps: 0.2, minPInRange: 0.6, seed: 9 });
  assert.equal(decision.worthLp, true);
  assert.ok(decision.suggestedBucketTicks > 0);
  assert.ok(decision.suggestedMaxDeployUsdc > 0);
});

test("decide returns false when volatility dwarfs fees", () => {
  const pool = {
    available: true,
    price: 1,
    tvlUsd: 1_000_000,
    active: { activeTvlUsd: 1_000_000 },
    volatility: { h3: 0.25, h14d: 0.25 },
    metrics: { feePerHourPerUsd: 1e-7 },
  };
  const decision = decide(pool, [25, 50, 100], { horizonHours: 1, minEdgeBps: 0.2, minPInRange: 0.6, seed: 9 });
  assert.equal(decision.worthLp, false);
});
