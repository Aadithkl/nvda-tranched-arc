// Agent Marketplace + nanopayment reasoning loop.
//
// 1. Discovers x402 LLM services (Circle Agent Marketplace Discovery API, free).
// 2. Composes the Graph market snapshot into a strict-JSON reasoning request.
// 3. Pays per call with the Circle agent wallet (CLI, Gateway nanopayments).
// 4. Stores the verdict in agent/.cache/reasoning.json with a snapshot hash.
//
// Usage:
//   node scripts/agent-market.mjs --search llm            # discovery (no auth)
//   node scripts/agent-market.mjs --inspect              # show the 402 challenge
//   node scripts/agent-market.mjs --dry-run              # request + exact CLI command
//   node scripts/agent-market.mjs                        # pay + call (agent wallet session)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT, compactMarket } from "../agent/ai-prompt.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DISCOVERY_URL = "https://api.circle.com/v2/x402/discovery/resources";
const DEFAULT_SERVICE = "https://api.aisa.one/v2/chat/completions";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

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

function short(value, len = 60) {
  const text = String(value ?? "");
  return text.length > len ? `${text.slice(0, len - 1)}…` : text;
}

function hashSnapshot(market) {
  return `0x${crypto.createHash("sha256").update(JSON.stringify(compactMarket(market))).digest("hex")}`;
}

async function discover({ query = "chat completions", network = process.env.AGENT_AI_CHAIN_NETWORK ?? "eip155:8453", limit = 25 } = {}) {
  const url = `${DISCOVERY_URL}?query=${encodeURIComponent(query)}&limit=${limit}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`discovery HTTP ${response.status}`);
  const json = await response.json();
  const items = (json.items ?? []).filter((item) => {
    if (network && !item.accepts?.some((accept) => accept.network === network)) return false;
    return item.metadata?.supportsCircleGateway !== false;
  });
  return items;
}

function printDiscovery(items) {
  if (!items.length) {
    console.log("no services matched (try a different query or network)");
    return;
  }
  console.log(`provider | url | price | networks | gateway`);
  for (const item of items) {
    const price = item.accepts?.[0]?.amount ?? "-";
    const networks = [...new Set((item.accepts ?? []).map((a) => a.network))].join(",");
    console.log(
      `${short(item.metadata?.provider?.name, 24)} | ${short(item.resource, 60)} | ${price} | ${short(networks, 40)} | ${item.metadata?.supportsCircleGateway ?? "-"}`,
    );
  }
}

async function inspect(url) {
  const cli = circleCli(["services", "inspect", url, "-X", "POST", "-o", "json"]);
  if (cli.status === 0 && cli.stdout.trim()) {
    console.log(cli.stdout.trim());
    return;
  }
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const header = response.headers.get("payment-required");
  let challenge = null;
  if (header) {
    try {
      challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      challenge = { raw: header };
    }
  }
  console.log(JSON.stringify({ status: response.status, body: (await response.text()).slice(0, 400), challenge }, null, 2));
}

function circleCliEntry() {
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).stdout?.trim();
  if (!npmRoot) throw new Error("npm root -g failed; is npm on PATH?");
  return path.join(npmRoot, "@circle-fin", "cli", "dist", "index.js");
}

// Run the Circle CLI without a shell so JSON bodies are passed verbatim (Windows-safe).
function circleCli(args) {
  return spawnSync(process.execPath, [circleCliEntry(), ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CIRCLE_ACCEPT_TERMS: "1" },
  });
}

function agentWalletAddress() {
  if (process.env.AGENT_CIRCLE_WALLET) return process.env.AGENT_CIRCLE_WALLET;
  const result = circleCli(["wallet", "list", "--type", "agent", "--chain", process.env.AGENT_AI_CHAIN || "BASE", "-o", "json"]);
  if (result.status !== 0) {
    throw new Error(
      "no agent wallet address; run `circle wallet login <email>` (and set AGENT_CIRCLE_WALLET) first",
    );
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const wallets = parsed.data?.wallets ?? parsed.wallets ?? parsed.items ?? parsed;
    const address = wallets?.[0]?.address ?? wallets?.data?.[0]?.address;
    if (address) return address;
  } catch {
    /* fall through */
  }
  throw new Error("could not parse `circle wallet list` output; set AGENT_CIRCLE_WALLET explicitly");
}

function buildRequestBody(model, maxTokens) {
  const marketPath = path.resolve(root, process.env.AGENT_MARKET_CACHE || "agent/.cache/market.json");
  if (!fs.existsSync(marketPath)) throw new Error(`market snapshot missing at ${marketPath} - run "npm run market" first`);
  const market = JSON.parse(fs.readFileSync(marketPath, "utf8"));
  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(compactMarket(market)) },
    ],
    max_tokens: maxTokens,
  };
  return { body, snapshotHash: hashSnapshot(market), market };
}

function payArgs({ url, body, address, chain, maxAmount }) {
  return [
    "services",
    "pay",
    url,
    "-X",
    "POST",
    "-d",
    JSON.stringify(body),
    "--address",
    address,
    "--chain",
    chain,
    "--max-amount",
    String(maxAmount),
    "-o",
    "json",
  ];
}

function payViaCli({ url, body, address, chain, maxAmount }) {
  const result = circleCli(payArgs({ url, body, address, chain, maxAmount }));
  if (result.status !== 0) {
    throw new Error(`circle services pay failed: ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
  return result.stdout;
}

