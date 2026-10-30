// Build the cadCAD allocator scenario from the downloaded Uniswap swap tapes.
//
// Output: one row per hour with, per book:
//   - price / tick path (open, close, high, low, avg)
//   - USDG volume and pool fee notional
//   - fee-share moments: sum(volume / L) and sum(volume / L^2)
//   - pool active liquidity (mean / last, USD)
//   - the 12 five-minute price moves used by the guard-pull model
//   - trailing 36-minute risk stats (volatility, volume, fee moments, ticks)
//
// Book A is the V4 0.05% book in the allocator, but the downloaded set has no
// V4 USDG/NVDA 0.05% pool. We use the V3 USDG/NVDA 0.05% tape as the
// fee-equivalent proxy and mark it in meta. Book B is the real V4 0.30% pool.
//
//   node scripts/research/build_allocator_scenario.mjs
//   node scripts/research/build_allocator_scenario.mjs --guard-bps 50 --out research/cadcad/allocator/data/scenario_45d_guard50.json
//
// Reads only local files. No RPC.

import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";

const Q96 = 2 ** 96;

function args() {
  const a = process.argv.slice(2);
  const out = {
    bookA: "research/data/swaps-45d/v3-usdg-nvda-005",
    bookB: "research/data/swaps-45d/v4-usdg-nvda-030",
    out: "research/cadcad/allocator/data/scenario_45d.json",
    feeA: 500,
    feeB: 3000,
    hours: 1080,
    guardBps: 200,
    riskMinutes: 36,
  };
  for (let i = 0; i < a.length; i += 1) {
    const k = a[i];
    const v = a[i + 1];
    if (k === "--book-a") out.bookA = v;
    else if (k === "--book-b") out.bookB = v;
    else if (k === "--out") out.out = v;
    else if (k === "--fee-a") out.feeA = Number(v);
    else if (k === "--fee-b") out.feeB = Number(v);
    else if (k === "--hours") out.hours = Number(v);
    else if (k === "--guard-bps") out.guardBps = Number(v);
    else if (k === "--risk-minutes") out.riskMinutes = Number(v);
    else continue;
    i += 1;
  }
  return out;
}

function emptyBin() {
  return {
    priceOpen: 0,
    priceClose: 0,
    priceHigh: -Infinity,
    priceLow: Infinity,
    priceSum: 0,
    priceCount: 0,
    tickOpen: null,
    tickClose: null,
    volume: 0,
    swaps: 0,
    volOverL: 0,
    volOverL2: 0,
    lSum: 0,
    lCount: 0,
    lLast: 0,
    sqrtPLast: 0,
  };
}

function addToBin(bin, price, tick, volume, lHuman, sqrtP) {
  if (bin.priceOpen === 0) bin.priceOpen = price;
  bin.priceClose = price;
  if (price > bin.priceHigh) bin.priceHigh = price;
  if (price < bin.priceLow) bin.priceLow = price;
  bin.priceSum += price;
  bin.priceCount += 1;
  if (bin.tickOpen === null) bin.tickOpen = tick;
  bin.tickClose = tick;
  bin.volume += volume;
  bin.swaps += 1;
  if (lHuman > 0) {
    bin.volOverL += volume / lHuman;
    bin.volOverL2 += volume / (lHuman * lHuman);
    bin.lSum += lHuman;
    bin.lCount += 1;
    bin.lLast = lHuman;
  }
  if (sqrtP > 0) bin.sqrtPLast = sqrtP;
}

function finishBin(bin) {
  const priceAvg = bin.priceCount > 0 ? bin.priceSum / bin.priceCount : 0;
  const lMean = bin.lCount > 0 ? bin.lSum / bin.lCount : 0;
  return {
    ...bin,
    priceHigh: Number.isFinite(bin.priceHigh) ? bin.priceHigh : 0,
    priceLow: Number.isFinite(bin.priceLow) ? bin.priceLow : 0,
    priceAvg,
    lMean,
    // Virtual active-liquidity value: 2L/sqrtP, in USDG.
    poolLiquidityUsd:
      lMean > 0 && bin.sqrtPLast > 0 ? (2 * lMean * 1e18) / bin.sqrtPLast / 1e6 : 0,
  };
}

