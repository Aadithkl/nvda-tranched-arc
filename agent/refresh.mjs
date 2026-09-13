// Conditional LLM manager refresh: when the paid verdict is older than
// AGENT_LLM_REFRESH_SECONDS (default 6h), refresh the Graph market snapshot and request a new
// verdict through the paid rail before the deterministic tick runs. The deterministic path never
// depends on this script: a skipped or failed refresh leaves the previous verdict (or the env
// defaults) in place and the agent tick keeps running.
//
// Usage:
//   node agent/refresh.mjs            # refresh if stale (skips the paid call without a payer key)
//   node agent/refresh.mjs --force    # refresh regardless of age (manual use)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

function loadEnv(file = path.join(root, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
  }
}

loadEnv();

const refreshSeconds = Number(process.env.AGENT_LLM_REFRESH_SECONDS || "21600");
const reasoningPath = path.resolve(
  root,
  process.env.AGENT_REASONING_CACHE || "agent/.cache/reasoning.json",
);

function ageSeconds(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const ageMs = Date.now() - Date.parse(raw.generatedAt);
    return Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null;
  } catch {
    return null;
  }
}

function run(script, extraArgs = []) {
  console.log(`[refresh] node ${script}${extraArgs.length ? ` ${extraArgs.join(" ")}` : ""}`);
  const result = spawnSync(process.execPath, [path.join(root, script), ...extraArgs], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`${script} exited with ${result.status}`);
}

const age = ageSeconds(reasoningPath);
if (age != null && age <= refreshSeconds && !args.has("--force")) {
  console.log(`[refresh] reasoning is fresh (${age}s <= ${refreshSeconds}s); deterministic tick continues`);
  process.exit(0);
}

// The caller (agent tick) may have refreshed the Graph snapshot already.
if (!args.has("--no-market")) run("agent/market.mjs", ["--json"]);

const payer = process.env.X402_PAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
if (!payer) {
  console.warn(
    "[refresh] no X402_PAYER_PRIVATE_KEY/DEPLOYER_PRIVATE_KEY; keeping the previous verdict (env defaults apply)",
  );
  process.exit(0);
}

run("scripts/x402-ai.mjs");
console.log("[refresh] reasoning refreshed");
