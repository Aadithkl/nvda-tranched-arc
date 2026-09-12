import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeTvl,
  bandToTicks,
  decide,
  feeMetrics,
  ilBpsAtPrice,
  ilShockTable,
  logReturns,
  hourlyVolatility,
  pInRange,
  portfolioIlBps,
  portfolioValueUsd,
  rebalanceCostBps,
  rebalanceDecision,
  rebalancingPremiumBps,
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

test("ilBpsAtPrice: zero move has zero IL, moves are negative and monotonic", () => {
  const p0 = 100;
  assert.ok(close(ilBpsAtPrice(p0, p0, 100)));
  const down1 = ilBpsAtPrice(p0, 99, 100);
  const down5 = ilBpsAtPrice(p0, 95, 100);
  const up1 = ilBpsAtPrice(p0, 101, 100);
  assert.ok(down1 < 0 && down5 < down1);
  assert.ok(up1 < 0);
  assert.ok(down5 < up1);
});

test("simulateRange risk analytics are coherent", () => {
  const r = simulateRange({
    price: 100,
    bandBps: 100,
    sigmaHourly: 0.005,
    horizonHours: 1,
    feePerHourPerUsd: 1e-5,
    tvlUsd: 500_000,
    activeTvlUsd: 10_000,
    paths: 4000,
    seed: 11,
  });
  assert.ok(r.var95Bps < r.ilP50Bps, "VaR95 must be worse than median");
  assert.ok(r.cvar95Bps <= r.var95Bps, "CVaR95 must be at least as bad as VaR95");
  assert.ok(r.ilWorstBps <= r.var95Bps);
  assert.ok(r.pIlExceedsFees >= 0 && r.pIlExceedsFees <= 1);
  assert.ok(r.requiredFeeBps >= 0);
  assert.ok(r.breakevenFeePerHourPerUsd >= 0);
  assert.ok(r.expectedTimeInRange > 0 && r.expectedTimeInRange <= 1);
  const sigmaRows = r.ilShocks.filter((row) => row.kind === "sigma");
  assert.equal(sigmaRows.length, 6);
  assert.ok(sigmaRows.every((row) => row.ilBps <= 0));
});

test("ilShockTable percent rows are symmetric and deeper moves hurt more", () => {
  const rows = ilShockTable({ price: 100, bandBps: 100, sigmaHourly: null });
  const at = (pct) => rows.find((row) => row.move === pct).ilBps;
  assert.ok(at(-10) < at(-5) && at(-5) < at(-1));
  assert.ok(at(10) < at(5) && at(5) < at(1));
  assert.ok(at(1) < 0 && at(-1) < 0);
});

test("decide rejects LP when IL risk exceeds the gate", () => {
  const pool = {
    available: true,
    price: 1,
    tvlUsd: 1_000_000,
    active: { activeTvlUsd: 10_000 },
    volatility: { h3: 0.05, h14d: 0.05 },
    metrics: { feePerHourPerUsd: 1e-6 },
  };
  const decision = decide(pool, [25, 50, 100], {
    horizonHours: 1,
    minEdgeBps: 0.2,
    minPInRange: 0.6,
    maxPIlExceedsFees: 0.01,
    seed: 13,
  });
  assert.equal(decision.worthLp, false);
  assert.equal(decision.reason, "il_risk_too_high");
  assert.ok(decision.risk.var95Bps < 0);
  assert.ok(decision.risk.ilShocks.length >= 8);
});

test("portfolioValueUsd values a dual-asset book", () => {
  assert.equal(portfolioValueUsd({ usdcAmount: 300, equityAmount: 1, equityPriceUsd: 200 }), 500);
  assert.equal(portfolioValueUsd({}), 0);
});

test("portfolioIlBps is zero against a mark-to-market benchmark and negative when shifted", () => {
  const flat = portfolioIlBps({
    usdcAmount: 300,
    equityAmount: 1,
    equityPriceUsd: 220,
    refUsdc: 300,
    refEquity: 1,
  });
  assert.equal(flat, 0);
  const shifted = portfolioIlBps({
    usdcAmount: 200,
    equityAmount: 1.5,
    equityPriceUsd: 220,
    refUsdc: 300,
    refEquity: 1,
  });
  assert.ok(shifted > 0, "selling USDC to hold more equity into a rally beats the reference hold");
  assert.equal(portfolioIlBps({ usdcAmount: 1, equityAmount: 1, equityPriceUsd: 0 }), null);
});

test("rebalancingPremiumBps is maximized at 50/50 and scales with sigma^2", () => {
  const w70 = rebalancingPremiumBps({ weight: 0.7, sigmaHourly: 0.01, horizonHours: 1 });
  const w50 = rebalancingPremiumBps({ weight: 0.5, sigmaHourly: 0.01, horizonHours: 1 });
  const w70Double = rebalancingPremiumBps({ weight: 0.7, sigmaHourly: 0.02, horizonHours: 1 });
  assert.ok(Math.abs(w70 - 0.21) < 1e-9);
  assert.ok(Math.abs(w50 - 0.25) < 1e-9);
  assert.ok(Math.abs(w70Double - w70 * 4) < 1e-9);
});

test("rebalanceCostBps measures quote slippage versus oracle", () => {
  assert.ok(Math.abs(rebalanceCostBps({ oracleOut: 100, quotedOut: 99 }) - 100) < 1e-9);
  assert.equal(rebalanceCostBps({ oracleOut: 0, quotedOut: 1 }), null);
});

test("rebalanceDecision trims above the hard cap regardless of edge", () => {
  const d = rebalanceDecision({
    equityBps: 9000,
    hardCapBps: 8000,
    escrowFunded: false,
    worthLp: false,
    navUsd: 100_000,
    minSwapUsd: 10,
  });
  assert.equal(d.action, "sell");
  assert.equal(d.reason, "above_hard_cap");
  assert.equal(d.sizeUsd, 10_000);
});

test("rebalanceDecision buys inventory only when funded with positive edge and cap headroom", () => {
  const base = {
    equityBps: 3000,
    hardCapBps: 8000,
    escrowFunded: true,
    oracleValid: true,
    worthLp: true,
    lpEdgeBps: 5,
    minEdgeBps: 0.2,
    navUsd: 100_000,
    suggestedDeployUsd: 500,
    minSwapUsd: 10,
    maxSwapUsd: 1_000,
  };
  assert.equal(rebalanceDecision(base).action, "buy");
  assert.equal(rebalanceDecision({ ...base, escrowFunded: false }).reason, "escrow_unfunded");
  assert.equal(rebalanceDecision({ ...base, worthLp: false }).reason, "no_positive_lp_edge");
  assert.equal(rebalanceDecision({ ...base, lpEdgeBps: 0 }).reason, "no_positive_lp_edge");
  assert.equal(rebalanceDecision({ ...base, oracleValid: false }).reason, "oracle_invalid");
  assert.equal(rebalanceDecision({ ...base, equityBps: 7700 }).reason, "within_cap_margin");
  const small = rebalanceDecision({ ...base, suggestedDeployUsd: 5 });
  assert.equal(small.action, "hold");
  assert.equal(small.reason, "buy_below_min_size");
  const capped = rebalanceDecision({ ...base, suggestedDeployUsd: 99_999 });
  assert.equal(capped.action, "buy");
  assert.equal(capped.sizeUsd, 1_000);
});
