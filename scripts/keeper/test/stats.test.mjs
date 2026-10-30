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
  chunkedBlockRanges,
  computeGuardUptime,
  filterSwapsByBlock,
  pruneSwapCache,
  mergeSwapCache,
  fetchBookStats,
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

// A flat book fixture: $500 of pool fees over 6h and a $10,000 book value, so
// feeApr = 730,000 * share bps.
const BOOK = {
  volumeUsd: 1_000_000,
  feesUsd: 500,
  volatilityBps: 100,
  priceFirst: 1,
  priceLast: 1,
  tickFirst: 0,
  tickLast: 0,
  tickMin: 0,
  tickMax: 0,
  priceMin: 1,
  priceMax: 1,
  priceAvg: 1,
  swaps: 2,
};

test("book stats: tick min/max are the range of observed ticks", () => {
  const s = summarizeBook({
    swaps: [
      { amount0: 10n ** 6n, sqrtPriceX96: 1n << 96n, tick: -120 },
      { amount0: 10n ** 6n, sqrtPriceX96: 1n << 96n, tick: 45 },
      { amount0: 10n ** 6n, sqrtPriceX96: 1n << 96n, tick: -30 },
    ],
    feePips: 500,
    windowSeconds: 21_600,
  });
  assert.equal(s.tickFirst, -120);
  assert.equal(s.tickLast, -30);
  assert.equal(s.tickMin, -120);
  assert.equal(s.tickMax, 45);
});

test("book stats: no ticks -> tick range zeros", () => {
  const s = summarizeBook({
    swaps: [{ amount0: 10n ** 6n, sqrtPriceX96: 1n << 96n }],
    feePips: 500,
    windowSeconds: 21_600,
  });
  assert.equal(s.tickFirst, 0);
  assert.equal(s.tickLast, 0);
  assert.equal(s.tickMin, 0);
  assert.equal(s.tickMax, 0);
});

test("guard uptime: no events -> fully up", () => {
  const r = computeGuardUptime({ events: [], windowStart: 1_000, windowEnd: 2_000 });
  assert.equal(r.uptime, 1);
  assert.equal(r.pulledSeconds, 0);
  assert.deepEqual(r.intervals, []);
});

test("guard uptime: deployed-only stream -> fully up", () => {
  const r = computeGuardUptime({
    events: [
      { type: "deployed", timestamp: 1_100 },
      { type: "deployed", timestamp: 1_500 },
    ],
    windowStart: 1_000,
    windowEnd: 2_000,
  });
  assert.equal(r.uptime, 1);
  assert.equal(r.pulledSeconds, 0);
});

test("guard uptime: pulled for half the window -> 50%", () => {
  const r = computeGuardUptime({
    events: [
      { type: "pulled", timestamp: 1_000 },
      { type: "deployed", timestamp: 1_500 },
    ],
    windowStart: 1_000,
    windowEnd: 2_000,
  });
  assert.equal(r.pulledSeconds, 500);
  assert.equal(r.uptime, 0.5);
  assert.deepEqual(r.intervals, [{ from: 1_000, to: 1_500, seconds: 500 }]);
});

test("guard uptime: still down at window end counts to windowEnd", () => {
  const r = computeGuardUptime({
    events: [{ type: "pulled", timestamp: 1_750 }],
    windowStart: 1_000,
    windowEnd: 2_000,
  });
  assert.equal(r.pulledSeconds, 250);
  assert.equal(r.uptime, 0.75);
});

test("guard uptime: down before window start counts from windowStart", () => {
  const r = computeGuardUptime({
    events: [
      { type: "pulled", timestamp: 500 },
      { type: "deployed", timestamp: 1_250 },
    ],
    windowStart: 1_000,
    windowEnd: 2_000,
  });
  assert.equal(r.pulledSeconds, 250);
  assert.equal(r.uptime, 0.75);
});

test("guard uptime: repeated pull while down does not double count", () => {
  const r = computeGuardUptime({
    events: [
      { type: "pulled", timestamp: 1_000 },
      { type: "pulled", timestamp: 1_200 },
      { type: "deployed", timestamp: 1_500 },
    ],
    windowStart: 1_000,
    windowEnd: 2_000,
  });
  assert.equal(r.pulledSeconds, 500);
  assert.equal(r.uptime, 0.5);
});

test("guard uptime: block numbers fall back to blockTimeSeconds", () => {
  const r = computeGuardUptime({
    events: [
      { type: "pulled", blockNumber: 100n },
      { type: "deployed", blockNumber: 150n },
    ],
    windowStart: 0,
    windowEnd: 1_000, // 0.1s blocks -> 10s..15s
  });
  assert.ok(Math.abs(r.pulledSeconds - 5) < 1e-9, `pulled ${r.pulledSeconds}`);
  assert.ok(Math.abs(r.uptime - 0.995) < 1e-9, `uptime ${r.uptime}`);
});

