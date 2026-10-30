// Simple hook/LP simulator over downloaded Uniswap swaps.
//
// It models two static positions (wide base + narrow guard), the vault's share
// of pool active liquidity, fees at a chosen fee tier, and IL vs HODL. It is a
// first-pass model for the real PoolGuardHook; it does not yet model the hook's
// exact re-arm timing or the vault's tranche accounting.
//
//   node scripts/research/simulate_hook.mjs --target v3-usdg-nvda-005 --fee-pips 3000 --capital 10000
//   node scripts/research/simulate_hook.mjs --target v3-usdg-nvda-005 --fee-pips 10000 --half-width-ticks 6000 --guard-ticks 600
//
// Reads research/data/swaps/<target>/*.jsonl, dedupes by txHash:logIndex, sorts
// by block/log, and writes research/out/<target>-<fee>.json.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { priceFromSqrtX96, positionValueUsd } from "../keeper/stats.mjs";

const SWAPS = process.env.RESEARCH_SWAPS || "research/data/swaps";
const OUT = "research/out";

function args() {
  const a = process.argv.slice(2);
  const get = (k, d) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : d;
  };
  const feeArg = get("--fee-pips", "") || get("--fee-bps", "3000");
  return {
    target: get("--target", "v3-usdg-nvda-005"),
    feePips: Number(feeArg),
    days: Number(get("--days", 0)),
    capital: Number(get("--capital", 10_000)),
    halfWidthTicks: Number(get("--half-width-ticks", 6_000)),
    guardTicks: Number(get("--guard-ticks", 600)),
    guardShare: Number(get("--guard-share", 0.5)),
    token0Decimals: Number(get("--token0-decimals", 6)),
    token1Decimals: Number(get("--token1-decimals", 18)),
    quoteSymbol: get("--quote-symbol", "USDG"),
  };
}

function amountsForL({ liquidity, sqrtP, tickLower, tickUpper }) {
  const L = Number(liquidity);
  const sqrtPa = Math.sqrt(1.0001 ** Number(tickLower));
  const sqrtPb = Math.sqrt(1.0001 ** Number(tickUpper));
  if (!(L > 0) || !(sqrtP > 0) || !(sqrtPb > sqrtPa)) return { x: 0, y: 0 };
  let x;
  let y;
  if (sqrtP <= sqrtPa) {
    x = L * (1 / sqrtPa - 1 / sqrtPb);
    y = 0;
  } else if (sqrtP >= sqrtPb) {
    x = 0;
    y = L * (sqrtPb - sqrtPa);
  } else {
    x = L * (1 / sqrtP - 1 / sqrtPb);
    y = L * (sqrtP - sqrtPa);
  }
  return { x, y };
}

function valueInToken0({ x, y, sqrtP }) {
  const P = sqrtP * sqrtP;
  return x + y / P;
}

function valuePerL({ sqrtP, tickLower, tickUpper, token0Decimals }) {
  const a = amountsForL({ liquidity: 1e18, sqrtP, tickLower, tickUpper });
  return valueInToken0({ ...a, sqrtP }) / 10 ** token0Decimals;
}

