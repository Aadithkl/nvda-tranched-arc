// Manifest for the ETH/NVDA 45-day downloads.
// Reads research/data/swaps-eth-45d/<target>/*.jsonl and writes manifest.json.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = "research/data/swaps-eth-45d";
const END = 96_245_937n;
const DAY = 86_400;

function dirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name));
}

function checkpoint(dir) {
  const p = path.join(dir, "checkpoint.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function summarize(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  let rows = 0;
  let bytes = 0;
  let first = null;
  let last = null;
  let token0 = null;
  let feePips = null;

  for (const f of files) {
    const p = path.join(dir, f);
    bytes += statSync(p).size;
    const text = readFileSync(p, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      rows++;
      if (!first) first = r;
      last = r;
      token0 = r.token0 ?? token0;
      feePips = r.feePips ?? feePips;
    }
  }

  const cp = checkpoint(dir);
  const complete = cp?.nextBlock ? BigInt(cp.nextBlock) > END : false;
  const days =
    first && last && first.timestamp && last.timestamp
      ? ((Number(last.timestamp) - Number(first.timestamp)) / DAY).toFixed(2)
      : "?";
  return {
    rows,
    mb: +(bytes / 1_048_576).toFixed(2),
    files: files.length,
    firstBlock: first?.blockNumber ?? null,
    lastBlock: last?.blockNumber ?? null,
    days,
    token0,
    feePips,
    complete,
    checkpoint: cp?.nextBlock ?? null,
  };
}

function main() {
  mkdirSync(ROOT, { recursive: true });
  const targets = {};
  const totals = { rows: 0, mb: 0 };
  for (const dir of dirs(ROOT)) {
    const name = path.basename(dir);
    if (name === "manifest.json") continue;
    targets[name] = summarize(dir);
    totals.rows += targets[name].rows;
    totals.mb += targets[name].mb;
  }
  totals.mb = +totals.mb.toFixed(2);
  const out = { generatedAt: new Date().toISOString(), range: { fromBlock: 57_365_937, toBlock: 96_245_937 }, targets, totals };
  writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main();
