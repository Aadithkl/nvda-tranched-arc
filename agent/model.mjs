// Pure math for the agent market model: volatility, fee yield, TVL, active (rewarded) TVL,
// concentrated-liquidity IL, range sweep and decision. No network access here - testable offline.

export const HOURS_PER_YEAR = 24 * 365;
export const TICK_BASE = 1.0001;

// ---------- basic stats ----------

export function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function stddev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
}

export function logReturns(closesAsc) {
  const clean = closesAsc.map(Number).filter((v) => Number.isFinite(v) && v > 0);
  const returns = [];
  for (let i = 1; i < clean.length; i += 1) returns.push(Math.log(clean[i] / clean[i - 1]));
  return returns;
}

// Zero-mean hourly volatility (crypto hourly drift is negligible).
export function hourlyVolatility(returns) {
  if (!returns.length) return null;
  return Math.sqrt(returns.reduce((sum, r) => sum + r * r, 0) / returns.length);
}

export function ewmaVolatility(returns, lambda = 0.94) {
  if (!returns.length) return null;
  let variance = returns[0] ** 2;
  for (let i = 1; i < returns.length; i += 1) {
    variance = lambda * variance + (1 - lambda) * returns[i] ** 2;
  }
  return Math.sqrt(variance);
}

// Rows must be ascending by periodStartUnix.
export function volatilityProfile(hoursAsc, triggerHours = 3) {
  const closes = hoursAsc.map((row) => Number(row.close));
  const returns = logReturns(closes);
  const trigger = returns.slice(-Math.max(triggerHours, 1));
  return {
    samples: returns.length,
    h3: trigger.length >= 2 ? hourlyVolatility(trigger) : null,
    h14d: returns.length >= 24 ? hourlyVolatility(returns) : null,
    ewma: ewmaVolatility(returns),
    annualized: hourlyVolatility(returns) === null ? null : hourlyVolatility(returns) * Math.sqrt(HOURS_PER_YEAR),
  };
}

export function pooledVolatility(poolProfiles) {
  // Variance pooling weighted by tvlUsd * volume24hUsd * priorityFactor.
  let weightSum = 0;
  let varianceSum = 0;
  for (const p of poolProfiles) {
    const sigma = p.volatility?.h14d ?? p.volatility?.ewma;
    if (!sigma) continue;
    const w = Math.max(p.metrics.weight, 0);
    if (!w) continue;
    weightSum += w;
    varianceSum += w * sigma * sigma;
  }
  if (!weightSum) {
    const sigmas = poolProfiles.map((p) => p.volatility?.h14d).filter(Boolean);
    if (!sigmas.length) return null;
    return Math.sqrt(sigmas.reduce((sum, s) => sum + s * s, 0) / sigmas.length);
  }
  return Math.sqrt(varianceSum / weightSum);
}

// ---------- fee metrics ----------

// hoursDesc: raw subgraph rows (most recent first).
export function feeMetrics(hoursDesc, tvlUsd) {
  const rows = [...hoursDesc];
  const hours = rows.length;
  const sum = (key) => rows.reduce((acc, row) => acc + Number(row[key] ?? 0), 0);
  const volume = sum("volumeUSD");
  const fees = sum("feesUSD");
  const last24 = rows.slice(0, 24);
  const volume24h = last24.reduce((acc, row) => acc + Number(row.volumeUSD ?? 0), 0);
  const fees24h = last24.reduce((acc, row) => acc + Number(row.feesUSD ?? 0), 0);
  const effectiveFeeBps = volume > 0 ? (fees / volume) * 10_000 : null;
  const feeApr = tvlUsd > 0 && hours > 0 ? (fees / tvlUsd) * (HOURS_PER_YEAR / hours) : null;
  const feePerHourPerUsd = tvlUsd > 0 && hours > 0 ? fees / hours / tvlUsd : 0;
  return {
    hours,
    volumeUsd: volume,
    feesUsd: fees,
    volume24hUsd: volume24h,
    fees24hUsd: fees24h,
    effectiveFeeBps,
    feeApr,
    feePerHourPerUsd,
  };
}

export function realizedVolatilityUsd(hoursDesc, tvlUsd) {
  // Pool-day realization already handled by callers; kept for symmetry/extension.
  return feeMetrics(hoursDesc, tvlUsd);
}

// ---------- concentrated liquidity math ----------

export function sqrtPriceAtTick(tick) {
  return Math.pow(TICK_BASE, Number(tick) / 2);
}

export function tickAtPrice(price) {
  return Math.log(price) / Math.log(TICK_BASE);
}

