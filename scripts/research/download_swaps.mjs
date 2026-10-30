// Resumable on-chain Uniswap swap downloader for the NVDA/USDG research set.
//
// Writes one JSONL file per chunk under research/data/swaps/<name>/ and a
// checkpoint.json with the next block to fetch. Re-running resumes.
//
//   node scripts/research/download_swaps.mjs --days 2 --chunk 50000
//   node scripts/research/download_swaps.mjs --days 60 --chunk 100000 --concurrency 4
//
// The default RPC is the local proxy (npm run robinhood:proxy). For a full
// two-month backfill use a provider RPC and raise --chunk/--concurrency.

import { createPublicClient, http, parseAbiItem } from "viem";
import { mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import path from "node:path";

const RPC_URL = process.env.RESEARCH_RPC_URL || "http://127.0.0.1:8546";
const OUT = process.env.RESEARCH_OUT || "research/data/swaps";
const BLOCK_TIME = Number(process.env.RESEARCH_BLOCK_TIME || 0.1);

const V4_SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
const V3_SWAP = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

const TARGETS = [
  {
    name: "v3-usdg-nvda-005",
    kind: "v3",
    address: "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3",
    feePips: 500,
    tickSpacing: 10,
  },
  {
    name: "v4-usdg-nvda-030",
    kind: "v4",
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    poolId: "0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1",
    feePips: 3000,
    tickSpacing: 60,
  },
  {
    name: "v4-usdg-nvda-100",
    kind: "v4",
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    poolId: "0x6a41bdbdf82850998dd5f30588cde7a38447ba6334258ba91775e090155eb796",
    feePips: 10000,
    tickSpacing: 100,
  },
  {
    name: "v4-usdg-nvda-001",
    kind: "v4",
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    poolId: "0x6444a8e0b267406a15db74ca00c4a24bdfa81ed3180f5b6d0851f8ed6f4f29c5",
    feePips: 100,
    tickSpacing: 1,
  },
  {
    name: "v4-usdg-nvda-00375",
    kind: "v4",
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    poolId: "0xdf5c0bcd967d54774c139a4ef803ec994779736346fb4c21b50ed241b1fd2682",
    feePips: 375,
    tickSpacing: 4,
  },
  {
    name: "v3-weth-nvda-005",
    kind: "v3",
    address: "0x62ab521f71431f78ac374cdbadc6cda3c8916b6c",
    feePips: 500,
    tickSpacing: 10,
    token0: "WETH",
    token0Decimals: 18,
  },
  {
    name: "v3-weth-nvda-030",
    kind: "v3",
    address: "0xc0be1cb0f674d9737c72b2a63fc542361185b807",
    feePips: 3000,
    tickSpacing: 60,
    token0: "WETH",
    token0Decimals: 18,
  },
  {
    name: "v4-weth-nvda-005",
    kind: "v4",
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    poolId: "0x71f9660f9535e3e81d720696a58ea80274da8b2c6eb7c3acb22611d977439a5c",
    feePips: 500,
    tickSpacing: 10,
    token0: "WETH",
    token0Decimals: 18,
  },
];

function args() {
  const a = process.argv.slice(2);
  const get = (k, d) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : d;
  };
  return {
    days: Number(get("--days", 2)),
    chunk: Number(get("--chunk", 50_000)),
    concurrency: Number(get("--concurrency", 1)),
    target: get("--target", ""),
    fromBlock: get("--from-block", ""),
    toBlock: get("--to-block", ""),
    reset: a.includes("--reset"),
    pauseMs: Number(get("--pause-ms", 200)),
  };
}

const client = createPublicClient({
  chain: {
    id: 4663,
    name: "robinhood",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  },
  transport: http(RPC_URL),
});

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

