import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scanReferencePools } from "../reference-scan.mjs";
import { buildMarketView } from "../market-view.mjs";

const ADDRESSES = {
  quote: "0x1111111111111111111111111111111111111111",
  equity: "0x2222222222222222222222222222222222222222",
  pool: "0x3333333333333333333333333333333333333333",
  manager: "0x4444444444444444444444444444444444444444",
  weth: "0x5555555555555555555555555555555555555555",
  otherPool: "0x6666666666666666666666666666666666666666",
  outsider: "0x7777777777777777777777777777777777777777",
};

const POOL_ID = `0x${"ab".repeat(32)}`;
const HEAD = 1_000_000n;
const POOL_L = 1_000_000_000_000_000n;
const SPOT = 180;
const TICK_BASE = 1.0001;
const Q_DEC = 6;
const E_DEC = 18;

function approx(actual, expected, rel = 1e-6, label = "") {
  const ok =
    Number.isFinite(actual) && Math.abs(actual - expected) <= Math.abs(expected) * rel;
  assert.ok(ok, `${label || "value"}: expected ~${expected}, got ${actual}`);
}

/** Raw token1/token0 price for a human quote-per-equity price. */
function rawPriceFor(price, quoteIsToken0, quoteDecimals = Q_DEC, equityDecimals = E_DEC) {
  const scale = 10 ** (equityDecimals - quoteDecimals);
  return quoteIsToken0 ? scale / price : price / scale;
}

function sqrtX96ForRawPrice(raw) {
  return BigInt(Math.round(Math.sqrt(raw) * 2 ** 96));
}

function tickForRaw(raw) {
  return Math.round(Math.log(raw) / Math.log(TICK_BASE));
}

function market(price = SPOT, quoteIsToken0 = true, quoteDecimals = Q_DEC, equityDecimals = E_DEC) {
  const raw = rawPriceFor(price, quoteIsToken0, quoteDecimals, equityDecimals);
  return { raw, sqrtPriceX96: sqrtX96ForRawPrice(raw), tick: tickForRaw(raw) };
}

function makeSwap({
  quoteIsToken0 = true,
  quoteAmount = 1_000n * 10n ** 6n,
  blockNumber,
  sender = ADDRESSES.outsider,
  logIndex = 0,
  fee,
  spot = market(SPOT, quoteIsToken0),
} = {}) {
  const args = {
    sender,
    recipient: ADDRESSES.otherPool,
    amount0: quoteIsToken0 ? -quoteAmount : 0n,
    amount1: quoteIsToken0 ? 0n : -quoteAmount,
    sqrtPriceX96: spot.sqrtPriceX96,
    liquidity: POOL_L,
    tick: spot.tick,
  };
  if (fee !== undefined) args.fee = fee;
  return {
    args,
    blockNumber,
    logIndex,
    transactionHash: `0x${String(blockNumber).padStart(64, "0")}`,
  };
}

function makeConfig({ reference = {}, allocator = {}, addresses = {} } = {}) {
  return {
    addresses: {
      quote: ADDRESSES.quote,
      equity: ADDRESSES.equity,
      weth: ADDRESSES.weth,
      ...addresses,
    },
    allocator: {
      blockTimeSeconds: 0.1,
      rangeHalfWidthBps: 1_000,
      ...allocator,
    },
    pools: { manager: ADDRESSES.manager },
    reference: {
      allocUsd: 1_000,
      windowSeconds: 86_400,
      fastWindowSeconds: 21_600,
      maxStaleSeconds: 1_800,
      logsChunkBlocks: 50_000,
      ...reference,
    },
  };
}

function makeClient({ reads = {}, logs = [], failLogsFor = null } = {}) {
  const readCalls = [];
  const logCalls = [];
  return {
    readCalls,
    logCalls,
    async readContract(request) {
      readCalls.push(request);
      const key = `${String(request.address).toLowerCase()}.${request.functionName}`;
      const value = reads[key];
      if (value === undefined) throw new Error(`unexpected read: ${key}`);
      return typeof value === "function" ? value(request) : value;
    },
    async getLogs(query) {
      logCalls.push(query);
      if (
        failLogsFor != null &&
        String(query.address).toLowerCase() === String(failLogsFor).toLowerCase()
      ) {
        throw new Error("rpc down");
      }
      return logs.filter(
        (entry) =>
          entry.blockNumber >= query.fromBlock && entry.blockNumber <= query.toBlock,
      );
    },
  };
}

