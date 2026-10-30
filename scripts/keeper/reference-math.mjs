// Pure math for external reference pools (Uniswap v3/v4).
//
// The book's own stats assume its quote token is token0. Reference venues sort
// token0/token1 by address, so the quote may land on either side; every helper
// below takes an explicit `quoteIsToken0` flag instead of guessing.
//
// No I/O, no config reads, no market addresses or prices. Callers pass raw
// amounts, sqrtPriceX96, and decimals. Raw token amounts stay BigInt and are
// floored; prices/volumes are Numbers because they only feed scoring.

import { ilBpsForTicks } from "./stats.mjs";

const Q96 = 2 ** 96;
const PIPS = 1_000_000n;
const TICK_BASE = 1.0001;

/** Integer-like input (bigint | string | integer number) as BigInt; else 0n. */
function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    // Non-integers cannot be base units; truncate instead of throwing.
    return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  }
  if (typeof value === "string") {
    try {
      return BigInt(value.trim());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/** Finite Number or `fallback`. */
function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Per-swap fee in pips when it is a valid fee: finite, >= 0, and <= 1e6.
 * v4 flags dynamic-fee pools with a high bit (`0x800000`), which is not a fee;
 * null tells the caller to fall back to the pool fee.
 */
function perSwapFeePips(value) {
  if (value == null) return null;
  const fee = Number(value);
  if (!Number.isFinite(fee) || fee < 0 || fee > 1_000_000) return null;
  return toBigInt(value);
}

/** sqrtPriceX96 as a float sqrt price; 0 when absent/invalid. */
function sqrtPriceFloat(sqrtPriceX96) {
  const x = toBigInt(sqrtPriceX96);
  if (x <= 0n) return 0;
  return Number(x) / Q96;
}

/** Floor a non-negative float into raw base units; 0n otherwise. */
function floorBigInt(value) {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.floor(value));
}

/** Lower-case string identity for an address, or "" when not a string. */
function addressKey(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Absolute quote-side amount of a swap or position, in quote base units.
 * `amount0`/`amount1` may be bigint, string, or number.
 */
export function quoteSideAmount({ amount0, amount1, quoteIsToken0 }) {
  const raw = toBigInt(quoteIsToken0 ? amount0 : amount1);
  return raw < 0n ? -raw : raw;
}

/**
 * Human quote per equity from a v3/v4 Q96 sqrt price.
 *
 * The raw price is token1 per token0; decimals are applied on the raw side:
 *   token1-per-token0 = raw * 10^(d0 - d1)
 * When the quote is token0 that is equity per quote, so the result is inverted.
 * Returns 0 for a zero/invalid price.
 */
export function priceQuotePerEquity({
  sqrtPriceX96,
  quoteIsToken0,
  quoteDecimals = 6,
  equityDecimals = 18,
}) {
  const sqrtP = sqrtPriceFloat(sqrtPriceX96);
  if (!(sqrtP > 0)) return 0;

  const raw = sqrtP * sqrtP;
  // 10^(equityDecimals - quoteDecimals) converts raw token1/token0 to human
  // quote-per-equity when token1 is quote (and equity-per-quote otherwise).
  const decimalsScale = 10 ** (toNumber(equityDecimals, 18) - toNumber(quoteDecimals, 6));
  if (!(decimalsScale > 0) || !Number.isFinite(decimalsScale)) return 0;

  const human = quoteIsToken0 ? raw / decimalsScale : raw * decimalsScale;
  if (!(human > 0) || !Number.isFinite(human)) return 0;
  return quoteIsToken0 ? 1 / human : human;
}

/**
 * Time-weighted price over the sampled swaps.
 *
 * With block numbers, each price is weighted by the blocks elapsed since the
 * previous swap (the interval it closes), so the first swap closes no interval.
 * Only the tail of the sample inside `windowSeconds` contributes. Without block
 * numbers, or when no interval has a positive length, the arithmetic mean wins.
 */
function timeWeightedPrice(rows, blockTimeSeconds, windowSeconds) {
  if (rows.length === 0) return 0;
  if (rows.some((row) => row.block == null)) {
    return rows.reduce((sum, row) => sum + row.price, 0) / rows.length;
  }

  const sorted = rows
    .slice()
    .sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));

  const step = toNumber(blockTimeSeconds, 0);
  const window = toNumber(windowSeconds, 0);

  let sample = sorted;
  if (window > 0 && step > 0) {
    const cutoff = Number(sorted[sorted.length - 1].block) - window / step;
    sample = sorted.filter((row) => Number(row.block) >= cutoff);
  }

  let weighted = 0;
  let totalBlocks = 0;
  for (let i = 1; i < sample.length; i += 1) {
    const delta = Number(sample[i].block - sample[i - 1].block);
    if (!(delta > 0)) continue;
    weighted += sample[i].price * delta;
    totalBlocks += delta;
  }
  if (!(totalBlocks > 0)) {
    return sample.reduce((sum, row) => sum + row.price, 0) / sample.length;
  }
  return weighted / totalBlocks;
}

