// Agent market pipeline: live Graph data -> volatility, fees, TVL, active (rewarded) TVL,
// fee-vs-IL range sweep and a deploy verdict per NVDAc pool.
//
// Usage:
//   node agent/market.mjs            # table
//   node agent/market.mjs --json     # machine readable (also cached)
//   node agent/market.mjs --json --pool uni-v3-usdc-nvdac
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { endpoint, fetchPool, fetchPoolHours, fetchPoolDays } from "./graph.mjs";
import {
  activeTvl,
  blendVenueEdge,
  decide,
  feeMetrics,
  liquidityToAmountsRaw,
  pooledVolatility,
  simulateRange,
  sqrtPriceAtTick,
  tickAtPrice,
  volatilityProfile,
} from "./model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function loadEnv(file = path.join(root, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
  }
}

loadEnv();

const args = [...process.argv.slice(2)];
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const asJson = has("--json");
const onlyPool = value("--pool", null);
const noCache = has("--no-cache");
const windowHours = Number(process.env.AGENT_MARKET_WINDOW_HOURS || "336");
const triggerHours = Number(process.env.AGENT_MARKET_TRIGGER_HOURS || "3");
const bands = (process.env.AGENT_MARKET_BANDS_BPS || "25,50,100,200,500")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => v > 0);
const horizonHours = Number(process.env.AGENT_MARKET_HORIZON_HOURS || "1");
const minEdgeBps = Number(process.env.AGENT_MIN_EDGE_BPS || "0.2");
const minPInRange = Number(process.env.AGENT_MIN_P_IN_RANGE || "0.6");
const maxPIlExceedsFees = Number(process.env.AGENT_MAX_P_IL_EXCEEDS_FEES || "0.35");
const cachePath = path.resolve(root, process.env.AGENT_MARKET_CACHE || "agent/.cache/market.json");
const cacheTtlSeconds = Number(process.env.AGENT_MARKET_CACHE_TTL || "900");

function readCache() {
  if (noCache || !fs.existsSync(cachePath)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const age = Date.now() - Date.parse(cached.generatedAt);
    if (age <= cacheTtlSeconds * 1000) return cached;
  } catch {
    /* fall through to live */
  }
  return null;
}

function writeCache(payload) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2));
}

function short(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return n.toFixed(decimals);
}

const priorityWeight = (priority) => (priority === "primary" ? 1 : 0.5);

async function loadPool(config, subgraphs) {
  const url = endpoint(subgraphs[config.subgraph]);
  const base = {
    id: config.id,
    venue: config.venue,
    quote: config.quote,
    priority: config.priority,
    status: config.status,
    schema: config.schema,
    pool: config.pool,
    feeBps: config.feeBps,
  };

  try {
    const pool = await fetchPool(url, config.pool);
    if (!pool) {
      return { ...base, available: false, reason: "pool_not_indexed" };
    }
    const [hoursDesc, daysDesc] = await Promise.all([
      fetchPoolHours(url, config.pool, Math.min(windowHours, 1000)),
      fetchPoolDays(url, config.pool, 30).catch(() => []),
    ]);
    if (!hoursDesc?.length) {
      return { ...base, available: false, reason: "no_hourly_data", poolState: pool };
    }
    const hoursAsc = [...hoursDesc].reverse();
    const tvlUsd = Number(pool.totalValueLockedUSD);
    const metrics = feeMetrics(hoursDesc, tvlUsd);
    const volatility = volatilityProfile(hoursAsc, triggerHours);
    const active = activeTvl(pool);
    const price = active?.price1Per0 ?? null;
    const dayRows = daysDesc?.length ?? 0;
    const dayFees = (daysDesc ?? []).reduce((sum, row) => sum + Number(row.feesUSD ?? 0), 0);
    const dayVolume = (daysDesc ?? []).reduce((sum, row) => sum + Number(row.volumeUSD ?? 0), 0);

    return {
      ...base,
      available: true,
      poolState: {
        feeTier: Number(pool.feeTier),
        tick: Number(pool.tick),
        tickSpacing: Number(pool.tickSpacing),
        liquidity: pool.liquidity,
        sqrtPrice: pool.sqrtPrice,
        tokens: [pool.token0, pool.token1].map((t) => ({
          id: t.id,
          symbol: t.symbol,
          decimals: Number(t.decimals),
        })),
      },
      tvlUsd,
      metrics: {
        ...metrics,
        weight: tvlUsd * metrics.volume24hUsd * priorityWeight(config.priority),
        days: dayRows,
        fees30dUsd: dayFees,
        volume30dUsd: dayVolume,
      },
      volatility,
      active,
      price,
      tick: Number(pool.tick),
      tickAt: price ? tickAtPrice(price) : null,
    };
  } catch (error) {
    return { ...base, available: false, reason: error.message?.slice(0, 120) ?? "graph_error" };
  }
}

