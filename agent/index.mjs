import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compactMarket } from "./ai-prompt.mjs";
import { refreshOraclePrice } from "./price.mjs";
import {
  clampAuditOverrides,
  clampParamOverrides,
  economicAudit,
  rebalancingPremiumBps,
  validateRebalanceProposal,
} from "./model.mjs";

function loadEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
  }
}

loadEnv();

const args = new Set(process.argv.slice(2));
const has = (flag) => args.has(flag);
const value = (flag, fallback) => {
  const list = [...args];
  const i = list.indexOf(flag);
  return i >= 0 && list[i + 1] !== undefined ? list[i + 1] : fallback;
};

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

const abi = parseAbi([
  "function params() view returns ((bool quotingEnabled, uint24 baseFee, uint16 maxDeviationBps, uint16 toxicityMultiplierBps, uint16 minEvBps, uint32 cooldownSeconds, uint32 ttl, uint32 gracePeriod, uint128 maxDeployPerSwap, int24 bucketTicks))",
  "function quoteState() view returns (uint8)",
  "function expired() view returns (bool)",
  "function previewQuote(bool zeroForOne) view returns (uint24 fee, bool toxic, uint16 deviationBps, uint8 state)",
  "function effectiveMaxDeploy() view returns (uint256)",
  "function accountant() view returns (address)",
  "function owner() view returns (address)",
  "function assetComposition() view returns (uint256 usdcValue, uint256 equityValue, uint256 equityBps)",
  "function hardMaxEquityBps() view returns (uint16)",
  "function usdcDecimals() view returns (uint8)",
  "function equityDecimals() view returns (uint8)",
  "function activePool() view returns ((address,address,uint24,int24,address))",
]);

const oracleAbi = parseAbi([
  "function getPrice() view returns ((int192 mid, int192 bid, int192 ask, uint32 marketStatus, uint8 session, uint32 sourceTimestamp, uint256 updatedAt, bytes32 paymentRef, bool valid))",
]);

const agentAbi = parseAbi([
  "function operator() view returns (address)",
  "function controller() view returns (address)",
  "function submitParams((bool quotingEnabled, uint24 baseFee, uint16 maxDeviationBps, uint16 toxicityMultiplierBps, uint16 minEvBps, uint32 cooldownSeconds, uint32 ttl, uint32 gracePeriod, uint128 maxDeployPerSwap, int24 bucketTicks) params)",
  "function submitBaseFee(uint24 baseFee)",
  "function submitQuotingEnabled(bool enabled)",
  "function submitRebalance(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline)",
]);

const controllerAbi = parseAbi([
  "function bounds() view returns ((uint16 maxDeviationBps, uint16 maxToxicityMultiplierBps, uint32 maxTtl, uint32 maxGracePeriod, uint128 maxDeployPerSwap, uint128 maxRebalanceSwapUsdc, uint32 rebalanceCooldown))",
]);

const accountantAbi = parseAbi([
  "function juniorClaim() view returns (uint256)",
  "function seniorClaim() view returns (uint256)",
  "function escrowFunded() view returns (bool)",
  "function rebalance() returns (uint256, uint256)",
  "function fulfillRedeem(bool senior, address user)",
]);

const config = {
  hook: process.env.AGENT_HOOK || process.env.HOOK_DEMO_HOOK,
  module: process.env.AGENT_MODULE || process.env.AGENT_HOOK || process.env.HOOK_DEMO_HOOK,
  oracle: process.env.AGENT_ORACLE || process.env.HOOK_DEMO_ORACLE,
  agent: process.env.AGENT_ADDRESS || process.env.HOOK_DEMO_AGENT,
  keeper: process.env.AGENT_KEEPER, // accountant address for redeem fulfillment
};