function estimateViaCli({ url, body, address, chain, maxAmount }) {
  const result = circleCli([...payArgs({ url, body, address, chain, maxAmount }).slice(0, -2), "--estimate", "-o", "json"]);
  if (result.status !== 0) {
    throw new Error(`circle services pay --estimate failed: ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
  return result.stdout;
}

function extractJson(text) {
  if (typeof text !== "string") return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseContent(raw) {
  let payload = raw;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { content: raw, parsed: extractJson(raw), usage: null, model: null };
  }
  const body =
    payload.response?.body ??
    payload.response ??
    payload.data?.response ??
    payload.body ??
    payload.data ??
    payload;
  const content =
    body?.choices?.[0]?.message?.content ??
    body?.content ??
    body?.output_text ??
    (typeof body === "string" ? body : null);
  return { content: content ?? JSON.stringify(body).slice(0, 2000), parsed: extractJson(content), usage: body?.usage ?? payload.usage ?? null, model: body?.model ?? payload.model ?? null, raw: payload };
}

async function main() {
  loadEnv();

  if (arg("--search", false)) {
    const query = typeof arg("--search") === "string" ? arg("--search") : "chat completions";
    const items = await discover({ query });
    printDiscovery(items);
    return;
  }

  const url = String(arg("--service", process.env.AGENT_AI_SERVICE_URL || DEFAULT_SERVICE));
  if (arg("--inspect", false)) {
    await inspect(url);
    return;
  }

  const model = String(arg("--model", process.env.AGENT_AI_MODEL || DEFAULT_MODEL));
  const maxTokens = Number(arg("--max-tokens", process.env.AGENT_AI_MAX_TOKENS || "600"));
  const chain = String(arg("--chain", process.env.AGENT_AI_CHAIN || "BASE"));
  const maxAmount = String(arg("--max-amount", process.env.AGENT_AI_MAX_PAYMENT_USDC || "0.01"));

  const { body, snapshotHash } = buildRequestBody(model, maxTokens);

  if (arg("--dry-run", false)) {
    let address = process.env.AGENT_CIRCLE_WALLET || "<agent-wallet-address>";
    try {
      address = agentWalletAddress();
    } catch {
      /* dry run without a login */
    }
    const cliArgs = [
      "services",
      "pay",
      url,
      "-X",
      "POST",
      "-d",
      JSON.stringify(body),
      "--address",
      address,
      "--chain",
      chain,
      "--max-amount",
      maxAmount,
      "-o",
      "json",
    ];
    console.log(JSON.stringify({ service: url, model, chain, maxAmount, address, snapshotHash, body, command: `circle ${cliArgs.join(" ")}` }, null, 2));
    return;
  }
  const address = agentWalletAddress();

  if (arg("--challenge", false)) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const header = response.headers.get("payment-required");
    let challenge = null;
    if (header) {
      try {
        challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      } catch {
        challenge = { raw: header };
      }
    }
    console.log(JSON.stringify({ status: response.status, challenge }, null, 2));
    return;
  }

  if (arg("--estimate", false)) {
    console.log(estimateViaCli({ url, body, address, chain, maxAmount }));
    return;
  }

  const raw = payViaCli({ url, body, address, chain, maxAmount });
  const { content, parsed, usage, model: responseModel } = parseContent(raw);

  const output = {
    generatedAt: new Date().toISOString(),
    source: "circle-agent-marketplace",
    service: url,
    model: responseModel ?? model,
    chain,
    payer: address,
    snapshotHash,
    usage,
    content,
    reasoning: parsed,
  };

  const outPath = path.resolve(root, "agent/.cache/reasoning.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(
    JSON.stringify(
      {
        service: url,
        model: output.model,
        payer: address,
        snapshotHash,
        decision: parsed?.decision ?? null,
        confidence: parsed?.confidence ?? null,
        recommendedBucketTicks: parsed?.recommendedBucketTicks ?? null,
        recommendedMaxDeployUsdc: parsed?.recommendedMaxDeployUsdc ?? null,
        rationale: parsed?.rationale ?? (content ? String(content).slice(0, 300) : null),
      },
      null,
      2,
    ),
  );
  console.log(`saved ${path.relative(root, outPath)}`);
}

main().catch((error) => {
  console.error(`[agent-market] ${error.message}`);
  process.exitCode = 1;
});
