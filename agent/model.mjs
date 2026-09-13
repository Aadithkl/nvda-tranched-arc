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

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

// Deterministic IL (bps of notional) for a given final price.
export function ilBpsAtPrice(p0, pT, bandBps, notionalUsd = 1000) {
  const band = bandBps / 10_000;
  const pa = p0 / (1 + band);
  const pb = p0 * (1 + band);
  const sqrtA = Math.sqrt(pa);
  const sqrtB = Math.sqrt(pb);
  const L = notionalUsd / positionValue(1, Math.sqrt(p0), sqrtA, sqrtB);
  const vLp = positionValue(L, Math.sqrt(pT), sqrtA, sqrtB);
  const vHodl = (notionalUsd / 2 / p0) * pT + notionalUsd / 2;
  return ((vLp - vHodl) / notionalUsd) * 10_000;
}

// Deterministic IL shock table: percent moves and (optionally) sigma moves.
export function ilShockTable({ price, bandBps, sigmaHourly = null, movesPct = [-10, -5, -2, -1, 1, 2, 5, 10] }) {
  const rows = movesPct.map((pct) => ({
    kind: "pct",
    move: pct,
    ilBps: ilBpsAtPrice(price, price * (1 + pct / 100), bandBps),
  }));
  if (sigmaHourly) {
    for (const mult of [-3, -2, -1, 1, 2, 3]) {
      const pT = price * Math.exp(-0.5 * sigmaHourly * sigmaHourly + sigmaHourly * mult);
      rows.push({ kind: "sigma", move: mult, ilBps: ilBpsAtPrice(price, pT, bandBps) });
    }
  }
  return rows;
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
  const ilSamples = [];

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
    ilSamples.push(ilBps);
    const net = ilBps + (inRange ? feesBps : 0);
    if (net > 0) profitable += 1;
  }

  const expectedIlBps = ilSum / paths;
  const p = pInRange(bandBps, sigmaHourly, horizonHours);
  const expectedFeeBps = effectiveFeePerHourPerUsd * horizonHours * (p ?? inRangePaths / paths) * 10_000;
  const netEdgeBps = expectedIlBps + expectedFeeBps;

  // IL risk analytics over the simulated paths.
  ilSamples.sort((a, b) => a - b); // ascending: worst (most negative) first
  const worstSampleCount = Math.max(1, Math.floor(paths * 0.05));
  const cvar95Bps = ilSamples.slice(0, worstSampleCount).reduce((sum, v) => sum + v, 0) / worstSampleCount;
  const var95Bps = percentile(ilSamples, 0.05);
  const ilP50Bps = percentile(ilSamples, 0.5);
  const ilP99Bps = percentile(ilSamples, 0.99);
  const ilWorstBps = ilSamples[0];
  const expectedTimeInRange = inRangePaths / paths;
  const requiredFeeBps = Math.max(0, -expectedIlBps);
  const breakevenFeePerHourPerUsd =
    horizonHours > 0 && notionalUsd > 0 ? requiredFeeBps / 10_000 / horizonHours : null;

  return {
    bandBps,
    ticks: bandToTicks(bandBps),
    pInRange: p ?? expectedTimeInRange,
    expectedTimeInRange,
    expectedIlBps,
    expectedFeeBps,
    netEdgeBps,
    netEdgeDailyBps: (netEdgeBps * 24) / horizonHours,
    pProfitable: profitable / paths,
    pIlExceedsFees: 1 - profitable / paths,
    var95Bps,
    cvar95Bps,
    ilP50Bps,
    ilP99Bps,
    ilWorstBps,
    requiredFeeBps,
    breakevenFeePerHourPerUsd,
    ilShocks: ilShockTable({ price: p0, bandBps, sigmaHourly }),
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
  const minEdgeBps = opts.minEdgeBps ?? 0.2;
  const minP = opts.minPInRange ?? 0.6;
  const maxPIl = opts.maxPIlExceedsFees ?? 0.35;
  const sweep = rangeSweep(poolMetrics, bands, opts);
  const viable = sweep.filter((row) => row.pInRange >= minP && row.pIlExceedsFees <= maxPIl);
  const best = (viable.length ? viable : sweep)[0] ?? null;
  if (!best) return { worthLp: false, reason: "no_sigma_or_price", best: null, sweep };
  const riskOk = best.pIlExceedsFees <= maxPIl;
  const edgeOk = best.netEdgeBps >= minEdgeBps && best.pInRange >= minP;
  const worthLp = edgeOk && riskOk;
  const suggestedMaxDeployUsdc = Math.max(0, Math.min(100_000, Math.round((best.netEdgeBps * 1000) / 100) * 100));
  return {
    worthLp,
    reason: worthLp
      ? "edge_above_threshold"
      : !riskOk
        ? "il_risk_too_high"
        : best.netEdgeBps < 0
          ? "fees_below_il"
          : "edge_below_threshold",
    best,
    risk: {
      var95Bps: best.var95Bps,
      cvar95Bps: best.cvar95Bps,
      pIlExceedsFees: best.pIlExceedsFees,
      ilWorstBps: best.ilWorstBps,
      requiredFeeBps: best.requiredFeeBps,
      expectedTimeInRange: best.expectedTimeInRange,
      ilShocks: best.ilShocks,
    },
    suggestedBucketTicks: best.ticks,
    suggestedMaxDeployUsdc,
    sweep,
  };
}