const submit = has("--submit");
const once = has("--once") || !has("--loop");
const intervalSeconds = Number(value("--interval", process.env.AGENT_CADENCE_SECONDS || "600"));
const ttlTarget = Number(process.env.PARAMS_TTL_SECONDS || "3600");
const marketCachePath = process.env.AGENT_MARKET_CACHE || "agent/.cache/market.json";
const marketTtlSeconds = Number(process.env.AGENT_MARKET_CACHE_TTL || "900");
const reasoningCachePath = "agent/.cache/reasoning.json";
const policyCachePath = process.env.AGENT_POLICY_CACHE || "agent/.cache/policy.json";
// LLM manager cadence: the paid verdict is refreshed every AGENT_LLM_REFRESH_SECONDS (6h default)
// by agent/refresh.mjs / the heartbeat workflow. Audit overrides stay usable for twice that;
// rebalance calls must be at most one interval old.
const llmRefreshSeconds = Number(process.env.AGENT_LLM_REFRESH_SECONDS || "21600");
const reasoningMaxAgeSeconds = Number(
  process.env.AGENT_REASONING_MAX_AGE_SECONDS || String(llmRefreshSeconds * 2),
);
const rebalanceMaxAgeSeconds = Number(process.env.AGENT_REBALANCE_MAX_AGE_SECONDS || String(llmRefreshSeconds));
const rebalanceEnabled = process.env.AGENT_REBALANCE_ENABLED !== "0";
const rebalanceMinUsd = Number(process.env.AGENT_REBALANCE_MIN_USD || "1");
const rebalanceMaxUsd = Number(
  process.env.AGENT_REBALANCE_MAX_USD || process.env.AGENT_REBALANCE_MAX_USDC || "500",
);
const rebalanceSlippageBps = Number(process.env.AGENT_REBALANCE_SLIPPAGE_BPS || "50");
const rebalanceDeadlineSeconds = Number(process.env.AGENT_REBALANCE_DEADLINE_SECONDS || "300");
// The agent owns the oracle price rail: on load (and each tick) it pushes a fresh quote when
// the onchain price is stale. Only the authorized writer (the agent wallet) can publish.
const pricePushEnabled = process.env.AGENT_PRICE_PUSH !== "0";
// Economic audit thresholds: env defaults, overridable by the fresh paid LLM within hard clamps
// (see clampAuditOverrides in model.mjs and AGENT_MARKET.md).
const auditMinNetEdgeBps = Number(process.env.AGENT_AUDIT_MIN_NET_EDGE_BPS || "0.2");
const auditMinJuniorBufferBps = Number(process.env.AGENT_AUDIT_MIN_BUFFER_BPS || "500");
const auditMaxDeployOfJuniorBps = Number(process.env.AGENT_AUDIT_MAX_DEPLOY_OF_JUNIOR_BPS || "5000");
const auditMaxVar95Bps = Number(process.env.AGENT_AUDIT_MAX_VAR95_BPS || "500");
const auditMaxPIlExceedsFees = Number(process.env.AGENT_AUDIT_MAX_PIL_EXCEEDS_FEES || "0.35");

function loadMarket() {
  try {
    const cached = JSON.parse(fs.readFileSync(marketCachePath, "utf8"));
    const ageMs = Date.now() - Date.parse(cached.generatedAt);
    if (!Number.isFinite(ageMs)) return null;
    return { ...cached, ageSeconds: Math.round(ageMs / 1000), stale: ageMs > marketTtlSeconds * 1000 * 4 };
  } catch {
    return null;
  }
}

// Circle Agent Marketplace verdict (BlockRun.AI paid via Gateway). Only trusted when the
// snapshot hash matches the market cache the agent is acting on.
function loadReasoning(market) {
  try {
    const raw = JSON.parse(fs.readFileSync(reasoningCachePath, "utf8"));
    const ageMs = Date.now() - Date.parse(raw.generatedAt);
    if (!Number.isFinite(ageMs) || ageMs > reasoningMaxAgeSeconds * 1000) return null;
    let staleHash = false;
    if (raw.snapshotHash && market) {
      const hash = `0x${crypto.createHash("sha256").update(JSON.stringify(compactMarket(market))).digest("hex")}`;
      staleHash = raw.snapshotHash !== hash;
    }
    return {
      ...raw,
      staleHash,
      ageSeconds: Math.round(ageMs / 1000),
      rebalanceFresh: ageMs <= rebalanceMaxAgeSeconds * 1000,
    };
  } catch {
    return null;
  }
}

// The LLM only influences policy while its verdict is fresh and bound to the market snapshot.
function effectiveAi(state) {
  const r = state.reasoning;
  if (!r || r.staleHash) return null;
  return r.reasoning ?? null;
}

const rpc = process.env.ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0];
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) });

function wallet() {
  const pk = process.env.AGENT_OPERATOR_PRIVATE_KEY;
  if (!pk) throw new Error("AGENT_OPERATOR_PRIVATE_KEY not set (operator key, never the deployer key)");
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  return { account, client: createWalletClient({ account, chain: arcTestnet, transport: http(rpc) }) };
}

const REGIMES = {
  calm: {
    quotingEnabled: true,
    baseFee: 3000,
    maxDeviationBps: 300,
    toxicityMultiplierBps: 1000,
    minEvBps: 0,
    cooldownSeconds: 0,
    ttl: 3600,
    gracePeriod: 3600,
    maxDeployPerSwap: 1_000_000n,
    bucketTicks: 1,
  },
  elevated: {
    quotingEnabled: true,
    baseFee: 5000,
    maxDeviationBps: 250,
    toxicityMultiplierBps: 1500,
    minEvBps: 0,
    cooldownSeconds: 15,
    ttl: 1800,
    gracePeriod: 1800,
    maxDeployPerSwap: 500_000n,
    bucketTicks: 1,
  },
  turbulent: {
    quotingEnabled: true,
    baseFee: 8000,
    maxDeviationBps: 150,
    toxicityMultiplierBps: 2500,
    minEvBps: 0,
    cooldownSeconds: 60,
    ttl: 900,
    gracePeriod: 900,
    maxDeployPerSwap: 100_000n,
    bucketTicks: 1,
  },
};

function marketCacheAgeSeconds() {
  try {
    const cached = JSON.parse(fs.readFileSync(marketCachePath, "utf8"));
    const age = (Date.now() - Date.parse(cached.generatedAt)) / 1000;
    return Number.isFinite(age) ? Math.round(age) : null;
  } catch {
    return null;
  }
}