function v3Reads({
  quoteIsToken0 = true,
  fee = 500n,
  tickSpacing = 10n,
  spot = market(SPOT, quoteIsToken0),
  poolAddress = ADDRESSES.pool,
  quoteToken = ADDRESSES.quote,
  equityToken = ADDRESSES.equity,
  quoteDecimals = 6n,
  equityDecimals = 18n,
} = {}) {
  const base = String(poolAddress).toLowerCase();
  const token0 = quoteIsToken0 ? quoteToken : equityToken;
  const token1 = quoteIsToken0 ? equityToken : quoteToken;
  return {
    [`${base}.token0`]: token0,
    [`${base}.token1`]: token1,
    [`${base}.fee`]: fee,
    [`${base}.tickSpacing`]: tickSpacing,
    [`${base}.slot0`]: [spot.sqrtPriceX96, spot.tick, 0, 0, 0, 0, true],
    [`${base}.liquidity`]: POOL_L,
    [`${String(quoteToken).toLowerCase()}.decimals`]: quoteDecimals,
    [`${String(equityToken).toLowerCase()}.decimals`]: equityDecimals,
  };
}

function v4Reads({
  lpFee = 3_000n,
  spot = market(SPOT, true),
  manager = ADDRESSES.manager,
  quoteToken = ADDRESSES.quote,
  equityToken = ADDRESSES.equity,
} = {}) {
  const base = String(manager).toLowerCase();
  return {
    [`${base}.getSlot0`]: [spot.sqrtPriceX96, spot.tick, 0, lpFee],
    [`${base}.getLiquidity`]: POOL_L,
    [`${String(quoteToken).toLowerCase()}.decimals`]: 6n,
    [`${String(equityToken).toLowerCase()}.decimals`]: 18n,
  };
}

function v3Pool(overrides = {}) {
  return {
    name: "ext-usd-v3",
    kind: "v3",
    pair: "nvda-usd",
    enabled: true,
    address: ADDRESSES.pool,
    quoteToken: ADDRESSES.quote,
    equityToken: ADDRESSES.equity,
    feePips: 500,
    ...overrides,
  };
}

function v4Pool(overrides = {}) {
  return {
    name: "ext-usd-v4",
    kind: "v4",
    pair: "nvda-usd",
    enabled: true,
    poolId: POOL_ID,
    tickSpacing: 60,
    quoteToken: ADDRESSES.quote,
    equityToken: ADDRESSES.equity,
    ...overrides,
  };
}

test("v3: quote is token0, volume, fees, price, liquidity", async () => {
  const spot = market(SPOT, true);
  const logs = [
    makeSwap({ blockNumber: 999_000n, logIndex: 0, sender: ADDRESSES.outsider, spot }),
    makeSwap({ blockNumber: 999_500n, logIndex: 1, sender: ADDRESSES.otherPool, spot }),
  ];
  const client = makeClient({ reads: v3Reads({ quoteIsToken0: true, spot }), logs });

  const { observations, errors } = await scanReferencePools({
    publicClient: client,
    pools: [v3Pool()],
    blockNumber: HEAD,
    config: makeConfig(),
  });

  assert.deepEqual(errors, []);
  assert.equal(observations.length, 1);
  const o = observations[0];
  assert.equal(o.name, "ext-usd-v3");
  assert.equal(o.kind, "v3");
  assert.equal(o.feePips, 500);
  assert.equal(o.quoteIsToken0, true);
  approx(o.price, 180, 1e-9, "spot");
  approx(o.twapPrice, 180, 1e-9, "twap");
  assert.equal(o.volume24h, 2_000);
  assert.equal(o.volume6h, 2_000);
  assert.equal(o.fees24h, 1);
  assert.equal(o.fees6h, 1);
  assert.equal(o.swaps24h, 2);
  assert.equal(o.uniqueSenders24h, 2);
  assert.equal(o.lastSwapAgeSeconds, 50);
  assert.equal(o.fresh, true);
  assert.ok(o.liquidityUsd > 20_000 && o.liquidityUsd < 35_000, `liquidity ${o.liquidityUsd}`);
  assert.ok(o.ourShareBps > 0 && o.ourShareBps < 10_000, `share ${o.ourShareBps}`);
  assert.ok(o.feeApr24h > 0);
  assert.ok(o.ilBps >= 0);
  assert.ok(
    Math.abs(o.netApr24h - (o.feeApr24h - o.ilApr24h)) <= 1,
    "net APR is fee APR minus IL APR",
  );
  assert.equal(o.tickLower % 10, 0);
  assert.equal(o.tickUpper % 10, 0);
});