// ---------- economic audit ----------

// Pre-trade economic audit for the tranched book. The agent must run this on every tick and
// only deploy when every hard check passes; otherwise it holds or disables quoting. The audit
// decomposes yield (who pays), marks the first-loss structure, and computes the maximum size
// the junior buffer can underwrite.
//
// Yield decomposition (bps of deployed capital, annualized where noted):
//   - baseYieldBps: exogenous cash yield from the Aave rest state (someone else's borrow demand)
//   - feeYieldBps:  endogenous JIT fees - paid by swappers, depends on our own quoting
//   - incentivesBps: token incentives (always 0 here; no emissions in this design)
// Costs:
//   - expectedIlBps: concentrated-liquidity IL from the Monte-Carlo model (negative = loss)
//   - swapCostBps:  rebalancing slippage/fees paid to enter/exit inventory
//   - gasCostUsd:   fixed tx cost converted at NAV (rough)
// Hard checks:
//   1. oracle valid (no stale/closed market)
//   2. senior escrow funded (junior buffer exists before risk)
//   3. junior buffer >= minJuniorBufferBps of senior claim (first-loss skin in the game)
//   4. net edge after IL and swap costs > minNetEdgeBps
//   5. p(IL > fees) <= maxPIlExceedsFees
//   6. VaR95 no worse than -maxVar95Bps
//   7. requested deploy <= maxDeployOfJuniorBps of the junior claim
export function economicAudit({
  oracleValid = true,
  escrowFunded = false,
  seniorClaimUsd = 0,
  juniorClaimUsd = 0,
  expectedFeeBps = 0,
  expectedIlBps = 0,
  netEdgeBps = null,
  pIlExceedsFees = 0,
  var95Bps = 0,
  cvar95Bps = 0,
  swapCostBps = 0,
  deployUsd = 0,
  baseYieldBps = 0,
  feeYieldBps = null,
  minNetEdgeBps = 0.2,
  minJuniorBufferBps = 500,
  maxDeployOfJuniorBps = 5_000,
  maxVar95Bps = 500,
  maxPIlExceedsFees = 0.35,
} = {}) {
  const senior = Math.max(0, Number(seniorClaimUsd) || 0);
  const junior = Math.max(0, Number(juniorClaimUsd) || 0);
  const juniorBufferBps = senior > 0 ? (junior / senior) * 10_000 : junior > 0 ? 10_000 : 0;

  const grossEdgeBps = netEdgeBps != null ? Number(netEdgeBps) : Number(expectedFeeBps) + Number(expectedIlBps);
  const netAfterCostsBps = grossEdgeBps - (Number(swapCostBps) || 0);

  const maxDeployUsd = Math.floor((junior * maxDeployOfJuniorBps) / 10_000);
  const cappedDeployUsd = Math.max(0, Math.min(Number(deployUsd) || 0, maxDeployUsd));

  const checks = [
    { name: "oracle_valid", pass: Boolean(oracleValid), value: oracleValid, limit: true },
    { name: "senior_escrow_funded", pass: Boolean(escrowFunded), value: escrowFunded, limit: true },
    {
      name: "junior_buffer",
      pass: juniorBufferBps >= minJuniorBufferBps,
      value: Math.round(juniorBufferBps),
      limit: minJuniorBufferBps,
    },
    {
      name: "net_edge_after_costs",
      pass: netAfterCostsBps >= minNetEdgeBps,
      value: Number(netAfterCostsBps.toFixed(4)),
      limit: minNetEdgeBps,
    },
    {
      name: "il_probability",
      pass: Number(pIlExceedsFees) <= maxPIlExceedsFees,
      value: Number(pIlExceedsFees),
      limit: maxPIlExceedsFees,
    },
    { name: "var95", pass: Number(var95Bps) >= -Math.abs(maxVar95Bps), value: Number(var95Bps), limit: -Math.abs(maxVar95Bps) },
    {
      name: "deploy_within_junior",
      pass: (Number(deployUsd) || 0) <= maxDeployUsd,
      value: Number(deployUsd) || 0,
      limit: maxDeployUsd,
    },
  ];

  const structuralFail = checks[0].pass === false || checks[1].pass === false || checks[2].pass === false;
  const failed = checks.filter((c) => !c.pass);
  const verdict = structuralFail ? "disable" : failed.length ? "hold" : "deploy";
  const reason = structuralFail
    ? !oracleValid
      ? "oracle_invalid"
      : !escrowFunded
        ? "escrow_unfunded"
        : "junior_buffer_too_thin"
    : failed.length
      ? failed[0].name
      : "all_checks_passed";

  return {
    verdict,
    reason,
    checks,
    juniorBufferBps: Math.round(juniorBufferBps),
    netAfterCostsBps: Number(netAfterCostsBps.toFixed(4)),
    maxDeployUsd,
    cappedDeployUsd,
    yieldSplit: {
      baseYieldBps: Number(baseYieldBps) || 0,
      feeYieldBps: feeYieldBps == null ? Number(expectedFeeBps) || 0 : Number(feeYieldBps),
      incentivesBps: 0,
      endogenous: "jit_fees_depend_on_our_quoting",
      exogenous: "aave_borrower_demand",
    },
    risk: {
      firstLoss: "junior",
      seniorClaimUsd: senior,
      juniorClaimUsd: junior,
      var95Bps: Number(var95Bps),
      cvar95Bps: Number(cvar95Bps),
      pIlExceedsFees: Number(pIlExceedsFees),
      swapCostBps: Number(swapCostBps) || 0,
    },
    // Conditions that must invalidate the current posture; the daemon logs these and the
    // regime policy flips quoting accordingly.
    invalidationTriggers: [
      { when: "oracle.valid == false", action: "disable" },
      { when: "escrowFunded == false", action: "disable" },
      { when: `juniorBufferBps < ${minJuniorBufferBps}`, action: "disable" },
      { when: `netAfterCostsBps < ${minNetEdgeBps}`, action: "hold" },
      { when: `pIlExceedsFees > ${maxPIlExceedsFees}`, action: "hold" },
      { when: `var95Bps < ${-Math.abs(maxVar95Bps)}`, action: "hold" },
      { when: `deployUsd > ${maxDeployOfJuniorBps}bps of juniorClaim`, action: "cap_deploy" },
    ],
  };
}