// Pull a fresh Graph snapshot (fees / TVL / volume / IL sweep) by running agent/market.mjs.
// Ticks use the cache inside its TTL; the UI button passes ?refresh=1 to force a pull.
async function maybeRefreshMarket(force) {
  if (process.env.AGENT_MARKET_REFRESH === "0") return { ok: false, skipped: "market refresh disabled" };
  const age = marketCacheAgeSeconds();
  const ttl = Number(process.env.AGENT_MARKET_CACHE_TTL || "900");
  if (!force && age !== null && age < ttl) {
    return { ok: false, skipped: `cache ${age}s old < ttl ${ttl}s`, ageSeconds: age };
  }
  const { spawnSync } = await import("node:child_process");
  const started = Date.now();
  const spawnArgs = ["agent/market.mjs", "--json"];
  if (force) spawnArgs.push("--no-cache");
  const run = spawnSync(process.execPath, spawnArgs, {
    encoding: "utf8",
    timeout: 180_000,
    cwd: process.cwd(),
  });
  const elapsedMs = Date.now() - started;
  if (run.status !== 0) {
    console.warn(`[agent] market refresh failed: ${(run.stderr || run.stdout || "").slice(0, 200)}`);
    return { ok: false, elapsedMs, error: "market.mjs failed" };
  }
  console.log(`[agent] market snapshot refreshed in ${elapsedMs}ms`);
  return { ok: true, elapsedMs, ageSeconds: marketCacheAgeSeconds() };
}

// Refresh the paid LLM manager verdict through agent/refresh.mjs when it is older than
// AGENT_LLM_REFRESH_SECONDS (or forced). Market snapshot must be fresh before the prompt is built.
async function maybeRefreshReasoning(force) {
  if (process.env.AGENT_LLM_REFRESH === "0") return { ok: false, skipped: "llm refresh disabled" };
  const reasoningPath = process.env.AGENT_REASONING_CACHE || "agent/.cache/reasoning.json";
  const threshold = Number(process.env.AGENT_LLM_REFRESH_SECONDS || "21600");
  const ageSeconds = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(reasoningPath, "utf8"));
      const age = (Date.now() - Date.parse(raw.generatedAt)) / 1000;
      return Number.isFinite(age) ? Math.round(age) : null;
    } catch {
      return null;
    }
  };
  const before = ageSeconds();
  if (!force && before !== null && before <= threshold) {
    return { ok: false, skipped: `verdict ${before}s old <= ${threshold}s`, ageSeconds: before };
  }
  const { spawnSync } = await import("node:child_process");
  const started = Date.now();
  const spawnArgs = ["agent/refresh.mjs", "--no-market"];
  if (force) spawnArgs.push("--force");
  const run = spawnSync(process.execPath, spawnArgs, { encoding: "utf8", timeout: 300_000, cwd: process.cwd() });
  const elapsedMs = Date.now() - started;
  if (run.status !== 0) {
    console.warn(`[agent] reasoning refresh failed: ${(run.stderr || run.stdout || "").slice(0, 300)}`);
    return { ok: false, elapsedMs, error: "refresh.mjs failed", ageSeconds: ageSeconds() };
  }
  const after = ageSeconds();
  if (after !== null && (before === null || after < before)) {
    console.log(`[agent] LLM verdict refreshed in ${elapsedMs}ms (age ${after}s)`);
    return { ok: true, elapsedMs, ageSeconds: after };
  }
  return { ok: false, elapsedMs, skipped: "no payer key or LLM call skipped", ageSeconds: after };
}

