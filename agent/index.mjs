import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compactMarket } from "./ai-prompt.mjs";
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
  "function params() view returns ((bool quotingEnabled, uint24 baseFee, uint24 maxSurgeFee, uint16 maxDeviationBps, uint16 toxicityMultiplierBps, uint16 minEvBps, uint32 cooldownSeconds, uint32 ttl, uint32 gracePeriod, uint128 maxDeployPerSwap, int24 bucketTicks))",
  "function quoteState() view returns (uint8)",
  "function previewQuote(bool zeroForOne) view returns (uint24 fee, bool toxic, uint16 deviationBps, uint8 state)",
  "function effectiveMaxDeploy() view returns (uint256)",
  "function accountant() view returns (address)",
  "function owner() view returns (address)",
  "function assetComposition() view returns (uint256 usdcValue, uint256 equityValue, uint256 equityBps)",
  "function hardMaxEquityBps() view returns (uint16)",
  "function usdcDecimals() view returns (uint8)",
  "function equityDecimals() view returns (uint8)",
]);

const oracleAbi = parseAbi([
  "function getPrice() view returns ((int192 mid, int192 bid, int192 ask, uint32 marketStatus, uint8 session, uint32 sourceTimestamp, uint256 updatedAt, bytes32 paymentRef, bool valid))",
]);

const agentAbi = parseAbi([
  "function operator() view returns (address)",
  "function controller() view returns (address)",
  "function submitParams((bool quotingEnabled, uint24 baseFee, uint24 maxSurgeFee, uint16 maxDeviationBps, uint16 toxicityMultiplierBps, uint16 minEvBps, uint32 cooldownSeconds, uint32 ttl, uint32 gracePeriod, uint128 maxDeployPerSwap, int24 bucketTicks) params)",
  "function submitBaseFee(uint24 baseFee)",
  "function submitQuotingEnabled(bool enabled)",
  "function submitRebalance(bool equityOut, uint256 amountIn, uint256 minOut, uint256 deadline)",
]);