// ---------- venue blending (Arc own pool + Base pools) ----------

// Blend venue fee/IL estimates in daily bps. w is the Arc weight; Base gets 1-w.
// Used to average realized fees from our Arc venue with the Base market fee run-rate.
export function blendVenueEdge({ arcFeeBpsPerDay, arcIlBpsPerDay, baseFeeBpsPerDay, baseIlBpsPerDay, arcWeight = 0.5 }) {
  const w = Math.min(Math.max(Number(arcWeight) || 0, 0), 1);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const feeBpsPerDay = w * num(arcFeeBpsPerDay) + (1 - w) * num(baseFeeBpsPerDay);
  const ilBpsPerDay = w * num(arcIlBpsPerDay) + (1 - w) * num(baseIlBpsPerDay);
  return { feeBpsPerDay, ilBpsPerDay, netEdgeBpsPerDay: feeBpsPerDay - ilBpsPerDay, arcWeight: w };
}

// ---------- dual-asset (USDC/equity) rebalancing ----------

// Portfolio USD value from unit amounts.
export function portfolioValueUsd({ usdcAmount = 0, equityAmount = 0, equityPriceUsd = 0 }) {
  return Number(usdcAmount) + Number(equityAmount) * Number(equityPriceUsd);
}

// Impermanent loss (bps) of the current book versus holding the reference units
// (units recorded at a prior composition), both marked at the current price.
export function portfolioIlBps({ usdcAmount, equityAmount, equityPriceUsd, refUsdc, refEquity }) {
  if (!(Number(equityPriceUsd) > 0)) return null;
  const benchmark = portfolioValueUsd({ usdcAmount: refUsdc, equityAmount: refEquity, equityPriceUsd });
  if (!(benchmark > 0)) return null;
  const nav = portfolioValueUsd({ usdcAmount, equityAmount, equityPriceUsd });
  return ((nav - benchmark) / benchmark) * 10_000;
}