function pnl(
  position,
  feePips,
  capital,
  halfWidthTicks,
  guardTicks,
  guardShare,
  token0Decimals,
  token1Decimals,
  quoteSymbol,
) {
  if (!position.length) return null;
  const t0 = token0Decimals;
  const t1 = token1Decimals;

  const first = position[0];
  const startSqrt = Number(BigInt(first.sqrtPriceX96)) / 2 ** 96;
  const startTick = Number(first.tick);
  const baseRange = { tickLower: startTick - halfWidthTicks, tickUpper: startTick + halfWidthTicks };
  const guardRange = { tickLower: startTick - guardTicks, tickUpper: startTick + guardTicks };

  const baseCapital = capital * (1 - guardShare);
  const guardCapital = capital * guardShare;
  const basePerL = valuePerL({ sqrtP: startSqrt, ...baseRange, token0Decimals: t0 });
  const guardPerL = valuePerL({ sqrtP: startSqrt, ...guardRange, token0Decimals: t0 });
  // L in units of 1e18 liquidity; raw L is 1e18 * L.
  const LBase = basePerL > 0 ? baseCapital / basePerL : 0;
  const LGuard = guardPerL > 0 ? guardCapital / guardPerL : 0;
  const LBaseRaw = 1e18 * LBase;
  const LGuardRaw = 1e18 * LGuard;

  const base0 = amountsForL({ liquidity: LBaseRaw, sqrtP: startSqrt, ...baseRange });
  const guard0 = amountsForL({ liquidity: LGuardRaw, sqrtP: startSqrt, ...guardRange });

  let fees = 0;
  let inBase = 0;
  let inGuard = 0;
  let positionValue = 0;
  let totalInputUsd = 0;
  let shareSum = 0;

  for (const s of position) {
    const sqrtP = Number(BigInt(s.sqrtPriceX96)) / 2 ** 96;
    const tick = Number(s.tick);
    const poolL = Number(BigInt(s.liquidity));

    const baseIn = tick >= baseRange.tickLower && tick < baseRange.tickUpper;
    const guardIn = tick >= guardRange.tickLower && tick < guardRange.tickUpper;
    if (baseIn) inBase += 1;
    if (guardIn) inGuard += 1;

    const vaultL = (baseIn ? LBaseRaw : 0) + (guardIn ? LGuardRaw : 0);
    const share = poolL + vaultL > 0 ? vaultL / (poolL + vaultL) : 0;

    const a0 = BigInt(s.amount0);
    const a1 = BigInt(s.amount1);
    const humanP = priceFromSqrtX96(s.sqrtPriceX96) * 10 ** (t0 - t1);
    const quotePerNvda = humanP > 0 ? 1 / humanP : 0;

    let inputUsd = 0;
    if (a0 < 0n) inputUsd = Number(-a0) / 10 ** t0;
    else if (a1 < 0n) inputUsd = (Number(-a1) / 10 ** t1) * quotePerNvda;

    totalInputUsd += inputUsd;
    shareSum += share;
    fees += inputUsd * (feePips / 1_000_000) * share;

    const baseValue = positionValueUsd({
      liquidity: BigInt(Math.round(LBaseRaw)),
      sqrtPriceX96: s.sqrtPriceX96,
      tickLower: baseRange.tickLower,
      tickUpper: baseRange.tickUpper,
      token0Decimals: t0,
    });
    const guardValue = positionValueUsd({
      liquidity: BigInt(Math.round(LGuardRaw)),
      sqrtPriceX96: s.sqrtPriceX96,
      tickLower: guardRange.tickLower,
      tickUpper: guardRange.tickUpper,
      token0Decimals: t0,
    });
    positionValue = baseValue + guardValue;
  }

  const last = position[position.length - 1];
  const endSqrt = Number(BigInt(last.sqrtPriceX96)) / 2 ** 96;
  const endP = endSqrt * endSqrt;
  const startP = startSqrt * startSqrt;
  // y_raw / (endP * 10^token0Decimals) converts raw token1 to quote token.
  const hodlValue =
    (base0.x + guard0.x) / 10 ** t0 +
    (base0.y + guard0.y) / (endP * 10 ** t0);

  const firstTs = first.timestamp || Number(first.blockNumber) * 0.1;
  const lastTs = last.timestamp || Number(last.blockNumber) * 0.1;
  const durationSeconds = Math.max(1, lastTs - firstTs);
  const annualization = (365 * 24 * 3600) / durationSeconds;

  const netVsHodl = positionValue + fees - hodlValue;
  return {
    target: first.target,
    feePips,
    capital,
    capitalQuote: quoteSymbol,
    quoteSymbol,
    token0Decimals: t0,
    token1Decimals: t1,
    halfWidthTicks,
    guardTicks,
    guardShare,
    LBaseRaw,
    LGuardRaw,
    totalInputUsd,
    avgShare: position.length ? shareSum / position.length : 0,
    swaps: position.length,
    startTick,
    endTick: Number(last.tick),
    startNvdaQuote: startP > 0 ? 1 / (priceFromSqrtX96(first.sqrtPriceX96) * 10 ** (t0 - t1)) : 0,
    endNvdaQuote: endP > 0 ? 1 / (priceFromSqrtX96(last.sqrtPriceX96) * 10 ** (t0 - t1)) : 0,
    feesUsd: fees,
    positionValueUsd: positionValue,
    hodlValueUsd: hodlValue,
    netVsHodlUsd: netVsHodl,
    feeAprPct: (fees / capital) * annualization * 100,
    netAprPct: (netVsHodl / capital) * annualization * 100,
    durationSeconds,
    inBasePct: (inBase / position.length) * 100,
    inGuardPct: (inGuard / position.length) * 100,
  };
}

async function loadTarget(target) {
  const dir = path.join(SWAPS, target);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  const seen = new Set();
  const rows = [];
  for (const f of files) {
    const text = await readFile(path.join(dir, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      const key = `${r.txHash}:${r.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
  }
  rows.sort((a, b) =>
    BigInt(a.blockNumber) < BigInt(b.blockNumber)
      ? -1
      : BigInt(a.blockNumber) > BigInt(b.blockNumber)
        ? 1
        : Number(a.logIndex) - Number(b.logIndex),
  );
  return rows;
}

async function main() {
  const cfg = args();
  let rows = await loadTarget(cfg.target);
  if (!rows.length) throw new Error(`no swaps for ${cfg.target}`);

  if (cfg.days > 0) {
    const last = rows[rows.length - 1];
    const lastTs = last.timestamp || Number(last.blockNumber) * 0.1;
    const cutoff = lastTs - cfg.days * 86_400;
    rows = rows.filter((r) => (r.timestamp || Number(r.blockNumber) * 0.1) >= cutoff);
  }

  const result = pnl(
    rows,
    cfg.feePips,
    cfg.capital,
    cfg.halfWidthTicks,
    cfg.guardTicks,
    cfg.guardShare,
    cfg.token0Decimals,
    cfg.token1Decimals,
    cfg.quoteSymbol,
  );
  result.windowDays = cfg.days || null;
  await mkdir(OUT, { recursive: true });
  const file = path.join(
    OUT,
    `${cfg.target}-fee${cfg.feePips}${cfg.days ? `-${cfg.days}d` : ""}.json`,
  );
  await writeFile(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`wrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