async function readSwaps(file, t0, hours, feePips) {
  const hourBins = Array.from({ length: hours }, emptyBin);
  const fiveBins = Array.from({ length: hours * 12 }, emptyBin);
  const minuteBins = Array.from({ length: hours * 60 }, emptyBin);

  let firstTs = null;
  let lastTs = null;
  let rows = 0;
  let skipped = 0;

  const rl = readline.createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let s;
    try {
      s = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const ts = Number(s.timestamp);
    if (!Number.isFinite(ts)) {
      skipped += 1;
      continue;
    }
    if (t0 === null) t0 = ts;
    if (firstTs === null) firstTs = ts;
    lastTs = ts;

    const dt = ts - t0;
    if (dt < 0) {
      skipped += 1;
      continue;
    }
    const h = Math.floor(dt / 3600);
    if (h < 0 || h >= hours) {
      skipped += 1;
      continue;
    }

    const sqrtX96 = Number(s.sqrtPriceX96);
    if (!(sqrtX96 > 0) || !Number.isFinite(sqrtX96)) {
      skipped += 1;
      continue;
    }
    const sqrtP = sqrtX96 / Q96;
    const rawPrice = sqrtP * sqrtP; // raw token1/token0
    const human = rawPrice * 1e-12; // token0=6dp, token1=18dp
    if (!(human > 0) || !Number.isFinite(human)) {
      skipped += 1;
      continue;
    }
    const price = 1 / human; // USDG per NVDA
    const tick = Number(s.tick);
    if (!Number.isFinite(tick)) {
      skipped += 1;
      continue;
    }

    let volume = Math.abs(Number(s.amount0)) / 1e6;
    if (!(volume > 0)) {
      const amount1 = Math.abs(Number(s.amount1)) / 1e18;
      volume = amount1 * price;
    }
    if (!(volume >= 0) || !Number.isFinite(volume)) {
      skipped += 1;
      continue;
    }

    const lHuman = Number(s.liquidity) / 1e18;
    const f = Math.floor(dt / 300);
    const m = Math.floor(dt / 60);

    addToBin(hourBins[h], price, tick, volume, lHuman, sqrtP);
    if (f >= 0 && f < fiveBins.length) addToBin(fiveBins[f], price, tick, volume, lHuman, sqrtP);
    if (m >= 0 && m < minuteBins.length) addToBin(minuteBins[m], price, tick, volume, lHuman, sqrtP);
    rows += 1;
  }

  return {
    hourBins: hourBins.map(finishBin),
    fiveBins: fiveBins.map(finishBin),
    minuteBins: minuteBins.map(finishBin),
    rows,
    skipped,
    firstTs,
    lastTs,
    feePips,
  };
}

function aggregateRisk(minuteBins, hour, riskMinutes) {
  const start = hour * 60 + Math.max(0, 60 - riskMinutes);
  const end = hour * 60 + 60;
  let volume = 0;
  let volOverL = 0;
  let volOverL2 = 0;
  let high = -Infinity;
  let low = Infinity;
  let sum = 0;
  let count = 0;
  let tickFirst = null;
  let tickLast = null;
  let priceFirst = 0;
  let priceLast = 0;
  let lSum = 0;
  let lCount = 0;
  let sqrtPLast = 0;
  let swaps = 0;

  for (let i = start; i < end && i < minuteBins.length; i += 1) {
    const b = minuteBins[i];
    if (b.swaps === 0) continue;
    volume += b.volume;
    volOverL += b.volOverL;
    volOverL2 += b.volOverL2;
    if (b.priceHigh > high) high = b.priceHigh;
    if (b.priceLow < low) low = b.priceLow;
    sum += b.priceSum;
    count += b.priceCount;
    if (tickFirst === null) tickFirst = b.tickOpen;
    tickLast = b.tickClose;
    if (priceFirst === 0) priceFirst = b.priceOpen;
    priceLast = b.priceClose;
    lSum += b.lSum;
    lCount += b.lCount;
    if (b.sqrtPLast > 0) sqrtPLast = b.sqrtPLast;
    swaps += b.swaps;
  }

  const avg = count > 0 ? sum / count : 0;
  const lMean = lCount > 0 ? lSum / lCount : 0;
  return {
    volumeUsd: volume,
    volatilityBps: avg > 0 && high > -Infinity ? Math.round(((high - low) / avg) * 10_000) : 0,
    volOverL,
    volOverL2,
    tickFirst,
    tickLast,
    priceFirst,
    priceLast,
    priceAvg: avg,
    priceHigh: Number.isFinite(high) ? high : 0,
    priceLow: Number.isFinite(low) ? low : 0,
    poolLMean: lMean,
    poolLiquidityUsd:
      lMean > 0 && sqrtPLast > 0 ? (2 * lMean * 1e18) / sqrtPLast / 1e6 : 0,
    swaps,
  };
}