/**
 * Volume, fees, price path, and TWAP for one reference pool.
 *
 * `swaps` are swap-event args `{ amount0, amount1, sqrtPriceX96, tick, fee?,
 * blockNumber? }` in log order. Volume is the sum of |quote-side amount|; the
 * quote token is assumed to be a USD stablecoin, so volumeQuote === volumeUsd.
 *
 * Fees: per swap `|quoteAmount| * (swap.fee ?? feePips) / 1e6`, floored to raw
 * base units and summed; a valid `swap.fee` (v4) wins over the pool `feePips`,
 * while an out-of-range value (e.g. a dynamic-fee flag) falls back to `feePips`.
 *
 * TWAP: see `timeWeightedPrice`; `windowSeconds` bounds the sampled tail.
 * `volatilityBps` is `(max - min) / mean * 10_000`, rounded like stats.mjs.
 */
export function summarizeReferenceSwaps({
  swaps,
  quoteIsToken0,
  feePips,
  quoteDecimals = 6,
  equityDecimals = 18,
  windowSeconds = 86_400,
  blockTimeSeconds = 0.1,
}) {
  const list = Array.isArray(swaps) ? swaps : [];
  const qDec = toNumber(quoteDecimals, 6);
  const eDec = toNumber(equityDecimals, 18);
  const quoteScale = 10 ** qDec;
  const poolFee = toBigInt(feePips);

  let volumeRaw = 0n;
  let feesRaw = 0n;
  let priceFirst = 0;
  let priceLast = 0;
  let priceMin = Infinity;
  let priceMax = -Infinity;
  let priceSum = 0;
  let priceCount = 0;
  let tickFirst = 0;
  let tickLast = 0;
  let tickMin = 0;
  let tickMax = 0;
  let tickCount = 0;
  let lastSwapBlock = 0n;
  const priced = [];

  for (const swap of list) {
    const quoteAmount = quoteSideAmount({
      amount0: swap?.amount0,
      amount1: swap?.amount1,
      quoteIsToken0,
    });
    volumeRaw += quoteAmount;

    const fee = perSwapFeePips(swap?.fee) ?? poolFee;
    if (fee > 0n && quoteAmount > 0n) feesRaw += (quoteAmount * fee) / PIPS;

    let block = null;
    if (swap?.blockNumber != null) {
      try {
        block = BigInt(swap.blockNumber);
      } catch {
        block = null;
      }
    }
    if (block != null && block > lastSwapBlock) lastSwapBlock = block;

    const price = priceQuotePerEquity({
      sqrtPriceX96: swap?.sqrtPriceX96,
      quoteIsToken0,
      quoteDecimals: qDec,
      equityDecimals: eDec,
    });
    if (price > 0 && Number.isFinite(price)) {
      if (priceCount === 0) priceFirst = price;
      priceLast = price;
      if (price < priceMin) priceMin = price;
      if (price > priceMax) priceMax = price;
      priceSum += price;
      priceCount += 1;
      priced.push({ price, block });
    }

    const tick = swap?.tick == null ? NaN : Number(swap.tick);
    if (Number.isFinite(tick)) {
      if (tickCount === 0) {
        tickFirst = tick;
        tickMin = tick;
        tickMax = tick;
      }
      tickLast = tick;
      if (tick < tickMin) tickMin = tick;
      if (tick > tickMax) tickMax = tick;
      tickCount += 1;
    }
  }

  const priceAvg = priceCount > 0 ? priceSum / priceCount : 0;
  const volatilityBps =
    priceCount > 0 ? Math.round(((priceMax - priceMin) / priceAvg) * 10_000) : 0;

  return {
    volumeQuote: Number(volumeRaw) / quoteScale,
    volumeUsd: Number(volumeRaw) / quoteScale,
    feesUsd: Number(feesRaw) / quoteScale,
    priceFirst,
    priceLast,
    priceMin: priceCount > 0 ? priceMin : 0,
    priceMax: priceCount > 0 ? priceMax : 0,
    priceAvg,
    volatilityBps,
    tickFirst,
    tickLast,
    tickMin: tickCount > 0 ? tickMin : 0,
    tickMax: tickCount > 0 ? tickMax : 0,
    twapPrice: timeWeightedPrice(priced, blockTimeSeconds, windowSeconds),
    swaps: list.length,
    lastSwapBlock,
  };
}

