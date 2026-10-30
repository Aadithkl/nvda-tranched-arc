import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMarketView } from "../market-view.mjs";

const BASE_REFERENCE = {
  mode: "advisory",
  allocUsd: 1_000,
  windowSeconds: 86_400,
  fastWindowSeconds: 21_600,
  maxPriceDevBps: 200,
  maxDispersionBps: 300,
  maxCrossDevBps: 300,
  maxStaleSeconds: 1_800,
  minHealthy: 2,
  minVolumeUsd: 50_000,
  minSwaps: 50,
  logsChunkBlocks: 50_000,
  pools: [],
};

const BASE_COURSE = {
  bufferBps: 500,
  fastBufferBps: 1_000,
  guardWidthMinBps: 200,
  guardWidthMaxBps: 3_000,
  guardShareMinBps: 1_000,
  guardShareMaxBps: 9_000,
  riskVolMinBps: 150,
  riskVolMaxBps: 1_200,
  riskVolumeMinUsd: 5_000,
  riskVolumeMaxUsd: 100_000,
  baselineVolBps: 300,
  baselineVolumeUsd: 15_000,
  armVolHighBps: 600,
};

function makeConfig({ reference = {}, course = {} } = {}) {
  return {
    reference: { ...BASE_REFERENCE, ...reference },
    course: { ...BASE_COURSE, ...course },
  };
}

function obs(overrides = {}) {
  return {
    name: "usd-500",
    pair: "nvda-usd",
    kind: "v3",
    feePips: 500,
    price: 180,
    twapPrice: 180,
    volume24h: 100_000,
    volume6h: 40_000,
    fees24h: 100,
    fees6h: 20,
    netApr24h: 600,
    netApr6h: 300,
    volatilityBps: 100,
    volatility24hBps: 150,
    ilBps: 50,
    liquidityUsd: 1_000_000,
    ourShareBps: 100,
    swaps24h: 200,
    uniqueSenders24h: 30,
    lastSwapAgeSeconds: 60,
    fresh: true,
    ...overrides,
  };
}

const ORACLE = { nvdaUsd: 180, ethUsd: 3_000 };

function approx(actual, expected, rel = 1e-6, label = "") {
  const ok =
    Number.isFinite(actual) && Math.abs(actual - expected) <= Math.abs(expected) * rel;
  assert.ok(ok, `${label || "value"}: expected ~${expected}, got ${actual}`);
}

function byName(view, name) {
  const pool = view.pools.find((entry) => entry.name === name);
  assert.ok(pool, `missing pool ${name}`);
  return pool;
}

test("view: healthy pools aggregate by pair and fee tier, cross-check passes", () => {
  const view = buildMarketView({
    observations: [
      obs({ name: "usd-500" }),
      obs({
        name: "usd-3000",
        feePips: 3_000,
        price: 181,
        netApr24h: 900,
        netApr6h: 400,
        volume24h: 80_000,
        volume6h: 30_000,
        volatilityBps: 120,
      }),
      obs({
        name: "eth-500",
        pair: "nvda-eth",
        price: 0.06,
        netApr24h: 300,
        netApr6h: 100,
        volume24h: 60_000,
        volume6h: 20_000,
        volatilityBps: 200,
      }),
    ],
    oracle: ORACLE,
    config: makeConfig(),
  });

  assert.equal(view.pools.length, 3);
  assert.equal(view.healthy.length, 3);
  assert.deepEqual(view.excluded, []);
  assert.equal(view.regime, "calm");
  assert.deepEqual(view.warnings, []);

  assert.equal(view.byPair["nvda-usd"].count, 2);
  approx(view.byPair["nvda-usd"].medianPrice, 180.5);
  approx(view.byPair["nvda-usd"].dispersionBps, (0.5 / 180.5) * 10_000);
  approx(view.byPair["nvda-usd"].medianNetApr24h, 750);
  approx(view.byPair["nvda-usd"].bestNetApr24h, 900);
  approx(view.byPair["nvda-usd"].medianNetApr6h, 350);
  approx(view.byPair["nvda-usd"].medianVolume24h, 90_000);
  approx(view.byPair["nvda-usd"].medianVolume6h, 35_000);

  assert.equal(view.byPair["nvda-eth"].count, 1);
  approx(view.byPair["nvda-eth"].medianPrice, 0.06);

  assert.equal(view.byFeeTier["500"].count, 2);
  approx(view.byFeeTier["500"].medianNetApr24h, 450);
  approx(view.byFeeTier["500"].bestNetApr24h, 600);
  assert.equal(view.byFeeTier["3000"].count, 1);
  approx(view.byFeeTier["3000"].medianNetApr24h, 900);
  // Mixed pairs cannot have a meaningful median price.
  assert.equal("medianPrice" in view.byFeeTier["500"], false);

  approx(view.price.nvdaUsd, 180.5);
  approx(view.price.nvdaEth, 0.06);
  approx(view.price.impliedEthUsd, 180.5 / 0.06);
  approx(view.price.dispersionBps, (0.5 / 180.5) * 10_000);
  assert.equal(view.price.crossCheck, true);

  approx(view.medianExternalNetApr, 600);
  approx(view.bestExternalNetApr, 900);
  approx(view.medianVolume24h, 80_000);
  approx(view.medianVol6h, 120);
  approx(view.medianVolatilityBps, 120);
  approx(view.medianVolatility24hBps, 150);
});

