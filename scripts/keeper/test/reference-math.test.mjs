import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ilBpsForTicks } from "../stats.mjs";
import {
  quoteSideAmount,
  priceQuotePerEquity,
  summarizeReferenceSwaps,
  amountsForLiquidity,
  liquidityForValueOriented,
  alignRangeToSpacing,
  worstIlBps,
  median,
  bpsDeviation,
  resolveQuoteOrientation,
} from "../reference-math.mjs";

const Q96 = 2 ** 96;
const Q_DEC = 6;
const E_DEC = 18;
const TICK = Math.log(1.0001);

function approx(actual, expected, rel = 1e-6, label = "") {
  const ok =
    Number.isFinite(actual) && Math.abs(actual - expected) <= Math.abs(expected) * rel;
  assert.ok(ok, `${label || "value"}: expected ~${expected}, got ${actual}`);
}

/** v3/v4 Q96 sqrt price for a raw token1/token0 price. */
function sqrtX96ForRawPrice(rawPrice) {
  return BigInt(Math.round(Math.sqrt(rawPrice) * Q96));
}

/** Raw token1/token0 price for a human quote-per-equity price. */
function rawPriceFor(quotePerEquity, quoteIsToken0) {
  const scale = 10 ** (E_DEC - Q_DEC);
  return quoteIsToken0 ? scale / quotePerEquity : quotePerEquity / scale;
}

function tickForRaw(rawPrice) {
  return Math.round(Math.log(rawPrice) / TICK);
}

/** Synthetic swap; quote side carries `quoteAmount` raw units. */
function makeSwap({
  quotePerEquity = 180,
  quoteIsToken0 = false,
  quoteAmount = 1_000n * 10n ** BigInt(Q_DEC),
  blockNumber,
  fee,
  tick,
} = {}) {
  const raw = rawPriceFor(quotePerEquity, quoteIsToken0);
  const swap = {
    amount0: quoteIsToken0 ? -quoteAmount : 0n,
    amount1: quoteIsToken0 ? 0n : -quoteAmount,
    sqrtPriceX96: sqrtX96ForRawPrice(raw),
    tick: tick ?? tickForRaw(raw),
  };
  if (blockNumber !== undefined) swap.blockNumber = blockNumber;
  if (fee !== undefined) swap.fee = fee;
  return swap;
}

test("quoteSideAmount: picks the quote side and returns |amount|", () => {
  assert.equal(quoteSideAmount({ amount0: -5n, amount1: 7n, quoteIsToken0: true }), 5n);
  assert.equal(quoteSideAmount({ amount0: -5n, amount1: 7n, quoteIsToken0: false }), 7n);
});

test("quoteSideAmount: accepts string and number amounts", () => {
  assert.equal(quoteSideAmount({ amount0: "-42", amount1: 0, quoteIsToken0: true }), 42n);
  assert.equal(quoteSideAmount({ amount0: 0, amount1: -1_000, quoteIsToken0: false }), 1_000n);
  assert.equal(quoteSideAmount({ amount0: "nope", amount1: null, quoteIsToken0: true }), 0n);
});

test("price: quote is token1 -> raw token1/token0 used as-is", () => {
  const p = priceQuotePerEquity({
    sqrtPriceX96: sqrtX96ForRawPrice(rawPriceFor(180, false)),
    quoteIsToken0: false,
  });
  approx(p, 180, 1e-9, "quote per equity");
});

test("price: quote is token0 -> inverted", () => {
  const p = priceQuotePerEquity({
    sqrtPriceX96: sqrtX96ForRawPrice(rawPriceFor(180, true)),
    quoteIsToken0: true,
  });
  approx(p, 180, 1e-9, "quote per equity");
});

test("price: decimals scale the raw price", () => {
  // raw price 1 with 18-decimal equity and 6-decimal quote -> 1e12 quote/equity.
  const p = priceQuotePerEquity({
    sqrtPriceX96: sqrtX96ForRawPrice(1),
    quoteIsToken0: false,
    quoteDecimals: Q_DEC,
    equityDecimals: E_DEC,
  });
  assert.equal(p, 1e12);
});

test("price: zero/invalid sqrt price -> 0", () => {
  assert.equal(priceQuotePerEquity({ sqrtPriceX96: 0n, quoteIsToken0: false }), 0);
  assert.equal(priceQuotePerEquity({ sqrtPriceX96: "x", quoteIsToken0: true }), 0);
});