test("guard uptime: unparseable timestamp falls back to blockNumber", () => {
  const r = computeGuardUptime({
    events: [
      { type: "pulled", timestamp: "n/a", blockNumber: 100n },
      { type: "deployed", timestamp: "n/a", blockNumber: 150n },
    ],
    windowStart: 0,
    windowEnd: 1_000,
  });
  assert.ok(Math.abs(r.pulledSeconds - 5) < 1e-9, `pulled ${r.pulledSeconds}`);
});

test("chunked ranges: exact multiple", () => {
  assert.deepEqual(chunkedBlockRanges({ fromBlock: 0n, toBlock: 9n, chunkBlocks: 5n }), [
    { fromBlock: 0n, toBlock: 4n },
    { fromBlock: 5n, toBlock: 9n },
  ]);
});

test("chunked ranges: remainder clamps the last chunk", () => {
  assert.deepEqual(chunkedBlockRanges({ fromBlock: 100, toBlock: 112, chunkBlocks: 5 }), [
    { fromBlock: 100n, toBlock: 104n },
    { fromBlock: 105n, toBlock: 109n },
    { fromBlock: 110n, toBlock: 112n },
  ]);
});

test("chunked ranges: single block and empty/invalid windows", () => {
  assert.deepEqual(chunkedBlockRanges({ fromBlock: 7n, toBlock: 7n, chunkBlocks: 5n }), [
    { fromBlock: 7n, toBlock: 7n },
  ]);
  assert.deepEqual(chunkedBlockRanges({ fromBlock: 11n, toBlock: 10n, chunkBlocks: 5n }), []);
  assert.deepEqual(chunkedBlockRanges({ fromBlock: 0n, toBlock: 10n, chunkBlocks: 0n }), []);
  assert.deepEqual(chunkedBlockRanges({ fromBlock: 0n, toBlock: 10n, chunkBlocks: "nope" }), []);
});

test("filter swaps by block: bigint-safe inclusive range", () => {
  const swaps = [
    { blockNumber: 9n, tag: "before" },
    { blockNumber: 10, tag: "first" },
    { blockNumber: 15n, tag: "last" },
    { blockNumber: "16", tag: "after" },
    { tag: "unknown" },
  ];
  assert.deepEqual(
    filterSwapsByBlock(swaps, 10n, 15n).map((s) => s.tag),
    ["first", "last", "unknown"],
  );
});

test("filter swaps by block: missing bounds keep everything", () => {
  const swaps = [{ blockNumber: 1n }, { blockNumber: 2n }, {}];
  assert.equal(filterSwapsByBlock(swaps).length, 3);
  assert.equal(filterSwapsByBlock(swaps, null, 1n).length, 2);
});

test("swap cache: prune drops entries below fromBlock", () => {
  const entries = [
    { blockNumber: 9n, logIndex: 0 },
    { blockNumber: 10n, logIndex: 0 },
    { blockNumber: 11n },
    { logIndex: 1 },
  ];
  const kept = pruneSwapCache({ entries, fromBlock: 10n });
  assert.equal(kept.length, 3);
  assert.deepEqual(
    kept.map((e) => e.blockNumber),
    [10n, 11n, undefined],
  );
  assert.equal(entries.length, 4, "does not mutate the input");
});

test("swap cache: merge dedupes by block + logIndex", () => {
  const existing = [{ blockNumber: 1n, logIndex: 0, v: "a" }];
  const incoming = [
    { blockNumber: 1n, logIndex: 0, v: "duplicate" },
    { blockNumber: 1n, logIndex: 1, v: "b" },
  ];
  assert.deepEqual(
    mergeSwapCache(existing, incoming).map((e) => e.v),
    ["a", "b"],
  );
});

test("swap cache: merge dedupes by block + tx hash + index", () => {
  const existing = [{ blockNumber: 5, transactionHash: "0xAA", index: 0 }];
  const incoming = [
    { blockNumber: 5, transactionHash: "0xaa", index: 0 },
    { blockNumber: 5, transactionHash: "0xaa", index: 1 },
  ];
  assert.equal(mergeSwapCache(existing, incoming).length, 2);
});

test("swap cache: entries without an identity are kept", () => {
  assert.equal(mergeSwapCache([{}], [{}, { blockNumber: 1n }]).length, 3);
});

test("market stats: guard uptime discounts the guard share", () => {
  const args = {
    book: BOOK,
    activeLiquidityUsd: 100_000,
    windowSeconds: 21_600,
    bookValueUsd: 10_000,
    baseShare: 0.05,
    guardShare: 0.1,
  };
  const up = marketStats({ ...args, guardUptime: 1 });
  const half = marketStats({ ...args, guardUptime: 0.5 });
  const down = marketStats({ ...args, guardUptime: 0 });

  assert.ok(Math.abs(up.effectiveShare - 0.15) < 1e-12, `up ${up.effectiveShare}`);
  assert.ok(Math.abs(half.effectiveShare - 0.1) < 1e-12, `half ${half.effectiveShare}`);
  assert.ok(Math.abs(down.effectiveShare - 0.05) < 1e-12, `down ${down.effectiveShare}`);

  assert.equal(up.feeAprBps, 109_500);
  assert.equal(half.feeAprBps, 73_000);
  assert.equal(down.feeAprBps, 36_500);
  assert.equal(half.guardUptime, 0.5);
});

