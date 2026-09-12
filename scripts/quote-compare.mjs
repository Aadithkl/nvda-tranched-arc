// Quote comparison: Circle App Kits Swap vs our onchain v4 pool (Arc testnet).
//
// App Kits Swap on Arc testnet supports USDC, EURC and cirBTC only (no NVDA), so
// the stablecoin leg is the one where both venues can quote the same route.
//
// Usage:
//   node scripts/quote-compare.mjs                    # 1 USDC -> EURC
//   node scripts/quote-compare.mjs --amount 5 --json
//   node scripts/quote-compare.mjs --execute --via app-kit
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { createPublicClient, defineChain, formatUnits, http, parseUnits } from "viem";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

loadEnv();

const rpc = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

const manifest = JSON.parse(fs.readFileSync(path.join(root, "deployments/arc-testnet.json"), "utf8"));
const quoterAbi = JSON.parse(fs.readFileSync(path.join(root, "docs/abis/V4Quoter.json"), "utf8"));
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) });

async function poolQuote(amountUsdc) {
  const key = manifest.pools.usdcEurc.key;
  const { result } = await publicClient.simulateContract({
    address: manifest.contracts.v4Quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: {
          currency0: key.currency0,
          currency1: key.currency1,
          fee: key.fee,
          tickSpacing: key.tickSpacing,
          hooks: key.hooks,
        },
        zeroForOne: true,
        exactAmount: parseUnits(amountUsdc, 6),
        hookData: "0x",
      },
    ],
  });
  return result[0]; // amountOut in EURC (6 decimals)
}

function makeAdapter() {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");
  return createViemAdapterFromPrivateKey({
    privateKey,
    getPublicClient: () => publicClient,
  });
}

async function appKitQuote(adapter, amountUsdc) {
  const kit = new AppKit(process.env.CIRCLE_APP_KIT_KEY ? { apiKey: process.env.CIRCLE_APP_KIT_KEY } : undefined);
  return kit.estimateSwap({
    from: { adapter, chain: "Arc_Testnet" },
    tokenIn: "USDC",
    tokenOut: "EURC",
    amountIn: String(amountUsdc),
  });
}

async function main() {
  const amountUsdc = String(arg("--amount", "1"));
  const asJson = Boolean(arg("--json", false));

  const { amountOut: poolOut } = { amountOut: await poolQuote(amountUsdc) };

  let kitOut = null;
  let kitEstimate = null;
  let kitError = null;
  try {
    const adapter = makeAdapter();
    kitEstimate = await appKitQuote(adapter, amountUsdc);
    kitOut = parseUnits(String(kitEstimate.estimatedOutput.amount), 6);
  } catch (error) {
    kitError = error.message;
  }

  const diffBps = kitOut != null && poolOut > 0n ? Number(((kitOut - poolOut) * 10_000n) / poolOut) : null;

  const summary = {
    pair: "USDC -> EURC (Arc testnet)",
    amountIn: amountUsdc,
    appKits: kitOut != null ? { amountOut: formatUnits(kitOut, 6), estimate: kitEstimate } : { error: kitError },
    ourPool: { amountOut: formatUnits(poolOut, 6), poolId: manifest.pools.usdcEurc.poolId, feeBps: manifest.pools.usdcEurc.lpFee / 100 },
    comparison: {
      betterVenue: diffBps == null ? "n/a" : diffBps > 0 ? "app-kits" : diffBps < 0 ? "our-pool" : "tie",
      appKitsVsPoolBps: diffBps,
    },
  };

  if (asJson) {
    console.log(JSON.stringify(summary, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2));
  } else {
    console.log(`pair:            ${summary.pair}`);
    console.log(`amount in:       ${summary.amountIn} USDC`);
    console.log(`App Kits out:    ${kitOut != null ? formatUnits(kitOut, 6) : `unavailable (${kitError})`} EURC`);
    console.log(`our pool out:    ${formatUnits(poolOut, 6)} EURC (fee ${summary.ourPool.feeBps} bps)`);
    console.log(`difference:      ${diffBps == null ? "n/a" : `${diffBps} bps`} (${summary.comparison.betterVenue})`);
  }

  if (arg("--execute", false)) {
    if (String(arg("--via", "app-kit")) === "app-kit") {
      const adapter = makeAdapter();
      const kit = new AppKit(process.env.CIRCLE_APP_KIT_KEY ? { apiKey: process.env.CIRCLE_APP_KIT_KEY } : undefined);
      const result = await kit.swap({
        from: { adapter, chain: "Arc_Testnet" },
        tokenIn: "USDC",
        tokenOut: "EURC",
        amountIn: amountUsdc,
      });
      console.log(JSON.stringify(result, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2));
    } else {
      console.log("pool execution uses DemoRouter.swapExactIn (see scripts/hook-demo.mjs) - not executed here");
    }
  }
}

main().catch((error) => {
  console.error(`[quote-compare] ${error.message}`);
  process.exitCode = 1;
});