async function perceive() {
  const [oracle, params, state, maxDeploy, accountant, expired, poolKey] = await Promise.all([
    publicClient.readContract({ address: config.oracle, abi: oracleAbi, functionName: "getPrice" }),
    publicClient.readContract({ address: config.hook, abi, functionName: "params" }),
    publicClient.readContract({ address: config.hook, abi, functionName: "quoteState" }),
    publicClient.readContract({ address: config.hook, abi, functionName: "effectiveMaxDeploy" }),
    publicClient.readContract({ address: config.hook, abi, functionName: "accountant" }),
    publicClient.readContract({ address: config.hook, abi, functionName: "expired" }).catch(() => false),
    publicClient.readContract({ address: config.hook, abi, functionName: "activePool" }).catch(() => null),
  ]);
  // The hook requires bucketTicks to be a multiple of the pool's tickSpacing.
  const tickSpacing = poolKey ? Number(poolKey[3]) || 1 : 1;

  let deviationBps = 0n;
  try {
    const [fee, toxic, dev] = await publicClient.readContract({
      address: config.hook,
      abi,
      functionName: "previewQuote",
      args: [true],
    });
    fee;
    toxic;
    deviationBps = BigInt(dev);
  } catch {
    deviationBps = 0n;
  }

  let risk = { seniorClaim: 0n, juniorClaim: 0n, escrowFunded: false };
  if (accountant !== "0x0000000000000000000000000000000000000000") {
    const [seniorClaim, juniorClaim, escrowFunded] = await Promise.all([
      publicClient.readContract({ address: accountant, abi: accountantAbi, functionName: "seniorClaim" }),
      publicClient.readContract({ address: accountant, abi: accountantAbi, functionName: "juniorClaim" }),
      publicClient.readContract({ address: accountant, abi: accountantAbi, functionName: "escrowFunded" }),
    ]);
    risk = { seniorClaim, juniorClaim, escrowFunded };
  }

  let composition = null;
  let decimals = { usdc: 6, equity: 18 };
  if (rebalanceEnabled) {
    try {
      const [comp, cap, usdcDec, equityDec] = await Promise.all([
        publicClient.readContract({ address: config.module, abi, functionName: "assetComposition" }),
        publicClient.readContract({ address: config.module, abi, functionName: "hardMaxEquityBps" }),
        publicClient.readContract({ address: config.hook, abi, functionName: "usdcDecimals" }),
        publicClient.readContract({ address: config.hook, abi, functionName: "equityDecimals" }),
      ]);
      decimals = { usdc: Number(usdcDec), equity: Number(equityDec) };
      composition = {
        usdcValue: comp[0],
        equityValue: comp[1],
        equityBps: Number(comp[2]),
        hardCapBps: Number(cap),
        navUsd: (Number(comp[0]) + Number(comp[1])) / 10 ** decimals.usdc,
      };
    } catch (error) {
      composition = { error: error.shortMessage || error.message };
    }
  }

  let bounds = null;
  let legacyStack = false;
  try {
    const controller = await publicClient.readContract({
      address: config.agent,
      abi: agentAbi,
      functionName: "controller",
    });
    if (controller !== "0x0000000000000000000000000000000000000000") {
      const raw = await publicClient.readContract({
        address: controller,
        abi: controllerAbi,
        functionName: "bounds",
      });
      // The pre-fee-removal controller decodes into the first fee fields; ignore it until the
      // strategy controller is redeployed with the current (fee-free) bounds layout.
      legacyStack = Number(raw.maxDeviationBps) > 5_000;
      bounds = legacyStack ? null : raw;
    }
  } catch {
    bounds = null;
  }

  const market = loadMarket();

  return {
    oracleMid: Number(oracle.mid) / 1e8,
    oracleValid: oracle.valid,
    expired: Boolean(expired),
    marketStatus: Number(oracle.marketStatus),
    deviationBps: Number(deviationBps),
    quoteState: Number(state),
    params,
    maxDeploy,
    accountant,
    tickSpacing,
    risk,
    composition,
    decimals,
    bounds,
    legacyStack,
    market,
    reasoning: loadReasoning(market),
  };
}

function marketOverlay(decision, market) {
  const aggregate = market?.aggregate;
  if (!aggregate) return decision;
  const effective = aggregate.effective;
  const worthLp = effective ? Boolean(effective.worthLp) : Boolean(aggregate.worthLp);
  const suffix = `${worthLp ? "lp-on" : "lp-off"}${effective ? `@${effective.source}` : ""}`;
  const params = { ...decision.params };
  if (!worthLp) {
    params.quotingEnabled = false;
  } else {
    const bucketTicks = Math.max(
      1,
      Math.min(5_000, Number(effective?.bucketTicks ?? aggregate.suggestedBucketTicks) || params.bucketTicks),
    );
    const deployUsdc = Math.max(
      0,
      Math.min(100_000, Number(effective?.suggestedMaxDeployUsdc ?? aggregate.suggestedMaxDeployUsdc) || 0),
    );
    params.bucketTicks = bucketTicks;
    params.maxDeployPerSwap = BigInt(Math.round(deployUsdc)) * 1_000_000n;
    params.quotingEnabled = true;
  }
  return { regime: `${decision.regime}+${suffix}`, params };
}

// The paid LLM owns the slow policy: full param overrides (dynamic fees, deviation band, TTL,
// JIT range/size, quoting switch) plus legacy schema-v1 fields, all clamped to the controller
// bounds and only trusted while the snapshot hash matches.
function aiOverlay(decision, state) {
  const ai = effectiveAi(state);
  if (!ai || !ai.decision) return decision;
  const overrides = { ...(ai.paramOverrides ?? {}) };

  const legacyBucket = Number(ai.recommendedBucketTicks);
  if (overrides.bucketTicks == null && Number.isFinite(legacyBucket) && legacyBucket >= 1) {
    overrides.bucketTicks = Math.round(legacyBucket);
  }
  const legacyUsdc = Number(ai.recommendedMaxDeployUsdc);
  if (overrides.maxDeployPerSwap == null && Number.isFinite(legacyUsdc) && legacyUsdc >= 0) {
    const deterministicUsdc = Number(decision.params.maxDeployPerSwap) / 1_000_000;
    let target = Math.min(100_000, legacyUsdc);
    if (ai.decision === "reduce") target = Math.min(target, deterministicUsdc);
    if (ai.decision === "hold") target = deterministicUsdc;
    overrides.maxDeployPerSwap = Math.round(target * 1_000_000);
  }

  const params = clampParamOverrides(decision.params, overrides, state.bounds);
  if (ai.decision === "disable") params.quotingEnabled = false;
  return { regime: `${decision.regime}+ai-${ai.decision}`, params };
}