test("volume and fees: quote is token1", () => {
  const s = summarizeReferenceSwaps({
    swaps: [makeSwap({ quoteAmount: 2_000n * 10n ** 6n, quoteIsToken0: false })],
    quoteIsToken0: false,
    feePips: 3000,
  });
  assert.equal(s.volumeQuote, 2_000);
  assert.equal(s.volumeUsd, 2_000);
  assert.equal(s.feesUsd, 6); // 2000 * 0.30%
});

test("volume and fees: quote is token0", () => {
  const s = summarizeReferenceSwaps({
    swaps: [makeSwap({ quoteAmount: 2_000n * 10n ** 6n, quoteIsToken0: true })],
    quoteIsToken0: true,
    feePips: 500,
  });
  assert.equal(s.volumeQuote, 2_000);
  assert.equal(s.feesUsd, 1); // 2000 * 0.05%
});

test("fees: v4 per-swap fee beats the pool fee", () => {
  const s = summarizeReferenceSwaps({
    swaps: [
      makeSwap({ quoteAmount: 1_000n * 10n ** 6n, fee: 500 }),
      makeSwap({ quoteAmount: 1_000n * 10n ** 6n }),
    ],
    quoteIsToken0: false,
    feePips: 3000,
  });
  approx(s.feesUsd, 3.5, 1e-12, "fees"); // 0.5 + 3.0
  assert.equal(s.volumeQuote, 2_000);
});

test("fees: out-of-range per-swap fee falls back to the pool fee", () => {
  const s = summarizeReferenceSwaps({
    swaps: [makeSwap({ quoteAmount: 1_000n * 10n ** 6n, fee: 0x800000 })],
    quoteIsToken0: false,
    feePips: 3000,
  });
  // 0x800000 is the v4 dynamic-fee flag, not a fee: use 3000 pips (0.30%).
  approx(s.feesUsd, 3, 1e-12, "fees");
});

test("fees: valid per-swap fee still wins over the pool fee", () => {
  const s = summarizeReferenceSwaps({
    swaps: [makeSwap({ quoteAmount: 1_000n * 10n ** 6n, fee: 500 })],
    quoteIsToken0: false,
    feePips: 3000,
  });
  approx(s.feesUsd, 0.5, 1e-12, "fees");
});

test("summarize: price path, ticks, volatility", () => {
  const s = summarizeReferenceSwaps({
    swaps: [
      makeSwap({ quotePerEquity: 100, tick: -10 }),
      makeSwap({ quotePerEquity: 300, tick: 30 }),
      makeSwap({ quotePerEquity: 200, tick: 10 }),
    ],
    quoteIsToken0: false,
    feePips: 3000,
  });
  approx(s.priceFirst, 100, 1e-6);
  approx(s.priceLast, 200, 1e-6);
  approx(s.priceMin, 100, 1e-6);
  approx(s.priceMax, 300, 1e-6);
  approx(s.priceAvg, 200, 1e-6);
  assert.equal(s.volatilityBps, 10_000); // (300-100)/200
  assert.equal(s.tickFirst, -10);
  assert.equal(s.tickLast, 10);
  assert.equal(s.tickMin, -10);
  assert.equal(s.tickMax, 30);
  assert.equal(s.swaps, 3);
});

test("summarize: empty input -> zeros", () => {
  const s = summarizeReferenceSwaps({ swaps: [], quoteIsToken0: true, feePips: 3000 });
  assert.equal(s.volumeQuote, 0);
  assert.equal(s.volumeUsd, 0);
  assert.equal(s.feesUsd, 0);
  assert.equal(s.priceFirst, 0);
  assert.equal(s.priceLast, 0);
  assert.equal(s.priceMin, 0);
  assert.equal(s.priceMax, 0);
  assert.equal(s.priceAvg, 0);
  assert.equal(s.volatilityBps, 0);
  assert.equal(s.twapPrice, 0);
  assert.equal(s.swaps, 0);
  assert.equal(s.lastSwapBlock, 0n);
});

test("summarize: missing swaps array does not throw", () => {
  const s = summarizeReferenceSwaps({ swaps: undefined, quoteIsToken0: false, feePips: 500 });
  assert.equal(s.swaps, 0);
  assert.equal(s.twapPrice, 0);
});