// Our own venue pool on Arc (real USDC + NVDA): swaps we routed, fees they paid, LP value.
// Read from the Arc subgraph (manifest poolId + URL); numbers feed the LLM prompt and the
// agent's estimation of realized fee capture next to the Base pools.
async function loadOwnPool() {
  let poolId = process.env.AGENT_OWN_POOL_ID || null;
  let url = process.env.GRAPH_URL || null;
  let manifestStack = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "deployments/arc-testnet.json"), "utf8"));
    poolId = poolId || manifest.pools?.usdcNvda?.poolId || null;
    url = url || manifest.subgraph?.url || null;
    manifestStack = manifest.stack ?? null;
  } catch {
    /* manifest optional */
  }
  if (!poolId || !url) return { available: false, reason: "own pool not configured" };
  try {
    const query = `{
      pool(id: "${poolId.toLowerCase()}") { currency0 currency1 tick liquidity swapCount fee }
      poolSwaps(first: 500, orderBy: timestamp, orderDirection: asc, where: { pool: "${poolId.toLowerCase()}" }) {
        amount0 amount1 timestamp
      }
    }`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const json = await response.json();
    const pool = json.data?.pool;
    if (!pool) {
      return { available: false, reason: json.errors?.[0]?.message?.slice(0, 120) ?? "own pool not indexed" };
    }

    const usdc = (process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000").toLowerCase();
    const usdcIsToken0 = String(pool.currency0).toLowerCase() === usdc;
    const dec0 = usdcIsToken0 ? 6 : 18;
    const dec1 = usdcIsToken0 ? 18 : 6;
    const rawPrice = Math.exp(Number(pool.tick) * Math.log(1.0001));
    const humanPrice = rawPrice * 10 ** (dec0 - dec1); // token1 per token0
    const usdPerNvda = usdcIsToken0 ? 1 / humanPrice : humanPrice;

    const swaps = json.data?.poolSwaps ?? [];
    let volumeUsd = 0;
    let firstTs = 0;
    let lastTs = 0;
    for (const swap of swaps) {
      volumeUsd += (usdcIsToken0 ? Math.abs(Number(swap.amount0)) : Math.abs(Number(swap.amount1))) / 1e6;
      const ts = Number(swap.timestamp);
      if (ts > 0) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }
    }
    const feePpm = Number(pool.fee ?? 3000); // v4 fee units: 1e6 = 100%
    const feesUsd = (volumeUsd * feePpm) / 1e6;
    const elapsedDays = lastTs > firstTs ? Math.max((lastTs - firstTs) / 86_400, 1 / 24) : 0;
    const feesPerDayUsd = elapsedDays > 0 ? feesUsd / elapsedDays : 0;

    // Hook-pool JIT fees (same Arc subgraph): pair JitDeployment seeds with JitRemoval claims.
    let hookJit = null;
    try {
      const hookId = manifestStack?.hook ?? null;
      const hookPoolId = manifestStack?.poolId ?? null;
      if (hookId && hookPoolId) {
        const jitQuery = `{
          hookStates { id totalQuotes totalJitDeployments totalJitRemovals }
          jitDeployments(first: 500, orderBy: timestamp, orderDirection: asc, where: { poolId: "${hookPoolId.toLowerCase()}" }) { zeroForOne seed timestamp }
          jitRemovals(first: 500, orderBy: timestamp, orderDirection: asc, where: { poolId: "${hookPoolId.toLowerCase()}" }) { claim0 claim1 timestamp }
        }`;
        const jitRes = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: jitQuery }),
        });
        const jitJson = await jitRes.json();
        const state = (jitJson.data?.hookStates ?? []).find((h) => h.id.toLowerCase() === hookId.toLowerCase());
        const deployments = jitJson.data?.jitDeployments ?? [];
        const removals = jitJson.data?.jitRemovals ?? [];
        const usdcValue = (amount) => Number(amount) / 1e6;
        const nvdaValue = (amount) => (Number(amount) / 1e18) * usdPerNvda;
        const value0 = (amount) => (usdcIsToken0 ? usdcValue(amount) : nvdaValue(amount));
        const value1 = (amount) => (usdcIsToken0 ? nvdaValue(amount) : usdcValue(amount));
        let netUsd = 0;
        let jitFirst = 0;
        let jitLast = 0;
        removals.forEach((removal, index) => {
          const deployment = deployments[index];
          const seedValue = deployment ? (deployment.zeroForOne ? value1(deployment.seed) : value0(deployment.seed)) : 0;
          netUsd += value0(removal.claim0) + value1(removal.claim1) - seedValue;
          const ts = Number(removal.timestamp);
          if (ts > 0) {
            if (!jitFirst || ts < jitFirst) jitFirst = ts;
            if (ts > jitLast) jitLast = ts;
          }
        });
        const spanDays = jitLast > jitFirst ? Math.max((jitLast - jitFirst) / 86_400, 1 / 24) : 0;
        hookJit = {
          poolId: hookPoolId,
          quotes: Number(state?.totalQuotes ?? 0),
          jitEpisodes: Number(state?.totalJitRemovals ?? removals.length),
          jitNetUsd: netUsd,
          jitPerDayUsd: spanDays > 0 ? netUsd / spanDays : 0,
          spanHours: Number((spanDays * 24).toFixed(2)),
        };
      }
    } catch {
      hookJit = null;
    }

    // Approximate LP value from liquidity over a band around the current tick.
    const bandTicks = Number(process.env.AGENT_OWN_POOL_BAND_TICKS || "6000");
    const sqrtP = sqrtPriceAtTick(Number(pool.tick));
    const amounts =
      liquidityToAmountsRaw(
        Number(pool.liquidity),
        sqrtP,
        sqrtPriceAtTick(Number(pool.tick) - bandTicks / 2),
        sqrtPriceAtTick(Number(pool.tick) + bandTicks / 2),
      ) ?? { amount0: 0, amount1: 0 };
    const usdcAmount = usdcIsToken0 ? amounts.amount0 / 1e6 : amounts.amount1 / 1e6;
    const nvdaAmount = usdcIsToken0 ? amounts.amount1 / 1e18 : amounts.amount0 / 1e18;
    const lpValueUsd = usdcAmount + nvdaAmount * usdPerNvda;
    const feeApr = lpValueUsd > 0 && feesPerDayUsd > 0 ? (feesPerDayUsd * 365) / lpValueUsd : 0;

    return {
      available: true,
      poolId,
      venue: "arc-usdc-nvda-venue",
      tick: Number(pool.tick),
      usdPerNvda: Number(usdPerNvda.toFixed(2)),
      liquidity: String(pool.liquidity),
      swapCount: Number(pool.swapCount),
      swapsIndexed: swaps.length,
      volumeUsd,
      feesUsd,
      feesPerDayUsd,
      lpValueUsd,
      feeApr,
      spanHours: Number((elapsedDays * 24).toFixed(2)),
      hook: hookJit,
    };
  } catch (error) {
    return { available: false, reason: error.message?.slice(0, 120) ?? "own pool error" };
  }
}