function reason(state) {
  if (!state.oracleValid || state.marketStatus === 0 || state.marketStatus === 5) {
    return { regime: "closed", params: { ...REGIMES.turbulent, quotingEnabled: false } };
  }
  if (!state.risk.escrowFunded) {
    return { regime: "unfunded", params: { ...REGIMES.turbulent, quotingEnabled: false } };
  }
  let decision;
  if (state.deviationBps <= 50) decision = { regime: "calm", params: REGIMES.calm };
  else if (state.deviationBps <= 150) decision = { regime: "elevated", params: REGIMES.elevated };
  else decision = { regime: "turbulent", params: REGIMES.turbulent };
  if (state.market?.stale) {
    console.warn(
      `[agent] market cache is stale (${state.market.ageSeconds}s) - using it with low confidence`,
    );
  }
  return aiOverlay(marketOverlay(decision, state.market), state);
}

function sameParams(a, b) {
  if (!a) return false;
  return (
    Boolean(a.quotingEnabled) === Boolean(b.quotingEnabled) &&
    Number(a.baseFee) === b.baseFee &&
    Number(a.maxDeviationBps) === b.maxDeviationBps &&
    Number(a.toxicityMultiplierBps) === b.toxicityMultiplierBps &&
    Number(a.minEvBps) === b.minEvBps &&
    Number(a.cooldownSeconds) === b.cooldownSeconds &&
    Number(a.ttl) === b.ttl &&
    Number(a.gracePeriod) === b.gracePeriod &&
    BigInt(a.maxDeployPerSwap) === b.maxDeployPerSwap &&
    Number(a.bucketTicks) === b.bucketTicks
  );
}

function marketEdge(state) {
  const market = state.market;
  const aggregate = market?.aggregate;
  if (!aggregate) {
    return {
      worthLp: false,
      edgeBps: 0,
      ilBps: null,
      sigmaHourly: null,
      suggestedDeployUsd: 0,
      pIlExceedsFees: 0,
      var95Bps: 0,
      cvar95Bps: 0,
    };
  }
  const pools = market.pools ?? [];
  const exec =
    pools.find((pool) => pool.id === aggregate.executedPool) ?? pools.find((pool) => pool.decision?.worthLp) ?? null;
  const best = exec?.decision?.best ?? null;
  const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const effective = aggregate.effective ?? null;
  return {
    worthLp: effective ? Boolean(effective.worthLp) : Boolean(aggregate.worthLp),
    edgeBps: effective ? num(effective.netEdgeBpsPerHour, 0) : num(exec?.decision?.best?.netEdgeBps, 0),
    ilBps: effective ? num(effective.ilBpsPerDay / 24, null) : num(exec?.decision?.best?.expectedIlBps, null),
    sigmaHourly: num(effective?.sigmaHourly ?? aggregate.sigma14d, null),
    suggestedDeployUsd: num(effective?.suggestedMaxDeployUsdc ?? aggregate.suggestedMaxDeployUsdc, 0),
    pIlExceedsFees: num(best?.pIlExceedsFees, 0),
    var95Bps: num(best?.var95Bps, 0),
    cvar95Bps: num(best?.cvar95Bps, 0),
    source: effective?.source ?? "base",
    blendWeight: effective?.blendWeight ?? null,
    lowConfidence: Boolean(effective?.lowConfidence),
  };
}

// Effective audit thresholds = env defaults overridden by the fresh LLM verdict, clamped per
// field (bounded both ways, never below the protocol floors). Structural disables are not
// overridable and are re-applied by economicAudit regardless of the thresholds.
function effectiveThresholds(state) {
  const ai = effectiveAi(state);
  return clampAuditOverrides(
    {
      minNetEdgeBps: auditMinNetEdgeBps,
      minJuniorBufferBps: auditMinJuniorBufferBps,
      maxDeployOfJuniorBps: auditMaxDeployOfJuniorBps,
      maxVar95Bps: auditMaxVar95Bps,
      maxPIlExceedsFees: auditMaxPIlExceedsFees,
    },
    ai?.auditOverrides,
  );
}

