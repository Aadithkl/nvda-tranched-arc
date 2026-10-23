// On-chain market stats for the risk/IL allocator.
//
// Reads Swap logs over the lookback window and computes, per pool:
//   - USDG notional volume
//   - fees (volume * pool fee)
//   - fee APR on the pool's active liquidity
//   - price fluctuation (max-min range) and first/last move
//   - IL for a configured concentrated range
//   - net APR = fee APR - |IL APR|
//
// Assumes USDG/NVDA with USDG as token0 (0x5fc5... < 0xd060...).

import { parseAbiItem } from "viem";

export const SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

const Q192 = 1n << 192n;

/** Raw token1/token0 price from sqrtPriceX96, scaled by 1e18. */
export function priceFromSqrtX96(sqrtPriceX96) {
  const x = BigInt(sqrtPriceX96);
  return Number((x * x * 10n ** 18n) / Q192) / 1e18;
}

/**
 * @param swaps        Swap event args: { amount0, amount1, sqrtPriceX96 }
 * @param feePips       Uniswap fee in pips per 1e6 (e.g. 500 = 0.05%, 3000 = 0.30%)
 * @param nav          Optional NAV in token0 base units; only used for nav-based fee APR.
 * @param windowSeconds Lookback window used for annualization
 */
export function summarizeBook({
  swaps,
  feePips,
  nav,
  windowSeconds = 21_600,
  token0Decimals = 6,
  token1Decimals = 18,
}) {
  let volume = 0n;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  let tickCount = 0;
  let firstPrice = 0;
  let lastPrice = 0;
  let tickFirst = 0;
  let tickLast = 0;

  for (const s of swaps) {
    const a0 = BigInt(s.amount0);
    volume += a0 < 0n ? -a0 : a0;

    const human = priceFromSqrtX96(s.sqrtPriceX96) * 10 ** (token0Decimals - token1Decimals);
    if (!Number.isFinite(human) || human <= 0) continue;
    if (count === 0) firstPrice = human;
    lastPrice = human;
    min = Math.min(min, human);
    max = Math.max(max, human);
    sum += human;
    count += 1;

    const tick = Number(s.tick);
    if (Number.isFinite(tick)) {
      if (tickCount === 0) tickFirst = tick;
      tickLast = tick;
      tickCount += 1;
    }
  }

  const volumeUsd = Number(volume) / 10 ** token0Decimals;
  const feesUsd = (volumeUsd * Number(feePips)) / 1_000_000;
  const annualization = windowSeconds > 0 ? (365 * 24 * 3600) / windowSeconds : 0;
  const navUsd = Number(nav ?? 0) / 10 ** token0Decimals;
  const feeAprBps = navUsd > 0 ? Math.round((feesUsd * annualization * 10_000) / navUsd) : 0;

  const avg = count > 0 ? sum / count : 0;
  const volatilityBps = avg > 0 ? Math.round(((max - min) / avg) * 10_000) : 0;
  const priceMoveBps = firstPrice > 0 ? Math.round(((lastPrice / firstPrice) - 1) * 10_000) : 0;

  return {
    volumeUsd,
    feesUsd,
    feeAprBps,
    volatilityBps,
    priceMoveBps,
    swaps: swaps.length,
    priceFirst: firstPrice,
    priceLast: lastPrice,
    tickFirst,
    tickLast,
    priceMin: count > 0 ? min : 0,
    priceMax: count > 0 ? max : 0,
    priceAvg: avg,
  };
}

/** IL for an explicit range [pa, pb], held from p0 to p1. Value in token0. */
function ilForRange(p0, p1, pa, pb) {
  if (!(p0 > 0) || !(p1 > 0) || !(pa > 0) || !(pb > pa)) return 0;
  const sqrtPa = Math.sqrt(pa);
  const sqrtPb = Math.sqrt(pb);
  const L = 1;

  const amounts = (p) => {
    const s = Math.sqrt(p);
    if (p <= pa) return { x: L * (1 / sqrtPa - 1 / sqrtPb), y: 0 };
    if (p >= pb) return { x: 0, y: L * (sqrtPb - sqrtPa) };
    return { x: L * (1 / s - 1 / sqrtPb), y: L * (s - sqrtPa) };
  };

  const a0 = amounts(p0);
  const a1 = amounts(p1);
  const hodl = a0.x + a0.y / p1;
  const lp = a1.x + a1.y / p1;
  if (!(hodl > 0)) return 0;
  return Math.round(((lp / hodl) - 1) * 10_000);
}

/**
 * IL for a static concentrated range [p0*(1-w), p0*(1+w)] held from p0 to p1.
 * Negative or zero, in bps. `halfWidthBps >= 10000` means full range.
 */
export function ilBps({ priceStart, priceEnd, halfWidthBps = 1_000 }) {
  const p0 = Number(priceStart);
  const p1 = Number(priceEnd);
  if (!(p0 > 0) || !(p1 > 0)) return 0;

  const w = Number(halfWidthBps) / 10_000;
  if (w >= 1) {
    const r = p1 / p0;
    return Math.round(((2 * Math.sqrt(r)) / (1 + r) - 1) * 10_000);
  }

  return ilForRange(p0, p1, p0 * (1 - w), p0 * (1 + w));
}

/** IL for the book's actual tick range, using the tick path from the swaps. */
export function ilBpsForTicks({ tickStart, tickEnd, tickLower, tickUpper }) {
  const s = Number(tickStart);
  const e = Number(tickEnd);
  const lo = Number(tickLower);
  const hi = Number(tickUpper);
  if (![s, e, lo, hi].every(Number.isFinite) || hi <= lo) return 0;
  const p = (t) => 1.0001 ** t;
  return ilForRange(p(s), p(e), p(lo), p(hi));
}