function printTable(pools, decisionSummary) {
  const header = [
    "pool".padEnd(20),
    "quote".padEnd(6),
    "tvl$".padStart(9),
    "vol24h$".padStart(9),
    "feeAPR%".padStart(8),
    "effPeerBps".padStart(10),
    "activeTVL$".padStart(10),
    "act%".padStart(6),
    "σ3h(bps)".padStart(9),
    "σ14d(bps)".padStart(10),
    "bandBps".padStart(8),
    "pInR".padStart(6),
    "E[IL]bps".padStart(9),
    "E[fee]bps".padStart(9),
    "edgeBps".padStart(8),
    "pLoss".padStart(6),
    "VaR95".padStart(8),
    "verdict".padStart(10),
    "maxDeploy$".padStart(10),
  ].join(" ");
  console.log(header);
  for (const p of pools) {
    if (!p.available) {
      console.log(`${p.id.padEnd(20)} ${p.quote.padEnd(6)} unavailable: ${p.reason}`);
      continue;
    }
    const best = p.decision?.best ?? {};
    console.log(
      [
        p.id.padEnd(20),
        p.quote.padEnd(6),
        short(p.tvlUsd).padStart(9),
        short(p.metrics.volume24hUsd).padStart(9),
        (p.metrics.feeApr ? (p.metrics.feeApr * 100).toFixed(2) : "-").padStart(8),
        (p.metrics.effectiveFeeBps?.toFixed(1) ?? "-").padStart(10),
        short(p.active?.activeTvlUsd).padStart(10),
        (p.active?.activeShare != null ? (p.active.activeShare * 100).toFixed(0) : "-").padStart(6),
        ((p.volatility.h3 ?? 0) * 10_000).toFixed(1).padStart(9),
        ((p.volatility.h14d ?? 0) * 10_000).toFixed(1).padStart(10),
        String(best.bandBps ?? "-").padStart(8),
        (best.pInRange?.toFixed(2) ?? "-").padStart(6),
        (best.expectedIlBps?.toFixed(1) ?? "-").padStart(9),
        (best.expectedFeeBps?.toFixed(1) ?? "-").padStart(9),
        (best.netEdgeBps?.toFixed(1) ?? "-").padStart(8),
        (best.pIlExceedsFees != null ? best.pIlExceedsFees.toFixed(2) : "-").padStart(6),
        (best.var95Bps?.toFixed(1) ?? "-").padStart(8),
        (p.decision?.worthLp ? "LP" : "no-LP").padStart(10),
        String(p.decision?.suggestedMaxDeployUsdc ?? 0).padStart(10),
      ].join(" "),
    );
  }
  console.log("");
  console.log(
    `aggregate: sigma14d=${decisionSummary.sigma14d ? (decisionSummary.sigma14d * 10_000).toFixed(1) : "-"} bps/h` +
      ` | referenceFeeBps=${decisionSummary.referenceFeeBps?.toFixed(2) ?? "-"}` +
      ` | bestBand=${decisionSummary.bestBandBps ?? "-"} bps` +
      ` | worthLP=${decisionSummary.worthLp}` +
      ` | maxDeploy=${decisionSummary.suggestedMaxDeployUsdc}`,
  );
}