// Raw amounts for liquidity L within [sqrtA, sqrtB] at sqrt price s.
export function liquidityToAmountsRaw(liquidity, sqrtP, sqrtA, sqrtB) {
  const L = Number(liquidity);
  const s = Number(sqrtP);
  const sa = Number(sqrtA);
  const sb = Number(sqrtB);
  if (!(L > 0) || !(s > 0) || !(sa > 0) || !(sb > 0) || sb <= sa) return null;
  if (s <= sa) return { amount0: L * (sb - sa) / (sa * sb), amount1: 0 };
  if (s >= sb) return { amount0: 0, amount1: L * (sb - sa) };
  return { amount0: L * (sb - s) / (s * sb), amount1: L * (s - sa) };
}

// Human price token1 per token0 from raw sqrtPriceX96-ish raw sqrt price and decimals.
export function humanPriceFromSqrt(sqrtPriceRaw, decimals0, decimals1) {
  const raw = Number(sqrtPriceRaw) ** 2; // token1_raw per token0_raw
  return raw * 10 ** (Number(decimals0) - Number(decimals1));
}

// Solve token USD prices from TVL and total token amounts (human units).
export function tokenUsdPrices(tvlUsd, amount0, amount1, price1Per0) {
  const a0 = Number(amount0);
  const a1 = Number(amount1);
  if (!(tvlUsd > 0) || !(price1Per0 > 0) || a0 + a1 <= 0) return null;
  const p1 = tvlUsd / (price1Per0 * a0 + a1);
  return { price0: price1Per0 * p1, price1: p1 };
}

// Standard v3 fee tier -> tick spacing. Aerodrome custom tiers can be overridden per pool config.
export function tickSpacingForFee(feeTier) {
  const fee = Number(feeTier);
  if (fee === 100) return 1;
  if (fee === 500) return 10;
  if (fee === 3000) return 60;
  if (fee === 10000) return 200;
  return 60;
}

// Active (rewarded) TVL: value of the liquidity that is currently in range.
// Estimate uses the active tick-spacing band around the current tick.
export function activeTvl(pool) {
  const liquidity = Number(pool.liquidity);
  const tick = Number(pool.tick);
  const spacing = Number(pool.tickSpacing ?? tickSpacingForFee(pool.feeTier));
  if (!(liquidity > 0) || !Number.isFinite(tick) || !(spacing > 0)) return null;
  const lower = Math.floor(tick / spacing) * spacing;
  const upper = lower + spacing;
  // Subgraph sqrtPrice is Q96; tick-derived sqrt prices are already raw (decimals baked in).
  const sqrtP = Number(pool.sqrtPrice) > 0 ? Number(pool.sqrtPrice) / 2 ** 96 : sqrtPriceAtTick(tick);
  const amounts = liquidityToAmountsRaw(liquidity, sqrtP, sqrtPriceAtTick(lower), sqrtPriceAtTick(upper));
  if (!amounts) return null;
  const d0 = Number(pool.token0?.decimals ?? 18);
  const d1 = Number(pool.token1?.decimals ?? 18);
  const human0 = amounts.amount0 / 10 ** d0;
  const human1 = amounts.amount1 / 10 ** d1;
  const price1Per0 = humanPriceFromSqrt(sqrtP, d0, d1);
  const prices = tokenUsdPrices(
    Number(pool.totalValueLockedUSD),
    Number(pool.totalValueLockedToken0),
    Number(pool.totalValueLockedToken1),
    price1Per0,
  );
  if (!prices) return null;
  const tvlUsd = human0 * prices.price0 + human1 * prices.price1;
  return {
    activeLiquidity: liquidity,
    activeTvlUsd: tvlUsd,
    activeShare: Number(pool.totalValueLockedUSD) > 0 ? Math.min(tvlUsd / Number(pool.totalValueLockedUSD), 1) : null,
    price0: prices.price0,
    price1: prices.price1,
    price1Per0,
  };
}

// ---------- in-range probability / range sweep ----------

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export function pInRange(bandBps, sigmaHourly, horizonHours) {
  if (!sigmaHourly) return null;
  const band = bandBps / 10_000;
  const k = Math.log(1 + band) / (sigmaHourly * Math.sqrt(horizonHours));
  return Math.max(0, 2 * normalCdf(k) - 1);
}