/**
 * Raw token amounts of a position at the current price, in v3/v4 base units.
 * Below the range the position is all token0, above it all token1. Floored.
 */
export function amountsForLiquidity({ liquidity, sqrtPriceX96, tickLower, tickUpper }) {
  const L = Number(toBigInt(liquidity));
  const sqrtP = sqrtPriceFloat(sqrtPriceX96);
  const lower = Number(tickLower);
  const upper = Number(tickUpper);
  if (
    !(L > 0) ||
    !(sqrtP > 0) ||
    !Number.isFinite(lower) ||
    !Number.isFinite(upper) ||
    upper <= lower
  ) {
    return { amount0: 0n, amount1: 0n };
  }

  const sqrtPa = Math.sqrt(TICK_BASE ** lower);
  const sqrtPb = Math.sqrt(TICK_BASE ** upper);
  if (!(sqrtPa > 0) || !Number.isFinite(sqrtPb) || !(sqrtPb > sqrtPa)) {
    return { amount0: 0n, amount1: 0n };
  }

  let amount0 = 0;
  let amount1 = 0;
  if (sqrtP <= sqrtPa) {
    amount0 = L * (1 / sqrtPa - 1 / sqrtPb);
  } else if (sqrtP >= sqrtPb) {
    amount1 = L * (sqrtPb - sqrtPa);
  } else {
    amount0 = L * (1 / sqrtP - 1 / sqrtPb);
    amount1 = L * (sqrtP - sqrtPa);
  }
  return { amount0: floorBigInt(amount0), amount1: floorBigInt(amount1) };
}

/**
 * Liquidity L whose position at the current price is worth `valueUsd`.
 *
 * The quote value of a probe L is measured in human units:
 *   quote token0: amount0/10^q + (amount1/10^e) * price
 *   quote token1: (amount0/10^e) * price + amount1/10^q
 * because `price` is quote per equity. Floors to a BigInt; 0 on bad input.
 */