async function main() {
  const cached = readCache();
  if (cached) {
    if (asJson) console.log(JSON.stringify(cached, null, 2));
    else printTable(cached.pools, cached.aggregate);
    return;
  }

  const configPath = path.resolve(root, process.env.AGENT_MARKET_POOLS || "agent/pools.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const selected = config.pools.filter((p) => !onlyPool || p.id === onlyPool);

  const pools = [];
  for (const poolConfig of selected) {
    pools.push(await loadPool(poolConfig, config.subgraphs));
  }

  const live = pools.filter((p) => p.available);
  const sigma14d = pooledVolatility(
    live.map((p) => ({ volatility: p.volatility, metrics: p.metrics })),
  );

  for (const p of live) {
    p.decision = decide(p, bands, {
      horizonHours,
      minEdgeBps,
      minPInRange,
      maxPIlExceedsFees,
      seed: 42 + p.id.length,
    });
  }

  const primary = live.filter((p) => p.priority === "primary");
  const primaryLive = primary.length ? primary : live;
  const feeRates = primaryLive
    .map((p) => p.metrics.effectiveFeeBps)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const referenceFeeBps = feeRates.length ? feeRates[Math.floor(feeRates.length / 2)] : null;
  const exec = primaryLive.filter((p) => p.decision?.worthLp).sort((a, b) => (b.decision?.best?.netEdgeBps ?? -1e9) - (a.decision?.best?.netEdgeBps ?? -1e9))[0]
    ?? primaryLive.sort((a, b) => (b.decision?.best?.netEdgeBps ?? -1e9) - (a.decision?.best?.netEdgeBps ?? -1e9))[0];

  const aggregate = {
    generatedAt: new Date().toISOString(),
    network: config.network,
    poolsTotal: selected.length,
    poolsLive: live.length,
    poolsTracked: selected.length - live.length,
    sigma14d,
    sigma14dAnnualized: sigma14d ? sigma14d * Math.sqrt(24 * 365) : null,
    referenceFeeBps,
    bestBandBps: exec?.decision?.best?.bandBps ?? null,
    worthLp: Boolean(exec?.decision?.worthLp),
    reason: exec?.decision?.reason ?? "no_live_pools",
    suggestedMaxDeployUsdc: exec?.decision?.suggestedMaxDeployUsdc ?? 0,
    suggestedBucketTicks: exec?.decision?.suggestedBucketTicks ?? null,
    executedPool: exec?.id ?? null,
  };

  const ownPool = await loadOwnPool();

  // Effective venue economics: blend Arc realized fees with the Base fee run-rate (default 50/50).
  // IL for both sides uses the Base sigma (same underlying); the 6h rule flags thin Arc data.
  const blendWeight = Number(process.env.AGENT_POOL_BLEND_ARC_WEIGHT || "0.5");
  const arcBandTicks = Number(process.env.AGENT_OWN_POOL_BAND_TICKS || "6000");
  const bandBpsFromTicks = (ticks) => (Math.pow(1.0001, Math.abs(ticks) / 2) - 1) * 10_000;
  const sigma = aggregate.sigma14d;
  const baseBandBps = exec?.decision?.best?.bandBps ?? 500;
  const arcBandBps = bandBpsFromTicks(arcBandTicks);
  const ilDailyBps = (bandBps) => {
    if (!sigma) return 0;
    const sim = simulateRange({
      price: 100,
      bandBps,
      sigmaHourly: sigma,
      horizonHours: 24,
      paths: 2_000,
      seed: 7,
      feePerHourPerUsd: 0,
      notionalUsd: 1_000,
    });
    return Math.abs(sim.expectedIlBps);
  };
  const arcFeeDailyBps = ownPool?.available && ownPool.lpValueUsd > 0 ? (ownPool.feesPerDayUsd / ownPool.lpValueUsd) * 10_000 : 0;
  const baseFeeDailyBps = exec?.metrics?.feeApr ? (exec.metrics.feeApr * 10_000) / 365 : 0;
  const minSpanHours = Number(process.env.AGENT_OWN_POOL_MIN_SPAN_HOURS || "6");
  const lowConfidence = ownPool?.available ? Number(ownPool.spanHours) < minSpanHours : false;
  // The 6h rule: while the Arc window is thin the Base side carries the blend; after that
  // Arc enters at the configured weight (default 50/50).
  const effectiveArcWeight = lowConfidence ? 0 : blendWeight;
  const blended = blendVenueEdge({
    arcFeeBpsPerDay: arcFeeDailyBps,
    arcIlBpsPerDay: ilDailyBps(arcBandBps),
    baseFeeBpsPerDay: baseFeeDailyBps,
    baseIlBpsPerDay: ilDailyBps(baseBandBps),
    arcWeight: effectiveArcWeight,
  });
  aggregate.effective = {
    source: ownPool?.available ? "blend" : "base",
    blendWeight: blended.arcWeight,
    configuredBlendWeight: blendWeight,
    minSpanHours,
    feeBpsPerDay: blended.feeBpsPerDay,
    ilBpsPerDay: blended.ilBpsPerDay,
    netEdgeBpsPerDay: blended.netEdgeBpsPerDay,
    netEdgeBpsPerHour: blended.netEdgeBpsPerDay / 24,
    worthLp: blended.netEdgeBpsPerDay / 24 >= minEdgeBps,
    bandBps: baseBandBps,
    bucketTicks: exec?.decision?.suggestedBucketTicks ?? null,
    suggestedMaxDeployUsdc: exec?.decision?.suggestedMaxDeployUsdc ?? 0,
    sigmaHourly: sigma,
    lowConfidence,
    arc: {
      feeBpsPerDay: arcFeeDailyBps,
      ilBpsPerDay: ilDailyBps(arcBandBps),
      feesPerDayUsd: ownPool?.feesPerDayUsd ?? 0,
      feeApr: ownPool?.feeApr ?? 0,
      swapCount: ownPool?.swapCount ?? 0,
      spanHours: ownPool?.spanHours ?? 0,
      bandTicks: arcBandTicks,
      hookJitNetUsd: ownPool?.hook?.jitNetUsd ?? 0,
      hookJitPerDayUsd: ownPool?.hook?.jitPerDayUsd ?? 0,
      hookJitEpisodes: ownPool?.hook?.jitEpisodes ?? 0,
    },
    base: {
      feeBpsPerDay: baseFeeDailyBps,
      ilBpsPerDay: ilDailyBps(baseBandBps),
      pool: exec?.id ?? null,
      feeApr: exec?.metrics?.feeApr ?? 0,
    },
  };

  const output = { generatedAt: aggregate.generatedAt, aggregate, ownPool, pools };
  writeCache(output);

  if (asJson) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printTable(pools, aggregate);
    if (ownPool?.available) {
      console.log(
        `own venue (Arc USDC/NVDA): swaps=${ownPool.swapCount} vol=$${short(ownPool.volumeUsd)} fees=$${ownPool.feesUsd.toFixed(2)} ` +
          `feeAPR=${(ownPool.feeApr * 100).toFixed(1)}% lpValue=$${short(ownPool.lpValueUsd)} span=${ownPool.spanHours}h`,
      );
    } else {
      console.log(`own venue: unavailable (${ownPool?.reason ?? "n/a"})`);
    }
    const eff = aggregate.effective;
    if (eff) {
      console.log(
        `effective: source=${eff.source} w(arc)=${eff.blendWeight} fee=${eff.feeBpsPerDay.toFixed(2)} bps/day ` +
          `il=${eff.ilBpsPerDay.toFixed(2)} net=${eff.netEdgeBpsPerDay.toFixed(2)} bps/day worthLP=${eff.worthLp}` +
          `${eff.lowConfidence ? " (low-confidence: arc span < 6h)" : ""}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(`[market] failed: ${error.message}`);
  process.exitCode = 1;
});
