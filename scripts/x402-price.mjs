import fs from "node:fs";
import {
  decodePaymentResponseHeader,
  wrapFetchWithPaymentFromConfig,
} from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";

const DEFAULT_STOCK_URL = "https://agent402.tools/api/stock-quote?symbol=NVDA";
const DEFAULT_MAX_PAYMENT_USDC = "0.01";

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

const oracleAbi = parseAbi([
  "function updateX402Price(int192 mid, uint32 marketStatus, uint32 sourceTimestamp, bytes32 paymentRef)",
]);

function loadEnv(file = ".env") {
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
  return value ?? true;
}

function getPath(object, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), object);
}

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
];

function extractPrice(payload) {
  for (const path of PRICE_PATHS) {
    const parsed = toNumber(getPath(payload, path));
    if (parsed !== null && parsed > 0) return parsed;
  }
  return null;
}

function marketStatusEt(now = new Date()) {
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

function paymentRefFrom(response) {
  const header = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-Payment-Response");
  if (header) {
    try {
      const decoded = decodePaymentResponseHeader(header);
      return keccak256(stringToHex(JSON.stringify(decoded)));
    } catch {
      return keccak256(stringToHex(header));
    }
  }
  return keccak256(stringToHex(`${response.url}:${Date.now()}`));
}

function selectWithinCap(accepts, capUsdc) {
  const cap = BigInt(Math.round(Number(capUsdc) * 1e6));
  if (!accepts || accepts.length === 0) throw new Error("No payment options available");

  const evmOptions = accepts.filter(
    (option) => typeof option.network === "string" && option.network.startsWith("eip155:")
  );
  const preferred = process.env.X402_PREFERRED_NETWORK ?? "eip155:8453";
  const preferredOptions = evmOptions.filter((option) => option.network === preferred);
  const pool = preferredOptions.length > 0 ? preferredOptions : evmOptions;
  if (pool.length === 0) throw new Error("No EVM payment options available");

  const priced = pool
    .map((option) => ({ option, value: BigInt(option.maxAmountRequired ?? option.value ?? option.amount ?? "0") }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  if (priced[0].value > cap) {
    throw new Error(`Payment ${priced[0].value} exceeds cap ${cap} (USDC atomic units)`);
  }
  return priced[0].option;
}

async function fetchWithStandardX402(url, payerKey, maxPaymentUsdc) {
  const account = privateKeyToAccount(payerKey);
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
    paymentRequirementsSelector: (_version, accepts) => selectWithinCap(accepts, maxPaymentUsdc),
  });
  return fetchWithPayment(url, { method: "GET" });
}

async function createGateway(payerKey) {
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  return new GatewayClient({
    chain: "arcTestnet",
    privateKey: payerKey,
    rpcUrl: process.env.ARC_RPC_URL,
  });
}

async function fetchWithGateway(url, payerKey) {
  const gateway = await createGateway(payerKey);
  const payer = privateKeyToAccount(payerKey).address;
  const support = await gateway.supports(url);
  const payTo = support.requirements?.payTo ?? support.requirements?.accepts?.[0]?.payTo;
  if (support.supported && typeof payTo === "string" && payTo.toLowerCase() === payer.toLowerCase()) {
    throw new Error("self_transfer rejected by Gateway: seller payTo equals payer (use a distinct seller wallet)");
  }
  const result = await gateway.pay(url);
  return result;
}

async function probe(url) {
  const response = await fetch(url, { method: "GET" });
  const headers = Object.fromEntries(response.headers.entries());
  const body = await response.text();
  console.log(`status: ${response.status}`);
  console.log(JSON.stringify({ headers, body: body.slice(0, 2000) }, null, 2));
  return response.status;
}

async function pushOnchain({ price, marketStatus, sourceTimestamp, paymentRef }) {
  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (!oracleAddress) throw new Error("ORACLE_ADDRESS not set (required for --push)");
  const payerKey = process.env.X402_PAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!payerKey) throw new Error("X402_PAYER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY not set");

  const account = privateKeyToAccount(payerKey);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL) });

  const mid = BigInt(Math.round(price * 1e8));
  const hash = await wallet.writeContract({
    address: oracleAddress,
    abi: oracleAbi,
    functionName: "updateX402Price",
    args: [mid, marketStatus, sourceTimestamp, paymentRef],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`pushed onchain: ${hash} (block ${receipt.blockNumber})`);
  return hash;
}

