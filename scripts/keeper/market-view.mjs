// Pure external-market view over reference-pool observations.
//
// The reference scanner reads external NVDA/USD and NVDA/ETH pools; this module turns those
// observations into a scored, comparable view: which pools are healthy, how far each price is
// from the oracle, how dispersed a pair is, whether the two pairs agree on ETH/USD, and one
// coarse regime tag. It performs no I/O and carries no market addresses or live values: every
// price, oracle value and limit is supplied by the caller.
//
// `oracle` is `{ nvdaUsd, ethUsd }`. `price` is quote per equity (USD per NVDA, or WETH per
// NVDA), so the NVDA/ETH expected price is `nvdaUsd / ethUsd`.
//
// Status precedence is deliberate: an error is reported first, then missing price/oracle, then
// staleness, then depth, then price deviation. A pool that is both stale and thin reads as
// stale, which is the more actionable reason.

import { bpsDeviation, median } from "./reference-math.mjs";

/** Supported reference pairs. */
export const MARKET_PAIRS = Object.freeze(["nvda-usd", "nvda-eth"]);

/** Per-pool status values. Only `healthy` pools contribute to aggregates and the regime. */
export const MARKET_STATUSES = Object.freeze([
  "healthy",
  "stale",
  "thin",
  "price-deviation",
  "no-data",
  "error",
]);

/** Regime values, from least to most usable as market evidence. */
export const MARKET_REGIMES = Object.freeze([
  "uncertain",
  "volatile",
  "thin",
  "calm",
  "normal",
]);

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nonNegative(value, fallback = 0) {
  const n = numberOr(value, fallback);
  return n > 0 ? n : 0;
}

/** Highest finite value; 0 for an empty/all-invalid list. Negative values are preserved. */
function maxOf(values) {
  let best = 0;
  let seen = false;
  for (const value of values) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    if (!seen || n > best) {
      best = n;
      seen = true;
    }
  }
  return seen ? best : 0;
}

/** Expected quote per equity from the oracle; 0 when the oracle cannot price the pair. */
function expectedPriceFor(pair, oracle) {
  const nvdaUsd = nonNegative(oracle?.nvdaUsd);
  if (nvdaUsd <= 0) return 0;
  if (pair === "nvda-usd") return nvdaUsd;
  if (pair === "nvda-eth") {
    const ethUsd = nonNegative(oracle?.ethUsd);
    return ethUsd > 0 ? nvdaUsd / ethUsd : 0;
  }
  return 0;
}

/**
 * Classify one observation.
 *
 * `fresh === false` means the scanner itself judged the data unusable (for example, no recent
 * logs), so it is stale even when the age field looks acceptable.
 */
function assessObservation(observation, index, oracle, limits) {
  const source = observation !== null && typeof observation === "object" ? observation : {};
  const name =
    typeof source.name === "string" && source.name.trim() !== ""
      ? source.name.trim()
      : `pool-${index}`;
  const pair = typeof source.pair === "string" ? source.pair : "";
  const price = nonNegative(source.price);
  const expectedPrice = expectedPriceFor(pair, oracle);
  const priceDeviationBps = bpsDeviation(price, expectedPrice);
  const volume24h = nonNegative(source.volume24h);
  const swaps24h = nonNegative(source.swaps24h);
  const fresh = source.fresh !== false;

  const rawAge =
    source.lastSwapAgeSeconds === null ||
    source.lastSwapAgeSeconds === undefined ||
    source.lastSwapAgeSeconds === ""
      ? NaN
      : Number(source.lastSwapAgeSeconds);
  const lastSwapAgeSeconds = Number.isFinite(rawAge) ? Math.max(0, rawAge) : null;
  const ageKnown = lastSwapAgeSeconds !== null;

  const hasError =
    source.error !== undefined &&
    source.error !== null &&
    source.error !== false &&
    source.error !== "";

  let status;
  let reason;
  if (hasError) {
    // Do not echo scanner error text: it can contain an RPC URL or token.
    status = "error";
    reason = "pool-error";
  } else if (price <= 0) {
    status = "no-data";
    reason = "no-price";
  } else if (expectedPrice <= 0) {
    // Without an oracle price there is no honest deviation test.
    status = "no-data";
    reason = "no-oracle";
  } else if (!fresh) {
    status = "stale";
    reason = "not-fresh";
  } else if (!ageKnown || lastSwapAgeSeconds > limits.maxStaleSeconds) {
    status = "stale";
    reason = ageKnown ? "max-stale-exceeded" : "unknown-swap-age";
  } else {
    const lowVolume = volume24h < limits.minVolumeUsd;
    const lowSwaps = swaps24h < limits.minSwaps;
    if (lowVolume && lowSwaps) {
      status = "thin";
      reason = "below-min-volume-and-swaps";
    } else if (lowVolume) {
      status = "thin";
      reason = "below-min-volume";
    } else if (lowSwaps) {
      status = "thin";
      reason = "below-min-swaps";
    } else if (priceDeviationBps > limits.maxPriceDevBps) {
      status = "price-deviation";
      reason = "price-outlier";
    } else {
      status = "healthy";
      reason = "ok";
    }
  }

  return {
    name,
    pair,
    kind: typeof source.kind === "string" ? source.kind : "",
    feePips: numberOr(source.feePips, 0),
    price,
    twapPrice: nonNegative(source.twapPrice),
    expectedPrice,
    priceDeviationBps,
    status,
    reason,
    fresh,
    volume24h,
    volume6h: nonNegative(source.volume6h),
    fees24h: nonNegative(source.fees24h),
    fees6h: nonNegative(source.fees6h),
    netApr24h: numberOr(source.netApr24h, 0),
    netApr6h: numberOr(source.netApr6h, 0),
    volatilityBps: nonNegative(source.volatilityBps),
    volatility24hBps: nonNegative(source.volatility24hBps),
    ilBps: nonNegative(source.ilBps),
    liquidityUsd: nonNegative(source.liquidityUsd),
    ourShareBps: nonNegative(source.ourShareBps),
    swaps24h,
    uniqueSenders24h: nonNegative(source.uniqueSenders24h),
    lastSwapAgeSeconds,
  };
}

