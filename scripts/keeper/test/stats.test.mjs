import test from "node:test";
import assert from "node:assert/strict";
import {
  priceFromSqrtX96,
  summarizeBook,
  ilBps,
  ilBpsForTicks,
  activeLiquidityValue,
  positionValueUsd,
  liquidityForValue,
  rangeFromHalfWidth,
  marketStats,
} from "../stats.mjs";

test("price: sqrtPriceX96 = 2^96 -> raw price 1", () => {
  assert.equal(priceFromSqrtX96(1n << 96n), 1);
});

test("price: sqrtPriceX96 = 2^97 -> raw price 4", () => {
  assert.equal(priceFromSqrtX96(1n << 97n), 4);
});

test("book stats: volume, fees, fee APR, volatility", () => {
  const s = summarizeBook({
    swaps: [
      { amount0: -1_000n * 10n ** 6n, amount1: 5n * 10n ** 18n, sqrtPriceX96: 1n << 96n },
      { amount0: 500n * 10n ** 6n, amount1: -2n * 10n ** 18n, sqrtPriceX96: 1n << 97n },
    ],
    feePips: 3000,
    nav: 10_000n * 10n ** 6n,
    windowSeconds: 21_600,
    token0Decimals: 6,
    token1Decimals: 18,
  });

  assert.equal(s.volumeUsd, 1_500);
  assert.equal(s.feesUsd, 4.5);
  // 4.5 * (365d / 6h) / 10,000 = 65.7% = 6570 bps
  assert.equal(s.feeAprBps, 6_570);
  // prices 1e-12 and 4e-12: range 3e-12 / avg 2.5e-12 = 120% = 12000 bps
  assert.equal(s.volatilityBps, 12_000);
  assert.equal(s.swaps, 2);
});

test("book stats: empty window -> zeros", () => {
  const s = summarizeBook({
    swaps: [],
    feePips: 3000,
    nav: 10_000n * 10n ** 6n,
    windowSeconds: 21_600,
  });
  assert.equal(s.volumeUsd, 0);
  assert.equal(s.feesUsd, 0);
  assert.equal(s.feeAprBps, 0);
  assert.equal(s.volatilityBps, 0);
});

test("book stats: one swap -> zero volatility", () => {
  const s = summarizeBook({
    swaps: [{ amount0: -1_000n * 10n ** 6n, amount1: 5n * 10n ** 18n, sqrtPriceX96: 1n << 96n }],
    feePips: 3000,
    nav: 10_000n * 10n ** 6n,
    windowSeconds: 21_600,
  });
  assert.equal(s.volatilityBps, 0);
});

test("IL: no price move -> zero", () => {
  assert.equal(ilBps({ priceStart: 1, priceEnd: 1, halfWidthBps: 1_000 }), 0);
});

test("IL: full range +10% -> about -11 bps", () => {
  const b = ilBps({ priceStart: 1, priceEnd: 1.1, halfWidthBps: 10_000 });
  assert.ok(b <= -10 && b >= -12, `got ${b}`);
});

test("IL: concentrated +-10% loses more than full range", () => {
  const full = ilBps({ priceStart: 1, priceEnd: 1.1, halfWidthBps: 10_000 });
  const tight = ilBps({ priceStart: 1, priceEnd: 1.1, halfWidthBps: 1_000 });
  assert.ok(tight < full, `tight ${tight} full ${full}`);
  assert.ok(tight < -200, `tight ${tight}`);
});

test("active liquidity value: L=1e18 at sqrtP=1 is 2 token0", () => {
  assert.equal(activeLiquidityValue({ liquidity: 10n ** 18n, sqrtPriceX96: 1n << 96n, token0Decimals: 0 }), 2e18);
});

test("active liquidity value: L=1e18 at sqrtP=2 is 1 token0 (divides by sqrtP)", () => {
  assert.equal(activeLiquidityValue({ liquidity: 10n ** 18n, sqrtPriceX96: 1n << 97n, token0Decimals: 0 }), 1e18);
});

test("liquidityForValue: inverse of positionValueUsd", () => {
  const value = positionValueUsd({
    liquidity: 10n ** 18n,
    sqrtPriceX96: 1n << 96n,
    tickLower: -1_000,
    tickUpper: 1_000,
    token0Decimals: 0,
  });
  const l = liquidityForValue({
    valueUsd: value,
    sqrtPriceX96: 1n << 96n,
    tickLower: -1_000,
    tickUpper: 1_000,
    token0Decimals: 0,
  });
  assert.ok(Math.abs(l - 1e18) / 1e18 < 1e-6, `got ${l}`);
});