async function getLogsWithRetry(params, attempts = 9) {
  let delay = 2_000;
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.getLogs(params);
    } catch (e) {
      const msg = `${e.shortMessage ?? ""} ${e.details ?? ""} ${e.message ?? ""}`;
      // Deterministic: split the block range instead of retrying.
      if (/exceeds limit of 10000|more than 10000/i.test(msg)) throw e;
      if (i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

/** Fetch a range, recursively halving it when the node's 10k log cap is hit. */
async function fetchLogsRange(baseParams, s, e, depth = 0) {
  try {
    return await getLogsWithRetry({ ...baseParams, fromBlock: s, toBlock: e });
  } catch (err) {
    const msg = `${err.shortMessage ?? ""} ${err.details ?? ""} ${err.message ?? ""}`;
    if (/exceeds limit of 10000|more than 10000/i.test(msg) && e - s > 1_000n && depth < 20) {
      const mid = s + (e - s) / 2n;
      const left = await fetchLogsRange(baseParams, s, mid, depth + 1);
      const right = await fetchLogsRange(baseParams, mid + 1n, e, depth + 1);
      return [...left, ...right];
    }
    throw err;
  }
}

async function downloadTarget(t, cfg, head) {
  const dir = path.join(OUT, t.name);
  if (cfg.reset) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const span = BigInt(Math.ceil((cfg.days * 86_400) / BLOCK_TIME));
  const from = cfg.fromBlock ? BigInt(cfg.fromBlock) : head > span ? head - span : 0n;
  const to = cfg.toBlock ? BigInt(cfg.toBlock) : head;
  const chunk = BigInt(cfg.chunk);

  const checkpointFile = path.join(dir, "checkpoint.json");
  let start = from;
  try {
    const cp = JSON.parse(await readFile(checkpointFile, "utf8"));
    if (cp.nextBlock) start = BigInt(cp.nextBlock);
  } catch {}

  console.log(`${t.name}: blocks ${start}..${to} chunk=${chunk}`);

  for (let s = start; s <= to; s += chunk) {
    const e = s + chunk - 1n > to ? to : s + chunk - 1n;
    const baseParams =
      t.kind === "v4"
        ? { address: t.poolManager, event: V4_SWAP, args: { id: t.poolId } }
        : { address: t.address, event: V3_SWAP };

    const logs = await fetchLogsRange(baseParams, s, e);

    let blockTs = 0;
    try {
      const b = await client.getBlock({ blockNumber: s });
      blockTs = Number(b.timestamp);
    } catch {}

    const lines = logs.map((l) => {
      const bn = BigInt(l.blockNumber);
      const timestamp = blockTs ? blockTs + Number(bn - s) * BLOCK_TIME : 0;
      return json({
        target: t.name,
        kind: t.kind,
        feePips: t.feePips,
        token0: t.token0 ?? "USDG",
        token0Decimals: t.token0Decimals ?? 6,
        blockNumber: bn,
        logIndex: l.logIndex,
        txHash: l.transactionHash,
        sender: l.args.sender ?? null,
        recipient: l.args.recipient ?? null,
        timestamp,
        amount0: l.args.amount0,
        amount1: l.args.amount1,
        sqrtPriceX96: l.args.sqrtPriceX96,
        liquidity: l.args.liquidity,
        tick: l.args.tick,
        fee: l.args.fee ?? t.feePips,
      });
    });

    if (lines.length) {
      await appendFile(path.join(dir, `swaps-${s}-${e}.jsonl`), lines.join("\n") + "\n");
    }
    await writeFile(
      checkpointFile,
      JSON.stringify({ nextBlock: (e + 1n).toString(), updatedAt: new Date().toISOString() }),
    );

    console.log(`${t.name}: ${s}..${e} logs=${lines.length}`);
    if (cfg.pauseMs > 0) await new Promise((r) => setTimeout(r, cfg.pauseMs));
  }
}

async function getBlockNumberWithRetry(attempts = 8) {
  let delay = 5_000;
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.getBlockNumber();
    } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

async function main() {
  const cfg = args();
  // --to-block avoids eth_blockNumber on a rate-limited public RPC (resume path).
  const head = cfg.toBlock ? BigInt(cfg.toBlock) : await getBlockNumberWithRetry();
  const targets = cfg.target ? TARGETS.filter((t) => t.name === cfg.target) : TARGETS;
  if (targets.length === 0) throw new Error(`no target ${cfg.target}`);

  for (const t of targets) {
    await downloadTarget(t, cfg, head);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
