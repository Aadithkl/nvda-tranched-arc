// Read-only reference-pool scanner (external Uniswap v3 and v4 venues).
//
// Produces the per-pool observations consumed by `market-view.mjs`. This module is market data
// only: it never adds liquidity, moves capital, signs, or writes. It also bakes in no market
// address, pool id, token or price; token addresses come from the registry entry or the config
// defaults for the entry's pair.
//
// Failure model: one bad pool must not sink the batch. Pools run through `Promise.allSettled`;
// a failure becomes an observation with `fresh: false` and `error`, plus one line in `errors`.
// The scanner only throws for programmer errors (none on the pool path).
//
// Assumptions the view depends on:
//   - `nvda-usd` values are quote-token units (USDG); `nvda-eth` values are WETH units. The
//     scanner never invents an ETH/USD conversion.
//   - v4 token0/token1 are the two currencies sorted by address, as a v4 PoolKey requires; v3
//     reads `token0()`/`token1()` from the pool itself.
//   - `liquidityUsd` is the virtual value of the pool's ACTIVE liquidity at spot
//     (`x = L/sqrtP`, `y = L*sqrtP`), not the value of every position across all ticks.
//   - TWAP is the 30-minute swap TWAP and falls back to the spot price when that window is empty.
//   - Fee APR credits our L-share of the pool's fees against `reference.allocUsd`. IL is the
//     worst path IL for the aligned range, annualized over the same window.
//   - `decimals()` is the source of token decimals; 6/18 are only failed-read fallbacks.

import { parseAbi, parseAbiItem } from "viem";
import { SWAP_EVENT, chunkedBlockRanges, rangeFromHalfWidth } from "./stats.mjs";
import {
  summarizeReferenceSwaps,
  priceQuotePerEquity,
  liquidityForValueOriented,
  alignRangeToSpacing,
  worstIlBps,
  resolveQuoteOrientation,
} from "./reference-math.mjs";

const Q96 = 2 ** 96;
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const TWAP_WINDOW_SECONDS = 1_800;
const DEFAULT_TICK_SPACING = 60;
const DEFAULT_WINDOW_SECONDS = 86_400;
const DEFAULT_FAST_WINDOW_SECONDS = 21_600;
const DEFAULT_MAX_STALE_SECONDS = 1_800;
const DEFAULT_HALF_WIDTH_BPS = 1_000;
const MAX_ERROR_CHARS = 240;

const V3_POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
]);

const V4_STATE_ABI = parseAbi([
  "function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 id) view returns (uint128 liquidity)",
]);

const ERC20_DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);

const V3_SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

/** Finite positive Number, or `fallback`. */
function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** BigInt for integer-like input; 0n for absent or unparseable values. */
function asBigInt(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
}

/** One-line, length-capped error text. viem errors carry the useful part in `shortMessage`. */
function describeError(error) {
  if (error !== null && typeof error === "object") {
    const message = error.shortMessage ?? error.message;
    if (typeof message === "string" && message.trim() !== "") {
      return message.split("\n")[0].slice(0, MAX_ERROR_CHARS);
    }
  }
  return String(error).split("\n")[0].slice(0, MAX_ERROR_CHARS);
}

function note(log, message) {
  if (typeof log === "function") log(`reference-scan: ${message}`);
}

/** True when the swap carries a parseable block at or after `fromBlock`. */
function isAtOrAfter(swap, fromBlock) {
  try {
    return swap?.blockNumber != null && BigInt(swap.blockNumber) >= fromBlock;
  } catch {
    return false;
  }
}

/** First block of a time window, clamped to genesis. */
function windowStart(head, seconds, blockTimeSeconds) {
  const blocks = Math.ceil(seconds / blockTimeSeconds);
  if (!Number.isFinite(blocks) || blocks < 0) return 0n;
  const offset = BigInt(blocks);
  return head > offset ? head - offset : 0n;
}

/**
 * Quote/equity addresses for an entry: explicit fields win, then the pair's config defaults.
 * A missing default is passed through as "" so `resolveQuoteOrientation` reports it.
 */
function resolveTokens(pool, config) {
  const pair = pool?.pair;
  const defaultQuote =
    pair === "nvda-eth" ? config?.addresses?.weth : config?.addresses?.quote;
  return {
    quoteToken: pool?.quoteToken || defaultQuote || "",
    equityToken: pool?.equityToken || config?.addresses?.equity || "",
  };
}

