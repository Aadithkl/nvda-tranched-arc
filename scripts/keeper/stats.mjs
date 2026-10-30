// On-chain market stats for the risk/IL allocator.
//
// Reads Swap logs over the lookback window and computes, per pool:
//   - USDG notional volume
//   - fees (volume * pool fee)
//   - fee APR on the pool's active liquidity
//   - price fluctuation (max-min range) and first/last move
//   - IL for a configured concentrated range, and the worst |IL| along the tick path
//   - guard-uptime-adjusted fee share (base + guard * uptime)
//   - net APR = fee APR - |IL APR| * ilMultiple
//
// Assumes USDG/NVDA with USDG as token0 (0x5fc5... < 0xd060...).

import { parseAbiItem } from "viem";

export const SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

const Q192 = 1n << 192n;

/** Clamp a possibly-unparseable number into [0, 1]; non-finite input clamps to 0. */
function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

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
  let tickMin = 0;
  let tickMax = 0;

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
      if (tickCount === 0) {
        tickFirst = tick;
        tickMin = tick;
        tickMax = tick;
      }
      tickLast = tick;
      tickMin = Math.min(tickMin, tick);
      tickMax = Math.max(tickMax, tick);
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
    tickMin: tickCount > 0 ? tickMin : 0,
    tickMax: tickCount > 0 ? tickMax : 0,
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
 *
 * Optional inputs are backward compatible:
 *   - `guardUptime` (0..1) with `baseShare`/`guardShare`: the book's fee share is
 *     `baseShare + guardShare * guardUptime`, so time spent with the guard pulled
 *     does not earn guard-range fees. Without `baseShare`/`guardShare` the share is
 *     `bookShare` unchanged.
 *   - `ilWorst` is the largest |IL| between the start tick and the end/min/max ticks.
 *     `tickMin`/`tickMax` default to the fields recorded by `summarizeBook`.
 *   - `ilMultipleBps` (default 1x) stresses the worst-case IL when scoring net APR.
 *
 * `ilBps` stays signed (the endpoint read); `ilWorstBps` and `ilAprBps` are magnitudes.
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
  tickMin,
  tickMax,
  guardUptime = 1,
  baseShare,
  guardShare,
  ilMultipleBps = 10_000,
}) {
  const annualization = windowSeconds > 0 ? (365 * 24 * 3600) / windowSeconds : 0;

  const uptime = clamp01(guardUptime);
  const hasShareSplit = baseShare != null || guardShare != null;
  const effectiveShare = hasShareSplit
    ? clamp01(Number(baseShare ?? 0) + Number(guardShare ?? 0) * uptime)
    : bookShare;

  let feeAprBps;
  if (effectiveShare != null) {
    // Position-level fees: pool fees × L_book/L_pool, divided by the book's LP value.
    // Zero share or zero position value means the book earned nothing (guard pulled/out of range).
    feeAprBps =
      Number(bookValueUsd) > 0
        ? Math.round(
            ((Number(book.feesUsd) * Number(effectiveShare)) / Number(bookValueUsd)) *
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

  const tickRange =
    bookRange != null
      ? { tickLower: Number(bookRange.tickLower), tickUpper: Number(bookRange.tickUpper) }
      : null;

  // Endpoint IL: unchanged from the original behaviour (tick path, else price path).
  const il =
    tickRange && Number.isFinite(Number(tickStart)) && Number.isFinite(Number(tickEnd))
      ? ilBpsForTicks({ tickStart, tickEnd, ...tickRange })
      : ilBps({
          priceStart: book.priceFirst,
          priceEnd: book.priceLast,
          halfWidthBps: rangeHalfWidthBps,
        });

  // Worst case: the path may leave the range and come back, so the endpoint IL
  // can be zero while the book actually took the excursion loss.
  let ilWorst = Math.abs(il);
  if (tickRange && Number.isFinite(Number(tickStart))) {
    for (const tick of [tickEnd, tickMin ?? book.tickMin, tickMax ?? book.tickMax]) {
      if (!Number.isFinite(Number(tick))) continue;
      const worstTick = Math.abs(ilBpsForTicks({ tickStart, tickEnd: tick, ...tickRange }));
      if (worstTick > ilWorst) ilWorst = worstTick;
    }
  }

  const ilAprBps = Math.round(ilWorst * annualization);
  const multiple = Number(ilMultipleBps);
  const ilStress = Number.isFinite(multiple) && multiple >= 0 ? multiple : 10_000;

  return {
    ...book,
    activeLiquidityUsd,
    effectiveShare,
    guardUptime: uptime,
    feeAprBps,
    ilBps: il,
    ilWorstBps: ilWorst,
    ilAprBps,
    netAprBps: Math.round(feeAprBps - (Math.abs(ilAprBps) * ilStress) / 10_000),
  };
}

/**
 * Split [fromBlock, toBlock] into inclusive BigInt chunks of at most `chunkBlocks`.
 * An inverted range or a non-positive/unparseable chunk size returns [] (never loops).
 */
export function chunkedBlockRanges({ fromBlock, toBlock, chunkBlocks }) {
  let from;
  let to;
  let size;
  try {
    from = BigInt(fromBlock);
    to = BigInt(toBlock);
    size = BigInt(chunkBlocks);
  } catch {
    return [];
  }
  if (size <= 0n || to < from) return [];

  const ranges = [];
  for (let start = from; start <= to; start += size) {
    const last = start + size - 1n;
    ranges.push({ fromBlock: start, toBlock: last < to ? last : to });
  }
  return ranges;
}

/** Event time in seconds: `timestamp` when usable, else `blockNumber * blockTimeSeconds`. */
function guardEventTime(event, blockTimeSeconds) {
  if (event == null) return null;
  if (event.timestamp != null) {
    const t = Number(event.timestamp);
    if (Number.isFinite(t)) return t;
  }
  if (event.blockNumber != null) {
    const b = Number(event.blockNumber);
    const step = Number(blockTimeSeconds);
    if (!Number.isFinite(b) || !Number.isFinite(step)) return null;
    return b * step;
  }
  return null;
}

/**
 * Fraction of [windowStart, windowEnd] the guard was deployed.
 *
 * `events` are `{ type: "pulled" | "deployed", timestamp?, blockNumber? }`; a
 * `pulled` opens a down interval and a `deployed` closes it. Intervals are clipped
 * to the window, so a pull before the window counts from `windowStart` and a pull
 * still open at the end counts to `windowEnd`. Returns
 * `{ uptime, pulledSeconds, intervals }` with `uptime` in [0, 1].
 */
export function computeGuardUptime({
  events,
  windowStart,
  windowEnd,
  blockTimeSeconds = 0.1,
}) {
  const start = Number(windowStart);
  const end = Number(windowEnd);
  const windowSeconds = end - start;
  // No observable window: nothing was pulled, so the guard counts as up.
  if (!(windowSeconds > 0)) return { uptime: 1, pulledSeconds: 0, intervals: [] };

  const timed = [];
  for (const event of Array.isArray(events) ? events : []) {
    const time = guardEventTime(event, blockTimeSeconds);
    if (time != null) timed.push({ type: event.type, time });
  }
  timed.sort((a, b) => a.time - b.time);

  const raw = [];
  let downStart = null;
  for (const event of timed) {
    if (event.type === "pulled") {
      if (downStart == null) downStart = event.time;
    } else if (event.type === "deployed" && downStart != null) {
      raw.push({ from: downStart, to: event.time });
      downStart = null;
    }
  }
  if (downStart != null) raw.push({ from: downStart, to: end });

  const intervals = [];
  let pulledSeconds = 0;
  for (const interval of raw) {
    const from = Math.max(interval.from, start);
    const to = Math.min(interval.to, end);
    if (!(to > from)) continue;
    intervals.push({ from, to, seconds: to - from });
    pulledSeconds += to - from;
  }
  pulledSeconds = Math.min(Math.max(pulledSeconds, 0), windowSeconds);

  return { uptime: clamp01(1 - pulledSeconds / windowSeconds), pulledSeconds, intervals };
}

/** Parse a block-like value; null when absent or unparseable. */
function blockNumberOrNull(value) {
  if (value == null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Swaps whose `blockNumber` is inside the inclusive [fromBlock, toBlock] range.
 * Swaps without a parseable `blockNumber` are kept rather than dropped silently.
 */
export function filterSwapsByBlock(swaps, fromBlock, toBlock) {
  const from = blockNumberOrNull(fromBlock);
  const to = blockNumberOrNull(toBlock);
  return (Array.isArray(swaps) ? swaps : []).filter((swap) => {
    const block = blockNumberOrNull(swap?.blockNumber);
    if (block == null) return true;
    if (from != null && block < from) return false;
    if (to != null && block > to) return false;
    return true;
  });
}

/** Drop cached swaps below `fromBlock`; entries without a block number are kept. */
export function pruneSwapCache({ entries, fromBlock } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const from = blockNumberOrNull(fromBlock);
  if (from == null) return list.slice();
  return list.filter((entry) => {
    const block = blockNumberOrNull(entry?.blockNumber);
    return block == null || block >= from;
  });
}

/** Stable identity for a cached swap, or null when it carries none. */
function swapCacheKey(entry) {
  const block = blockNumberOrNull(entry?.blockNumber);
  if (block == null) return null;
  if (entry.logIndex != null) return `${block}:log:${String(entry.logIndex)}`;
  if (entry.transactionHash != null && entry.index != null) {
    return `${block}:tx:${String(entry.transactionHash).toLowerCase()}:${String(entry.index)}`;
  }
  return null;
}

/**
 * Append `incoming` to `existing`, dropping duplicates by block + logIndex, or
 * block + transactionHash + index when logIndex is absent. Entries with no
 * identity are kept as-is (there is nothing to dedupe them on).
 */
export function mergeSwapCache(existing, incoming) {
  const merged = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set();
  for (const entry of merged) {
    const key = swapCacheKey(entry);
    if (key != null) seen.add(key);
  }
  for (const entry of Array.isArray(incoming) ? incoming : []) {
    const key = swapCacheKey(entry);
    if (key != null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    merged.push(entry);
  }
  return merged;
}

/** Positive BigInt chunk size, or 0n when absent/invalid (single getLogs call). */
function positiveBlockChunk(chunkBlocks) {
  if (chunkBlocks == null) return 0n;
  try {
    const size = BigInt(chunkBlocks);
    return size > 0n ? size : 0n;
  } catch {
    return 0n;
  }
}

/** getLogs for one book, split into block chunks when `chunkBlocks` is positive. */
async function getSwapLogs({ publicClient, poolManager, poolId, fromBlock, toBlock, chunkBlocks }) {
  const query = { address: poolManager, event: SWAP_EVENT, args: { id: poolId } };
  const chunk = positiveBlockChunk(chunkBlocks);

  if (chunk > 0n && fromBlock != null && toBlock != null) {
    const ranges = chunkedBlockRanges({ fromBlock, toBlock, chunkBlocks: chunk });
    const logs = [];
    for (const range of ranges) {
      const part = await publicClient.getLogs({ ...query, ...range });
      logs.push(...part);
    }
    return logs;
  }

  return publicClient.getLogs({ ...query, fromBlock, toBlock });
}

/**
 * Fetch and summarize one v4 book's Swap logs.
 * `chunkBlocks` (optional) splits the block range into sequential getLogs calls.
 * Each swap arg carries `blockNumber` so callers can filter/prune the cache.
 */
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
  chunkBlocks,
}) {
  const logs = await getSwapLogs({
    publicClient,
    poolManager,
    poolId,
    fromBlock,
    toBlock,
    chunkBlocks,
  });

  return summarizeBook({
    swaps: logs.map((l) => ({ ...l.args, blockNumber: l.blockNumber })),
    feePips,
    nav,
    windowSeconds,
    token0Decimals,
    token1Decimals,
  });
}


