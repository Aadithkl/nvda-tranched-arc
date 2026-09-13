// Automatic oracle price rail, owned by the agent. The agent pushes a fresh NVDA/USD quote on
// load and on every tick when the onchain price is stale; the oracle only accepts the
// owner-authorized writer (the agent operator), so nobody else can publish a price.
// Payments for the quote go exclusively through Circle Gateway nanopayments: if a seller fails
// (upstream outage, no Gateway support), the next seller in the list is tried.
import fs from "node:fs";
import { isBatchPayment } from "@circle-fin/x402-batching";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

export const oracleAbi = parseAbi([
  "function updatePrice(int192 mid, uint32 marketStatus, uint32 sourceTimestamp, bytes32 paymentRef)",
  "function getPrice() view returns ((int192 mid, int192 bid, int192 ask, uint32 marketStatus, uint8 session, uint32 sourceTimestamp, uint256 updatedAt, bytes32 paymentRef, bool valid))",
  "function maxStaleness() view returns (uint32)",
  "function writers(address) view returns (bool)",
]);

const DEFAULT_SELLERS = [
  "https://nano.blockrun.ai/api/v1/usstock/price/NVDA",
  "https://nano.blockrun.ai/api/v1/stocks/us/price/NVDA",
];
const DEFAULT_MAX_PAYMENT_USDC = "0.01";

// Seller list for the stock quote. Override with a comma-separated ORACLE_PRICE_SELLERS; every
// seller is tried in order until one returns a quote (paid only via Circle Gateway nanopayments).
export function parseSellers(value = process.env.ORACLE_PRICE_SELLERS) {
  const list = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_SELLERS;
}

export function loadEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
  }
}

const getPath = (object, path) => path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), object);

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,]/g, "").trim();
    if (cleaned === "") return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const PRICE_PATHS = [
  "price",
  "last",
  "lastPrice",
  "regularMarketPrice",
  "close",
  "quote.price",
  "data.price",
  "data.last",
  "data.lastPrice",
  "data.regularMarketPrice",
  "data.close",
  "data.quote.price",
  "data.c",
  "chart.result.0.meta.regularMarketPrice",
];

export function extractPrice(payload) {
  for (const path of PRICE_PATHS) {
    const parsed = toNumber(getPath(payload, path));
    if (parsed !== null && parsed > 0) return parsed;
  }
  return null;
}

// US equities 24/5 session mapping: 1 pre / 2 regular / 3 post / 4 overnight / 5 closed.
export function marketStatusEt(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayIndex = days.indexOf(parts.weekday);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);

  if (dayIndex === 5 && minutes >= 1200) return 5;
  if (dayIndex === 6) return 5;
  if (dayIndex === 0 && minutes < 1200) return 5;
  if (minutes >= 240 && minutes < 570) return 1;
  if (minutes >= 570 && minutes < 960) return 2;
  if (minutes >= 960 && minutes < 1200) return 3;
  return 4;
}