test("twap: weight by block delta", () => {
  const s = summarizeReferenceSwaps({
    swaps: [
      makeSwap({ quotePerEquity: 100, blockNumber: 100 }),
      makeSwap({ quotePerEquity: 200, blockNumber: 110 }),
      makeSwap({ quotePerEquity: 300, blockNumber: 130 }),
    ],
    quoteIsToken0: false,
    feePips: 3000,
    blockTimeSeconds: 1,
  });
  // Each price is weighted by the blocks since the previous swap:
  // 200 holds 10 blocks, 300 holds 20 blocks -> (200*10 + 300*20) / 30.
  approx(s.twapPrice, 800 / 3, 1e-6, "twap");
});

test("twap: no block numbers -> arithmetic mean", () => {
  const s = summarizeReferenceSwaps({
    swaps: [
      makeSwap({ quotePerEquity: 100 }),
      makeSwap({ quotePerEquity: 200 }),
      makeSwap({ quotePerEquity: 300 }),
    ],
    quoteIsToken0: false,
    feePips: 3000,
  });
  approx(s.twapPrice, 200, 1e-6, "twap");
});

test("twap: one swap -> its price", () => {
  const s = summarizeReferenceSwaps({
    swaps: [makeSwap({ quotePerEquity: 180, blockNumber: 50 })],
    quoteIsToken0: false,
    feePips: 500,
  });
  approx(s.twapPrice, 180, 1e-6, "twap");
});

test("twap: equal blocks -> arithmetic mean", () => {
  const s = summarizeReferenceSwaps({
    swaps: [
      makeSwap({ quotePerEquity: 100, blockNumber: 7 }),
      makeSwap({ quotePerEquity: 300, blockNumber: 7 }),
    ],
    quoteIsToken0: false,
    feePips: 500,
  });
  approx(s.twapPrice, 200, 1e-6, "twap");
});

test("twap: only the tail inside windowSeconds counts", () => {
  const s = summarizeReferenceSwaps({
    swaps: [
      makeSwap({ quotePerEquity: 100, blockNumber: 100 }),
      makeSwap({ quotePerEquity: 200, blockNumber: 110 }),
      makeSwap({ quotePerEquity: 300, blockNumber: 130 }),
    ],
    quoteIsToken0: false,
    feePips: 3000,
    blockTimeSeconds: 1,
    windowSeconds: 20,
  });
  // Cutoff is block 110, leaving 200 @110 and 300 @130 -> 300.
  approx(s.twapPrice, 300, 1e-6, "twap");
});

test("twap: mixed block presence falls back to the mean", () => {
  const s = summarizeReferenceSwaps({
    swaps: [
      makeSwap({ quotePerEquity: 100, blockNumber: 100 }),
      makeSwap({ quotePerEquity: 300 }),
    ],
    quoteIsToken0: false,
    feePips: 3000,
  });
  approx(s.twapPrice, 200, 1e-6, "twap");
});

test("amounts: below range -> all token0", () => {
  const raw = rawPriceFor(180, false);
  const current = tickForRaw(raw);
  const { amount0, amount1 } = amountsForLiquidity({
    liquidity: 10n ** 18n,
    sqrtPriceX96: sqrtX96ForRawPrice(raw),
    tickLower: current + 100,
    tickUpper: current + 200,
  });
  assert.ok(amount0 > 0n, `amount0 ${amount0}`);
  assert.equal(amount1, 0n);
});

test("amounts: above range -> all token1", () => {
  const raw = rawPriceFor(180, false);
  const current = tickForRaw(raw);
  const { amount0, amount1 } = amountsForLiquidity({
    liquidity: 10n ** 18n,
    sqrtPriceX96: sqrtX96ForRawPrice(raw),
    tickLower: current - 200,
    tickUpper: current - 100,
  });
  assert.equal(amount0, 0n);
  assert.ok(amount1 > 0n, `amount1 ${amount1}`);
});

test("amounts: inside range -> both sides, BigInt base units", () => {
  const raw = rawPriceFor(180, false);
  const current = tickForRaw(raw);
  const { amount0, amount1 } = amountsForLiquidity({
    liquidity: 10n ** 18n,
    sqrtPriceX96: sqrtX96ForRawPrice(raw),
    tickLower: current - 600,
    tickUpper: current + 600,
  });
  assert.equal(typeof amount0, "bigint");
  assert.equal(typeof amount1, "bigint");
  assert.ok(amount0 > 0n, `amount0 ${amount0}`);
  assert.ok(amount1 > 0n, `amount1 ${amount1}`);
});