test("rangeFromHalfWidth: +-10% around tick 0", () => {
  const r = rangeFromHalfWidth({ currentTick: 0, halfWidthBps: 1_000 });
  assert.ok(r.tickLower < 0 && r.tickUpper > 0);
  assert.ok(Math.abs(r.tickUpper - 954) <= 2, `got ${r.tickUpper}`);
});

test("IL by ticks: no move -> zero", () => {
  assert.equal(ilBpsForTicks({ tickStart: 0, tickEnd: 0, tickLower: -1_000, tickUpper: 1_000 }), 0);
});

test("IL by ticks: move inside range -> negative", () => {
  const b = ilBpsForTicks({ tickStart: 0, tickEnd: 100, tickLower: -1_000, tickUpper: 1_000 });
  assert.ok(b < 0, `got ${b}`);
});

test("position value: at sqrtP=1, in-range position is positive", () => {
  const v = positionValueUsd({
    liquidity: 10n ** 18n,
    sqrtPriceX96: 1n << 96n,
    tickLower: -1_000,
    tickUpper: 1_000,
    token0Decimals: 0,
  });
  assert.ok(v > 0, `got ${v}`);
});

test("position value: above range is all token1 and still positive", () => {
  const v = positionValueUsd({
    liquidity: 10n ** 18n,
    sqrtPriceX96: 1n << 98n,
    tickLower: -1_000,
    tickUpper: 1_000,
    token0Decimals: 0,
  });
  assert.ok(v > 0, `got ${v}`);
});

test("guard pull: bookShare 0 -> book fee APR 0 even if pool fees are high", () => {
  const book = {
    volumeUsd: 1_000_000,
    feesUsd: 500,
    volatilityBps: 100,
    priceFirst: 1,
    priceLast: 1,
    tickFirst: 0,
    tickLast: 0,
    priceMin: 1,
    priceMax: 1,
    priceAvg: 1,
    swaps: 2,
  };
  const m = marketStats({
    book,
    activeLiquidityUsd: 100_000,
    windowSeconds: 21_600,
    rangeHalfWidthBps: 1_000,
    bookShare: 0,
    bookValueUsd: 10_000,
    bookRange: { tickLower: -1_000, tickUpper: 1_000 },
    tickStart: 0,
    tickEnd: 0,
  });
  assert.equal(m.feeAprBps, 0);
  assert.ok(m.netAprBps <= 0);
});

test("position-level fees: share 10% of pool fees over book value", () => {
  const book = {
    volumeUsd: 1_000_000,
    feesUsd: 500,
    volatilityBps: 100,
    priceFirst: 1,
    priceLast: 1,
    tickFirst: 0,
    tickLast: 0,
    priceMin: 1,
    priceMax: 1,
    priceAvg: 1,
    swaps: 2,
  };
  const m = marketStats({
    book,
    activeLiquidityUsd: 100_000,
    windowSeconds: 21_600,
    rangeHalfWidthBps: 1_000,
    bookShare: 0.1,
    bookValueUsd: 10_000,
    bookRange: { tickLower: -1_000, tickUpper: 1_000 },
    tickStart: 0,
    tickEnd: 0,
  });
  // 500 * 0.1 / 10,000 = 0.5% over 6h -> 730% annualized = 73,000 bps
  assert.ok(m.feeAprBps > 70_000 && m.feeAprBps < 76_000, `fee ${m.feeAprBps}`);
});

test("market stats: fee APR minus annualized IL", () => {
  const book = {
    volumeUsd: 1_000,
    feesUsd: 0.5,
    volatilityBps: 100,
    priceFirst: 1,
    priceLast: 1.1,
    priceMin: 1,
    priceMax: 1.1,
    priceAvg: 1.05,
    swaps: 2,
  };
  const m = marketStats({
    book,
    activeLiquidityUsd: 10_000,
    windowSeconds: 21_600,
    rangeHalfWidthBps: 1_000,
  });
  // 0.5 / 10,000 = 0.005% over 6h; annualized = 7.3% = 730 bps (approx)
  assert.ok(m.feeAprBps > 700 && m.feeAprBps < 760, `fee ${m.feeAprBps}`);
  assert.ok(m.ilBps < 0);
  assert.ok(m.netAprBps < m.feeAprBps);
});