function fiveMinMoves(fiveBins, hour, guardBps) {
  const moves = [];
  let pulls = 0;
  let maxMove = 0;
  let prevClose = 0;

  for (let i = 0; i < 12; i += 1) {
    const b = fiveBins[hour * 12 + i];
    if (!b || b.swaps === 0 || !(b.priceOpen > 0) || !(b.priceClose > 0)) {
      moves.push(0);
      continue;
    }
    const intra = Math.abs(b.priceClose / b.priceOpen - 1) * 10_000;
    const cross = prevClose > 0 ? Math.abs(b.priceClose / prevClose - 1) * 10_000 : 0;
    const move = Math.max(intra, cross);
    moves.push(Math.round(move));
    if (move > maxMove) maxMove = move;
    if (move > guardBps) pulls += 1;
    prevClose = b.priceClose;
  }

  return { moves, pulls, maxMove: Math.round(maxMove) };
}

function depegProxy(fiveBins, hour) {
  // Price-vs-30-minute-TWAP divergence proxy. This is NOT a Chainlink depeg;
  // it only flags pool-price dislocation. The model keeps depeg exogenous by default.
  const prices = [];
  for (let i = Math.max(0, hour * 12 + 6); i < hour * 12 + 12; i += 1) {
    const b = fiveBins[i];
    if (b && b.swaps > 0 && b.priceAvg > 0) prices.push(b.priceAvg);
  }
  if (prices.length < 3) return 0;
  const twap = prices.reduce((a, b) => a + b, 0) / prices.length;
  const last = prices[prices.length - 1];
  const dev = Math.abs(last / twap - 1) * 10_000;
  const above = prices.filter((p) => Math.abs(p / twap - 1) * 10_000 > 200).length;
  return dev > 200 && above >= 2 ? 1 : 0;
}

function round(x, d = 6) {
  if (!Number.isFinite(x)) return 0;
  const p = 10 ** d;
  return Math.round(x * p) / p;
}

function minutePath(minuteBins, h) {
  const tick = [];
  const volume = [];
  const volOverL = [];
  const volOverL2 = [];
  for (let i = 0; i < 60; i += 1) {
    const b = minuteBins[h * 60 + i];
    if (!b || b.swaps === 0 || b.tickClose === null) {
      tick.push(null);
      volume.push(0);
      volOverL.push(0);
      volOverL2.push(0);
    } else {
      tick.push(b.tickClose);
      volume.push(round(b.volume, 6));
      volOverL.push(round(b.volOverL, 10));
      volOverL2.push(round(b.volOverL2, 14));
    }
  }
  return { tick, volume, volOverL, volOverL2 };
}

