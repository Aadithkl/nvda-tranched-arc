import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../config.mjs";
import { DEFAULT_REFERENCE_POOLS } from "../reference-pools.mjs";

const RPC = "https://rpc.example.test";

const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const id = (n) => `0x${n.toString(16).padStart(64, "0")}`;

function env(overrides = {}) {
  return { KEEPER_RPC_URL: RPC, ...overrides };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertConfigError(fn, key) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error?.name}`);
    assert.equal(error.key, key);
    // Keys like `KEEPER_CANDIDATE_POOLS[0]` contain regex metacharacters.
    assert.match(error.message, new RegExp(`^${escapeRegExp(key)}:`));
    return true;
  });
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test("defaults: groups exist and market-agnostic defaults are empty", () => {
  const cfg = loadConfig(env());

  assert.deepEqual(Object.keys(cfg), [
    "rpc",
    "addresses",
    "allocator",
    "risk",
    "arm",
    "sweep",
    "switch",
    "book",
    "pools",
    "reference",
    "course",
    "guard",
    "preflight",
  ]);

  assert.equal(cfg.rpc.url, RPC);
  assert.equal(cfg.rpc.chainId, 4663);
  assert.equal(cfg.rpc.timeoutMs, 30_000);
  assert.equal(cfg.rpc.retries, 2);

  assert.equal(cfg.addresses.vault, "");
  assert.equal(cfg.addresses.hook, "");
  assert.equal(cfg.addresses.agent, "");
  assert.equal(cfg.addresses.ethUsdFeed, "");
  assert.equal(cfg.addresses.weth, "");

  assert.equal(cfg.allocator.enabled, false);
  assert.equal(cfg.allocator.execute, false);
  assert.equal(cfg.allocator.intervalSeconds, 7_200);
  assert.equal(cfg.allocator.statsLookbackBlocks, 21_600n);
  assert.equal(cfg.allocator.blockTimeSeconds, 0.1);
  assert.equal(cfg.allocator.inventoryReserveUsd, 1_000);
  assert.equal(cfg.allocator.inventoryReservePctBps, 500);
  assert.equal(cfg.allocator.maxPaybackDays, 30);
  assert.equal(cfg.allocator.gasUnitsPerAction, 500_000);
  assert.equal(cfg.allocator.feeWindowSeconds, 86_400);

  assert.equal(cfg.risk.minHealthFactor, 1_500_000_000_000_000_000n);
  assert.equal(cfg.risk.maxBorrowAprBps, 3_000);
  assert.equal(cfg.risk.ethUsd, 0);

  assert.equal(cfg.arm.maxLtvBps, 3_000);
  assert.equal(cfg.arm.targetLtvBps, 2_937);
  assert.equal(cfg.arm.loopEnabled, true);
  assert.equal(cfg.arm.carryEnabled, true);
  assert.equal(cfg.arm.minSpreadBps, 100);
  assert.equal(cfg.arm.exitSpreadBps, 0);
  assert.equal(cfg.arm.minBorrowUsd, 50);
  assert.equal(cfg.arm.collateralAlways, false);

  assert.equal(cfg.sweep.enabled, true);
  assert.equal(cfg.sweep.minUsd, 25);

  assert.equal(cfg.switch.bufferBps, 250);
  assert.equal(cfg.switch.confirmSeconds, 28_800);
  assert.equal(cfg.switch.unwindBps, 10_000);
  assert.equal(cfg.switch.ilMultipleBps, 10_000);
  assert.equal(cfg.switch.requireBothBooks, true);
  assert.equal(cfg.switch.logsChunkBlocks, 50_000);

  assert.equal(cfg.book.stepBps, 2_500);
  assert.equal(cfg.book.unwindDustQuote, 1_000_000n);
  assert.equal(cfg.book.unwindDustEquity, 1_000_000_000_000_000n);
  assert.equal(cfg.book.repayBufferQuote, 1_000_000n);
  assert.equal(cfg.book.fundBps, 9_000n);

  assert.equal(cfg.pools.bookA.poolId, "");
  assert.equal(cfg.pools.bookA.feePips, 500);
  assert.equal(cfg.pools.bookB.feePips, 3_000);
  assert.deepEqual(cfg.pools.candidates, []);

  assert.equal(cfg.reference.mode, "off");
  assert.equal(cfg.reference.allocUsd, 1_000);
  assert.equal(cfg.reference.windowSeconds, 86_400);
  assert.equal(cfg.reference.fastWindowSeconds, 21_600);
  assert.equal(cfg.reference.maxPriceDevBps, 200);
  assert.equal(cfg.reference.maxDispersionBps, 300);
  assert.equal(cfg.reference.maxCrossDevBps, 300);
  assert.equal(cfg.reference.maxStaleSeconds, 1_800);
  assert.equal(cfg.reference.minHealthy, 2);
  assert.equal(cfg.reference.minVolumeUsd, 50_000);
  assert.equal(cfg.reference.minSwaps, 50);
  assert.equal(cfg.reference.logsChunkBlocks, 50_000);

  assert.equal(cfg.course.bufferBps, 500);
  assert.equal(cfg.course.fastBufferBps, 1_000);
  assert.equal(cfg.course.guardWidthMinBps, 200);
  assert.equal(cfg.course.guardWidthMaxBps, 3_000);
  assert.equal(cfg.course.guardShareMinBps, 1_000);
  assert.equal(cfg.course.guardShareMaxBps, 9_000);
  assert.equal(cfg.course.riskVolMinBps, 150);
  assert.equal(cfg.course.riskVolMaxBps, 1_200);
  assert.equal(cfg.course.riskVolumeMinUsd, 5_000);
  assert.equal(cfg.course.riskVolumeMaxUsd, 100_000);
  assert.equal(cfg.course.baselineVolBps, 300);
  assert.equal(cfg.course.baselineVolumeUsd, 15_000);
  assert.equal(cfg.course.armVolHighBps, 600);

  assert.ok(Object.isFrozen(cfg.reference));
  assert.ok(Object.isFrozen(cfg.course));

  assert.equal(cfg.guard.intervalSeconds, 300);
  assert.equal(cfg.guard.heartbeatSeconds, 1_800);
  assert.equal(cfg.guard.recheckSeconds, 300);
  assert.equal(cfg.guard.cooldownSeconds, 0);
  assert.equal(cfg.guard.maxPulls, 2);

  assert.equal(cfg.preflight.enabled, true);
  assert.equal(cfg.preflight.intervalSeconds, 21_600);
  assert.equal(cfg.preflight.strict, false);
  assert.equal(cfg.preflight.stateFile, "");
  assert.equal(cfg.preflight.dryRun, true);
  assert.equal(cfg.preflight.webhookUrl, "");
});

test("defaults: no address is required while the keeper is read-only", () => {
  const cfg = loadConfig(env());
  assert.equal(cfg.addresses.vault, "");
  assert.equal(cfg.pools.manager, "");
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

test("overrides: every new tuning key is applied", () => {
  const cfg = loadConfig(
    env({
      KEEPER_ALLOCATOR_INTERVAL_SECONDS: "3600",
      KEEPER_ARM_MAX_LTV_BPS: "2500",
      KEEPER_ARM_TARGET_LTV_BPS: "2000",
      KEEPER_ARM_LOOP_ENABLED: "false",
      KEEPER_ARM_MIN_SPREAD_BPS: "150",
      KEEPER_ARM_EXIT_SPREAD_BPS: "25",
      KEEPER_ARM_MIN_BORROW_USD: "75",
      KEEPER_ARM_COLLATERAL_ALWAYS: "true",
      KEEPER_CARRY_ARM_ENABLED: "false",
      KEEPER_SURPLUS_SWEEP: "false",
      KEEPER_SURPLUS_MIN_USD: "40",
      KEEPER_INVENTORY_RESERVE_USD: "500",
      KEEPER_INVENTORY_RESERVE_PCT_BPS: "250",
      KEEPER_MAX_PAYBACK_DAYS: "14",
      KEEPER_ETH_USD: "3200.5",
      KEEPER_GAS_UNITS_PER_ACTION: "750000",
      KEEPER_FEE_WINDOW_SECONDS: "43200",
      KEEPER_SWITCH_BUFFER_BPS: "500",
      KEEPER_SWITCH_CONFIRM_SECONDS: "3600",
      KEEPER_IL_MULTIPLE_BPS: "12000",
      KEEPER_REQUIRE_BOTH_BOOKS: "false",
      KEEPER_LOGS_CHUNK_BLOCKS: "10000",
      KEEPER_SWITCH_UNWIND_BPS: "9000",
      KEEPER_PREFLIGHT: "false",
      KEEPER_PREFLIGHT_INTERVAL_SECONDS: "3600",
      KEEPER_STATE_FILE: ".keeper-state.json",
      KEEPER_RPC_TIMEOUT_MS: "15000",
      KEEPER_RPC_RETRIES: "0",
      KEEPER_DRY_RUN: "false",
    }),
  );

  assert.equal(cfg.allocator.intervalSeconds, 3_600);
  assert.equal(cfg.arm.maxLtvBps, 2_500);
  assert.equal(cfg.arm.targetLtvBps, 2_000);
  assert.equal(cfg.arm.loopEnabled, false);
  assert.equal(cfg.arm.minSpreadBps, 150);
  assert.equal(cfg.arm.exitSpreadBps, 25);
  assert.equal(cfg.arm.minBorrowUsd, 75);
  assert.equal(cfg.arm.collateralAlways, true);
  assert.equal(cfg.arm.carryEnabled, false);
  assert.equal(cfg.sweep.enabled, false);
  assert.equal(cfg.sweep.minUsd, 40);
  assert.equal(cfg.allocator.inventoryReserveUsd, 500);
  assert.equal(cfg.allocator.inventoryReservePctBps, 250);
  assert.equal(cfg.allocator.maxPaybackDays, 14);
  assert.equal(cfg.risk.ethUsd, 3200.5);
  assert.equal(cfg.allocator.gasUnitsPerAction, 750_000);
  assert.equal(cfg.allocator.feeWindowSeconds, 43_200);
  assert.equal(cfg.switch.bufferBps, 500);
  assert.equal(cfg.switch.confirmSeconds, 3_600);
  assert.equal(cfg.switch.ilMultipleBps, 12_000);
  assert.equal(cfg.switch.requireBothBooks, false);
  assert.equal(cfg.switch.logsChunkBlocks, 10_000);
  assert.equal(cfg.switch.unwindBps, 9_000);
  assert.equal(cfg.preflight.enabled, false);
  assert.equal(cfg.preflight.intervalSeconds, 3_600);
  assert.equal(cfg.preflight.stateFile, ".keeper-state.json");
  assert.equal(cfg.rpc.timeoutMs, 15_000);
  assert.equal(cfg.rpc.retries, 0);
  assert.equal(cfg.preflight.dryRun, false);
});

test("overrides: quote/equity fall back to the deploy-script keys", () => {
  const cfg = loadConfig(
    env({
      QUOTE_ADDRESS: addr(0xaa),
      NVDA_ADDRESS: addr(0xbb),
    }),
  );
  assert.equal(cfg.addresses.quote, addr(0xaa));
  assert.equal(cfg.addresses.equity, addr(0xbb));
});

test("overrides: KEEPER_USDG/KEEPER_NVDA win over the deploy-script keys", () => {
  const cfg = loadConfig(
    env({
      QUOTE_ADDRESS: addr(0xaa),
      NVDA_ADDRESS: addr(0xbb),
      KEEPER_USDG: addr(0xcc),
      KEEPER_NVDA: addr(0xdd),
    }),
  );
  assert.equal(cfg.addresses.quote, addr(0xcc));
  assert.equal(cfg.addresses.equity, addr(0xdd));
});

test("overrides: booleans accept 1/0 and mixed case", () => {
  const cfg = loadConfig(
    env({
      KEEPER_ARM_LOOP_ENABLED: "0",
      KEEPER_SURPLUS_SWEEP: "TRUE",
      KEEPER_PREFLIGHT: "False",
    }),
  );
  assert.equal(cfg.arm.loopEnabled, false);
  assert.equal(cfg.sweep.enabled, true);
  assert.equal(cfg.preflight.enabled, false);
});

test("overrides: candidate pools are parsed and validated", () => {
  const cfg = loadConfig(
    env({
      KEEPER_CANDIDATE_POOLS: JSON.stringify([
        { name: "bookA", kind: "v4", poolId: id(7), feePips: 500, book: 0, switchable: true },
      ]),
    }),
  );
  assert.equal(cfg.pools.candidates.length, 1);
  assert.equal(cfg.pools.candidates[0].poolId, id(7));
  assert.equal(cfg.pools.candidates[0].book, 0);
  assert.ok(Object.isFrozen(cfg.pools.candidates[0]));
});

test("overrides: KEEPER_WETH falls back to WETH_ADDRESS", () => {
  assert.equal(loadConfig(env({ WETH_ADDRESS: addr(0xee) })).addresses.weth, addr(0xee));
  assert.equal(
    loadConfig(env({ WETH_ADDRESS: addr(0xee), KEEPER_WETH: addr(0xef) })).addresses.weth,
    addr(0xef),
  );
  assertConfigError(() => loadConfig(env({ KEEPER_WETH: "0x1234" })), "KEEPER_WETH");
});

test("defaults: reference pools are disabled placeholders", () => {
  const cfg = loadConfig(env());

  assert.equal(DEFAULT_REFERENCE_POOLS.length, 4);
  assert.ok(DEFAULT_REFERENCE_POOLS.every((pool) => pool.enabled === false));
  assert.equal(cfg.reference.pools.filter((pool) => pool.enabled).length, 0);
  assert.deepEqual(
    cfg.reference.pools.map((pool) => pool.name),
    ["nvda-usd-v3-005", "nvda-usd-v3-030", "nvda-eth-v3-005", "nvda-usd-v4-ext"],
  );
  assert.equal(cfg.reference.pools[0].kind, "v3");
  assert.equal(cfg.reference.pools[0].feePips, 500);
  assert.equal(cfg.reference.pools[1].feePips, 3_000);
  assert.equal(cfg.reference.pools[2].pair, "nvda-eth");
  assert.equal(cfg.reference.pools[3].kind, "v4");
  assert.equal(cfg.reference.pools[3].tickSpacing, 60);
  assert.ok(Object.isFrozen(cfg.reference.pools));
  assert.ok(Object.isFrozen(cfg.reference.pools[0]));
});

test("overrides: reference pools accept v3 and v4 entries", () => {
  const cfg = loadConfig(
    env({
      KEEPER_REFERENCE_POOLS: JSON.stringify([
        {
          name: "nvda-usd-v3-005",
          kind: "v3",
          pair: "nvda-usd",
          enabled: true,
          address: addr(0x10),
          quoteToken: addr(0x11),
          equityToken: addr(0x12),
          feePips: 500,
        },
        {
          name: "nvda-eth-v4",
          kind: "v4",
          pair: "nvda-eth",
          enabled: false,
          poolId: "",
          tickSpacing: 60,
          quoteToken: addr(0x13),
          equityToken: addr(0x14),
        },
        {
          name: "nvda-usd-v4-ext",
          kind: "v4",
          pair: "nvda-usd",
          enabled: true,
          poolId: id(0x20),
          poolManager: addr(0x21),
          tickSpacing: 10,
          quoteToken: addr(0x11),
          equityToken: addr(0x12),
        },
      ]),
    }),
  );

  const [v3, disabled, v4] = cfg.reference.pools;
  assert.equal(cfg.reference.pools.length, 3);
  assert.equal(v3.kind, "v3");
  assert.equal(v3.address, addr(0x10));
  assert.equal(v3.feePips, 500);
  assert.equal("poolId" in v3, false);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.poolId, "");
  assert.equal(v4.kind, "v4");
  assert.equal(v4.poolId, id(0x20));
  assert.equal(v4.poolManager, addr(0x21));
  assert.equal(v4.tickSpacing, 10);
  assert.equal("address" in v4, false);
  assert.ok(Object.isFrozen(v4));
});

test("overrides: optional reference fields get neutral defaults", () => {
  const cfg = loadConfig(
    env({
      KEEPER_REFERENCE_POOLS: JSON.stringify([
        { name: "v3-min", kind: "v3", pair: "nvda-usd" },
        { name: "v4-min", kind: "v4", pair: "nvda-eth" },
      ]),
    }),
  );

  const [v3, v4] = cfg.reference.pools;
  assert.equal(v3.enabled, false);
  assert.equal(v3.address, "");
  assert.equal(v3.quoteToken, "");
  assert.equal(v3.equityToken, "");
  assert.equal(v3.feePips, 0);
  assert.equal(v4.poolId, "");
  assert.equal(v4.poolManager, "");
  assert.equal(v4.tickSpacing, 60);
});

test("overrides: an empty reference list is valid", () => {
  const cfg = loadConfig(env({ KEEPER_REFERENCE_POOLS: "[]" }));
  assert.deepEqual(cfg.reference.pools, []);
  assert.ok(Object.isFrozen(cfg.reference.pools));
});

test("overrides: reference and course tuning keys are applied", () => {
  const cfg = loadConfig(
    env({
      KEEPER_COURSE_CORRECT_MODE: "advisory",
      KEEPER_REFERENCE_ALLOC_USD: "2500",
      KEEPER_REFERENCE_WINDOW_SECONDS: "43200",
      KEEPER_REFERENCE_FAST_WINDOW_SECONDS: "7200",
      KEEPER_REFERENCE_MAX_PRICE_DEV_BPS: "150",
      KEEPER_REFERENCE_MAX_DISPERSION_BPS: "250",
      KEEPER_REFERENCE_MAX_CROSS_DEV_BPS: "350",
      KEEPER_REFERENCE_MAX_STALE_SECONDS: "900",
      KEEPER_REFERENCE_MIN_HEALTHY: "1",
      KEEPER_REFERENCE_MIN_VOLUME_USD: "75000",
      KEEPER_REFERENCE_MIN_SWAPS: "25",
      KEEPER_REFERENCE_LOGS_CHUNK_BLOCKS: "10000",
      KEEPER_COURSE_BUFFER_BPS: "400",
      KEEPER_COURSE_FAST_BUFFER_BPS: "800",
      KEEPER_COURSE_GUARD_WIDTH_MIN_BPS: "250",
      KEEPER_COURSE_GUARD_WIDTH_MAX_BPS: "2500",
      KEEPER_COURSE_GUARD_SHARE_MIN_BPS: "1500",
      KEEPER_COURSE_GUARD_SHARE_MAX_BPS: "8000",
      KEEPER_COURSE_RISK_VOL_MIN_BPS: "200",
      KEEPER_COURSE_RISK_VOL_MAX_BPS: "1000",
      KEEPER_COURSE_RISK_VOLUME_MIN_USD: "6000",
      KEEPER_COURSE_RISK_VOLUME_MAX_USD: "90000",
      KEEPER_COURSE_BASELINE_VOL_BPS: "350",
      KEEPER_COURSE_BASELINE_VOLUME_USD: "20000",
      KEEPER_COURSE_ARM_VOL_HIGH_BPS: "700",
    }),
  );

  assert.equal(cfg.reference.mode, "advisory");
  assert.equal(cfg.reference.allocUsd, 2_500);
  assert.equal(cfg.reference.windowSeconds, 43_200);
  assert.equal(cfg.reference.fastWindowSeconds, 7_200);
  assert.equal(cfg.reference.maxPriceDevBps, 150);
  assert.equal(cfg.reference.maxDispersionBps, 250);
  assert.equal(cfg.reference.maxCrossDevBps, 350);
  assert.equal(cfg.reference.maxStaleSeconds, 900);
  assert.equal(cfg.reference.minHealthy, 1);
  assert.equal(cfg.reference.minVolumeUsd, 75_000);
  assert.equal(cfg.reference.minSwaps, 25);
  assert.equal(cfg.reference.logsChunkBlocks, 10_000);

  assert.equal(cfg.course.bufferBps, 400);
  assert.equal(cfg.course.fastBufferBps, 800);
  assert.equal(cfg.course.guardWidthMinBps, 250);
  assert.equal(cfg.course.guardWidthMaxBps, 2_500);
  assert.equal(cfg.course.guardShareMinBps, 1_500);
  assert.equal(cfg.course.guardShareMaxBps, 8_000);
  assert.equal(cfg.course.riskVolMinBps, 200);
  assert.equal(cfg.course.riskVolMaxBps, 1_000);
  assert.equal(cfg.course.riskVolumeMinUsd, 6_000);
  assert.equal(cfg.course.riskVolumeMaxUsd, 90_000);
  assert.equal(cfg.course.baselineVolBps, 350);
  assert.equal(cfg.course.baselineVolumeUsd, 20_000);
  assert.equal(cfg.course.armVolHighBps, 700);
});

// ---------------------------------------------------------------------------
// Invalid values
// ---------------------------------------------------------------------------

test("invalid: missing RPC URL names the key", () => {
  assertConfigError(() => loadConfig({}), "KEEPER_RPC_URL");
});

test("invalid: RPC URL must be http(s)", () => {
  assertConfigError(() => loadConfig({ KEEPER_RPC_URL: "ws://rpc.example.test" }), "KEEPER_RPC_URL");
});

test("invalid: numeric ranges are enforced and name the key", () => {
  const cases = [
    ["KEEPER_ARM_MAX_LTV_BPS", "0"],
    ["KEEPER_ARM_TARGET_LTV_BPS", "0"],
    ["KEEPER_ARM_MIN_SPREAD_BPS", "10001"],
    ["KEEPER_SWITCH_BUFFER_BPS", "-1"],
    ["KEEPER_SWITCH_UNWIND_BPS", "10001"],
    ["KEEPER_ALLOCATOR_INTERVAL_SECONDS", "10"],
    ["KEEPER_RPC_TIMEOUT_MS", "10"],
    ["KEEPER_RPC_RETRIES", "11"],
    ["KEEPER_MAX_GUARD_PULLS", "-1"],
    ["KEEPER_BOOK_A_FEE_PIPS", "1000001"],
    ["KEEPER_INVENTORY_RESERVE_PCT_BPS", "10001"],
    ["KEEPER_LOGS_CHUNK_BLOCKS", "0"],
    ["KEEPER_REFERENCE_LOGS_CHUNK_BLOCKS", "0"],
    ["KEEPER_COURSE_BUFFER_BPS", "10001"],
  ];
  for (const [key, value] of cases) {
    assertConfigError(() => loadConfig(env({ [key]: value })), key);
  }
});

test("invalid: non-numeric values are rejected, hex is not coerced", () => {
  assertConfigError(() => loadConfig(env({ KEEPER_RPC_TIMEOUT_MS: "0x10" })), "KEEPER_RPC_TIMEOUT_MS");
  assertConfigError(() => loadConfig(env({ KEEPER_ARM_MAX_LTV_BPS: "30%" })), "KEEPER_ARM_MAX_LTV_BPS");
  assertConfigError(() => loadConfig(env({ KEEPER_MIN_HEALTH_FACTOR: "1.5e18" })), "KEEPER_MIN_HEALTH_FACTOR");
});

test("invalid: booleans are strict", () => {
  assertConfigError(() => loadConfig(env({ KEEPER_DRY_RUN: "sometimes" })), "KEEPER_DRY_RUN");
});

test("invalid: target LTV cannot exceed max LTV", () => {
  assertConfigError(
    () => loadConfig(env({ KEEPER_ARM_MAX_LTV_BPS: "2000", KEEPER_ARM_TARGET_LTV_BPS: "2500" })),
    "KEEPER_ARM_TARGET_LTV_BPS",
  );
});

test("invalid: malformed addresses and pool ids name the key", () => {
  assertConfigError(() => loadConfig(env({ KEEPER_VAULT: "0x1234" })), "KEEPER_VAULT");
  assertConfigError(
    () => loadConfig(env({ KEEPER_VAULT: "0x0000000000000000000000000000000000000000" })),
    "KEEPER_VAULT",
  );
  assertConfigError(() => loadConfig(env({ KEEPER_BOOK_A_POOL_ID: "0xdeadbeef" })), "KEEPER_BOOK_A_POOL_ID");
});

test("invalid: candidate pool JSON is validated", () => {
  assertConfigError(
    () => loadConfig(env({ KEEPER_CANDIDATE_POOLS: "{not json" })),
    "KEEPER_CANDIDATE_POOLS",
  );
  assertConfigError(
    () => loadConfig(env({ KEEPER_CANDIDATE_POOLS: JSON.stringify({ kind: "v4" }) })),
    "KEEPER_CANDIDATE_POOLS",
  );
  assertConfigError(
    () =>
      loadConfig(
        env({ KEEPER_CANDIDATE_POOLS: JSON.stringify([{ kind: "v3", poolId: id(1) }]) }),
      ),
    "KEEPER_CANDIDATE_POOLS[0]",
  );
});

test("invalid: reference pool fields name the entry and field", () => {
  const base = {
    name: "nvda-usd-v3-005",
    kind: "v3",
    pair: "nvda-usd",
    enabled: true,
    address: addr(0x10),
    quoteToken: addr(0x11),
    equityToken: addr(0x12),
    feePips: 500,
  };
  const v4 = {
    name: "nvda-usd-v4-ext",
    kind: "v4",
    pair: "nvda-usd",
    enabled: true,
    poolId: id(0x20),
    quoteToken: addr(0x11),
    equityToken: addr(0x12),
  };

  const cases = [
    [{ ...base, kind: "v2" }, "KEEPER_REFERENCE_POOLS[0].kind"],
    [{ ...base, pair: "nvda-eur" }, "KEEPER_REFERENCE_POOLS[0].pair"],
    [{ ...base, address: "0x1234" }, "KEEPER_REFERENCE_POOLS[0].address"],
    [{ ...base, address: "" }, "KEEPER_REFERENCE_POOLS[0].address"],
    [{ ...base, quoteToken: "0x1234" }, "KEEPER_REFERENCE_POOLS[0].quoteToken"],
    [{ ...base, quoteToken: "" }, "KEEPER_REFERENCE_POOLS[0].quoteToken"],
    [{ ...base, equityToken: addr(0x11) }, "KEEPER_REFERENCE_POOLS[0].equityToken"],
    [{ ...base, name: "   " }, "KEEPER_REFERENCE_POOLS[0].name"],
    [{ ...base, enabled: "yes" }, "KEEPER_REFERENCE_POOLS[0].enabled"],
    [{ ...base, mystery: 1 }, "KEEPER_REFERENCE_POOLS[0].mystery"],
    [{ ...base, poolId: id(1) }, "KEEPER_REFERENCE_POOLS[0].poolId"],
    [{ ...base, feePips: 1_000_001 }, "KEEPER_REFERENCE_POOLS[0].feePips"],
    [{ ...v4, poolId: "0xdead" }, "KEEPER_REFERENCE_POOLS[0].poolId"],
    [{ ...v4, poolId: undefined }, "KEEPER_REFERENCE_POOLS[0].poolId"],
    [{ ...v4, tickSpacing: 0 }, "KEEPER_REFERENCE_POOLS[0].tickSpacing"],
    [{ ...v4, poolManager: "0x1234" }, "KEEPER_REFERENCE_POOLS[0].poolManager"],
    [{ ...v4, feePips: 500 }, "KEEPER_REFERENCE_POOLS[0].feePips"],
  ];

  for (const [entry, key] of cases) {
    assertConfigError(
      () => loadConfig(env({ KEEPER_REFERENCE_POOLS: JSON.stringify([entry]) })),
      key,
    );
  }
});

test("invalid: duplicate reference pool names are rejected", () => {
  const entry = (name) => ({ name, kind: "v3", pair: "nvda-usd" });
  assertConfigError(
    () =>
      loadConfig(env({ KEEPER_REFERENCE_POOLS: JSON.stringify([entry("dup"), entry("dup")]) })),
    "KEEPER_REFERENCE_POOLS[1].name",
  );
  assertConfigError(
    () =>
      loadConfig(env({ KEEPER_REFERENCE_POOLS: JSON.stringify([entry("DUP"), entry("dup")]) })),
    "KEEPER_REFERENCE_POOLS[1].name",
  );
});

test("invalid: malformed reference pool JSON names the key", () => {
  assertConfigError(
    () => loadConfig(env({ KEEPER_REFERENCE_POOLS: "{not json" })),
    "KEEPER_REFERENCE_POOLS",
  );
  assertConfigError(
    () => loadConfig(env({ KEEPER_REFERENCE_POOLS: JSON.stringify({ name: "x" }) })),
    "KEEPER_REFERENCE_POOLS",
  );
  assertConfigError(
    () => loadConfig(env({ KEEPER_REFERENCE_POOLS: JSON.stringify([null]) })),
    "KEEPER_REFERENCE_POOLS[0]",
  );
});

test("invalid: course-correct mode is an enum", () => {
  assert.equal(loadConfig(env({ KEEPER_COURSE_CORRECT_MODE: "APPLY" })).reference.mode, "apply");
  assertConfigError(
    () => loadConfig(env({ KEEPER_COURSE_CORRECT_MODE: "sometimes" })),
    "KEEPER_COURSE_CORRECT_MODE",
  );
});

test("invalid: reference windows and course min/max pairs are consistent", () => {
  assertConfigError(
    () => loadConfig(env({ KEEPER_REFERENCE_WINDOW_SECONDS: "3600" })),
    "KEEPER_REFERENCE_FAST_WINDOW_SECONDS",
  );
  const cases = [
    ["KEEPER_COURSE_GUARD_WIDTH_MIN_BPS", "4000"],
    ["KEEPER_COURSE_GUARD_SHARE_MIN_BPS", "9500"],
    ["KEEPER_COURSE_RISK_VOL_MIN_BPS", "1500"],
    ["KEEPER_COURSE_RISK_VOLUME_MIN_USD", "200000"],
  ];
  for (const [key, value] of cases) {
    assertConfigError(() => loadConfig(env({ [key]: value })), key);
  }
});

// ---------------------------------------------------------------------------
// Strict mode
// ---------------------------------------------------------------------------

test("strict: KEEPER_STRICT_CONFIG=true requires core addresses", () => {
  assertConfigError(() => loadConfig(env({ KEEPER_STRICT_CONFIG: "true" })), "KEEPER_VAULT");
});

test("strict: execute implies strict even if explicitly disabled", () => {
  assertConfigError(
    () =>
      loadConfig(
        env({
          KEEPER_ALLOCATOR_EXECUTE: "true",
          KEEPER_STRICT_CONFIG: "false",
        }),
      ),
    "KEEPER_VAULT",
  );
});

test("strict: a complete execute config loads and freezes", () => {
  const cfg = loadConfig(
    env({
      KEEPER_ALLOCATOR_ENABLED: "true",
      KEEPER_ALLOCATOR_EXECUTE: "true",
      KEEPER_VAULT: addr(1),
      KEEPER_HEARTBEAT: addr(2),
      KEEPER_HOOK: addr(3),
      KEEPER_AGENT: addr(4),
      KEEPER_POOL_MANAGER: addr(5),
      KEEPER_USDG: addr(6),
      KEEPER_NVDA: addr(7),
      KEEPER_BOOK_A_POOL_ID: id(1),
      KEEPER_BOOK_B_POOL_ID: id(2),
    }),
  );

  assert.equal(cfg.preflight.strict, true);
  assert.equal(cfg.allocator.execute, true);
  assert.equal(cfg.addresses.vault, addr(1));
  assert.equal(cfg.pools.manager, addr(5));
  assert.equal(cfg.pools.bookA.poolId, id(1));
  assert.equal(cfg.reference.pools.filter((pool) => pool.enabled).length, 0);
  assert.ok(Object.isFrozen(cfg));
  assert.ok(Object.isFrozen(cfg.pools.bookA));
  assert.throws(() => {
    cfg.rpc.url = "https://evil.example";
  }, TypeError);
});

test("strict: reference pools are optional and may be empty", () => {
  const cfg = loadConfig(
    env({
      KEEPER_STRICT_CONFIG: "true",
      KEEPER_VAULT: addr(1),
      KEEPER_HEARTBEAT: addr(2),
      KEEPER_HOOK: addr(3),
      KEEPER_REFERENCE_POOLS: "[]",
    }),
  );
  assert.equal(cfg.reference.mode, "off");
  assert.deepEqual(cfg.reference.pools, []);
  assert.ok(Object.isFrozen(cfg.reference.pools));
});

test("strict: execute requires the agent address", () => {
  assertConfigError(
    () =>
      loadConfig(
        env({
          KEEPER_ALLOCATOR_EXECUTE: "true",
          KEEPER_VAULT: addr(1),
          KEEPER_HEARTBEAT: addr(2),
          KEEPER_HOOK: addr(3),
        }),
      ),
    "KEEPER_AGENT",
  );
});

test("strict: strict allocator requires pool manager, quote, equity and pool ids", () => {
  const base = {
    KEEPER_STRICT_CONFIG: "true",
    KEEPER_ALLOCATOR_ENABLED: "true",
    KEEPER_VAULT: addr(1),
    KEEPER_HEARTBEAT: addr(2),
    KEEPER_HOOK: addr(3),
  };
  assertConfigError(() => loadConfig(env(base)), "KEEPER_POOL_MANAGER");
  assertConfigError(() => loadConfig(env({ ...base, KEEPER_POOL_MANAGER: addr(4) })), "KEEPER_USDG");
  assertConfigError(
    () =>
      loadConfig(
        env({
          ...base,
          KEEPER_POOL_MANAGER: addr(4),
          QUOTE_ADDRESS: addr(5),
          NVDA_ADDRESS: addr(6),
        }),
      ),
    "KEEPER_BOOK_A_POOL_ID",
  );
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test("secrets: KEEPER_PRIVATE_KEY is never part of the config", () => {
  const secret = `0x${"11".repeat(32)}`;
  const cfg = loadConfig(env({ KEEPER_PRIVATE_KEY: secret }));
  assert.equal("privateKey" in cfg, false);
  // The config carries BigInt values, so the replacer must stringify them for JSON.stringify.
  const json = JSON.stringify(cfg, (_key, value) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
  assert.equal(json.includes(secret), false);
});