// Economic audit gate: decomposes yield, checks the junior buffer and IL risk, and returns a
// verdict the daemon enforces (`disable` forces quoting off; `cappedDeployUsd` caps sizing).
function runAudit(state) {
  const market = marketEdge(state);
  const comp = state.composition && !state.composition.error ? state.composition : null;
  const navUsd = comp?.navUsd ?? 0;
  const deployUsd = Math.min(market.suggestedDeployUsd || 0, navUsd);
  const thresholds = effectiveThresholds(state);
  const audit = economicAudit({
    oracleValid: Boolean(state.oracleValid),
    escrowFunded: Boolean(state.risk.escrowFunded),
    seniorClaimUsd: Number(state.risk.seniorClaim ?? 0n) / 1e6,
    juniorClaimUsd: Number(state.risk.juniorClaim ?? 0n) / 1e6,
    expectedIlBps: market.ilBps ?? 0,
    netEdgeBps: market.edgeBps,
    pIlExceedsFees: market.pIlExceedsFees,
    var95Bps: market.var95Bps,
    cvar95Bps: market.cvar95Bps,
    swapCostBps: rebalanceSlippageBps,
    deployUsd,
    minNetEdgeBps: thresholds.minNetEdgeBps,
    minJuniorBufferBps: thresholds.minJuniorBufferBps,
    maxDeployOfJuniorBps: thresholds.maxDeployOfJuniorBps,
    maxVar95Bps: thresholds.maxVar95Bps,
    maxPIlExceedsFees: thresholds.maxPIlExceedsFees,
  });
  return { ...audit, thresholds };
}

// Rebalancing is LLM-owned: the model proposes buy/sell/size; the deterministic intern only
// validates the hard rails (validateRebalanceProposal). No fresh, hash-matched verdict -> no trade.
function planRebalance(state) {
  const ai = effectiveAi(state);
  const proposal = ai?.rebalance ?? null;
  if (!rebalanceEnabled) return { plan: null, ai: proposal, reason: "disabled" };
  if (!proposal) return { plan: null, ai: null, reason: "no_proposal" };
  if (!state.reasoning?.rebalanceFresh) return { plan: null, ai: proposal, reason: "stale_reasoning" };
  const comp = state.composition && !state.composition.error ? state.composition : null;
  const plan = validateRebalanceProposal(proposal, {
    oracleValid: Boolean(state.oracleValid),
    escrowFunded: Boolean(state.risk.escrowFunded),
    equityBps: comp?.equityBps ?? 0,
    hardCapBps: comp?.hardCapBps ?? 10_000,
    navUsd: comp?.navUsd ?? 0,
    compositionAvailable: Boolean(comp),
    minSwapUsd: rebalanceMinUsd,
    maxSwapUsd: rebalanceMaxUsd,
  });
  const market = marketEdge(state);
  const premiumBps = comp
    ? rebalancingPremiumBps({
        weight: comp.equityBps / 10_000,
        sigmaHourly: market.sigmaHourly ?? 0,
        horizonHours: 1,
      })
    : 0;
  return {
    plan: { ...plan, rationale: proposal.rationale ?? null },
    ai: proposal,
    reason: plan.reason,
    ilBps: market.ilBps,
    premiumBps,
  };
}

function rebalanceCalldata(plan, state) {
  if (!plan || plan.action === "hold" || !(plan.sizeUsd > 0)) return null;
  const price = state.oracleMid;
  if (!(price > 0)) return null;
  const mid8 = BigInt(Math.round(price * 1e8));
  const scale = 10n ** BigInt(8 + state.decimals.equity - state.decimals.usdc);
  const slip = BigInt(10_000 - Math.min(Math.max(rebalanceSlippageBps, 0), 9_000));
  const sizeMicro = BigInt(Math.round(plan.sizeUsd * 1e6));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.max(rebalanceDeadlineSeconds, 0));
  if (plan.action === "buy") {
    const amountIn = sizeMicro * 10n ** BigInt(Math.max(state.decimals.usdc - 6, 0));
    const oracleOut = (amountIn * scale) / mid8;
    return { equityOut: false, amountIn, minOut: (oracleOut * slip) / 10_000n, deadline };
  }
  const amountIn = (sizeMicro * 10n ** BigInt(state.decimals.equity) * 100_000_000n) / (mid8 * 1_000_000n);
  const oracleOut = (amountIn * mid8) / scale;
  return { equityOut: true, amountIn, minOut: (oracleOut * slip) / 10_000n, deadline };
}