/** Token decimals, cached per scan call. The promise cache also dedupes concurrent pools. */
function readTokenDecimals({ publicClient, token, fallback, cache }) {
  if (!token) return Promise.resolve(fallback);
  const key = String(token).toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = Promise.resolve()
    .then(() =>
      publicClient.readContract({
        address: token,
        abi: ERC20_DECIMALS_ABI,
        functionName: "decimals",
      }),
    )
    .then((value) => {
      const decimals = Number(value);
      return Number.isInteger(decimals) && decimals >= 0 && decimals <= 255
        ? decimals
        : fallback;
    })
    .catch(() => fallback);
  cache.set(key, pending);
  return pending;
}

/** Base observation so every exit path returns the same keys. */
function baseObservation(pool) {
  return {
    name: typeof pool?.name === "string" && pool.name !== "" ? pool.name : "unknown",
    pair: typeof pool?.pair === "string" ? pool.pair : "",
    kind: typeof pool?.kind === "string" ? pool.kind : "",
    feePips: Number(pool?.feePips) || 0,
    price: 0,
    twapPrice: 0,
    volume24h: 0,
    volume6h: 0,
    fees24h: 0,
    fees6h: 0,
    netApr24h: 0,
    netApr6h: 0,
    volatilityBps: 0,
    volatility24hBps: 0,
    ilBps: 0,
    liquidityUsd: 0,
    ourShareBps: 0,
    swaps24h: 0,
    uniqueSenders24h: 0,
    lastSwapAgeSeconds: null,
    fresh: false,
    // Diagnostics beyond the market-view contract.
    feeApr24h: 0,
    feeApr6h: 0,
    ilApr24h: 0,
    ilApr6h: 0,
    tickSpacing: Number(pool?.tickSpacing) || 0,
    tickLower: 0,
    tickUpper: 0,
    quoteIsToken0: false,
  };
}

function errorObservation(pool, error, overrides = {}) {
  return { ...baseObservation(pool), ...overrides, error };
}

/**
 * getLogs for one pool, split by `chunkBlocks`. A single call is used when the caller did not
 * configure a usable chunk size. Chunks run sequentially so one pool cannot fan out unbounded.
 */
async function fetchSwapEntries({ publicClient, query, fromBlock, toBlock, chunkBlocks }) {
  if (toBlock < fromBlock) return [];
  const ranges = chunkedBlockRanges({ fromBlock, toBlock, chunkBlocks });
  const bounds = ranges.length > 0 ? ranges : [{ fromBlock, toBlock }];
  const swaps = [];

  for (const range of bounds) {
    const logs = await publicClient.getLogs({
      ...query,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    });
    for (const entry of Array.isArray(logs) ? logs : []) {
      const args = entry?.args ?? {};
      swaps.push({
        ...args,
        blockNumber: entry?.blockNumber,
        logIndex: entry?.logIndex,
        transactionHash: entry?.transactionHash,
        sender: args.sender ?? "",
      });
    }
  }
  return swaps;
}

/**
 * Virtual value of the pool's active L at spot, in quote units.
 *
 * Active liquidity is worth `x = L/sqrtP` of token0 and `y = L*sqrtP` of token1 at the current
 * price. `amountsForLiquidity` would need the position's range, which is not observable from
 * `liquidity()`; the active-liquidity identity is the correct spot value of the L we can read.
 */
