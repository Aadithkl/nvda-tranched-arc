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
  decide,
  feeMetrics,
  pooledVolatility,
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
const minEdgeBps = Number(process.env.AGENT_MIN_EDGE_BPS || "5");
const minPInRange = Number(process.env.AGENT_MIN_P_IN_RANGE || "0.6");
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

  const output = { generatedAt: aggregate.generatedAt, aggregate, pools };
  writeCache(output);

  if (asJson) console.log(JSON.stringify(output, null, 2));
  else printTable(pools, aggregate);
}

main().catch((error) => {
  console.error(`[market] failed: ${error.message}`);
  process.exitCode = 1;
});