/** Token0 (USDG) value of one v3/v4 position at the current price. */
export function positionValueUsd({
  liquidity,
  sqrtPriceX96,
  tickLower,
  tickUpper,
  token0Decimals = 6,
}) {
  const sqrtP = Number(BigInt(sqrtPriceX96)) / 2 ** 96;
  const L = Number(BigInt(liquidity));
  if (!(L > 0) || !(sqrtP > 0)) return 0;

  const sqrtPa = Math.sqrt(1.0001 ** Number(tickLower));
  const sqrtPb = Math.sqrt(1.0001 ** Number(tickUpper));
  if (!(sqrtPb > sqrtPa)) return 0;

  let x;
  let y;
  if (sqrtP <= sqrtPa) {
    x = L * (1 / sqrtPa - 1 / sqrtPb);
    y = 0;
  } else if (sqrtP >= sqrtPb) {
    x = 0;
    y = L * (sqrtPb - sqrtPa);
  } else {
    x = L * (1 / sqrtP - 1 / sqrtPb);
    y = L * (sqrtP - sqrtPa);
  }

  return (x + y / (sqrtP * sqrtP)) / 10 ** token0Decimals;
}

/**
 * Virtual token0 value of the pool's active liquidity.
 * x = L/sqrtP and y = L*sqrtP; value in token0 = x + y/P = 2L/sqrtP.
 */
export function activeLiquidityValue({ liquidity, sqrtPriceX96, token0Decimals = 6 }) {
  const sqrtP = Number(BigInt(sqrtPriceX96)) / 2 ** 96;
  const L = Number(BigInt(liquidity));
  if (!(sqrtP > 0) || !(L > 0)) return 0;
  return (2 * L) / sqrtP / 10 ** token0Decimals;
}

/** Tick range around the current tick for a given price half-width in bps. */
export function rangeFromHalfWidth({ currentTick, halfWidthBps = 1_000 }) {
  const w = Math.min(0.99, Number(halfWidthBps) / 10_000);
  const ticks = Math.max(1, Math.round(Math.log(1 + w) / Math.log(1.0001)));
  return { tickLower: Number(currentTick) - ticks, tickUpper: Number(currentTick) + ticks };
}

/**
 * Raw liquidity that a given token0 value represents in [tickLower, tickUpper]
 * at the current price. Inverse of positionValueUsd for a known L.
 */
export function liquidityForValue({
  valueUsd,
  sqrtPriceX96,
  tickLower,
  tickUpper,
  token0Decimals = 6,
}) {
  if (!(Number(valueUsd) > 0)) return 0;
  const valuePer1e18 = positionValueUsd({
    liquidity: 10n ** 18n,
    sqrtPriceX96,
    tickLower,
    tickUpper,
    token0Decimals,
  });
  if (!(valuePer1e18 > 0)) return 0;
  return (Number(valueUsd) * 1e18) / valuePer1e18;
}

/** Fee APR on active liquidity, bps. */
export function feeAprFromActiveLiquidity({ feesUsd, activeLiquidityUsd, windowSeconds }) {
  if (!(activeLiquidityUsd > 0) || !(windowSeconds > 0)) return 0;
  const annualization = (365 * 24 * 3600) / windowSeconds;
  return Math.round((Number(feesUsd) / Number(activeLiquidityUsd)) * annualization * 10_000);
}

/**
 * Full market read for one candidate:
 * fees + volume + volatility + IL + net APR (fees after IL).
 */
export function marketStats({
  book,
  activeLiquidityUsd,
  windowSeconds,
  rangeHalfWidthBps = 1_000,
  bookShare,
  bookValueUsd,
  bookRange,
  tickStart,
  tickEnd,
}) {
  const annualization = windowSeconds > 0 ? (365 * 24 * 3600) / windowSeconds : 0;

  let feeAprBps;
  if (bookShare != null) {
    // Position-level fees: pool fees × L_book/L_pool, divided by the book's LP value.
    // Zero share or zero position value means the book earned nothing (guard pulled/out of range).
    feeAprBps =
      Number(bookValueUsd) > 0
        ? Math.round(
            ((Number(book.feesUsd) * Number(bookShare)) / Number(bookValueUsd)) *
              annualization *
              10_000,
          )
        : 0;
  } else {
    feeAprBps = feeAprFromActiveLiquidity({
      feesUsd: book.feesUsd,
      activeLiquidityUsd,
      windowSeconds,
    });
  }

  const il =
    bookRange && Number.isFinite(Number(tickStart)) && Number.isFinite(Number(tickEnd))
      ? ilBpsForTicks({
          tickStart,
          tickEnd,
          tickLower: bookRange.tickLower,
          tickUpper: bookRange.tickUpper,
        })
      : ilBps({
          priceStart: book.priceFirst,
          priceEnd: book.priceLast,
          halfWidthBps: rangeHalfWidthBps,
        });

  const ilAprBps = Math.round(il * annualization);

  return {
    ...book,
    activeLiquidityUsd,
    feeAprBps,
    ilBps: il,
    ilAprBps,
    netAprBps: feeAprBps - Math.abs(ilAprBps),
  };
}

/** Fetch and summarize one v4 book's Swap logs. */
export async function fetchBookStats({
  publicClient,
  poolManager,
  poolId,
  feePips,
  nav,
  fromBlock,
  toBlock,
  windowSeconds = 21_600,
  token0Decimals = 6,
  token1Decimals = 18,
}) {
  const logs = await publicClient.getLogs({
    address: poolManager,
    event: SWAP_EVENT,
    args: { id: poolId },
    fromBlock,
    toBlock,
  });

  return summarizeBook({
    swaps: logs.map((l) => l.args),
    feePips,
    nav,
    windowSeconds,
    token0Decimals,
    token1Decimals,
  });
}