function cleanBookRow(book, h, globalTick, globalPrice, lastKnown, minuteBins) {
  const risk = book.risk;
  const empty = book.swaps === 0;
  if (empty) {
    return {
      volumeUsd: 0,
      poolFeesUsd: 0,
      volOverL: 0,
      volOverL2: 0,
      poolLMean: lastKnown?.poolLMean ?? 0,
      poolLLast: lastKnown?.poolLLast ?? 0,
      poolLiquidityUsd: lastKnown?.poolLiquidityUsd ?? 0,
      swaps: 0,
      priceOpen: globalPrice,
      priceClose: globalPrice,
      priceHigh: globalPrice,
      priceLow: globalPrice,
      priceAvg: globalPrice,
      tickOpen: globalTick,
      tickClose: globalTick,
      fiveMinMoves: Array(12).fill(0),
      guardPulls: 0,
      max5mMoveBps: 0,
      depegProxy: 0,
      minutes: minutePath(minuteBins, h),
      risk: {
        volumeUsd: 0,
        volatilityBps: 0,
        volOverL: 0,
        volOverL2: 0,
        tickFirst: globalTick,
        tickLast: globalTick,
        priceFirst: globalPrice,
        priceLast: globalPrice,
        priceAvg: globalPrice,
        priceHigh: globalPrice,
        priceLow: globalPrice,
        poolLMean: lastKnown?.poolLMean ?? 0,
        poolLiquidityUsd: lastKnown?.poolLiquidityUsd ?? 0,
        swaps: 0,
      },
    };
  }
  return {
    volumeUsd: round(book.volume, 6),
    poolFeesUsd: round((book.volume * book.feePips) / 1_000_000, 6),
    volOverL: round(book.volOverL, 10),
    volOverL2: round(book.volOverL2, 14),
    poolLMean: round(book.lMean ?? book.poolLMean ?? 0, 12),
    poolLLast: round(book.lLast ?? book.poolLLast ?? 0, 12),
    poolLiquidityUsd: round(book.poolLiquidityUsd, 2),
    swaps: book.swaps,
    priceOpen: round(book.priceOpen, 6),
    priceClose: round(book.priceClose, 6),
    priceHigh: round(book.priceHigh, 6),
    priceLow: round(book.priceLow, 6),
    priceAvg: round(book.priceAvg, 6),
    tickOpen: book.tickOpen,
    tickClose: book.tickClose,
    fiveMinMoves: book.fiveMinMoves,
    guardPulls: book.guardPulls,
    max5mMoveBps: book.max5mMoveBps,
    depegProxy: book.depegProxy,
    minutes: minutePath(minuteBins, h),
    risk: {
      volumeUsd: round(risk.volumeUsd, 6),
      volatilityBps: risk.volatilityBps,
      volOverL: round(risk.volOverL, 10),
      volOverL2: round(risk.volOverL2, 14),
      tickFirst: risk.tickFirst ?? globalTick,
      tickLast: risk.tickLast ?? globalTick,
      priceFirst: round(risk.priceFirst || globalPrice, 6),
      priceLast: round(risk.priceLast || globalPrice, 6),
      priceAvg: round(risk.priceAvg || globalPrice, 6),
      priceHigh: round(risk.priceHigh || globalPrice, 6),
      priceLow: round(risk.priceLow || globalPrice, 6),
      poolLMean: round(risk.poolLMean, 12),
      poolLiquidityUsd: round(risk.poolLiquidityUsd, 2),
      swaps: risk.swaps,
    },
  };
}