function activeLiquidityQuoteValue({
  liquidity,
  sqrtPriceX96,
  price,
  quoteIsToken0,
  quoteDecimals,
  equityDecimals,
}) {
  const L = Number(asBigInt(liquidity));
  const sqrtP = Number(asBigInt(sqrtPriceX96)) / Q96;
  const quote = Number(quoteDecimals);
  const equity = Number(equityDecimals);
  if (!(L > 0) || !(sqrtP > 0) || !(price > 0)) return 0;
  if (!Number.isFinite(quote) || !Number.isFinite(equity)) return 0;

  const amount0 = L / sqrtP;
  const amount1 = L * sqrtP;
  const token0 = amount0 / 10 ** (quoteIsToken0 ? quote : equity);
  const token1 = amount1 / 10 ** (quoteIsToken0 ? equity : quote);
  const value = quoteIsToken0 ? token0 + token1 * price : token0 * price + token1;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Worst |IL| along the window's tick path for the aligned range. 0 without ticks. */
function ilOverWindow(summary, range) {
  if (!summary || summary.swaps === 0) return 0;
  return worstIlBps({
    tickStart: summary.tickFirst,
    tickEnd: summary.tickLast,
    tickMin: summary.tickMin,
    tickMax: summary.tickMax,
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
  });
}

function roundBps(value) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function roundSeconds(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : 0;
}

function roundUsd(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/** Shared read/measure path once token metadata and slot0 are known. */
async function observePool({
  publicClient,
  pool,
  kind,
  token0,
  token1,
  slot0,
  liquidity,
  feePips,
  tickSpacing,
  swapQuery,
  config,
  head,
  blockTimeSeconds,
  decimalsCache,
}) {
  const base = baseObservation(pool);
  const { quoteToken, equityToken } = resolveTokens(pool, config);
  const orientation = resolveQuoteOrientation({
    token0,
    token1,
    quoteToken,
    equityToken,
  });
  if (!orientation.ok) {
    return {
      ...base,
      kind,
      feePips,
      tickSpacing: Number(tickSpacing) || 0,
      error: orientation.reason,
    };
  }
  const { quoteIsToken0 } = orientation;

  const quoteFallback = pool?.pair === "nvda-eth" ? 18 : 6;
  const [quoteDecimals, equityDecimals] = await Promise.all([
    readTokenDecimals({
      publicClient,
      token: quoteToken,
      fallback: quoteFallback,
      cache: decimalsCache,
    }),
    readTokenDecimals({
      publicClient,
      token: equityToken,
      fallback: 18,
      cache: decimalsCache,
    }),
  ]);

  const ref = config?.reference ?? {};
  const windowSeconds = positiveNumber(ref.windowSeconds, DEFAULT_WINDOW_SECONDS);
  const fastWindowSeconds = positiveNumber(
    ref.fastWindowSeconds,
    DEFAULT_FAST_WINDOW_SECONDS,
  );
  const maxStaleSeconds = positiveNumber(
    ref.maxStaleSeconds,
    DEFAULT_MAX_STALE_SECONDS,
  );
  const allocUsd = positiveNumber(ref.allocUsd, 0);
  const halfWidthBps = positiveNumber(
    config?.allocator?.rangeHalfWidthBps,
    DEFAULT_HALF_WIDTH_BPS,
  );

  const from24 = windowStart(head, windowSeconds, blockTimeSeconds);
  const from6 = windowStart(head, fastWindowSeconds, blockTimeSeconds);
  const from30 = windowStart(head, TWAP_WINDOW_SECONDS, blockTimeSeconds);

  const swaps24 = await fetchSwapEntries({
    publicClient,
    query: swapQuery,
    fromBlock: from24,
    toBlock: head,
    chunkBlocks: ref.logsChunkBlocks,
  });
  const swaps6 = swaps24.filter((swap) => isAtOrAfter(swap, from6));
  const swaps30 = swaps24.filter((swap) => isAtOrAfter(swap, from30));

  const summary24 = summarizeReferenceSwaps({
    swaps: swaps24,
    quoteIsToken0,
    feePips,
    quoteDecimals,
    equityDecimals,
    windowSeconds,
    blockTimeSeconds,
  });
  const summary6 = summarizeReferenceSwaps({
    swaps: swaps6,
    quoteIsToken0,
    feePips,
    quoteDecimals,
    equityDecimals,
    windowSeconds: fastWindowSeconds,
    blockTimeSeconds,
  });
  const summary30 = summarizeReferenceSwaps({
    swaps: swaps30,
    quoteIsToken0,
    feePips,
    quoteDecimals,
    equityDecimals,
    windowSeconds: TWAP_WINDOW_SECONDS,
    blockTimeSeconds,
  });

  const price = priceQuotePerEquity({
    sqrtPriceX96: slot0?.[0],
    quoteIsToken0,
    quoteDecimals,
    equityDecimals,
  });
  const twap = Number(summary30.twapPrice);
  const twapPrice = Number.isFinite(twap) && twap > 0 ? twap : price;

  const range = alignRangeToSpacing({
    ...rangeFromHalfWidth({
      currentTick: Number(slot0?.[1]),
      halfWidthBps,
    }),
    tickSpacing,
  });

  const poolL = asBigInt(liquidity);
  const ourL = liquidityForValueOriented({
    valueUsd: allocUsd,
    sqrtPriceX96: slot0?.[0],
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    quoteIsToken0,
    quoteDecimals,
    equityDecimals,
  });
  const totalL = poolL + ourL;
  const ourShareBps = totalL > 0n ? Number((ourL * 10_000n) / totalL) : 0;

  const annualization24 = YEAR_SECONDS / windowSeconds;
  const annualization6 = YEAR_SECONDS / fastWindowSeconds;
  const feeApr24hRaw =
    allocUsd > 0
      ? (summary24.feesUsd *
          (ourShareBps / 10_000) *
          annualization24 *
          10_000) /
        allocUsd
      : 0;
  const feeApr6hRaw =
    allocUsd > 0
      ? (summary6.feesUsd *
          (ourShareBps / 10_000) *
          annualization6 *
          10_000) /
        allocUsd
      : 0;

  const ilWorst24 = ilOverWindow(summary24, range);
  const ilWorst6 = ilOverWindow(summary6, range);
  const ilApr24h = ilWorst24 * annualization24;
  const ilApr6h = ilWorst6 * annualization6;

  const swaps24h = swaps24.length;
  const lastSwapBlock = summary24.lastSwapBlock;
  const lastSwapAgeSeconds =
    lastSwapBlock > 0n
      ? roundSeconds(Math.max(0, Number(head - lastSwapBlock)) * blockTimeSeconds)
      : null;
  const fresh = lastSwapAgeSeconds != null && lastSwapAgeSeconds <= maxStaleSeconds;
  const error = swaps24h === 0 ? "no swaps" : undefined;

  return {
    ...base,
    kind,
    feePips,
    price,
    twapPrice,
    volume24h: summary24.volumeUsd,
    volume6h: summary6.volumeUsd,
    fees24h: summary24.feesUsd,
    fees6h: summary6.feesUsd,
    netApr24h: roundBps(feeApr24hRaw - ilApr24h),
    netApr6h: roundBps(feeApr6hRaw - ilApr6h),
    volatilityBps: summary6.volatilityBps,
    volatility24hBps: summary24.volatilityBps,
    ilBps: roundBps(ilWorst24),
    liquidityUsd: roundUsd(
      activeLiquidityQuoteValue({
        liquidity,
        sqrtPriceX96: slot0?.[0],
        price,
        quoteIsToken0,
        quoteDecimals,
        equityDecimals,
      }),
    ),
    ourShareBps,
    swaps24h,
    uniqueSenders24h: new Set(swaps24.map((swap) => swap.sender)).size,
    lastSwapAgeSeconds,
    fresh,
    feeApr24h: roundBps(feeApr24hRaw),
    feeApr6h: roundBps(feeApr6hRaw),
    ilApr24h: roundBps(ilApr24h),
    ilApr6h: roundBps(ilApr6h),
    tickSpacing: Number(tickSpacing) || 0,
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    quoteIsToken0,
    ...(error ? { error } : {}),
  };
}

async function scanV3(ctx) {
  const { publicClient, pool } = ctx;
  const address = pool?.address;
  if (!address) throw new Error("missing v3 pool address");

  const [token0, token1, fee, tickSpacing, slot0, liquidity] = await Promise.all([
    publicClient.readContract({ address, abi: V3_POOL_ABI, functionName: "token0" }),
    publicClient.readContract({ address, abi: V3_POOL_ABI, functionName: "token1" }),
    publicClient.readContract({ address, abi: V3_POOL_ABI, functionName: "fee" }),
    publicClient.readContract({ address, abi: V3_POOL_ABI, functionName: "tickSpacing" }),
    publicClient.readContract({ address, abi: V3_POOL_ABI, functionName: "slot0" }),
    publicClient.readContract({ address, abi: V3_POOL_ABI, functionName: "liquidity" }),
  ]);

  return observePool({
    ...ctx,
    kind: "v3",
    token0,
    token1,
    slot0,
    liquidity,
    // The registry fee is an override; the pool's own fee() is the truth when it is unset.
    feePips: Number(pool.feePips) || Number(fee) || 0,
    tickSpacing: Number(tickSpacing),
    swapQuery: { address, event: V3_SWAP_EVENT },
  });
}

async function scanV4(ctx) {
  const { publicClient, pool, config } = ctx;
  const poolId = pool?.poolId;
  const manager = pool?.poolManager || config?.pools?.manager || "";
  if (!poolId) throw new Error("missing v4 pool id");
  if (!manager) throw new Error("missing v4 pool manager");

  const [slot0, liquidity] = await Promise.all([
    publicClient.readContract({
      address: manager,
      abi: V4_STATE_ABI,
      functionName: "getSlot0",
      args: [poolId],
    }),
    publicClient.readContract({
      address: manager,
      abi: V4_STATE_ABI,
      functionName: "getLiquidity",
      args: [poolId],
    }),
  ]);

  const { quoteToken, equityToken } = resolveTokens(pool, config);
  // v4 PoolKey requires currency0 < currency1, so the pool's token0/token1 is the sorted pair.
  const quoteKey = String(quoteToken).toLowerCase();
  const equityKey = String(equityToken).toLowerCase();
  const sorted = quoteKey !== "" && equityKey !== "" && quoteKey < equityKey;
  const token0 = sorted ? quoteToken : equityToken;
  const token1 = sorted ? equityToken : quoteToken;

  const spacing = Number(pool.tickSpacing);
  return observePool({
    ...ctx,
    kind: "v4",
    token0,
    token1,
    slot0,
    liquidity,
    // v4 fees are dynamic: the slot0 lpFee is the current tier, with the entry as fallback.
    feePips: Number(slot0?.[3]) || Number(pool.feePips) || 0,
    tickSpacing: Number.isFinite(spacing) && spacing > 0 ? spacing : DEFAULT_TICK_SPACING,
    swapQuery: { address: manager, event: SWAP_EVENT, args: { id: poolId } },
  });
}

async function scanPool(ctx) {
  if (ctx.pool?.kind === "v3") return scanV3(ctx);
  if (ctx.pool?.kind === "v4") return scanV4(ctx);
  throw new Error(`unsupported kind "${String(ctx.pool?.kind)}"`);
}

/**
 * Scan enabled reference pools into view observations.
 *
 * @param {object} args
 * @param {object} args.publicClient viem public client (only readContract/getLogs are used)
 * @param {ReadonlyArray<object>} args.pools reference-pool registry entries
 * @param {bigint|number|string} args.blockNumber head block shared by every pool
 * @param {object} args.config keeper config (`reference`, `allocator`, `addresses`, `pools`)
 * @param {(...args: unknown[]) => void} [args.log] optional logger
 * @returns {Promise<{ observations: object[], errors: string[] }>}
 *   `observations` keeps registry order, minus entries explicitly `enabled: false`.
 *   `errors` is one log-ready line per failed or empty pool.
 */
export async function scanReferencePools({
  publicClient,
  pools,
  blockNumber,
  config,
  log,
} = {}) {
  const observations = [];
  const errors = [];
  const list = Array.isArray(pools) ? pools.filter(Boolean) : [];
  const active = list.filter((pool) => pool.enabled !== false);

  const failAll = (message) => {
    for (const pool of active) {
      const observation = errorObservation(pool, message);
      observations.push(observation);
      errors.push(`${observation.name}: ${message}`);
      note(log, `${observation.name}: ${message}`);
    }
    return { observations, errors };
  };

  if (active.length === 0) return { observations, errors };

  let head;
  try {
    head = BigInt(blockNumber);
  } catch {
    head = null;
  }
  if (head == null || head < 0n) return failAll("invalid block number");

  const blockTimeSeconds = Number(config?.allocator?.blockTimeSeconds);
  if (!(blockTimeSeconds > 0) || !Number.isFinite(blockTimeSeconds)) {
    return failAll("allocator.blockTimeSeconds must be > 0");
  }

  const context = {
    publicClient,
    config,
    head,
    blockTimeSeconds,
    decimalsCache: new Map(),
  };
  const settled = await Promise.allSettled(
    active.map((pool) => scanPool({ ...context, pool })),
  );

  settled.forEach((result, index) => {
    const pool = active[index];
    if (result.status === "fulfilled") {
      const observation = result.value;
      observations.push(observation);
      if (observation.error) {
        const message = `${observation.name}: ${observation.error}`;
        errors.push(message);
        note(log, message);
      }
      return;
    }

    const message = describeError(result.reason);
    const observation = errorObservation(pool, message);
    observations.push(observation);
    errors.push(`${observation.name}: ${message}`);
    note(log, `${observation.name}: ${message}`);
  });

  return { observations, errors };
}