test("v3: quote is token1, price is not inverted", async () => {
  const spot = market(SPOT, false);
  const logs = [
    makeSwap({
      quoteIsToken0: false,
      quoteAmount: 750n * 10n ** 6n,
      blockNumber: 999_000n,
      logIndex: 0,
      spot,
    }),
    makeSwap({
      quoteIsToken0: false,
      quoteAmount: 750n * 10n ** 6n,
      blockNumber: 999_500n,
      logIndex: 1,
      sender: ADDRESSES.otherPool,
      spot,
    }),
  ];
  const client = makeClient({ reads: v3Reads({ quoteIsToken0: false, spot }), logs });

  const { observations, errors } = await scanReferencePools({
    publicClient: client,
    pools: [v3Pool()],
    blockNumber: HEAD,
    config: makeConfig(),
  });

  assert.deepEqual(errors, []);
  const o = observations[0];
  assert.equal(o.quoteIsToken0, false);
  approx(o.price, 180, 1e-9);
  approx(o.twapPrice, 180, 1e-9);
  assert.equal(o.volume24h, 1_500);
  assert.equal(o.volume6h, 1_500);
  assert.equal(o.fees24h, 0.75);
  assert.equal(o.fresh, true);
  assert.ok(o.liquidityUsd > 20_000 && o.liquidityUsd < 35_000);
});

test("v3: on-chain fee and tick spacing fill a missing entry fee", async () => {
  const spot = market(SPOT, true);
  const logs = [
    makeSwap({ blockNumber: 999_000n, logIndex: 0, spot }),
    makeSwap({ blockNumber: 999_500n, logIndex: 1, spot }),
  ];
  const client = makeClient({
    reads: v3Reads({ quoteIsToken0: true, fee: 3_000n, tickSpacing: 60n, spot }),
    logs,
  });

  const { observations } = await scanReferencePools({
    publicClient: client,
    pools: [v3Pool({ feePips: undefined })],
    blockNumber: HEAD,
    config: makeConfig(),
  });

  const o = observations[0];
  assert.equal(o.feePips, 3_000);
  assert.equal(o.tickSpacing, 60);
  assert.equal(o.fees24h, 6); // 2,000 * 0.30%
});

test("v4: dynamic per-swap fee wins over pool fee, volume and args.id", async () => {
  const spot = market(SPOT, true);
  const logs = [
    makeSwap({ blockNumber: 999_000n, logIndex: 0, fee: 500n, spot }),
    makeSwap({ blockNumber: 999_300n, logIndex: 1, sender: ADDRESSES.otherPool, fee: 3_000n, spot }),
  ];
  const client = makeClient({ reads: v4Reads({ lpFee: 3_000n, spot }), logs });

  const { observations, errors } = await scanReferencePools({
    publicClient: client,
    pools: [v4Pool()],
    blockNumber: HEAD,
    config: makeConfig(),
  });

  assert.deepEqual(errors, []);
  const o = observations[0];
  assert.equal(o.kind, "v4");
  assert.equal(o.feePips, 3_000);
  assert.equal(o.quoteIsToken0, true);
  approx(o.price, 180, 1e-9);
  assert.equal(o.volume24h, 2_000);
  assert.equal(o.fees24h, 3.5); // 1,000 * 0.05% + 1,000 * 0.30%
  assert.equal(o.swaps24h, 2);
  assert.equal(o.lastSwapAgeSeconds, 70);
  assert.equal(o.fresh, true);

  assert.ok(client.logCalls.length > 0);
  for (const query of client.logCalls) {
    assert.equal(query.address, ADDRESSES.manager);
    assert.deepEqual(query.args, { id: POOL_ID });
    assert.ok(query.event, "v4 query carries the Swap event");
  }
});

test("v3: stale pool is not fresh", async () => {
  const spot = market(SPOT, true);
  const logs = [makeSwap({ blockNumber: 980_000n, logIndex: 0, spot })];
  const client = makeClient({ reads: v3Reads({ quoteIsToken0: true, spot }), logs });

  const { observations, errors } = await scanReferencePools({
    publicClient: client,
    pools: [v3Pool()],
    blockNumber: HEAD,
    config: makeConfig(),
  });

  assert.deepEqual(errors, []);
  const o = observations[0];
  assert.equal(o.swaps24h, 1);
  assert.equal(o.lastSwapAgeSeconds, 2_000);
  assert.equal(o.fresh, false);
  assert.equal(o.error, undefined);
});