async function main() {
  const cfg = args();
  const t0 = Date.now();
  console.log("reading Book A:", cfg.bookA);
  const a = await readSwaps(
    path.join(cfg.bookA, "swaps.jsonl"),
    null,
    cfg.hours,
    cfg.feeA,
  );
  console.log("reading Book B:", cfg.bookB);
  const b = await readSwaps(
    path.join(cfg.bookB, "swaps.jsonl"),
    a.firstTs,
    cfg.hours,
    cfg.feeB,
  );

  let lastA = null;
  let lastB = null;
  let lastGlobalPrice = 0;
  let lastGlobalTick = null;

  const rows = [];
  for (let h = 0; h < cfg.hours; h += 1) {
    const hbA = a.hourBins[h];
    const hbB = b.hourBins[h];

    // Global mark: Book A is the high-frequency tape. Fall back to Book B, then
    // to the last known mark.
    let globalPrice = lastGlobalPrice;
    let globalTick = lastGlobalTick;
    if (hbA.swaps > 0 && hbA.priceClose > 0) {
      globalPrice = hbA.priceClose;
      globalTick = hbA.tickClose;
    } else if (hbB.swaps > 0 && hbB.priceClose > 0) {
      globalPrice = hbB.priceClose;
      globalTick = hbB.tickClose;
    }
    if (!(globalPrice > 0)) globalPrice = lastGlobalPrice || hbA.priceAvg || hbB.priceAvg || 0;
    if (globalTick === null) globalTick = lastGlobalTick ?? hbA.tickOpen ?? hbB.tickOpen ?? 0;
    lastGlobalPrice = globalPrice;
    lastGlobalTick = globalTick;

    const riskA = aggregateRisk(a.minuteBins, h, cfg.riskMinutes);
    const riskB = aggregateRisk(b.minuteBins, h, cfg.riskMinutes);
    const gA = fiveMinMoves(a.fiveBins, h, cfg.guardBps);
    const gB = fiveMinMoves(b.fiveBins, h, cfg.guardBps);

    const bookA = cleanBookRow(
      {
        ...hbA,
        feePips: cfg.feeA,
        risk: riskA,
        fiveMinMoves: gA.moves,
        guardPulls: gA.pulls,
        max5mMoveBps: gA.maxMove,
        depegProxy: depegProxy(a.fiveBins, h),
      },
      h,
      globalTick,
      globalPrice,
      lastA,
      a.minuteBins,
    );
    const bookB = cleanBookRow(
      {
        ...hbB,
        feePips: cfg.feeB,
        risk: riskB,
        fiveMinMoves: gB.moves,
        guardPulls: gB.pulls,
        max5mMoveBps: gB.maxMove,
        depegProxy: depegProxy(b.fiveBins, h),
      },
      h,
      globalTick,
      globalPrice,
      lastB,
      b.minuteBins,
    );

    lastA = bookA;
    lastB = bookB;

    rows.push({
      t: h,
      ts: a.firstTs + h * 3600,
      price: round(globalPrice, 6),
      tick: globalTick,
      sqrtP: Math.sqrt(1.0001 ** Number(globalTick)),
      bookA,
      bookB,
    });
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    t0: a.firstTs,
    t1: a.lastTs,
    hours: cfg.hours,
    riskMinutes: cfg.riskMinutes,
    guardThresholdBps: cfg.guardBps,
    bookA: {
      source: cfg.bookA,
      feePips: cfg.feeA,
      proxy: true,
      proxyReason:
        "No V4 USDG/NVDA 0.05% pool exists in the downloaded set; the V3 USDG/NVDA 0.05% tape is used as the fee-equivalent Book A proxy.",
      rows: a.rows,
      skipped: a.skipped,
      firstTs: a.firstTs,
      lastTs: a.lastTs,
    },
    bookB: {
      source: cfg.bookB,
      feePips: cfg.feeB,
      proxy: false,
      rows: b.rows,
      skipped: b.skipped,
      firstTs: b.firstTs,
      lastTs: b.lastTs,
    },
    notes: [
      "volumeUsd is abs(amount0)/1e6 (USDG is token0); if amount0 is zero the amount1 leg is converted at the swap price.",
      "volOverL / volOverL2 are sum(volume / L) and sum(volume / L^2) with L normalized by 1e18. The model uses them to compute the book's fee share L/(poolL+L) to second order.",
      "poolLiquidityUsd is the virtual active-liquidity value 2L/sqrtP, used only for the thin-pool eligibility gate.",
      "fiveMinMoves are the max intra-bin and cross-bin absolute price moves in bps; the model counts guard pulls at any threshold.",
      "depegProxy is a pool-price-vs-30m-TWAP dislocation proxy, not a Chainlink depeg. The model keeps depeg exogenous by default.",
    ],
  };

  await mkdir(path.dirname(cfg.out), { recursive: true });
  await writeFile(cfg.out, JSON.stringify({ meta, hours: rows }));
  const mb = (JSON.stringify({ meta, hours: rows }).length / 1e6).toFixed(2);
  console.log(
    `wrote ${cfg.out} (${rows.length} hours, ${mb} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  console.log(
    `Book A rows=${a.rows} skipped=${a.skipped}; Book B rows=${b.rows} skipped=${b.skipped}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