test("market stats: no guard split keeps bookShare unchanged", () => {
  const m = marketStats({
    book: BOOK,
    activeLiquidityUsd: 100_000,
    windowSeconds: 21_600,
    bookShare: 0.1,
    bookValueUsd: 10_000,
  });
  assert.equal(m.effectiveShare, 0.1);
  assert.equal(m.guardUptime, 1);
  assert.equal(m.feeAprBps, 73_000);
});

test("market stats: worst IL counts an excursion that returns to start", () => {
  const book = { ...BOOK, tickMin: -2_000, tickMax: 2_000, priceMin: 0.8, priceMax: 1.25 };
  const range = { tickLower: -1_000, tickUpper: 1_000 };
  const m = marketStats({
    book,
    activeLiquidityUsd: 10_000,
    windowSeconds: 21_600,
    bookShare: 0.1,
    bookValueUsd: 10_000,
    bookRange: range,
    tickStart: 0,
    tickEnd: 0,
  });

  const excursion = Math.max(
    Math.abs(ilBpsForTicks({ tickStart: 0, tickEnd: 2_000, ...range })),
    Math.abs(ilBpsForTicks({ tickStart: 0, tickEnd: -2_000, ...range })),
  );
  assert.equal(m.ilBps, 0, "endpoint IL is zero");
  assert.ok(excursion > 0);
  assert.equal(m.ilWorstBps, excursion);
  assert.equal(m.ilAprBps, Math.round(excursion * ((365 * 24 * 3600) / 21_600)));
  assert.ok(m.netAprBps < m.feeAprBps);
});

test("market stats: missing ticks fall back to price-based worst IL", () => {
  const book = {
    ...BOOK,
    priceFirst: 1,
    priceLast: 1.1,
    priceMin: 1,
    priceMax: 1.1,
    priceAvg: 1.05,
    tickFirst: undefined,
    tickLast: undefined,
    tickMin: undefined,
    tickMax: undefined,
  };
  const m = marketStats({
    book,
    activeLiquidityUsd: 10_000,
    windowSeconds: 21_600,
    rangeHalfWidthBps: 1_000,
  });
  assert.ok(m.ilBps < 0);
  assert.equal(m.ilWorstBps, Math.abs(m.ilBps));
  assert.equal(m.ilAprBps, Math.abs(m.ilAprBps));
});

test("market stats: ilMultipleBps stresses the worst IL", () => {
  const args = {
    book: BOOK,
    activeLiquidityUsd: 10_000,
    windowSeconds: 21_600,
    bookShare: 0.1,
    bookValueUsd: 10_000,
    bookRange: { tickLower: -1_000, tickUpper: 1_000 },
    tickStart: 0,
    tickEnd: 100,
    tickMin: 0,
    tickMax: 100,
  };
  const base = marketStats(args);
  const stressed = marketStats({ ...args, ilMultipleBps: 20_000 });

  assert.ok(base.ilAprBps > 0);
  assert.equal(base.netAprBps, base.feeAprBps - base.ilAprBps);
  assert.equal(stressed.netAprBps, base.feeAprBps - 2 * base.ilAprBps);
  assert.ok(stressed.netAprBps < base.netAprBps);
});

test("fetch book stats: chunkBlocks splits getLogs and keeps blockNumber", async () => {
  const calls = [];
  const logs = [
    {
      blockNumber: 3n,
      args: {
        amount0: -(10n ** 6n),
        amount1: 10n ** 18n,
        sqrtPriceX96: 1n << 96n,
        tick: 5,
      },
    },
    {
      blockNumber: 8n,
      args: {
        amount0: -2n * 10n ** 6n,
        amount1: 2n * 10n ** 18n,
        sqrtPriceX96: 1n << 96n,
        tick: 6,
      },
    },
  ];
  const publicClient = {
    async getLogs(query) {
      calls.push(query);
      return logs.filter((l) => l.blockNumber >= query.fromBlock && l.blockNumber <= query.toBlock);
    },
  };

  const s = await fetchBookStats({
    publicClient,
    poolManager: "0xpool",
    poolId: "0xbook",
    feePips: 500,
    fromBlock: 0n,
    toBlock: 9n,
    windowSeconds: 21_600,
    chunkBlocks: 5n,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => [c.fromBlock, c.toBlock]),
    [
      [0n, 4n],
      [5n, 9n],
    ],
  );
  assert.equal(s.swaps, 2);
  assert.equal(s.volumeUsd, 3);
  assert.equal(s.tickMin, 5);
  assert.equal(s.tickMax, 6);
});

test("fetch book stats: no chunkBlocks keeps a single getLogs call", async () => {
  const calls = [];
  const publicClient = {
    async getLogs(query) {
      calls.push(query);
      return [];
    },
  };

  const s = await fetchBookStats({
    publicClient,
    poolManager: "0xpool",
    poolId: "0xbook",
    feePips: 500,
    fromBlock: 1n,
    toBlock: 2n,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].fromBlock, 1n);
  assert.equal(calls[0].toBlock, 2n);
  assert.equal(s.swaps, 0);
});