async function main() {
  loadEnv();
  const url = process.env.X402_STOCK_URL ?? DEFAULT_STOCK_URL;
  const maxPaymentUsdc = process.env.X402_MAX_PAYMENT_USDC ?? DEFAULT_MAX_PAYMENT_USDC;
  const payerKey = process.env.X402_PAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  const useGateway = Boolean(arg("--gateway", false)) || process.env.X402_USE_GATEWAY === "1";
  const save = Boolean(arg("--save", false));
  const push = Boolean(arg("--push", false));

  if (arg("--probe", false)) {
    process.exitCode = (await probe(url)) === 402 ? 0 : 1;
    return;
  }

  if (arg("--gateway-balances", false)) {
    if (!payerKey) throw new Error("payer key not set");
    const gateway = await createGateway(payerKey);
    const balances = await gateway.getBalances();
    console.log(JSON.stringify(balances, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return;
  }

  if (arg("--gateway-deposit", false)) {
    if (!payerKey) throw new Error("payer key not set");
    const gateway = await createGateway(payerKey);
    const amount = String(arg("--gateway-deposit", "1"));
    const result = await gateway.deposit(amount);
    console.log(`gateway deposit: ${result.formattedAmount} USDC (${result.depositTxHash})`);
    const balances = await gateway.getBalances();
    console.log(`gateway balances: ${JSON.stringify(balances, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    return;
  }

  if (!payerKey) throw new Error("Set X402_PAYER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in .env");

  let response;
  if (useGateway) {
    try {
      const result = await fetchWithGateway(url, payerKey);
      response = result.response ?? new Response(JSON.stringify(result.data ?? result));
      const payload = result.data ?? result;
      if (payload) {
        const price = extractPrice(payload);
        if (price !== null) {
          console.log(JSON.stringify({ mode: "gateway", price, url, payload }, null, 2));
          if (save && !push) {
            fs.mkdirSync("test/fixtures", { recursive: true });
            fs.writeFileSync(
              "test/fixtures/x402-nvda-price.json",
              JSON.stringify({ price, marketStatus: marketStatusEt(), fetchedAt: new Date().toISOString(), source: "gateway", url }, null, 2)
            );
          }
          if (!push) return;
          await pushOnchain({
            price,
            marketStatus: marketStatusEt(),
            sourceTimestamp: Math.floor(Date.now() / 1000),
            paymentRef: keccak256(stringToHex(`${url}:${Date.now()}`)),
          });
          return;
        }
      }
    } catch (error) {
      console.error(`gateway payment failed (${error.message}); falling back to standard x402`);
    }
  }

  response = await fetchWithStandardX402(url, payerKey, maxPaymentUsdc);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  const paymentRef = paymentRefFrom(response);
  const payload = await response.json();
  const price = extractPrice(payload);
  if (price === null) {
    throw new Error(`could not extract price from payload: ${JSON.stringify(payload).slice(0, 500)}`);
  }

  const marketStatus = marketStatusEt();
  const sourceTimestamp = Math.floor(Date.now() / 1000);
  console.log(JSON.stringify({ mode: useGateway ? "standard-fallback" : "standard", price, marketStatus, sourceTimestamp, paymentRef, url }, null, 2));

  if (save) {
    fs.mkdirSync("test/fixtures", { recursive: true });
    fs.writeFileSync(
      "test/fixtures/x402-nvda-price.json",
      JSON.stringify(
        { price, marketStatus, sourceTimestamp, paymentRef, fetchedAt: new Date().toISOString(), url },
        null,
        2
      )
    );
    console.log("saved test/fixtures/x402-nvda-price.json");
  }

  if (push) {
    await pushOnchain({ price, marketStatus, sourceTimestamp, paymentRef });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