export function liquidityForValueOriented({
  valueUsd,
  sqrtPriceX96,
  tickLower,
  tickUpper,
  quoteIsToken0,
  quoteDecimals = 6,
  equityDecimals = 18,
}) {
  const value = Number(valueUsd);
  if (!(value > 0) || !Number.isFinite(value)) return 0n;

  const probe = 10n ** 18n;
  const { amount0, amount1 } = amountsForLiquidity({
    liquidity: probe,
    sqrtPriceX96,
    tickLower,
    tickUpper,
  });
  if (amount0 === 0n && amount1 === 0n) return 0n;

  const price = priceQuotePerEquity({
    sqrtPriceX96,
    quoteIsToken0,
    quoteDecimals,
    equityDecimals,
  });
  if (!(price > 0) || !Number.isFinite(price)) return 0n;

  const qDec = toNumber(quoteDecimals, 6);
  const eDec = toNumber(equityDecimals, 18);
  const token0 = Number(amount0) / 10 ** (quoteIsToken0 ? qDec : eDec);
  const token1 = Number(amount1) / 10 ** (quoteIsToken0 ? eDec : qDec);
  const valuePerProbe = quoteIsToken0 ? token0 + token1 * price : token0 * price + token1;
  if (!(valuePerProbe > 0) || !Number.isFinite(valuePerProbe)) return 0n;

  return floorBigInt((value / valuePerProbe) * Number(probe));
}

/**
 * Floor the lower tick and ceil the upper tick to `tickSpacing`.
 * Guarantees `tickUpper > tickLower`; an invalid spacing returns the inputs.
 */
export function alignRangeToSpacing({ tickLower, tickUpper, tickSpacing }) {
  const lower = Number(tickLower);
  const upper = Number(tickUpper);
  const spacing = Number(tickSpacing);

  if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
    return { tickLower: 0, tickUpper: 0 };
  }
  if (!Number.isFinite(spacing) || spacing <= 0) {
    return { tickLower: lower, tickUpper: upper };
  }

  const lo = Math.floor(lower / spacing) * spacing;
  let hi = Math.ceil(upper / spacing) * spacing;
  if (hi <= lo) hi = lo + spacing;
  return { tickLower: lo, tickUpper: hi };
}

/**
 * Worst |IL| in bps (positive) between the start tick and the end/min/max ticks.
 * Captures excursions that leave the range and come back to the start.
 */
export function worstIlBps({ tickStart, tickEnd, tickMin, tickMax, tickLower, tickUpper }) {
  const start = Number(tickStart);
  if (!Number.isFinite(start)) return 0;

  let worst = 0;
  for (const candidate of [tickEnd, tickMin, tickMax]) {
    if (candidate == null) continue;
    const end = Number(candidate);
    if (!Number.isFinite(end)) continue;
    const il = Math.abs(ilBpsForTicks({ tickStart: start, tickEnd: end, tickLower, tickUpper }));
    if (il > worst) worst = il;
  }
  return worst;
}

/** Median of the finite values; 0 for an empty list. Does not mutate input. */
export function median(values) {
  const list = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (list.length === 0) return 0;

  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** |a - b| in bps of `b`; 0 when either side is non-positive. */
export function bpsDeviation(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0) || !(y > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return (Math.abs(x - y) / y) * 10_000;
}

/**
 * Which side of a reference pool holds the quote token.
 *
 * Addresses compare case-insensitively. `ok` is true only when one token is the
 * quote and the other is the equity; `reason` is a stable machine-readable tag.
 */
export function resolveQuoteOrientation({ token0, token1, quoteToken, equityToken }) {
  const t0 = addressKey(token0);
  const t1 = addressKey(token1);
  const quote = addressKey(quoteToken);
  const equity = addressKey(equityToken);

  if (!t0 || !t1 || !quote || !equity) {
    return { quoteIsToken0: false, ok: false, reason: "missing-token" };
  }
  if (t0 === t1) {
    return { quoteIsToken0: false, ok: false, reason: "identical-tokens" };
  }
  if (quote === equity) {
    return { quoteIsToken0: false, ok: false, reason: "quote-equals-equity" };
  }
  if (t0 === quote && t1 === equity) {
    return { quoteIsToken0: true, ok: true, reason: "quote-is-token0" };
  }
  if (t1 === quote && t0 === equity) {
    return { quoteIsToken0: false, ok: true, reason: "quote-is-token1" };
  }
  return { quoteIsToken0: false, ok: false, reason: "tokens-mismatch" };
}
