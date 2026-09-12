// NVDA stock quote via the Circle Agent Marketplace (BlockRun.AI), paid with the Circle
// agent wallet over Gateway nanopayments. Cross-check/backup for the onchain oracle.
//
// Usage:
//   node scripts/circle-stock.mjs --estimate      # show the 402 price
//   node scripts/circle-stock.mjs --dry-run
//   node scripts/circle-stock.mjs                 # pay + fetch NVDA quote
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function circleCliEntry() {
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).stdout?.trim();
  if (!npmRoot) throw new Error("npm root -g failed; is npm on PATH?");
  return path.join(npmRoot, "@circle-fin", "cli", "dist", "index.js");
}

function circleCli(args) {
  return spawnSync(process.execPath, [circleCliEntry(), ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CIRCLE_ACCEPT_TERMS: "1" },
  });
}

async function main() {
  loadEnv();
  const symbol = String(arg("--symbol", "NVDA")).toUpperCase();
  const url = `https://nano.blockrun.ai/api/v1/usstock/price/${symbol}`;
  const chain = String(arg("--chain", process.env.AGENT_AI_CHAIN || "MATIC"));
  const maxAmount = String(arg("--max-amount", process.env.AGENT_AI_MAX_PAYMENT_USDC || "0.01"));
  const address = process.env.AGENT_CIRCLE_WALLET;
  if (!address) throw new Error("AGENT_CIRCLE_WALLET not set");

  const baseArgs = ["services", "pay", url, "--address", address, "--chain", chain, "--max-amount", maxAmount, "-o", "json"];

  if (arg("--estimate", false)) {
    const result = circleCli([...baseArgs, "--estimate"]);
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "").slice(0, 400));
    console.log(result.stdout.trim());
    return;
  }

  if (arg("--dry-run", false)) {
    console.log(JSON.stringify({ url, chain, maxAmount, address, command: `circle ${baseArgs.join(" ")}` }, null, 2));
    return;
  }

  const result = circleCli(baseArgs);
  if (result.status !== 0) {
    throw new Error(`circle services pay failed: ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
  const payload = JSON.parse(result.stdout);
  const body = payload.data?.response ?? payload.data ?? payload;
  const price = body?.price ?? body?.data?.price ?? body?.quote?.price ?? null;

  const output = {
    generatedAt: new Date().toISOString(),
    symbol,
    source: "circle-marketplace:blockrun-usstock",
    url,
    chain,
    payer: address,
    price,
    raw: body,
  };
  const outPath = path.resolve(root, "agent/.cache/stock.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ symbol, price, payer: address, raw: JSON.stringify(body).slice(0, 240) }, null, 2));
  console.log(`saved ${path.relative(root, outPath)}`);
}

main().catch((error) => {
  console.error(`[circle-stock] ${error.message}`);
  process.exitCode = 1;
});