export function bandToTicks(bandBps) {
  return Math.ceil(Math.log(1 + bandBps / 10_000) / Math.log(TICK_BASE));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(rand) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Concentrated-liquidity position value in quote (token1) units.
function positionValue(liquidity, sqrtP, sqrtA, sqrtB) {
  const s = Number(sqrtP);
  const sa = Number(sqrtA);
  const sb = Number(sqrtB);
  const L = Number(liquidity);
  if (s <= sa) return (L * (sb - sa) / (sa * sb)) * s * s;
  if (s >= sb) return L * (sb - sa);
  return L * (2 * s - s * s / sb - sa);
}

export function simulateRange({
  price,
  bandBps,
  sigmaHourly,
  horizonHours = 1,
  feePerHourPerUsd = 0,
  tvlUsd = 0,
  activeTvlUsd = 0,
  notionalUsd = 1000,
  paths = 5000,
  seed = 42,
}) {
  const band = bandBps / 10_000;
  const p0 = Number(price);
  const pa = p0 / (1 + band);
  const pb = p0 * (1 + band);
  const sqrtA = Math.sqrt(pa);
  const sqrtB = Math.sqrt(pb);
  const sqrt0 = Math.sqrt(p0);
  const L = notionalUsd / positionValue(1, sqrt0, sqrtA, sqrtB);
  const amount0Hodl = notionalUsd / 2 / p0;
  const amount1Hodl = notionalUsd / 2;

  // Fee share: only the in-range (rewarded) value competes for fees.
  // Conservative: band-independent, so tighter ranges are under-credited.
  const activeValue = activeTvlUsd > 0 ? activeTvlUsd : tvlUsd || notionalUsd;
  const effectiveFeePerHourPerUsd =
    tvlUsd > 0 ? (feePerHourPerUsd * tvlUsd) / (notionalUsd + activeValue) : feePerHourPerUsd;

  const rand = mulberry32(seed);
  const sigma = sigmaHourly ?? 0;
  let ilSum = 0;
  let profitable = 0;
  let inRangePaths = 0;

  for (let i = 0; i < paths; i += 1) {
    const z = boxMuller(rand);
    const pT = p0 * Math.exp(-0.5 * sigma * sigma * horizonHours + sigma * Math.sqrt(horizonHours) * z);
    const vLp = positionValue(L, Math.sqrt(pT), sqrtA, sqrtB);
    const vHodl = amount0Hodl * pT + amount1Hodl;
    const ilBps = ((vLp - vHodl) / notionalUsd) * 10_000;
    const inRange = pT >= pa && pT <= pb;
    if (inRange) inRangePaths += 1;
    const feesBps = effectiveFeePerHourPerUsd * horizonHours * 10_000;
    ilSum += ilBps;
    const net = ilBps + (inRange ? feesBps : 0);
    if (net > 0) profitable += 1;
  }

  const expectedIlBps = ilSum / paths;
  const p = pInRange(bandBps, sigmaHourly, horizonHours);
  const expectedFeeBps = effectiveFeePerHourPerUsd * horizonHours * (p ?? inRangePaths / paths) * 10_000;
  const netEdgeBps = expectedIlBps + expectedFeeBps;
  return {
    bandBps,
    ticks: bandToTicks(bandBps),
    pInRange: p ?? inRangePaths / paths,
    expectedIlBps,
    expectedFeeBps,
    netEdgeBps,
    netEdgeDailyBps: (netEdgeBps * 24) / horizonHours,
    pProfitable: profitable / paths,
  };
}

export function rangeSweep(poolMetrics, bands, opts = {}) {
  const h3 = poolMetrics.volatility?.h3 ?? 0;
  const h14 = poolMetrics.volatility?.h14d ?? 0;
  const sigma = Math.max(h3, h14) || (poolMetrics.volatility?.ewma ?? 0);
  if (!poolMetrics.available || !sigma || !poolMetrics.price) return [];
  return bands
    .map((bandBps) =>
      simulateRange({
        price: poolMetrics.price,
        bandBps,
        sigmaHourly: sigma,
        horizonHours: opts.horizonHours ?? 1,
        feePerHourPerUsd: poolMetrics.metrics?.feePerHourPerUsd ?? 0,
        tvlUsd: poolMetrics.tvlUsd ?? 0,
        activeTvlUsd: poolMetrics.active?.activeTvlUsd ?? 0,
        paths: opts.paths ?? 5000,
        seed: opts.seed ?? 42,
      }),
    )
    .sort((a, b) => b.netEdgeBps - a.netEdgeBps);
}

export function decide(poolMetrics, bands, opts = {}) {
  const minEdgeBps = opts.minEdgeBps ?? 5;
  const minP = opts.minPInRange ?? 0.6;
  const sweep = rangeSweep(poolMetrics, bands, opts);
  const viable = sweep.filter((row) => row.pInRange >= minP);
  const best = (viable.length ? viable : sweep)[0] ?? null;
  if (!best) return { worthLp: false, reason: "no_sigma_or_price", best: null, sweep };
  const worthLp = best.netEdgeBps >= minEdgeBps && best.pInRange >= minP;
  const suggestedMaxDeployUsdc = Math.max(0, Math.min(100_000, Math.round((best.netEdgeBps * 1000) / 100) * 100));
  return {
    worthLp,
    reason: worthLp ? "edge_above_threshold" : best.netEdgeBps < 0 ? "fees_below_il" : "edge_below_threshold",
    best,
    suggestedBucketTicks: best.ticks,
    suggestedMaxDeployUsdc,
    sweep,
  };
}