const controllerAbi = parseAbi([
  "function bounds() view returns ((uint24 maxBaseFee, uint24 maxSurgeFee, uint16 maxDeviationBps, uint16 maxToxicityMultiplierBps, uint32 maxTtl, uint32 maxGracePeriod, uint128 maxDeployPerSwap, uint128 maxRebalanceSwapUsdc, uint32 rebalanceCooldown))",
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
    maxSurgeFee: 30_000,
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
    maxSurgeFee: 60_000,
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
    maxSurgeFee: 100_000,
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

async function perceive() {
  const [oracle, params, state, maxDeploy, accountant] = await Promise.all([
    publicClient.readContract({ address: config.oracle, abi: oracleAbi, functionName: "getPrice" }),
    publicClient.readContract({ address: config.hook, abi, functionName: "params" }),
    publicClient.readContract({ address: config.hook, abi, functionName: "quoteState" }),
    publicClient.readContract({ address: config.hook, abi, functionName: "effectiveMaxDeploy" }),
    publicClient.readContract({ address: config.hook, abi, functionName: "accountant" }),
  ]);

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
  try {
    const controller = await publicClient.readContract({
      address: config.agent,
      abi: agentAbi,
      functionName: "controller",
    });
    if (controller !== "0x0000000000000000000000000000000000000000") {
      bounds = await publicClient.readContract({
        address: controller,
        abi: controllerAbi,
        functionName: "bounds",
      });
    }
  } catch {
    bounds = null;
  }

  const market = loadMarket();

  return {
    oracleMid: Number(oracle.mid) / 1e8,
    oracleValid: oracle.valid,
    marketStatus: Number(oracle.marketStatus),
    deviationBps: Number(deviationBps),
    quoteState: Number(state),
    params,
    maxDeploy,
    accountant,
    risk,
    composition,
    decimals,
    bounds,
    market,
    reasoning: loadReasoning(market),
  };
}

function marketOverlay(decision, market) {
  const aggregate = market?.aggregate;
  if (!aggregate) return decision;
  const suffix = aggregate.worthLp ? "lp-on" : "lp-off";
  const params = { ...decision.params };
  if (!aggregate.worthLp) {
    params.quotingEnabled = false;
  } else {
    const bucketTicks = Math.max(1, Math.min(5_000, Number(aggregate.suggestedBucketTicks) || params.bucketTicks));
    const deployUsdc = Math.max(0, Math.min(100_000, Number(aggregate.suggestedMaxDeployUsdc) || 0));
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
    Number(a.maxSurgeFee) === b.maxSurgeFee &&
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
  return {
    worthLp: Boolean(aggregate.worthLp),
    edgeBps: num(exec?.decision?.best?.netEdgeBps, 0),
    ilBps: num(exec?.decision?.best?.expectedIlBps, null),
    sigmaHourly: num(aggregate.sigma14d, null),
    suggestedDeployUsd: num(aggregate.suggestedMaxDeployUsdc, 0),
    pIlExceedsFees: num(best?.pIlExceedsFees, 0),
    var95Bps: num(best?.var95Bps, 0),
    cvar95Bps: num(best?.cvar95Bps, 0),
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
        maxSurgeFee: Number(decision.params.maxSurgeFee),
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
    };
    fs.mkdirSync(path.dirname(policyCachePath), { recursive: true });
    fs.writeFileSync(policyCachePath, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.warn(`[agent] policy cache write skipped: ${error.message}`);
  }
}

async function act(state) {
  const decision = reason(state);
  const audit = runAudit(state);
  if (audit.verdict === "disable") {
    decision.params.quotingEnabled = false;
  } else if (audit.cappedDeployUsd > 0 && audit.cappedDeployUsd < Number(decision.params.maxDeployPerSwap) / 1_000_000) {
    decision.params.maxDeployPerSwap = BigInt(Math.round(audit.cappedDeployUsd)) * 1_000_000n;
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

  console.log(
    `[agent] regime=${decision.regime} devBps=${state.deviationBps} quoteState=${state.quoteState} ` +
      `oracle=${state.oracleMid} valid=${state.oracleValid} funded=${state.risk.escrowFunded} ` +
      `seniorClaim=${state.risk.seniorClaim} juniorClaim=${state.risk.juniorClaim} deploy=${state.maxDeploy} ` +
      `changed=${!upToDate} ` +
      `market=${market ? `${market.worthLp ? "lp" : "no-lp"}:${market.bestBandBps ?? "-"}bps:edge=${market.suggestedMaxDeployUsdc}$` : "n/a"} ` +
      `ai=${ai ? `${ai.decision}:${ai.confidence}:${state.reasoning.model ?? "-"}` : state.reasoning?.staleHash ? "stale-hash" : "n/a"} ` +
      `ai-audit=${aiAudit} ` +
      `audit=${audit.verdict}:${audit.reason}:buffer=${audit.juniorBufferBps}bps:net=${audit.netAfterCostsBps}bps ` +
      `equity=${compLabel} il=${rebal.ilBps != null ? rebal.ilBps.toFixed(1) : "-"} premium=${rebal.premiumBps != null ? rebal.premiumBps.toFixed(2) : "-"} rebal=${rebalLabel}`,
  );

  writePolicyCache(state, decision, audit);

  if (!submit) {
    console.log("[agent] dry-run; pass --submit to broadcast through StrategyAgent");
    return;
  }

  const { account, client } = wallet();
  const operator = await publicClient.readContract({ address: config.agent, abi: agentAbi, functionName: "operator" });
  if (operator.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`operator mismatch: contract=${operator} key=${account.address}`);
  }

  if (!upToDate) {
    const hash = await client.writeContract({
      address: config.agent,
      abi: agentAbi,
      functionName: "submitParams",
      args: [decision.params],
    });
    await publicClient.waitForTransactionReceipt({ hash });
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
      console.log(`[agent] accountant.rebalance(): ${hash}`);
    } catch (error) {
      console.warn(`[agent] accountant.rebalance skipped: ${error.shortMessage || error.message}`);
    }
  }
}

async function tick() {
  if (!config.hook || !config.oracle || !config.agent) {
    throw new Error("AGENT_HOOK / AGENT_ORACLE / AGENT_ADDRESS (or HOOK_DEMO_*) must be set");
  }
  const state = await perceive();
  await act(state);
}

await tick();
if (!once) {
  console.log(`[agent] loop every ${intervalSeconds}s`);
  setInterval(() => {
    tick().catch((error) => console.error("[agent] tick failed:", error.message));
  }, intervalSeconds * 1000);
}