test("view: price outlier is excluded, other pools stay healthy", () => {
  const view = buildMarketView({
    observations: [
      obs({ name: "a", price: 180 }),
      obs({ name: "b", price: 181 }),
      obs({ name: "outlier", price: 220 }),
    ],
    oracle: ORACLE,
    config: makeConfig(),
  });

  assert.equal(view.healthy.length, 2);
  assert.equal(view.excluded.length, 1);
  assert.equal(byName(view, "outlier").status, "price-deviation");
  assert.equal(byName(view, "outlier").reason, "price-outlier");
  approx(byName(view, "outlier").priceDeviationBps, (40 / 180) * 10_000);
  assert.equal(view.price.crossCheck, null);
  assert.ok(view.warnings.includes("excluded:outlier:price-deviation"));
  assert.ok(view.warnings.includes("cross-check-unavailable"));
  assert.equal(view.regime, "calm");
});

test("view: stale observations cover fresh=false, age and unknown age", () => {
  const view = buildMarketView({
    observations: [
      obs({ name: "not-fresh", fresh: false }),
      obs({ name: "old", lastSwapAgeSeconds: 2_000 }),
      obs({ name: "unknown", lastSwapAgeSeconds: null }),
    ],
    oracle: ORACLE,
    config: makeConfig(),
  });

  assert.equal(byName(view, "not-fresh").status, "stale");
  assert.equal(byName(view, "not-fresh").reason, "not-fresh");
  assert.equal(byName(view, "old").status, "stale");
  assert.equal(byName(view, "old").reason, "max-stale-exceeded");
  assert.equal(byName(view, "unknown").status, "stale");
  assert.equal(byName(view, "unknown").reason, "unknown-swap-age");
  assert.equal(view.healthy.length, 0);
  assert.equal(view.regime, "uncertain");
});

test("view: thin observations distinguish volume and swap depth", () => {
  const view = buildMarketView({
    observations: [
      obs({ name: "low-volume", volume24h: 10_000 }),
      obs({ name: "low-swaps", swaps24h: 10 }),
      obs({ name: "both", volume24h: 10_000, swaps24h: 10 }),
    ],
    oracle: ORACLE,
    config: makeConfig(),
  });

  assert.equal(byName(view, "low-volume").status, "thin");
  assert.equal(byName(view, "low-volume").reason, "below-min-volume");
  assert.equal(byName(view, "low-swaps").status, "thin");
  assert.equal(byName(view, "low-swaps").reason, "below-min-swaps");
  assert.equal(byName(view, "both").status, "thin");
  assert.equal(byName(view, "both").reason, "below-min-volume-and-swaps");
});

test("view: no price, missing oracle and scanner errors are excluded", () => {
  const missingPrice = buildMarketView({
    observations: [obs({ name: "zero", price: 0 }), obs({ name: "null", price: null })],
    oracle: ORACLE,
    config: makeConfig(),
  });
  assert.equal(byName(missingPrice, "zero").status, "no-data");
  assert.equal(byName(missingPrice, "zero").reason, "no-price");
  assert.equal(byName(missingPrice, "null").status, "no-data");

  const noOracle = buildMarketView({
    observations: [obs({ name: "eth", pair: "nvda-eth", price: 0.06 })],
    oracle: { nvdaUsd: 180, ethUsd: 0 },
    config: makeConfig(),
  });
  assert.equal(byName(noOracle, "eth").status, "no-data");
  assert.equal(byName(noOracle, "eth").reason, "no-oracle");
  assert.ok(noOracle.warnings.includes("missing-oracle-eth-usd"));

  const errored = buildMarketView({
    observations: [obs({ name: "bad", error: "rpc-timeout" })],
    oracle: ORACLE,
    config: makeConfig(),
  });
  assert.equal(byName(errored, "bad").status, "error");
  assert.equal(byName(errored, "bad").reason, "pool-error");
});

