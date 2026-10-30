// Research-only VFAT snapshot downloader.
//
// This is NOT used by the keeper. The keeper uses on-chain Uniswap data only.
// VFAT's prepared pool history covers 30 closed UTC days; the 2-month view is
// assembled from on-chain swaps plus VFAT backtest windows.
//
//   node scripts/research/fetch_vfat.mjs

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT = "research/data/vfat";

const POOLS = {
  "v3-usdg-nvda-005":
    "4663:0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3:0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3:poolId=:poolIndex=",
  "v4-usdg-nvda-030":
    "4663:0x8366a39cc670b4001a1121b8f6a443a643e40951:0x8366a39cc670b4001a1121b8f6a443a643e40951:poolId=0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1:poolIndex=",
  "v4-usdg-nvda-001":
    "4663:0x8366a39cc670b4001a1121b8f6a443a643e40951:0x8366a39cc670b4001a1121b8f6a443a643e40951:poolId=0x6444a8e0b267406a15db74ca00c4a24bdfa81ed3180f5b6d0851f8ed6f4f29c5:poolIndex=",
  "v4-usdg-nvda-100":
    "4663:0x8366a39cc670b4001a1121b8f6a443a643e40951:0x8366a39cc670b4001a1121b8f6a443a643e40951:poolId=0x6a41bdbdf82850998dd5f30588cde7a38447ba6334258ba91775e090155eb796:poolIndex=",
  "v3-weth-nvda-005":
    "4663:0x62ab521f71431f78ac374cdbadc6cda3c8916b6c:0x62ab521f71431f78ac374cdbadc6cda3c8916b6c:poolId=:poolIndex=",
  "v3-weth-nvda-030":
    "4663:0xc0be1cb0f674d9737c72b2a63fc542361185b807:0xc0be1cb0f674d9737c72b2a63fc542361185b807:poolId=:poolIndex=",
  "v4-weth-nvda-005":
    "4663:0x8366a39cc670b4001a1121b8f6a443a643e40951:0x8366a39cc670b4001a1121b8f6a443a643e40951:poolId=0x71f9660f9535e3e81d720696a58ea80274da8b2c6eb7c3acb22611d977439a5c:poolIndex=",
};

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const [name, id] of Object.entries(POOLS)) {
    const url = `https://api.vfat.io/v4/pool-history?id=${encodeURIComponent(id)}&bucket=day&limit=30`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    const j = await r.json();
    const file = path.join(OUT, `${name}-pool-history-30d.json`);
    await writeFile(file, JSON.stringify(j, null, 2));
    console.log(`${name}: ${j.points?.length ?? 0} points -> ${file}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