// Continuous-time expected rebalancing premium (bps) for equity weight w:
// w*(1-w)*sigma^2*dt. Small by construction; compare against swap cost.
export function rebalancingPremiumBps({ weight, sigmaHourly, horizonHours = 1 }) {
  const w = Math.min(Math.max(Number(weight) || 0, 0), 1);
  const s = Number(sigmaHourly) || 0;
  return w * (1 - w) * s * s * Math.max(0, Number(horizonHours)) * 10_000;
}

// Swap cost in bps versus an oracle-implied output.
export function rebalanceCostBps({ oracleOut, quotedOut }) {
  const o = Number(oracleOut);
  if (!(o > 0)) return null;
  return ((o - Number(quotedOut)) / o) * 10_000;
}

// ---------- LLM strategy-manager rails ----------
// The LLM owns the slow policy: hook params (JIT range/size, dynamic fees), audit thresholds and
// rebalancing. Deterministic code only clamps and validates; it never decides direction itself.

// Hard clamps for LLM audit-threshold overrides (bounded both ways, never structural disables).
export const AUDIT_CLAMPS = {
  minNetEdgeBps: [0.2, 50],
  minJuniorBufferBps: [500, 5_000],
  maxDeployOfJuniorBps: [0, 5_000],
  maxVar95Bps: [100, 500],
  maxPIlExceedsFees: [0, 0.35],
};

// Effective audit thresholds = env defaults overridden by the LLM, clamped per field.
export function clampAuditOverrides(defaults = {}, overrides = {}) {
  const effective = {};
  for (const [key, [lo, hi]] of Object.entries(AUDIT_CLAMPS)) {
    const base = Number(defaults[key]);
    const raw = overrides?.[key] == null ? base : Number(overrides[key]);
    const value = Number.isFinite(raw) ? raw : base;
    if (!Number.isFinite(value)) continue;
    effective[key] = Math.min(hi, Math.max(lo, value));
  }
  return effective;
}

// Hard clamps for LLM param overrides. `bounds` mirrors the onchain StrategyController bounds
// (read at perceive time); each clamp is the tighter of the protocol max and the controller bound.
export const PARAM_CLAMPS = {
  baseFee: [100, 1_000_000],
  maxDeviationBps: [10, 5_000],
  toxicityMultiplierBps: [0, 10_000],
  minEvBps: [0, 1_000],
  cooldownSeconds: [0, 3_600],
  ttl: [300, 86_400],
  gracePeriod: [0, 86_400],
  maxDeployPerSwap: [0n, 100_000_000_000n],
  bucketTicks: [1, 5_000],
};