test("amounts: zero liquidity and inverted ticks -> zeros", () => {
  const sqrtPriceX96 = sqrtX96ForRawPrice(rawPriceFor(180, false));
  assert.deepEqual(amountsForLiquidity({ liquidity: 0n, sqrtPriceX96, tickLower: -10, tickUpper: 10 }), {
    amount0: 0n,
    amount1: 0n,
  });
  assert.deepEqual(amountsForLiquidity({ liquidity: 10n ** 18n, sqrtPriceX96, tickLower: 10, tickUpper: -10 }), {
    amount0: 0n,
    amount1: 0n,
  });
});

function assertHypotheticalL({ quoteIsToken0 }) {
  const price = 180;
  const raw = rawPriceFor(price, quoteIsToken0);
  const sqrtPriceX96 = sqrtX96ForRawPrice(raw);
  const current = tickForRaw(raw);
  const tickLower = current - 600;
  const tickUpper = current + 600;

  const L = liquidityForValueOriented({
    valueUsd: 1_000,
    sqrtPriceX96,
    tickLower,
    tickUpper,
    quoteIsToken0,
  });
  assert.equal(typeof L, "bigint");
  assert.ok(L > 0n, `L ${L}`);

  const { amount0, amount1 } = amountsForLiquidity({
    liquidity: L,
    sqrtPriceX96,
    tickLower,
    tickUpper,
  });
  const value = quoteIsToken0
    ? Number(amount0) / 10 ** Q_DEC + (Number(amount1) / 10 ** E_DEC) * price
    : (Number(amount0) / 10 ** E_DEC) * price + Number(amount1) / 10 ** Q_DEC;
  approx(value, 1_000, 1e-6, "hypothetical value");
}

test("hypothetical L: quote is token0 round-trips to valueUsd", () => {
  assertHypotheticalL({ quoteIsToken0: true });
});

test("hypothetical L: quote is token1 round-trips to valueUsd", () => {
  assertHypotheticalL({ quoteIsToken0: false });
});

test("hypothetical L: zero/negative value or bad range -> 0n", () => {
  const sqrtPriceX96 = sqrtX96ForRawPrice(rawPriceFor(180, false));
  assert.equal(
    liquidityForValueOriented({
      valueUsd: 0,
      sqrtPriceX96,
      tickLower: -600,
      tickUpper: 600,
      quoteIsToken0: false,
    }),
    0n,
  );
  assert.equal(
    liquidityForValueOriented({
      valueUsd: -5,
      sqrtPriceX96,
      tickLower: -600,
      tickUpper: 600,
      quoteIsToken0: false,
    }),
    0n,
  );
  assert.equal(
    liquidityForValueOriented({
      valueUsd: 1_000,
      sqrtPriceX96,
      tickLower: 600,
      tickUpper: -600,
      quoteIsToken0: false,
    }),
    0n,
  );
});

test("alignRangeToSpacing: floors lower, ceils upper", () => {
  assert.deepEqual(alignRangeToSpacing({ tickLower: -7, tickUpper: 65, tickSpacing: 60 }), {
    tickLower: -60,
    tickUpper: 120,
  });
  assert.deepEqual(alignRangeToSpacing({ tickLower: 10, tickUpper: 20, tickSpacing: 60 }), {
    tickLower: 0,
    tickUpper: 60,
  });
});

test("alignRangeToSpacing: equal ticks still produce a non-empty range", () => {
  const r = alignRangeToSpacing({ tickLower: 0, tickUpper: 0, tickSpacing: 10 });
  assert.ok(r.tickUpper > r.tickLower, JSON.stringify(r));
  assert.equal(r.tickLower % 10, 0);
  assert.equal(r.tickUpper % 10, 0);
});

test("alignRangeToSpacing: invalid spacing passes ticks through", () => {
  assert.deepEqual(alignRangeToSpacing({ tickLower: -7, tickUpper: 65, tickSpacing: 0 }), {
    tickLower: -7,
    tickUpper: 65,
  });
});

test("worst IL: round trip off the start tick uses the excursion", () => {
  const args = { tickStart: 0, tickEnd: 0, tickMin: -800, tickMax: 800, tickLower: -1_000, tickUpper: 1_000 };
  const expected = Math.max(
    Math.abs(ilBpsForTicks({ tickStart: 0, tickEnd: -800, tickLower: -1_000, tickUpper: 1_000 })),
    Math.abs(ilBpsForTicks({ tickStart: 0, tickEnd: 800, tickLower: -1_000, tickUpper: 1_000 })),
  );
  assert.ok(expected > 0, `expected ${expected}`);
  assert.equal(worstIlBps(args), expected);
});

