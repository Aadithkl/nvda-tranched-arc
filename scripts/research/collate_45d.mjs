// Collate the 20-day + 25-day gap into one 45-day dataset per pool.
// Also filters the complete 60-day V4 0.30% set to the last 45 days.
//
//   node scripts/research/collate_45d.mjs
//
// Output: research/data/swaps-45d/<target>/swaps.jsonl + manifest.json

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const ROOT = "research/data";
const OUT = path.join(ROOT, "swaps-45d");
const GAP = path.join(ROOT, "swaps-45d-gap");
const TWENTY = path.join(ROOT, "swaps-20d");
const SIXTY = path.join(ROOT, "swaps-60d");
const DAY = 86_400;

const TARGETS = {
  "v3-usdg-nvda-005": {
    sources: [
      path.join(GAP, "v3-usdg-nvda-005"),
      path.join(ROOT, "swaps-45d-shards", "v3-s1", "v3-usdg-nvda-005"),
      path.join(ROOT, "swaps-45d-shards", "v3-s2", "v3-usdg-nvda-005"),
      path.join(ROOT, "swaps-45d-shards", "v3-s3", "v3-usdg-nvda-005"),
      path.join(ROOT, "swaps-45d-shards", "v3-s4", "v3-usdg-nvda-005"),
      path.join(TWENTY, "v3-usdg-nvda-005"),
    ],
    sourceEnds: [
      72_265_937n,
      73_940_937n,
      75_615_937n,
      77_290_937n,
      78_965_937n,
      96_245_938n,
    ],
  },
  "v4-usdg-nvda-001": {
    sources: [path.join(GAP, "v4-usdg-nvda-001"), path.join(TWENTY, "v4-usdg-nvda-001")],
    sourceEnds: [78_965_937n, 96_245_938n],
  },
  "v4-usdg-nvda-030": {
    sources: [path.join(SIXTY, "v4-usdg-nvda-030")],
    sourceEnds: [96_245_938n],
  },
  "v4-usdg-nvda-00375": {
    sources: [path.join(GAP, "v4-usdg-nvda-00375")],
    sourceEnds: [96_245_938n],
  },
};

function jsonlFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => path.join(dir, f));
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

async function maxTimestamp() {
  let max = 0;
  for (const t of Object.values(TARGETS)) {
    for (const dir of t.sources) {
      for (const f of jsonlFiles(dir)) {
        const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            const ts = Number(r.timestamp) || Number(r.blockNumber) * 0.1;
            if (ts > max) max = ts;
          } catch {}
        }
      }
    }
  }
  return max;
}

async function collate(name, t, cutoff) {
  const outDir = path.join(OUT, name);
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "swaps.jsonl");
  const stream = createWriteStream(outFile);

  const seen = new Set();
  let rows = 0;
  let first = null;
  let last = null;
  let batch = [];
  let bytes = 0;

  const flush = async () => {
    if (!batch.length) return;
    const s = batch.join("\n") + "\n";
    bytes += Buffer.byteLength(s);
    batch = [];
    if (!stream.write(s)) await new Promise((r) => stream.once("drain", r));
  };

  for (const dir of t.sources) {
    for (const f of jsonlFiles(dir)) {
      const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = Number(r.timestamp) || Number(r.blockNumber) * 0.1;
        if (ts < cutoff) continue;
        const key = `${r.txHash}:${r.logIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows++;
        if (!first) first = r;
        last = r;
        batch.push(line);
        if (batch.length >= 5_000) await flush();
      }
    }
  }
  await flush();
  await new Promise((r) => stream.end(r));

  const cps = t.sources.map((d) => checkpoint(d));
  const complete = t.sources.every((_, i) => {
    const cp = cps[i];
    return cp?.nextBlock ? BigInt(cp.nextBlock) >= t.sourceEnds[i] : false;
  });
  const days = first && last ? ((Number(last.timestamp) - Number(first.timestamp)) / DAY).toFixed(2) : "?";
  return {
    sources: t.sources,
    rows,
    mb: +(bytes / 1_048_576).toFixed(2),
    firstBlock: first?.blockNumber ?? null,
    lastBlock: last?.blockNumber ?? null,
    days,
    complete,
    checkpoints: cps.map((c) => c?.nextBlock ?? null),
  };
}

async function main() {
  const maxTs = await maxTimestamp();
  const cutoff = maxTs - 45 * DAY;
  const manifest = { generatedAt: new Date().toISOString(), cutoff, targets: {}, totals: { rows: 0, mb: 0 } };
  for (const [name, t] of Object.entries(TARGETS)) {
    const r = await collate(name, t, cutoff);
    manifest.targets[name] = r;
    manifest.totals.rows += r.rows;
    manifest.totals.mb += r.mb;
    console.log(`${name}: rows=${r.rows} mb=${r.mb} days=${r.days} complete=${r.complete}`);
  }
  manifest.totals.mb = +manifest.totals.mb.toFixed(2);
  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`wrote ${path.join(OUT, "manifest.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