function selectWithinCap(accepts, capUsdc) {
  const cap = BigInt(Math.round(Number(capUsdc) * 1e6));
  const evmOptions = (accepts ?? []).filter(
    (option) => typeof option.network === "string" && option.network.startsWith("eip155:"),
  );
  if (evmOptions.length === 0) throw new Error("no EVM payment options available");
  const preferred = process.env.X402_PREFERRED_NETWORK ?? "eip155:8453";
  const preferredOptions = evmOptions.filter((option) => option.network === preferred);
  const pool = preferredOptions.length > 0 ? preferredOptions : evmOptions;
  const priced = pool
    .map((option) => ({ option, value: BigInt(option.maxAmountRequired ?? option.value ?? option.amount ?? "0") }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  if (priced[0].value > cap) {
    throw new Error(`payment ${priced[0].value} exceeds cap ${cap} (USDC atomic units)`);
  }
  return priced[0].option;
}

const GATEWAY_CHAINS = {
  "eip155:137": "polygon",
  "eip155:8453": "base",
  "eip155:5042002": "arcTestnet",
};

async function fetchGatewayBatched(url, option, payerKey, accepts) {
  const chainName = GATEWAY_CHAINS[option.network];
  if (!chainName) throw new Error(`no Circle Gateway client for ${option.network}`);
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  const gateway = new GatewayClient({
    chain: chainName,
    privateKey: payerKey.startsWith("0x") ? payerKey : `0x${payerKey}`,
    rpcUrl: process.env.ARC_RPC_URL,
  });
  const support = await gateway.supports(url).catch(() => null);
  if (support && support.supported === false) {
    throw new Error(`Gateway batching not supported for this seller (${accepts.length} accepts)`);
  }
  const result = await gateway.pay(url);
  const payload = result.data ?? result;
  const paymentRef = result.transaction
    ? keccak256(stringToHex(String(result.transaction)))
    : keccak256(stringToHex(`${url}:${Date.now()}`));
  return { payload, paymentRef, source: "gateway" };
}

// Seller errors can name their internal data backends (Pyth, ...). Our stack only uses x402
// sellers and The Graph, so surface a generic message instead of third-party provider names.
const THIRD_PARTY_NAMES = /\b(pyth|chainlink|redstone|chronicle)\b/gi;
function friendlyError(error) {
  const text = String(error?.shortMessage || error?.message || error);
  return text
    .replace(THIRD_PARTY_NAMES, "seller upstream")
    .replace(/(seller upstream)(?: upstream)+/g, "$1")
    .slice(0, 120);
}

// One seller, nanopayment-only: free responses pass through, 402 responses must offer Circle
// Gateway batched settlement (no plain EOA x402 path for the price rail).
async function fetchFromSeller(url, payerKey, maxPaymentUsdc) {
  const plain = await fetch(url, { method: "GET" });
  if (plain.ok) {
    return { payload: await plain.json(), paymentRef: keccak256(stringToHex(`${url}:${Date.now()}`)), source: "free" };
  }
  if (plain.status !== 402) {
    throw new Error(`HTTP ${plain.status}: ${(await plain.text()).slice(0, 200)}`);
  }
  if (!payerKey) throw new Error("seller requires payment but no payer key is configured");

  const challenge = await plain.json().catch(() => null);
  const accepts = challenge?.x402?.accepts ?? challenge?.accepts ?? [];
  const option = selectWithinCap(accepts, maxPaymentUsdc);
  if (!isBatchPayment(option)) {
    throw new Error("seller does not accept Circle Gateway nanopayments");
  }
  return fetchGatewayBatched(url, option, payerKey, accepts);
}

export async function refreshOraclePrice({ log = console.log, force = false, dryRun = false } = {}) {
  loadEnv();
  const oracle = process.env.AGENT_ORACLE || process.env.HOOK_DEMO_ORACLE || process.env.ORACLE_ADDRESS;
  if (!oracle) {
    log("[price] no oracle configured; skipping automatic price push");
    return null;
  }
  const writerKey =
    process.env.ORACLE_WRITER_PRIVATE_KEY || process.env.AGENT_OPERATOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!writerKey) {
    log("[price] no writer key set; skipping automatic price push");
    return null;
  }

  const rpc = process.env.ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) });
  const [current, maxStaleness] = await Promise.all([
    publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: "getPrice" }),
    publicClient
      .readContract({ address: oracle, abi: oracleAbi, functionName: "maxStaleness" })
      .catch(() => 300),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const age = Number(current.updatedAt) === 0 ? Infinity : now - Number(current.updatedAt);
  const fresh = age < Number(maxStaleness) * 0.8;
  const marketClosed = marketStatusEt() === 5;
  if (!force && (fresh || marketClosed)) {
    log(
      marketClosed
        ? "[price] market closed; nothing to push"
        : `[price] oracle fresh (${age}s old); nothing to push`,
    );
    return null;
  }

  const manual = toNumber(process.env.ORACLE_PRICE_USD);
  let price = manual;
  let source = manual != null ? "manual" : null;
  let paymentRef = keccak256(stringToHex(`manual:${now}`));
  if (price == null) {
    const sellers = parseSellers();
    const payerKey =
      process.env.ORACLE_PRICE_PAYER_PRIVATE_KEY || process.env.X402_PAYER_PRIVATE_KEY || writerKey;
    const maxPaymentUsdc = process.env.ORACLE_MAX_PAYMENT_USDC || DEFAULT_MAX_PAYMENT_USDC;
    let lastError = null;
    for (const [index, url] of sellers.entries()) {
      try {
        const quote = await fetchFromSeller(url, payerKey, maxPaymentUsdc);
        const parsed = extractPrice(quote.payload);
        if (parsed == null) throw new Error("no price in payload");
        price = parsed;
        paymentRef = quote.paymentRef;
        source = quote.source;
        break;
      } catch (error) {
        lastError = error;
        log(`[price] seller ${index + 1}/${sellers.length} failed (${friendlyError(error)}); trying next`);
      }
    }
    if (price == null) {
      // Nanopayment-only by default: the public fallback runs only when explicitly configured.
      const fallbackUrl = process.env.ORACLE_PRICE_FALLBACK_URL;
      if (!fallbackUrl) throw new Error(friendlyError(lastError) || "no seller returned a price");
      log(`[price] all sellers failed; using configured public fallback`);
      const response = await fetch(fallbackUrl, { headers: { "user-agent": "Mozilla/5.0" } });
      if (!response.ok) throw new Error(`fallback quote HTTP ${response.status}`);
      price = extractPrice(await response.json());
      paymentRef = keccak256(stringToHex(`${fallbackUrl}:${now}`));
      source = "public";
      if (price == null) throw new Error("fallback quote returned no price");
    }
  }

  const account = privateKeyToAccount(writerKey);
  const isWriter = await publicClient.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: "writers",
    args: [account.address],
  });
  if (!isWriter) {
    throw new Error(`${account.address} is not an authorized oracle writer (owner must call setWriter)`);
  }

  const marketStatus = marketStatusEt();
  const mid = BigInt(Math.round(price * 1e8));
  if (dryRun) {
    log(`[price] dry-run: would push $${price} (${source ?? "unknown"} source, status ${marketStatus})`);
    return null;
  }

  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) });
  const hash = await wallet.writeContract({
    address: oracle,
    abi: oracleAbi,
    functionName: "updatePrice",
    args: [mid, marketStatus, now, paymentRef],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  log(`[price] pushed $${price.toFixed(2)} (${source ?? "unknown"} source, status ${marketStatus}) → ${hash} (block ${receipt.blockNumber})`);
  return hash;
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isDirectRun) {
  const force = process.argv.includes("--force");
  const dryRun = process.argv.includes("--dry");
  refreshOraclePrice({ force, dryRun }).catch((error) => {
    console.error(`[price] ${error.shortMessage || error.message}`);
    process.exitCode = 1;
  });
}