test("empty window: no swaps marks the observation stale with an error", async () => {
  const client = makeClient({ reads: v3Reads(), logs: [] });

  const { observations, errors } = await scanReferencePools({
    publicClient: client,
    pools: [v3Pool()],
    blockNumber: HEAD,
    config: makeConfig(),
  });

  const o = observations[0];
  assert.equal(o.swaps24h, 0);
  assert.equal(o.fresh, false);
  assert.equal(o.error, "no swaps");
  assert.equal(o.lastSwapAgeSeconds, null);
  assert.equal(o.volume24h, 0);
  assert.equal(o.fees24h, 0);
  assert.equal(o.netApr24h, 0);
  approx(o.twapPrice, o.price, 1e-12, "TWAP falls back to spot");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no swaps/);
});

test("orientation mismatch becomes an error observation, not a throw", async () => {
  const spot = market(SPOT, true);
  const base = ADDRESSES.pool.toLowerCase();
  const reads = {
    [`${base}.token0`]: ADDRESSES.outsider,
    [`${base}.token1`]: ADDRESSES.otherPool,
    [`${base}.fee`]: 500n,
    [`${base}.tickSpacing`]: 10n,
    [`${base}.slot0`]: [spot.sqrtPriceX96, spot.tick, 0, 0, 0, 0, true],
    [`${base}.liquidity`]: POOL_L,
  };
  const client = makeClient({ reads });

  const { observations, errors } = await scanReferencePools({
    publicClient: client,
    pools: [v3Pool()],
    blockNumber: HEAD,
    config: makeConfig(),
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0].error, "tokens-mismatch");
  assert.equal(observations[0].fresh, false);
  assert.equal(client.logCalls.length, 0, "no logs without a usable token pair");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /tokens-mismatch/);
});