/**
 * Aggregate a homogeneous list of healthy pools.
 *
 * Price fields are only meaningful inside one pair (USD vs WETH), so fee-tier aggregates pass
 * `includePrice: false` and expose APR/volume/volatility medians only.
 */
function summarizePools(list, { includePrice = true } = {}) {
  const summary = {
    count: list.length,
    medianNetApr24h: median(list.map((pool) => pool.netApr24h)),
    bestNetApr24h: maxOf(list.map((pool) => pool.netApr24h)),
    medianNetApr6h: median(list.map((pool) => pool.netApr6h)),
    bestNetApr6h: maxOf(list.map((pool) => pool.netApr6h)),
    medianVolume24h: median(list.map((pool) => pool.volume24h)),
    medianVolume6h: median(list.map((pool) => pool.volume6h)),
    medianVolatilityBps: median(list.map((pool) => pool.volatilityBps)),
    medianVolatility24hBps: median(list.map((pool) => pool.volatility24hBps)),
  };

  if (includePrice) {
    const prices = list.map((pool) => pool.price).filter((price) => price > 0);
    const medianPrice = median(prices);
    let dispersionBps = 0;
    if (medianPrice > 0) {
      for (const price of prices) {
        dispersionBps = Math.max(dispersionBps, bpsDeviation(price, medianPrice));
      }
    }
    summary.medianPrice = medianPrice;
    summary.dispersionBps = dispersionBps;
  }

  return summary;
}

function groupBy(list, keyOf) {
  /** @type {Record<string, Array<object>>} */
  const groups = {};
  for (const item of list) {
    const key = keyOf(item);
    if (key === undefined || key === null || key === "") continue;
    (groups[key] ??= []).push(item);
  }
  return groups;
}

/**
 * Build the pure external-market view.
 *
 * @param {object} input
 * @param {ReadonlyArray<object>} [input.observations] scanner observations
 * @param {{ nvdaUsd?: number, ethUsd?: number }} [input.oracle] oracle prices
 * @param {{ reference?: object, course?: object }} [input.config] validated keeper config groups
 * @returns {object} view with pools, aggregates, price cross-check, regime and warnings
 */
