// Sync subgraph data source addresses from the deployment manifest (source of truth).
// Redeploy flow: update .env -> npm run export:pack -> npm run subgraph:sync -> graph deploy.
//
// Usage:
//   node scripts/sync-subgraph-addresses.mjs          # write subgraph.yaml + networks.json
//   node scripts/sync-subgraph-addresses.mjs --check  # exit 1 if the files are out of sync
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "deployments/arc-testnet.json");
const yamlPath = path.join(root, "subgraph/subgraph.yaml");
const networksPath = path.join(root, "subgraph/networks.json");

const check = process.argv.includes("--check");

function loadEnv(file = path.join(root, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
  }
}

loadEnv();

if (!fs.existsSync(manifestPath)) {
  console.error(`[subgraph:sync] missing ${path.relative(root, manifestPath)}; run npm run export:pack first`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const stack = manifest.stack ?? {};

// data source name -> address (null keeps the existing value in the files)
const mapping = {
  NVDAPriceOracle: manifest.oracle?.address ?? null,
  PoolManager: manifest.contracts?.poolManager ?? null,
  TrancheJITHook: stack.hook ?? null,
  StrategyController: stack.controller ?? process.env.HOOK_DEMO_CONTROLLER ?? null,
  StrategyAgent: stack.agent ?? process.env.HOOK_DEMO_AGENT ?? null,
  SeniorVault: stack.seniorVault ?? null,
  JuniorVault: stack.juniorVault ?? null,
  TrancheAccountant: stack.accountant ?? null,
};

const startBlock = process.env.SUBGRAPH_START_BLOCK ? Number(process.env.SUBGRAPH_START_BLOCK) : null;
const startBlocks = (() => {
  try {
    return process.env.SUBGRAPH_START_BLOCKS ? JSON.parse(process.env.SUBGRAPH_START_BLOCKS) : {};
  } catch {
    throw new Error("SUBGRAPH_START_BLOCKS must be a JSON object of { dataSourceName: blockNumber }");
  }
})();
const ADDRESS_LINE = /^(      address: ")(0x[0-9a-fA-F]{40})(")$/;
const START_BLOCK_LINE = /^(      startBlock: )(\d+)$/;
const NAME_LINE = /^    name: ([A-Za-z0-9_]+)\s*$/;

function targetStartBlock(name) {
  if (!name || !mapping[name]) return null;
  if (startBlocks[name] !== undefined) return Number(startBlocks[name]);
  return startBlock;
}

function syncYaml(text) {
  let current = null;
  const changes = [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/).map((line) => {
    const nameMatch = line.match(NAME_LINE);
    if (nameMatch) current = nameMatch[1];

    const target = current ? mapping[current] : null;
    const addressMatch = line.match(ADDRESS_LINE);
    if (target && addressMatch && target.toLowerCase() !== addressMatch[2].toLowerCase()) {
      changes.push(`${current}: ${addressMatch[2]} -> ${target}`);
      return `${addressMatch[1]}${target}${addressMatch[3]}`;
    }
    const blockTarget = targetStartBlock(current);
    const blockMatch = line.match(START_BLOCK_LINE);
    if (blockTarget && blockMatch && Number(blockMatch[2]) !== blockTarget) {
      return `${blockMatch[1]}${blockTarget}`;
    }
    return line;
  });
  return { text: lines.join(eol), changes };
}

function syncNetworks(json) {
  const next = JSON.parse(JSON.stringify(json));
  const changes = [];
  for (const [network, entries] of Object.entries(next)) {
    for (const [name, entry] of Object.entries(entries)) {
      const target = mapping[name];
      if (target && target.toLowerCase() !== String(entry.address).toLowerCase()) {
        changes.push(`${network}.${name}: ${entry.address} -> ${target}`);
        entry.address = target;
      }
      const blockTarget = targetStartBlock(name);
      if (blockTarget && target && Number(entry.startBlock) !== blockTarget) {
        entry.startBlock = blockTarget;
      }
    }
  }
  return { json: next, changes };
}

const yamlOriginal = fs.readFileSync(yamlPath, "utf8");
const networksOriginal = fs.readFileSync(networksPath, "utf8");

const yaml = syncYaml(yamlOriginal);
const networks = syncNetworks(JSON.parse(networksOriginal));
const networksText = `${JSON.stringify(networks.json, null, 2)}\n`;

const yamlChanged = yaml.text !== yamlOriginal;
const networksChanged = networksText !== networksOriginal;

if (check) {
  if (!yamlChanged && !networksChanged) {
    console.log("[subgraph:sync] in sync with deployments/arc-testnet.json");
    process.exit(0);
  }
  for (const change of [...yaml.changes, ...networks.changes]) console.error(`[subgraph:sync] drift ${change}`);
  console.error("[subgraph:sync] files are out of sync; run: npm run subgraph:sync");
  process.exit(1);
}

if (!yamlChanged && !networksChanged) {
  console.log("[subgraph:sync] already in sync with deployments/arc-testnet.json");
  process.exit(0);
}

fs.writeFileSync(yamlPath, yaml.text);
fs.writeFileSync(networksPath, networksText);
for (const change of [...yaml.changes, ...networks.changes]) console.log(`[subgraph:sync] ${change}`);
console.log("[subgraph:sync] updated subgraph/subgraph.yaml + subgraph/networks.json");