test("batch: one failing pool does not reject the others", async () => {
  const spot = market(SPOT, true);
  const logs = [makeSwap({ blockNumber: 999_500n, logIndex: 0, spot })];
  const reads = {
    ...v3Reads({ quoteIsToken0: true, spot, poolAddress: ADDRESSES.pool }),
    ...v3Reads({ quoteIsToken0: true, spot, poolAddress: ADDRESSES.otherPool }),
  };
  const client = makeClient({
    reads,
    logs,
    failLogsFor: ADDRESSES.otherPool,
  });

  const { observations, errors } = await scanReferencePools({
    publicClient: client,
    pools: [
      v3Pool(),
      v3Pool({ name: "broken-v3", address: ADDRESSES.otherPool }),
    ],
    blockNumber: HEAD,
    config: makeConfig(),
  });

  assert.equal(observations.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(observations[0].name, "ext-usd-v3");
  assert.equal(observations[0].fresh, true);
  assert.equal(observations[1].name, "broken-v3");
  assert.equal(observations[1].fresh, false);
  assert.match(observations[1].error, /rpc down/);
  assert.match(errors[0], /broken-v3/);
});

test("disabled entries are skipped without reads", async () => {
  const spot = market(SPOT, true);
  const logs = [makeSwap({ blockNumber: 999_500n, logIndex: 0, spot })];
  const client = makeClient({ reads: v3Reads({ quoteIsToken0: true, spot }), logs });

  const { observations, errors } = await scanReferencePools({
    publicClient: client,
    pools: [
      v3Pool(),
      v3Pool({ name: "off", enabled: false, address: "" }),
    ],
    blockNumber: HEAD,
    config: makeConfig(),
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0].name, "ext-usd-v3");
  assert.deepEqual(errors, []);
  assert.equal(client.logCalls.length, 18); // 24h window / 50k chunks, one pool
});

test("chunked getLogs: v3 queries the pool, v4 queries the manager with the id", async () => {
  const spot = market(SPOT, true);

  const v3Client = makeClient({ reads: v3Reads({ quoteIsToken0: true, spot }), logs: [] });
  await scanReferencePools({
    publicClient: v3Client,
    pools: [v3Pool()],
    blockNumber: HEAD,
    config: makeConfig(),
  });

  assert.equal(v3Client.logCalls.length, 18);
  assert.equal(v3Client.logCalls[0].fromBlock, 136_000n);
  assert.equal(v3Client.logCalls[0].toBlock, 185_999n);
  assert.equal(v3Client.logCalls.at(-1).fromBlock, 986_000n);
  assert.equal(v3Client.logCalls.at(-1).toBlock, HEAD);
  for (const query of v3Client.logCalls) {
    assert.equal(query.address, ADDRESSES.pool);
    assert.equal(query.args, undefined);
    assert.ok(query.event, "v3 query carries the Swap event");
  }

  const v4Client = makeClient({
    reads: v4Reads({ spot }),
    logs: [],
  });
  await scanReferencePools({
    publicClient: v4Client,
    pools: [v4Pool()],
    blockNumber: HEAD,
    config: makeConfig({ reference: { logsChunkBlocks: 100_000 } }),
  });

  assert.equal(v4Client.logCalls.length, 9);
  assert.equal(v4Client.logCalls[0].fromBlock, 136_000n);
  assert.equal(v4Client.logCalls.at(-1).toBlock, HEAD);
  for (const query of v4Client.logCalls) {
    assert.equal(query.address, ADDRESSES.manager);
    assert.deepEqual(query.args, { id: POOL_ID });
  }
});

test("token defaults: nvda-eth falls back to WETH/equity from config", async () => {
  const spot = market(0.05, true, 18, 18);
  const logs = [makeSwap({ blockNumber: 999_500n, logIndex: 0, spot })];
  const client = makeClient({
    reads: v3Reads({
      quoteIsToken0: true,
      spot,
      quoteToken: ADDRESSES.weth,
      quoteDecimals: 18n,
    }),
    logs,
  });

  const { observations, errors } = await scanReferencePools({
    publicClient: client,
    pools: [
      v3Pool({
        name: "ext-eth-v3",
        pair: "nvda-eth",
        quoteToken: "",
        equityToken: "",
      }),
    ],
    blockNumber: HEAD,
    config: makeConfig(),
  });

  assert.deepEqual(errors, []);
  const o = observations[0];
  assert.equal(o.pair, "nvda-eth");
  assert.equal(o.quoteIsToken0, true);
  approx(o.price, 0.05, 1e-9);
  assert.ok(
    client.readCalls.some(
      (call) =>
        String(call.address).toLowerCase() === ADDRESSES.weth &&
        call.functionName === "decimals",
    ),
    "WETH decimals were read from the config default",
  );
});

test("TWAP uses the 30-minute subset, not the full 24h window", async () => {
  const oldSpot = market(100, true);
  const recentSpot = market(190, true);
  const logs = [
    makeSwap({ blockNumber: 900_000n, logIndex: 0, spot: oldSpot }),
    makeSwap({ blockNumber: 999_000n, logIndex: 1, spot: recentSpot }),
    makeSwap({ blockNumber: 999_500n, logIndex: 2, spot: recentSpot }),
  ];
  const client = makeClient({
    reads: v3Reads({ quoteIsToken0: true, spot: market(SPOT, true) }),
    logs,
  });

  const { observations } = await scanReferencePools({
    publicClient: client,
    pools: [v3Pool()],
    blockNumber: HEAD,
    config: makeConfig(),
  });

  const o = observations[0];
  approx(o.price, 180, 1e-9, "spot");
  approx(o.twapPrice, 190, 1e-9, "30m TWAP");
  assert.equal(o.swaps24h, 3);
  assert.ok(o.ilBps > 0, "old excursion makes the worst IL positive");
});

test("observations feed market-view without adaptation", async () => {
  const spot = market(SPOT, true);
  const logs = [
    makeSwap({ blockNumber: 999_000n, logIndex: 0, spot }),
    makeSwap({ blockNumber: 999_500n, logIndex: 1, sender: ADDRESSES.otherPool, spot }),
  ];
  const client = makeClient({ reads: v3Reads({ quoteIsToken0: true, spot }), logs });
  const config = makeConfig();

  const { observations } = await scanReferencePools({
    publicClient: client,
    pools: [v3Pool()],
    blockNumber: HEAD,
    config,
  });
  const view = buildMarketView({
    observations,
    oracle: { nvdaUsd: SPOT, ethUsd: 3_000 },
    config,
  });

  assert.equal(view.pools.length, 1);
  assert.equal(view.pools[0].status, "healthy");
  assert.equal(view.pools[0].reason, "ok");
  assert.equal(view.pools[0].lastSwapAgeSeconds, 50);
  assert.equal(view.pools[0].ilBps, observations[0].ilBps);
  assert.equal(view.pools[0].liquidityUsd, observations[0].liquidityUsd);
  assert.ok(view.healthy.length === 1);
});

test("source stays free of hardcoded market addresses", () => {
  const source = readFileSync(new URL("../reference-scan.mjs", import.meta.url), "utf8");
  assert.equal(/0x[0-9a-fA-F]{40}/.test(source), false, "hardcoded address found");
  for (const banned of ["process.env", "KEEPER_USDG", "KEEPER_NVDA", "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3"]) {
    assert.equal(source.includes(banned), false, `baked-in value found: ${banned}`);
  }
});