test("view: pair dispersion above the limit makes the regime uncertain", () => {
  const view = buildMarketView({
    observations: [obs({ name: "a", price: 180 }), obs({ name: "b", price: 182 })],
    oracle: { nvdaUsd: 181, ethUsd: 3_000 },
    config: makeConfig({
      reference: { maxPriceDevBps: 1_000, maxDispersionBps: 50 },
    }),
  });

  assert.equal(view.healthy.length, 2);
  approx(view.price.dispersionBps, (1 / 181) * 10_000);
  assert.equal(view.regime, "uncertain");
  assert.ok(view.warnings.includes("dispersion:nvda-usd"));
  assert.ok(view.warnings.includes("regime-uncertain"));
});

test("view: cross-pair ETH/USD disagreement makes the regime uncertain", () => {
  const view = buildMarketView({
    observations: [
      obs({ name: "usd", price: 180 }),
      obs({ name: "eth", pair: "nvda-eth", price: 0.05 }),
    ],
    oracle: ORACLE,
    config: makeConfig({ reference: { maxPriceDevBps: 2_000 } }),
  });

  assert.equal(view.price.crossCheck, false);
  approx(view.price.impliedEthUsd, 3_600);
  assert.equal(view.regime, "uncertain");
  assert.ok(view.warnings.includes("cross-check-failed"));
});

test("view: regime normal, volatile (both triggers) and thin", () => {
  const normal = buildMarketView({
    observations: [obs({ name: "a", volatilityBps: 300 }), obs({ name: "b", volatilityBps: 300 })],
    oracle: ORACLE,
    config: makeConfig(),
  });
  assert.equal(normal.regime, "normal");

  const volatileByArm = buildMarketView({
    observations: [obs({ name: "a", volatilityBps: 700 }), obs({ name: "b", volatilityBps: 700 })],
    oracle: ORACLE,
    config: makeConfig(),
  });
  assert.equal(volatileByArm.regime, "volatile");

  const volatileByBaseline = buildMarketView({
    observations: [obs({ name: "a", volatilityBps: 650 }), obs({ name: "b", volatilityBps: 650 })],
    oracle: ORACLE,
    config: makeConfig({
      course: { armVolHighBps: 2_000, baselineVolBps: 300 },
    }),
  });
  assert.equal(volatileByBaseline.regime, "volatile");

  const thin = buildMarketView({
    observations: [obs({ name: "a", volume24h: 80_000 }), obs({ name: "b", volume24h: 80_000 })],
    oracle: ORACLE,
    config: makeConfig({
      reference: { minVolumeUsd: 1_000 },
      course: { baselineVolumeUsd: 100_000 },
    }),
  });
  assert.equal(thin.regime, "thin");
});

test("view: uncertain wins over volatile when there are too few healthy pools", () => {
  const view = buildMarketView({
    observations: [obs({ name: "only", volatilityBps: 900 })],
    oracle: ORACLE,
    config: makeConfig(),
  });

  assert.equal(view.healthy.length, 1);
  assert.equal(view.regime, "uncertain");
  assert.ok(view.warnings.includes("insufficient-healthy"));
});

test("view: empty observations are uncertain and warn", () => {
  const view = buildMarketView({ observations: [], oracle: ORACLE, config: makeConfig() });

  assert.deepEqual(view.pools, []);
  assert.equal(view.regime, "uncertain");
  assert.equal(view.price.crossCheck, null);
  assert.ok(view.warnings.includes("no-observations"));
  assert.ok(view.warnings.includes("regime-uncertain"));
});

test("view and course-correct sources carry no market addresses or I/O", () => {
  for (const file of ["../market-view.mjs", "../course-correct.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /0x[0-9a-fA-F]{40}/, `${file} embeds an address`);
    assert.doesNotMatch(source, /https?:\/\//, `${file} embeds a URL`);
    assert.doesNotMatch(source, /from\s+"node:/, `${file} imports Node built-ins`);
  }
});