test("worst IL: a deeper excursion is worse", () => {
  const base = { tickStart: 0, tickEnd: 0, tickLower: -1_000, tickUpper: 1_000 };
  const shallow = worstIlBps({ ...base, tickMin: -400, tickMax: 400 });
  const deep = worstIlBps({ ...base, tickMin: -1_500, tickMax: 1_500 });
  assert.ok(deep > shallow, `deep ${deep} shallow ${shallow}`);
});

test("worst IL: missing/absent ticks are ignored", () => {
  assert.equal(worstIlBps({ tickStart: undefined, tickEnd: 10, tickMin: 0, tickMax: 0, tickLower: -1, tickUpper: 1 }), 0);
  assert.equal(worstIlBps({ tickStart: 0, tickEnd: null, tickLower: 10, tickUpper: 20 }), 0);
});

test("median: odd, even, unsorted, empty", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5]), 5);
  assert.equal(median([]), 0);
  assert.equal(median([1, Number.NaN, 3]), 2);
});

test("bpsDeviation: absolute bps of a against b", () => {
  assert.equal(bpsDeviation(101, 100), 100);
  assert.equal(bpsDeviation(100, 100), 0);
  assert.equal(bpsDeviation(90, 100), 1_000);
  assert.equal(bpsDeviation(0, 100), 0);
  assert.equal(bpsDeviation(100, 0), 0);
});

const QUOTE_TOKEN = "0xAa00000000000000000000000000000000000001";
const EQUITY_TOKEN = "0xBbb0000000000000000000000000000000000002";

test("orientation: quote is token0", () => {
  const r = resolveQuoteOrientation({
    token0: QUOTE_TOKEN.toLowerCase(),
    token1: EQUITY_TOKEN,
    quoteToken: QUOTE_TOKEN,
    equityToken: EQUITY_TOKEN,
  });
  assert.equal(r.ok, true);
  assert.equal(r.quoteIsToken0, true);
  assert.equal(r.reason, "quote-is-token0");
});

test("orientation: quote is token1", () => {
  const r = resolveQuoteOrientation({
    token0: EQUITY_TOKEN.toLowerCase(),
    token1: QUOTE_TOKEN,
    quoteToken: QUOTE_TOKEN.toLowerCase(),
    equityToken: EQUITY_TOKEN,
  });
  assert.equal(r.ok, true);
  assert.equal(r.quoteIsToken0, false);
  assert.equal(r.reason, "quote-is-token1");
});

test("orientation: mismatched tokens are rejected", () => {
  const unknown = "0xcccc000000000000000000000000000000000003";
  const r = resolveQuoteOrientation({
    token0: unknown,
    token1: EQUITY_TOKEN,
    quoteToken: QUOTE_TOKEN,
    equityToken: EQUITY_TOKEN,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "tokens-mismatch");
});

test("orientation: missing, identical, and quote==equity", () => {
  assert.equal(
    resolveQuoteOrientation({ token0: QUOTE_TOKEN, token1: undefined, quoteToken: QUOTE_TOKEN, equityToken: EQUITY_TOKEN })
      .reason,
    "missing-token",
  );
  assert.equal(
    resolveQuoteOrientation({ token0: QUOTE_TOKEN, token1: QUOTE_TOKEN, quoteToken: QUOTE_TOKEN, equityToken: EQUITY_TOKEN })
      .reason,
    "identical-tokens",
  );
  assert.equal(
    resolveQuoteOrientation({ token0: QUOTE_TOKEN, token1: EQUITY_TOKEN, quoteToken: QUOTE_TOKEN, equityToken: QUOTE_TOKEN })
      .reason,
    "quote-equals-equity",
  );
});

test("module stays pure: no market addresses and no I/O", () => {
  const source = readFileSync(new URL("../reference-math.mjs", import.meta.url), "utf8");
  assert.equal(/0x[0-9a-fA-F]{40}/.test(source), false, "hardcoded address found");
  for (const banned of ["getLogs", "publicClient", "process.env", "fetch(", "readFile"]) {
    assert.equal(source.includes(banned), false, `I/O symbol ${banned} found`);
  }
});