function paramCeiling(key, protocolCap, bounds) {
  const fromBounds = (() => {
    if (!bounds) return null;
    switch (key) {
      case "maxDeviationBps":
        return bounds.maxDeviationBps;
      case "toxicityMultiplierBps":
        return bounds.maxToxicityMultiplierBps;
      case "ttl":
        return bounds.maxTtl;
      case "gracePeriod":
        return bounds.maxGracePeriod;
      case "maxDeployPerSwap":
        return bounds.maxDeployPerSwap;
      default:
        return null;
    }
  })();
  if (fromBounds == null) return protocolCap;
  if (typeof protocolCap === "bigint") {
    const bound = BigInt(fromBounds);
    return bound < protocolCap ? bound : protocolCap;
  }
  return Math.min(Number(protocolCap), Number(fromBounds));
}

// Apply LLM param overrides (JIT range, dynamic fees, TTL, quoting switch) on top of the
// deterministic params, clamped to the hard rails. Unknown or malformed fields are ignored.
export function clampParamOverrides(params, overrides = {}, bounds = null) {
  const next = { ...params };
  if (!overrides || typeof overrides !== "object") return next;
  if (overrides.quotingEnabled != null) next.quotingEnabled = Boolean(overrides.quotingEnabled);
  for (const [key, [lo, hi]] of Object.entries(PARAM_CLAMPS)) {
    if (overrides[key] == null) continue;
    const raw = overrides[key];
    const isBig = typeof lo === "bigint";
    const value = isBig ? BigInt(Math.round(Number(raw))) : Number(raw);
    if (isBig ? !Number.isFinite(Number(value)) : !Number.isFinite(value)) continue;
    const hiBound = paramCeiling(key, hi, bounds);
    next[key] = value < lo ? lo : value > hiBound ? hiBound : value;
  }
  return next;
}

// LLM rebalance proposal validated against the hard rails only. The model picks
// buy/sell/hold and the size; this function enforces validity, the equity cap, size limits
// and funding. It never invents direction or size.
export function validateRebalanceProposal(
  proposal,
  {
    oracleValid = true,
    escrowFunded = false,
    equityBps = 0,
    hardCapBps = 10_000,
    navUsd = 0,
    compositionAvailable = true,
    minSwapUsd = 0,
    maxSwapUsd = Infinity,
  } = {},
) {
  if (!proposal || proposal.action === "hold") return { action: "hold", reason: "ai_hold", sizeUsd: 0 };
  const action = proposal.action;
  if (action !== "buy" && action !== "sell") return { action: "hold", reason: "unknown_action", sizeUsd: 0 };
  if (!oracleValid) return { action: "hold", reason: "oracle_invalid", sizeUsd: 0 };
  const sizeUsd = Number(proposal.sizeUsd);
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return { action: "hold", reason: "size_missing", sizeUsd: 0 };
  if (action === "buy" && !escrowFunded) return { action: "hold", reason: "escrow_unfunded", sizeUsd: 0 };
  if (action === "buy" && !compositionAvailable) {
    return { action: "hold", reason: "composition_unavailable", sizeUsd: 0 };
  }
  const minSwap = Number(minSwapUsd) || 0;
  const maxSwap = Number.isFinite(Number(maxSwapUsd)) ? Number(maxSwapUsd) : Infinity;
  let size = Math.min(sizeUsd, maxSwap);
  if (size < minSwap) return { action: "hold", reason: "below_min_size", sizeUsd: 0 };
  if (action === "buy" && Number(navUsd) > 0) {
    const capUsd = (Number(navUsd) * Number(hardCapBps)) / 10_000;
    const equityUsd = (Number(navUsd) * Number(equityBps)) / 10_000;
    const roomUsd = Math.max(0, capUsd - equityUsd);
    if (roomUsd <= 0) return { action: "hold", reason: "at_hard_cap", sizeUsd: 0 };
    size = Math.min(size, roomUsd);
    if (size < minSwap) return { action: "hold", reason: "cap_room_below_min_size", sizeUsd: 0 };
  }
  return { action, reason: "ai_proposal", sizeUsd: size };
}