export function buildMarketView({ observations, oracle, config } = {}) {
  const reference = config?.reference ?? {};
  const course = config?.course ?? {};
  const list = Array.isArray(observations) ? observations : [];

  const limits = {
    maxPriceDevBps: numberOr(reference.maxPriceDevBps, Infinity),
    maxStaleSeconds: numberOr(reference.maxStaleSeconds, Infinity),
    minSwaps: numberOr(reference.minSwaps, 0),
    minVolumeUsd: numberOr(reference.minVolumeUsd, 0),
  };

  const pools = list.map((observation, index) =>
    assessObservation(observation, index, oracle, limits),
  );
  const healthy = pools.filter((pool) => pool.status === "healthy");
  const excluded = pools.filter((pool) => pool.status !== "healthy");

  const pairGroups = groupBy(healthy, (pool) => pool.pair);
  const feeGroups = groupBy(healthy, (pool) => String(pool.feePips));

  const byPair = {};
  for (const [pair, group] of Object.entries(pairGroups)) {
    byPair[pair] = summarizePools(group, { includePrice: true });
  }

  const byFeeTier = {};
  for (const [fee, group] of Object.entries(feeGroups)) {
    byFeeTier[fee] = summarizePools(group, { includePrice: false });
  }

  const nvdaUsd = byPair["nvda-usd"]?.medianPrice ?? 0;
  const nvdaEth = byPair["nvda-eth"]?.medianPrice ?? 0;
  const impliedEthUsd = nvdaUsd > 0 && nvdaEth > 0 ? nvdaUsd / nvdaEth : 0;
  const oracleEthUsd = nonNegative(oracle?.ethUsd);
  const maxCrossDevBps = numberOr(reference.maxCrossDevBps, Infinity);

  let crossCheck = null;
  if (impliedEthUsd > 0 && oracleEthUsd > 0) {
    crossCheck = bpsDeviation(impliedEthUsd, oracleEthUsd) <= maxCrossDevBps;
  }

  let dispersionBps = 0;
  for (const summary of Object.values(byPair)) {
    if (summary.dispersionBps > dispersionBps) dispersionBps = summary.dispersionBps;
  }

  const medianVolatilityBps = median(healthy.map((pool) => pool.volatilityBps));
  const medianVolatility24hBps = median(healthy.map((pool) => pool.volatility24hBps));
  const medianVolume24h = median(healthy.map((pool) => pool.volume24h));
  const medianVolume6h = median(healthy.map((pool) => pool.volume6h));
  const medianExternalNetApr = median(healthy.map((pool) => pool.netApr24h));
  const bestExternalNetApr = maxOf(healthy.map((pool) => pool.netApr24h));

  const minHealthy = numberOr(reference.minHealthy, 0);
  const maxDispersionBps = numberOr(reference.maxDispersionBps, Infinity);
  const dispersionBreach = Object.values(byPair).some(
    (summary) => summary.dispersionBps > maxDispersionBps,
  );
  const uncertain =
    healthy.length === 0 ||
    healthy.length < minHealthy ||
    dispersionBreach ||
    crossCheck === false;

  const armVolHighBps = numberOr(course.armVolHighBps, Infinity);
  const baselineVolBps = nonNegative(course.baselineVolBps);
  const baselineVolumeUsd = nonNegative(course.baselineVolumeUsd);

  let regime;
  if (uncertain) {
    regime = "uncertain";
  } else if (
    medianVolatilityBps >= armVolHighBps ||
    (baselineVolBps > 0 && medianVolatilityBps >= 2 * baselineVolBps)
  ) {
    regime = "volatile";
  } else if (medianVolume24h < baselineVolumeUsd) {
    regime = "thin";
  } else if (
    medianVolatilityBps <= baselineVolBps * 0.5 &&
    medianVolume24h >= baselineVolumeUsd
  ) {
    regime = "calm";
  } else {
    regime = "normal";
  }

  const warnings = [];
  if (list.length === 0) warnings.push("no-observations");
  if (nonNegative(oracle?.nvdaUsd) <= 0) warnings.push("missing-oracle-nvda-usd");
  if (oracleEthUsd <= 0) warnings.push("missing-oracle-eth-usd");
  for (const pool of excluded) warnings.push(`excluded:${pool.name}:${pool.status}`);
  for (const [pair, summary] of Object.entries(byPair)) {
    if (summary.dispersionBps > maxDispersionBps) warnings.push(`dispersion:${pair}`);
  }
  if (crossCheck === false) {
    warnings.push("cross-check-failed");
  } else if (crossCheck === null) {
    warnings.push("cross-check-unavailable");
  }
  if (healthy.length < minHealthy) warnings.push("insufficient-healthy");
  if (regime === "uncertain") warnings.push("regime-uncertain");

  return {
    pools,
    healthy,
    excluded,
    price: {
      nvdaUsd,
      nvdaEth,
      impliedEthUsd,
      dispersionBps,
      crossCheck,
    },
    byPair,
    byFeeTier,
    bestExternalNetApr,
    medianExternalNetApr,
    medianVolatilityBps,
    medianVolatility24hBps,
    // Compatibility alias for course-correct: `volatilityBps` is the fast (6h) window.
    medianVol6h: medianVolatilityBps,
    medianVolume24h,
    medianVolume6h,
    regime,
    warnings,
  };
}