// Snapshot of the deterministic state for the LLM manager: the next paid verdict sees the live
// params, effective audit thresholds and book composition it is asked to oversee.
function writePolicyCache(state, decision, audit) {
  try {
    const ai = effectiveAi(state);
    const comp = state.composition && !state.composition.error ? state.composition : null;
    const payload = {
      generatedAt: new Date().toISOString(),
      regime: decision.regime,
      quotingEnabled: Boolean(decision.params.quotingEnabled),
      params: {
        baseFee: Number(decision.params.baseFee),
        maxDeviationBps: Number(decision.params.maxDeviationBps),
        toxicityMultiplierBps: Number(decision.params.toxicityMultiplierBps),
        minEvBps: Number(decision.params.minEvBps),
        cooldownSeconds: Number(decision.params.cooldownSeconds),
        ttl: Number(decision.params.ttl),
        gracePeriod: Number(decision.params.gracePeriod),
        maxDeployPerSwap: decision.params.maxDeployPerSwap.toString(),
        bucketTicks: Number(decision.params.bucketTicks),
      },
      audit: {
        verdict: audit.verdict,
        reason: audit.reason,
        thresholds: audit.thresholds,
        juniorBufferBps: audit.juniorBufferBps,
        netAfterCostsBps: audit.netAfterCostsBps,
        maxDeployUsd: audit.maxDeployUsd,
      },
      risk: {
        oracleValid: Boolean(state.oracleValid),
        quoteState: state.quoteState,
        deviationBps: state.deviationBps,
        escrowFunded: Boolean(state.risk.escrowFunded),
        seniorClaimUsd: Number(state.risk.seniorClaim ?? 0n) / 1e6,
        juniorClaimUsd: Number(state.risk.juniorClaim ?? 0n) / 1e6,
      },
      composition: comp
        ? {
            usdcValue: Number(comp.usdcValue) / 10 ** state.decimals.usdc,
            equityValue: Number(comp.equityValue) / 10 ** state.decimals.usdc,
            equityBps: comp.equityBps,
            hardCapBps: comp.hardCapBps,
            navUsd: comp.navUsd,
          }
        : null,
      ai: ai ? { decision: ai.decision ?? null, ageSeconds: state.reasoning?.ageSeconds ?? null } : null,
      ownPool: state.market?.ownPool ?? null,
      effective: state.market?.aggregate?.effective ?? null,
    };
    fs.mkdirSync(path.dirname(policyCachePath), { recursive: true });
    fs.writeFileSync(policyCachePath, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.warn(`[agent] policy cache write skipped: ${error.message}`);
  }
}

async function act(state) {
  if (state.expired) {
    console.log("[agent] book expired: trading/JIT stopped, settlement only; no actions submitted");
    return { expired: true, submitted: false, note: "book expired: settlement only" };
  }
  const decision = reason(state);
  const audit = runAudit(state);
  if (audit.verdict === "disable") {
    decision.params.quotingEnabled = false;
  } else if (audit.cappedDeployUsd > 0 && audit.cappedDeployUsd < Number(decision.params.maxDeployPerSwap) / 1_000_000) {
    decision.params.maxDeployPerSwap = BigInt(Math.round(audit.cappedDeployUsd)) * 1_000_000n;
  }
  // Hook-side gate: JIT reverts InvalidBucketWidth unless bucketTicks is a multiple of the pool tick spacing.
  const spacing = Number(state.tickSpacing) > 0 ? Number(state.tickSpacing) : 1;
  if (Number(decision.params.bucketTicks) % spacing !== 0) {
    const aligned = Math.max(spacing, Math.round(Number(decision.params.bucketTicks) / spacing) * spacing);
    console.log(`[agent] bucketTicks ${decision.params.bucketTicks} not aligned to tickSpacing ${spacing}; using ${aligned}`);
    decision.params.bucketTicks = aligned;
  }
  const upToDate = sameParams(state.params, decision.params);
  const market = state.market?.aggregate;
  const ai = effectiveAi(state);
  const rebal = planRebalance(state);
  const plan = rebal.plan;
  const exec = rebalanceCalldata(plan, state);
  const comp = state.composition;
  const compLabel = comp && !comp.error ? `${comp.equityBps}bps/${comp.hardCapBps}bps` : "n/a";
  const aiAudit = ai?.auditOverrides
    ? Object.entries(audit.thresholds)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")
    : "-";
  const rebalLabel = exec
    ? `${exec.equityOut ? "sell" : "buy"}:${formatUnits(exec.amountIn, exec.equityOut ? state.decimals.equity : state.decimals.usdc)}`
    : plan
      ? `${plan.action}:${plan.reason}`
      : `off:${rebal.reason}`;

  const ownPool = state.market?.ownPool;
  const ownPoolLabel = ownPool?.available
    ? `${ownPool.swapCount}sw/$${ownPool.volumeUsd.toFixed(1)}vol/$${ownPool.feesUsd.toFixed(2)}fee${
        ownPool.hook ? ` +jit $${ownPool.hook.jitPerDayUsd.toFixed(2)}/d (${ownPool.hook.jitEpisodes}ep)` : ""
      }`
    : "n/a";
  const effective = state.market?.aggregate?.effective;
  const effLabel = effective
    ? `${effective.source}:${effective.netEdgeBpsPerDay.toFixed(2)}bps/d@w${effective.blendWeight}${effective.lowConfidence ? "?" : ""}`
    : "n/a";

  const summary = {
    expired: false,
    submitted: submit,
    regime: decision.regime,
    oracleMid: state.oracleMid,
    oracleValid: Boolean(state.oracleValid),
    marketStatus: state.marketStatus,
    deviationBps: state.deviationBps,
    quoteState: state.quoteState,
    paramsChanged: !upToDate,
    maxDeployUsd: Number(state.maxDeploy) / 1_000_000,
    risk: {
      seniorClaimUsd: Number(state.risk.seniorClaim ?? 0n) / 1_000_000,
      juniorClaimUsd: Number(state.risk.juniorClaim ?? 0n) / 1_000_000,
      escrowFunded: Boolean(state.risk.escrowFunded),
    },
    market: market
      ? {
          worthLp: Boolean(market.worthLp),
          bestBandBps: market.bestBandBps ?? null,
          suggestedDeployUsdc: market.suggestedMaxDeployUsdc ?? null,
        }
      : null,
    ai: ai ? { decision: ai.decision ?? null, confidence: ai.confidence ?? null, model: state.reasoning?.model ?? null } : null,
    ownPool: ownPool ?? null,
    effective: effective ?? null,
    audit: {
      verdict: audit.verdict,
      reason: audit.reason,
      juniorBufferBps: audit.juniorBufferBps,
      netAfterCostsBps: audit.netAfterCostsBps,
    },
    rebalance: { action: plan?.action ?? "hold", reason: plan?.reason ?? rebal.reason, sizeUsd: plan?.sizeUsd ?? 0 },
    txHashes: [],
  };

  console.log(
    `[agent] regime=${decision.regime} devBps=${state.deviationBps} quoteState=${state.quoteState} ` +
      `oracle=${state.oracleMid} valid=${state.oracleValid} funded=${state.risk.escrowFunded} ` +
      `seniorClaim=${state.risk.seniorClaim} juniorClaim=${state.risk.juniorClaim} deploy=${state.maxDeploy} ` +
      `changed=${!upToDate} ` +
      `market=${market ? `${market.worthLp ? "lp" : "no-lp"}:${market.bestBandBps ?? "-"}bps:edge=${market.suggestedMaxDeployUsdc}$` : "n/a"} ` +
      `ai=${ai ? `${ai.decision}:${ai.confidence}:${state.reasoning.model ?? "-"}` : state.reasoning?.staleHash ? "stale-hash" : "n/a"} ` +
      `ai-audit=${aiAudit} ` +
      `audit=${audit.verdict}:${audit.reason}:buffer=${audit.juniorBufferBps}bps:net=${audit.netAfterCostsBps}bps ` +
      `equity=${compLabel} il=${rebal.ilBps != null ? rebal.ilBps.toFixed(1) : "-"} premium=${rebal.premiumBps != null ? rebal.premiumBps.toFixed(2) : "-"} rebal=${rebalLabel} ` +
      `own=${ownPoolLabel} eff=${effLabel}`,
  );

  writePolicyCache(state, decision, audit);

  if (!submit) {
    console.log("[agent] dry-run; pass --submit to broadcast through StrategyAgent");
    return summary;
  }

  const { account, client } = wallet();
  const operator = await publicClient.readContract({ address: config.agent, abi: agentAbi, functionName: "operator" });
  if (operator.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`operator mismatch: contract=${operator} key=${account.address}`);
  }

  if (state.legacyStack) {
    console.warn("[agent] legacy v2 stack (pre-v3 redeploy); skipping params submit");
  } else if (!upToDate) {
    const hash = await client.writeContract({
      address: config.agent,
      abi: agentAbi,
      functionName: "submitParams",
      args: [decision.params],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    summary.txHashes.push(hash);
    console.log(`[agent] submitted ${decision.regime} params: ${hash}`);
  } else {
    console.log("[agent] params already match the regime; heartbeat fresh");
  }

  if (exec) {
    const hash = await client.writeContract({
      address: config.agent,
      abi: agentAbi,
      functionName: "submitRebalance",
      args: [exec.equityOut, exec.amountIn, exec.minOut, exec.deadline],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    summary.txHashes.push(hash);
    console.log(`[agent] submitted ${exec.equityOut ? "sell" : "buy"} rebalance: ${hash}`);
  }

  if (config.keeper) {
    try {
      const hash = await client.writeContract({
        address: config.keeper,
        abi: accountantAbi,
        functionName: "rebalance",
      });
      await publicClient.waitForTransactionReceipt({ hash });
      summary.txHashes.push(hash);
      console.log(`[agent] accountant.rebalance(): ${hash}`);
    } catch (error) {
      console.warn(`[agent] accountant.rebalance skipped: ${error.shortMessage || error.message}`);
    }
  }

  return summary;
}

export async function tick(options = {}) {
  if (!config.hook || !config.oracle || !config.agent) {
    throw new Error("AGENT_HOOK / AGENT_ORACLE / AGENT_ADDRESS (or HOOK_DEMO_*) must be set");
  }
  if (pricePushEnabled && submit) {
    try {
      await refreshOraclePrice({ log: (line) => console.log(line), force: has("--force-price") });
    } catch (error) {
      console.warn(`[agent] price push skipped: ${error.shortMessage || error.message}`);
    }
  }
  const marketRefresh = await maybeRefreshMarket(Boolean(options.forceRefresh) || has("--force-market"));
  const reasoningRefresh = await maybeRefreshReasoning(Boolean(options.forceRefresh) || has("--force-reasoning"));
  const state = await perceive();
  const summary = await act(state);
  return { ...summary, marketRefresh, reasoningRefresh };
}

const isDirectRun = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isDirectRun) {
  await tick();
  if (!once) {
    console.log(`[agent] loop every ${intervalSeconds}s`);
    setInterval(() => {
      tick().catch((error) => console.error("[agent] tick failed:", error.message));
    }, intervalSeconds * 1000);
  }
}
