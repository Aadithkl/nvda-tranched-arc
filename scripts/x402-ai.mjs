// x402-paid AI reasoning over the live Graph market snapshot.
//
// Takes agent/.cache/market.json (volatility, fees, TVL, rewarded TVL, IL risk per NVDAc pool),
// sends it to the metered model gateway at agent402.tools, pays per call in USDC over x402,
// and stores the model's risk-committee answer in agent/.cache/reasoning.json.
//
// Usage:
//   node scripts/x402-ai.mjs --dry-run                 # prompt preview, no payment
//   node scripts/x402-ai.mjs --list-models             # model allowlist (free)
//   node scripts/x402-ai.mjs                           # paid call (default model)
//   node scripts/x402-ai.mjs --model openai/gpt-4.1-mini
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = process.env.AGENT_AI_URL ?? "https://agent402.tools/v1/metered/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_MAX_PAYMENT_USDC = "0.02";

function loadEnv(file = path.join(root, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
  }
}

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) return true;
  return value;
}

function selectWithinCap(accepts, capUsdc) {
  const cap = BigInt(Math.round(Number(capUsdc) * 1e6));
  if (!accepts || accepts.length === 0) throw new Error("No payment options available");
  const evmOptions = accepts.filter(
    (option) => typeof option.network === "string" && option.network.startsWith("eip155:"),
  );
  const preferred = process.env.X402_PREFERRED_NETWORK ?? "eip155:8453";
  const preferredOptions = evmOptions.filter((option) => option.network === preferred);
  const pool = preferredOptions.length > 0 ? preferredOptions : evmOptions;
  if (pool.length === 0) throw new Error("No EVM payment options available");
  const priced = pool
    .map((option) => ({
      option,
      value: BigInt(option.maxAmountRequired ?? option.value ?? option.amount ?? "0"),
    }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  if (priced[0].value > cap) {
    throw new Error(`Payment ${priced[0].value} exceeds cap ${cap} (USDC atomic units)`);
  }
  return priced[0].option;
}

function paymentRefFrom(response) {
  const header =
    response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-Payment-Response");
  if (header) {
    try {
      return { decoded: decodePaymentResponseHeader(header), raw: header };
    } catch {
      return { decoded: null, raw: header };
    }
  }
  return { decoded: null, raw: null };
}

const SYSTEM_PROMPT = [
  "You are the risk committee for an onchain tranched structured product on NVDA.",
  "The product runs a senior (fixed coupon) / junior (levered residual) vault whose capital can be",
  "deployed as concentrated-liquidity (JIT) positions on NVDAc pools. You receive live market data",
  "indexed by The Graph: volatility, fee yield, TVL, rewarded (in-range) TVL, and Monte-Carlo",
  "impermanent-loss risk per pool, plus the deterministic model verdict.",
  "Answer as strict JSON with keys:",
  '{"decision":"deploy"|"reduce"|"hold"|"disable",',
  '"confidence":0..1,',
  '"recommendedBucketTicks":int,',
  '"recommendedMaxDeployUsdc":int,',
  '"rationale":string,',
  '"risks":[string]}',
  "Respect the risk numbers: if pLoss is high or VaR95 is deep relative to fees, do not recommend deploy.",
  "No markdown, JSON only.",
].join(" ");

function compactMarket(market) {
  return {
    generatedAt: market.generatedAt,
    aggregate: market.aggregate,
    pools: market.pools
      .filter((pool) => pool.available)
      .map((pool) => ({
        id: pool.id,
        venue: pool.venue,
        quote: pool.quote,
        tvlUsd: pool.tvlUsd,
        volume24hUsd: pool.metrics.volume24hUsd,
        fees24hUsd: pool.metrics.fees24hUsd,
        feeApr: pool.metrics.feeApr,
        effectiveFeeBps: pool.metrics.effectiveFeeBps,
        activeTvlUsd: pool.active?.activeTvlUsd ?? null,
        activeShare: pool.active?.activeShare ?? null,
        sigma3hBps: pool.volatility.h3 == null ? null : pool.volatility.h3 * 10_000,
        sigma14dBps: pool.volatility.h14d == null ? null : pool.volatility.h14d * 10_000,
        decision: pool.decision
          ? {
              worthLp: pool.decision.worthLp,
              reason: pool.decision.reason,
              bestBandBps: pool.decision.best?.bandBps ?? null,
              expectedIlBps: pool.decision.best?.expectedIlBps ?? null,
              expectedFeeBps: pool.decision.best?.expectedFeeBps ?? null,
              netEdgeBps: pool.decision.best?.netEdgeBps ?? null,
              pIlExceedsFees: pool.decision.best?.pIlExceedsFees ?? null,
              var95Bps: pool.decision.best?.var95Bps ?? null,
              cvar95Bps: pool.decision.best?.cvar95Bps ?? null,
              requiredFeeBps: pool.decision.best?.requiredFeeBps ?? null,
              suggestedMaxDeployUsdc: pool.decision.suggestedMaxDeployUsdc ?? null,
            }
          : null,
      })),
  };
}

async function main() {
  loadEnv();

  if (arg("--list-models", false)) {
    const response = await fetch("https://agent402.tools/v1/models");
    const text = await response.text();
    console.log(`status: ${response.status}`);
    console.log(text.slice(0, 4000));
    return;
  }

  if (arg("--gateway-check", false)) {
    const payerKey = process.env.X402_PAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
    if (!payerKey) throw new Error("Set X402_PAYER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in .env");
    const { GatewayClient } = await import("@circle-fin/x402-batching/client");
    const gateway = new GatewayClient({
      chain: "arcTestnet",
      privateKey: payerKey.startsWith("0x") ? payerKey : `0x${payerKey}`,
      rpcUrl: process.env.ARC_RPC_URL,
    });
    const support = await gateway.supports(process.env.AGENT_AI_URL || DEFAULT_URL);
    console.log(JSON.stringify(support, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    const balances = await gateway.getBalances().catch(() => null);
    if (balances) {
      console.log(
        `gateway balances: ${JSON.stringify(balances, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
      );
    }
    return;
  }

  const marketPath = path.resolve(
    root,
    String(arg("--inputs", process.env.AGENT_MARKET_CACHE || "agent/.cache/market.json")),
  );
  if (!fs.existsSync(marketPath)) {
    throw new Error(`market snapshot missing at ${marketPath} - run "npm run market" first`);
  }
  const market = JSON.parse(fs.readFileSync(marketPath, "utf8"));

  const model = String(arg("--model", process.env.AGENT_AI_MODEL || DEFAULT_MODEL));
  const maxTokens = Number(arg("--max-tokens", process.env.AGENT_AI_MAX_TOKENS || DEFAULT_MAX_TOKENS));
  const url = process.env.AGENT_AI_URL || DEFAULT_URL;
  const capUsdc = process.env.AGENT_AI_MAX_PAYMENT_USDC || DEFAULT_MAX_PAYMENT_USDC;

  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(compactMarket(market)) },
    ],
    max_tokens: maxTokens,
    reasoning: { effort: "low" },
  };

  if (arg("--probe", false)) {
    const probeResponse = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const headers = Object.fromEntries(probeResponse.headers.entries());
    const paymentRequired = headers["payment-required"] ?? headers["x-payment-required"] ?? null;
    let accepts = null;
    if (paymentRequired) {
      try {
        accepts = JSON.parse(Buffer.from(paymentRequired, "base64").toString("utf8"));
      } catch {
        accepts = paymentRequired;
      }
    }
    console.log(
      JSON.stringify(
        { status: probeResponse.status, headers, body: (await probeResponse.text()).slice(0, 1000), accepts },
        null,
        2,
      ),
    );
    return;
  }

  if (arg("--dry-run", false)) {
    console.log(JSON.stringify({ url, model, maxTokens, capUsdc, body }, null, 2));
    return;
  }

  const payerKey = process.env.X402_PAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!payerKey) throw new Error("Set X402_PAYER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in .env");
  const account = privateKeyToAccount(payerKey.startsWith("0x") ? payerKey : `0x${payerKey}`);

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
    spendControls: false,
    paymentRequirementsSelector: (_version, accepts) => selectWithinCap(accepts, capUsdc),
  });

  const started = Date.now();
  const response = await fetchWithPayment(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);

  const payload = JSON.parse(text);
  const content = payload.choices?.[0]?.message?.content ?? null;
  let parsed = null;
  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }
  }

  const receipt = paymentRefFrom(response);
  const output = {
    generatedAt: new Date().toISOString(),
    url,
    model: payload.model ?? model,
    latencyMs: Date.now() - started,
    usage: payload.usage ?? null,
    payment: receipt,
    content,
    reasoning: parsed,
  };

  const outPath = path.resolve(root, "agent/.cache/reasoning.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(
    JSON.stringify(
      {
        model: output.model,
        latencyMs: output.latencyMs,
        usage: output.usage,
        payment: receipt.decoded ? { ...receipt.decoded, raw: undefined } : receipt.raw,
        decision: parsed?.decision ?? null,
        confidence: parsed?.confidence ?? null,
        recommendedBucketTicks: parsed?.recommendedBucketTicks ?? null,
        recommendedMaxDeployUsdc: parsed?.recommendedMaxDeployUsdc ?? null,
        rationale: parsed?.rationale ?? (content ? String(content).slice(0, 400) : null),
      },
      null,
      2,
    ),
  );
  console.log(`saved ${path.relative(root, outPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
