import fs from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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
]);

const oracleAbi = parseAbi([
  "function getPrice() view returns ((int192 mid, int192 bid, int192 ask, uint32 marketStatus, uint8 session, uint32 sourceTimestamp, uint256 updatedAt, bytes32 paymentRef, bool valid))",
]);

const agentAbi = parseAbi([
  "function operator() view returns (address)",
  "function submitParams((bool quotingEnabled, uint24 baseFee, uint24 maxSurgeFee, uint16 maxDeviationBps, uint16 toxicityMultiplierBps, uint16 minEvBps, uint32 cooldownSeconds, uint32 ttl, uint32 gracePeriod, uint128 maxDeployPerSwap, int24 bucketTicks) params)",
  "function submitBaseFee(uint24 baseFee)",
  "function submitQuotingEnabled(bool enabled)",
]);

const accountantAbi = parseAbi([
  "function juniorClaim() view returns (uint256)",
  "function escrowFunded() view returns (bool)",
  "function rebalance() returns (uint256, uint256)",
  "function fulfillRedeem(bool senior, address user)",
]);

const config = {
  hook: process.env.AGENT_HOOK || process.env.HOOK_DEMO_HOOK,
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

  let risk = { juniorClaim: 0n, escrowFunded: false };
  if (accountant !== "0x0000000000000000000000000000000000000000") {
    const [juniorClaim, escrowFunded] = await Promise.all([
      publicClient.readContract({ address: accountant, abi: accountantAbi, functionName: "juniorClaim" }),
      publicClient.readContract({ address: accountant, abi: accountantAbi, functionName: "escrowFunded" }),
    ]);
    risk = { juniorClaim, escrowFunded };
  }

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
    market: loadMarket(),
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
  return marketOverlay(decision, state.market);
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

async function act(state) {
  const decision = reason(state);
  const upToDate = sameParams(state.params, decision.params);
  const market = state.market?.aggregate;
  console.log(
    `[agent] regime=${decision.regime} devBps=${state.deviationBps} quoteState=${state.quoteState} ` +
      `oracle=${state.oracleMid} valid=${state.oracleValid} funded=${state.risk.escrowFunded} ` +
      `juniorClaim=${state.risk.juniorClaim} deploy=${state.maxDeploy} changed=${!upToDate} ` +
      `market=${market ? `${market.worthLp ? "lp" : "no-lp"}:${market.bestBandBps ?? "-"}bps:edge=${market.suggestedMaxDeployUsdc}$` : "n/a"}`,
  );

  if (upToDate) {
    console.log("[agent] params already match the regime; heartbeat fresh");
    return;
  }

  if (!submit) {
    console.log("[agent] dry-run; pass --submit to broadcast through StrategyAgent");
    return;
  }

  const { account, client } = wallet();
  const operator = await publicClient.readContract({ address: config.agent, abi: agentAbi, functionName: "operator" });
  if (operator.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`operator mismatch: contract=${operator} key=${account.address}`);
  }

  const hash = await client.writeContract({
    address: config.agent,
    abi: agentAbi,
    functionName: "submitParams",
    args: [decision.params],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[agent] submitted ${decision.regime} params: ${hash}`);
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
