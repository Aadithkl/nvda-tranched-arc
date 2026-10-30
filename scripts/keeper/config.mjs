// Keeper configuration loader.
//
// One validated, frozen view over `KEEPER_*` env keys, grouped by concern. The keeper itself
// (`index.mjs`) still reads `process.env` directly; this module is the source of truth for the
// hardened path (preflight + executor) and is meant to be the drop-in replacement for those
// ad-hoc reads.
//
// Rules:
//   - Market-agnostic: no oracle, LLTV, market id, pool id, cap or price is baked in here.
//   - Numeric ranges are enforced; a bad value throws `ConfigError` naming the env key.
//   - Required addresses are only required when the keeper will act on them
//     (`KEEPER_ALLOCATOR_EXECUTE=true`) or when `KEEPER_STRICT_CONFIG=true`.
//   - Reference pools are external, read-only market data: strict/execute never require them,
//     and an empty list is valid (the reference view is off).
//   - `KEEPER_PRIVATE_KEY` is deliberately NOT part of the returned object: secret material
//     never belongs in a config object that may be logged.
//
// `loadConfig(env)` takes the env map explicitly so tests never touch `process.env`.

import {
  DEFAULT_REFERENCE_POOLS,
  REFERENCE_POOL_KINDS,
  REFERENCE_POOL_KEYS,
  REFERENCE_POOL_PAIRS,
} from "./reference-pools.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const HTTP_RE = /^https?:\/\//i;
const INTEGER_RE = /^-?\d+$/;
const UINT_RE = /^\d+$/;
const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const COURSE_CORRECT_MODES = Object.freeze(["off", "advisory", "apply"]);

/**
 * Thrown for any invalid or missing keeper setting.
 * `key` is always the offending env key so callers can render a one-line, non-stack message.
 */
export class ConfigError extends Error {
  constructor(key, message) {
    super(`${key}: ${message}`);
    this.name = "ConfigError";
    this.key = key;
  }
}

// ---------------------------------------------------------------------------
// Primitive readers
// ---------------------------------------------------------------------------

function readRaw(env, key) {
  const value = env?.[key];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

function readString(env, key, fallback = "") {
  return readRaw(env, key) ?? fallback;
}

function readBool(env, key, fallback) {
  const text = readRaw(env, key)?.toLowerCase();
  if (text === undefined) return fallback;
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  throw new ConfigError(key, `expected a boolean (true|false), got "${text}"`);
}

function describeRange(min, max) {
  if (min === -Infinity && max === Infinity) return "a number";
  if (max === Infinity) return `>= ${min}`;
  if (min === -Infinity) return `<= ${max}`;
  return `between ${min} and ${max}`;
}

function assertRange(key, value, min, max) {
  if (value < min || value > max) {
    throw new ConfigError(key, `expected ${describeRange(min, max)}, got ${value}`);
  }
  return value;
}

function assertAtMost(key, value, maxKey, max) {
  if (value > max) {
    throw new ConfigError(key, `must be <= ${maxKey} (${max}), got ${value}`);
  }
  return value;
}

function readInt(env, key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const text = readRaw(env, key);
  if (text === undefined) return assertRange(key, fallback, min, max);
  if (!INTEGER_RE.test(text)) {
    throw new ConfigError(key, `expected an integer, got "${text}"`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new ConfigError(key, `expected a safe integer, got "${text}"`);
  }
  return assertRange(key, value, min, max);
}

function readNumber(env, key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const text = readRaw(env, key);
  if (text === undefined) return assertRange(key, fallback, min, max);
  if (!NUMBER_RE.test(text)) {
    throw new ConfigError(key, `expected a number, got "${text}"`);
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new ConfigError(key, `expected a finite number, got "${text}"`);
  }
  return assertRange(key, value, min, max);
}

function readBigInt(env, key, fallback, { min = 0n, max = null } = {}) {
  const text = readRaw(env, key);
  let value;
  if (text === undefined) {
    value = fallback;
  } else {
    if (!UINT_RE.test(text)) {
      throw new ConfigError(key, `expected a non-negative integer, got "${text}"`);
    }
    value = BigInt(text);
  }
  if (value < min) {
    throw new ConfigError(key, `expected >= ${min}, got ${value}`);
  }
  if (max !== null && value > max) {
    throw new ConfigError(key, `expected <= ${max}, got ${value}`);
  }
  return value;
}

function readAddress(env, key, { required = false, fallbacks = [], requiredHint = "" } = {}) {
  let value = "";
  let sourceKey = key;
  for (const candidate of [key, ...fallbacks]) {
    const text = readRaw(env, candidate);
    if (text) {
      value = text;
      sourceKey = candidate;
      break;
    }
  }
  if (value === "") {
    if (required) {
      throw new ConfigError(key, requiredHint || "required (set it at deployment and verify with npm run keeper:preflight)");
    }
    return "";
  }
  if (!ADDRESS_RE.test(value)) {
    throw new ConfigError(sourceKey, `expected a 0x-prefixed 20-byte address, got "${value}"`);
  }
  if (value.toLowerCase() === ZERO_ADDRESS) {
    throw new ConfigError(sourceKey, "must not be the zero address");
  }
  return value;
}

function readBytes32(env, key, { required = false } = {}) {
  const value = readRaw(env, key);
  if (value === undefined) {
    if (required) throw new ConfigError(key, "required (book pool id, set after pool initialization)");
    return "";
  }
  if (!BYTES32_RE.test(value)) {
    throw new ConfigError(key, `expected a 0x-prefixed 32-byte value, got "${value}"`);
  }
  if (value.toLowerCase() === ZERO_BYTES32) {
    throw new ConfigError(key, "must not be the zero pool id");
  }
  return value;
}

function readUrl(env, key, { required = true } = {}) {
  const value = readRaw(env, key);
  if (value === undefined) {
    if (required) throw new ConfigError(key, "required (RPC endpoint)");
    return "";
  }
  if (!HTTP_RE.test(value)) {
    throw new ConfigError(key, `expected an http(s) URL, got "${value}"`);
  }
  return value;
}

function readEnum(env, key, fallback, allowed) {
  const text = readRaw(env, key);
  if (text === undefined) return fallback;
  const value = text.toLowerCase();
  if (!allowed.includes(value)) {
    throw new ConfigError(key, `expected one of ${allowed.join("|")}, got "${text}"`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Structured readers
// ---------------------------------------------------------------------------

function readCandidates(env) {
  const text = readString(env, "KEEPER_CANDIDATE_POOLS", "");
  if (text === "") return Object.freeze([]);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError("KEEPER_CANDIDATE_POOLS", `invalid JSON (${e.message})`);
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError("KEEPER_CANDIDATE_POOLS", "expected a JSON array of pool entries");
  }

  return Object.freeze(
    parsed.map((entry, index) => {
      const where = `KEEPER_CANDIDATE_POOLS[${index}]`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new ConfigError(where, "expected an object");
      }
      if (entry.kind !== "v4") {
        throw new ConfigError(where, `unsupported kind "${String(entry.kind)}" (only "v4" is supported)`);
      }
      if (typeof entry.poolId !== "string" || !BYTES32_RE.test(entry.poolId)) {
        throw new ConfigError(where, "poolId must be a 0x-prefixed 32-byte value");
      }

      const name = entry.name === undefined ? `candidate${index}` : entry.name;
      if (typeof name !== "string" || name.trim() === "") {
        throw new ConfigError(where, "name must be a non-empty string");
      }

      const feePips = entry.feePips === undefined ? 0 : entry.feePips;
      if (!Number.isInteger(feePips) || feePips < 0 || feePips > 1_000_000) {
        throw new ConfigError(where, `feePips must be an integer between 0 and 1000000, got ${String(feePips)}`);
      }

      const book = entry.book === undefined ? null : entry.book;
      if (book !== null && book !== 0 && book !== 1) {
        throw new ConfigError(where, "book must be 0, 1 or omitted");
      }

      const switchable = entry.switchable === undefined ? book !== null : entry.switchable;
      if (typeof switchable !== "boolean") {
        throw new ConfigError(where, "switchable must be a boolean");
      }

      let poolManager = "";
      if (entry.poolManager !== undefined) {
        if (typeof entry.poolManager !== "string" || !ADDRESS_RE.test(entry.poolManager)) {
          throw new ConfigError(where, "poolManager must be a 0x-prefixed 20-byte address");
        }
        poolManager = entry.poolManager;
      }

      return Object.freeze({
        name,
        kind: "v4",
        poolId: entry.poolId,
        feePips,
        book,
        switchable,
        poolManager,
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Reference pools (external, read-only market data)
// ---------------------------------------------------------------------------

function readPoolAddress(where, field, value, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new ConfigError(`${where}.${field}`, "required when enabled (0x-prefixed 20-byte address)");
    }
    return "";
  }
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new ConfigError(`${where}.${field}`, `expected a 0x-prefixed 20-byte address, got ${JSON.stringify(value)}`);
  }
  if (value.toLowerCase() === ZERO_ADDRESS) {
    throw new ConfigError(`${where}.${field}`, "must not be the zero address");
  }
  return value;
}

function readPoolBytes32(where, field, value, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new ConfigError(`${where}.${field}`, "required when enabled (0x-prefixed 32-byte pool id)");
    }
    return "";
  }
  if (typeof value !== "string" || !BYTES32_RE.test(value)) {
    throw new ConfigError(`${where}.${field}`, `expected a 0x-prefixed 32-byte value, got ${JSON.stringify(value)}`);
  }
  if (value.toLowerCase() === ZERO_BYTES32) {
    throw new ConfigError(`${where}.${field}`, "must not be the zero pool id");
  }
  return value;
}

function readPoolInt(where, field, value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null) {
    return assertRange(`${where}.${field}`, fallback, min, max);
  }
  if (!Number.isInteger(value)) {
    throw new ConfigError(`${where}.${field}`, `expected an integer, got ${JSON.stringify(value)}`);
  }
  return assertRange(`${where}.${field}`, value, min, max);
}

function rejectForeignFields(where, entry, fields, kind) {
  for (const field of fields) {
    const value = entry[field];
    if (value === undefined || value === null || value === "") continue;
    throw new ConfigError(`${where}.${field}`, `not used by kind "${kind}"; remove it or change kind`);
  }
}

function normalizeReferencePool(entry, index, seenNames) {
  const where = `KEEPER_REFERENCE_POOLS[${index}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new ConfigError(where, "expected an object");
  }

  for (const key of Object.keys(entry)) {
    if (!REFERENCE_POOL_KEYS.includes(key)) {
      throw new ConfigError(
        `${where}.${key}`,
        `unknown field (allowed: ${REFERENCE_POOL_KEYS.join(", ")})`,
      );
    }
  }

  if (typeof entry.name !== "string" || entry.name.trim() === "") {
    throw new ConfigError(`${where}.name`, "name must be a non-empty string");
  }
  const name = entry.name.trim();
  const nameKey = name.toLowerCase();
  if (seenNames.has(nameKey)) {
    throw new ConfigError(`${where}.name`, `duplicate name "${name}" (names must be unique)`);
  }
  seenNames.add(nameKey);

  if (!REFERENCE_POOL_KINDS.includes(entry.kind)) {
    throw new ConfigError(
      `${where}.kind`,
      `expected "v3" or "v4", got ${JSON.stringify(entry.kind ?? null)}`,
    );
  }
  const kind = entry.kind;

  if (!REFERENCE_POOL_PAIRS.includes(entry.pair)) {
    throw new ConfigError(
      `${where}.pair`,
      `expected "nvda-usd" or "nvda-eth", got ${JSON.stringify(entry.pair ?? null)}`,
    );
  }
  const pair = entry.pair;

  const enabled = entry.enabled === undefined ? false : entry.enabled;
  if (typeof enabled !== "boolean") {
    throw new ConfigError(`${where}.enabled`, `expected a boolean, got ${JSON.stringify(enabled)}`);
  }

  let kindFields;
  if (kind === "v3") {
    rejectForeignFields(where, entry, ["poolId", "poolManager", "tickSpacing"], kind);
    kindFields = {
      address: readPoolAddress(where, "address", entry.address, { required: enabled }),
      feePips: readPoolInt(where, "feePips", entry.feePips, 0, { min: 0, max: 1_000_000 }),
    };
  } else {
    rejectForeignFields(where, entry, ["address", "feePips"], kind);
    kindFields = {
      poolId: readPoolBytes32(where, "poolId", entry.poolId, { required: enabled }),
      poolManager: readPoolAddress(where, "poolManager", entry.poolManager),
      // int24 bound; 60 is the common placeholder spacing.
      tickSpacing: readPoolInt(where, "tickSpacing", entry.tickSpacing, 60, {
        min: 1,
        max: 8_388_607,
      }),
    };
  }

  const quoteToken = readPoolAddress(where, "quoteToken", entry.quoteToken, { required: enabled });
  const equityToken = readPoolAddress(where, "equityToken", entry.equityToken, { required: enabled });
  if (quoteToken !== "" && equityToken !== "" && quoteToken.toLowerCase() === equityToken.toLowerCase()) {
    throw new ConfigError(`${where}.equityToken`, "must differ from quoteToken");
  }

  return Object.freeze({ name, kind, pair, enabled, ...kindFields, quoteToken, equityToken });
}

/**
 * Parse and validate the read-only reference-pool registry.
 *
 * An unset `KEEPER_REFERENCE_POOLS` falls back to the disabled placeholders in
 * `reference-pools.mjs`; `"[]"` is valid (the reference view is simply off). Entries are
 * normalized per kind: a v3 pool carries `address`/`feePips`, a v4 pool carries
 * `poolId`/`poolManager`/`tickSpacing`.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {ReadonlyArray<Readonly<object>>} frozen entries, enabled or not
 * @throws {ConfigError} naming `KEEPER_REFERENCE_POOLS[i].field`
 */
function readReferencePools(env) {
  const text = readString(env, "KEEPER_REFERENCE_POOLS", "");
  let entries;
  if (text === "") {
    entries = DEFAULT_REFERENCE_POOLS;
  } else {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new ConfigError("KEEPER_REFERENCE_POOLS", `invalid JSON (${e.message})`);
    }
    if (!Array.isArray(parsed)) {
      throw new ConfigError("KEEPER_REFERENCE_POOLS", "expected a JSON array of pool entries");
    }
    entries = parsed;
  }

  const seenNames = new Set();
  return Object.freeze(
    entries.map((entry, index) => normalizeReferencePool(entry, index, seenNames)),
  );
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

/**
 * Build the validated keeper config.
 *
 * @param {Record<string, string | undefined>} [env] environment map (default `process.env`)
 * @returns {Readonly<object>} frozen config grouped by concern
 * @throws {ConfigError} on the first invalid or missing key
 */
export function loadConfig(env = process.env) {
  const dryRun = readBool(env, "KEEPER_DRY_RUN", true);
  const allocatorEnabled = readBool(env, "KEEPER_ALLOCATOR_ENABLED", false);
  const allocatorExecute = readBool(env, "KEEPER_ALLOCATOR_EXECUTE", false);
  // Execute always implies strict: an explicit `KEEPER_STRICT_CONFIG=false` cannot weaken it.
  const strict = readBool(env, "KEEPER_STRICT_CONFIG", false) || allocatorExecute;
  const requireAddresses = allocatorExecute || strict;
  const strictAllocator = strict && allocatorEnabled;
  const requiredHint =
    "required when KEEPER_ALLOCATOR_EXECUTE=true or KEEPER_STRICT_CONFIG=true " +
    "(set at deployment; verify with npm run keeper:preflight)";

  const rpc = {
    url: readUrl(env, "KEEPER_RPC_URL"),
    chainId: readInt(env, "KEEPER_CHAIN_ID", 4663, { min: 1, max: 2 ** 31 - 1 }),
    timeoutMs: readInt(env, "KEEPER_RPC_TIMEOUT_MS", 30_000, { min: 1_000, max: 600_000 }),
    retries: readInt(env, "KEEPER_RPC_RETRIES", 2, { min: 0, max: 10 }),
  };

  const addresses = {
    vault: readAddress(env, "KEEPER_VAULT", { required: requireAddresses, requiredHint }),
    heartbeat: readAddress(env, "KEEPER_HEARTBEAT", { required: requireAddresses, requiredHint }),
    hook: readAddress(env, "KEEPER_HOOK", { required: requireAddresses, requiredHint }),
    sleeve: readAddress(env, "KEEPER_SLEEVE"),
    arm: readAddress(env, "KEEPER_ARM_ADAPTER"),
    agent: readAddress(env, "KEEPER_AGENT", { required: allocatorExecute, requiredHint }),
    usdgAdapter: readAddress(env, "KEEPER_USDG_ADAPTER"),
    poolManager: readAddress(env, "KEEPER_POOL_MANAGER", {
      required: strictAllocator,
      requiredHint,
    }),
    quote: readAddress(env, "KEEPER_USDG", {
      fallbacks: ["QUOTE_ADDRESS"],
      required: strictAllocator,
      requiredHint,
    }),
    equity: readAddress(env, "KEEPER_NVDA", {
      fallbacks: ["NVDA_ADDRESS"],
      required: strictAllocator,
      requiredHint,
    }),
    ethUsdFeed: readAddress(env, "KEEPER_ETH_USD_FEED"),
    // WETH is the quote token for NVDA/ETH reference pools (fallback: WETH_ADDRESS).
    weth: readAddress(env, "KEEPER_WETH", { fallbacks: ["WETH_ADDRESS"] }),
  };

  const allocator = {
    enabled: allocatorEnabled,
    execute: allocatorExecute,
    intervalSeconds: readInt(env, "KEEPER_ALLOCATOR_INTERVAL_SECONDS", 7_200, {
      min: 60,
      max: 604_800,
    }),
    statsLookbackSeconds: readInt(env, "KEEPER_STATS_LOOKBACK_SECONDS", 21_600, { min: 60 }),
    statsLookbackBlocks: readBigInt(env, "KEEPER_STATS_LOOKBACK_BLOCKS", 21_600n, { min: 1n }),
    blockTimeSeconds: readNumber(env, "KEEPER_BLOCK_TIME_SECONDS", 0.1, { min: 0 }),
    rangeHalfWidthBps: readInt(env, "KEEPER_RANGE_HALF_WIDTH_BPS", 1_000, { min: 1, max: 10_000 }),
    minPoolLiquidityUsd: readNumber(env, "KEEPER_MIN_POOL_LIQUIDITY_USD", 10_000, { min: 0 }),
    inventoryReserveUsd: readNumber(env, "KEEPER_INVENTORY_RESERVE_USD", 1_000, { min: 0 }),
    inventoryReservePctBps: readInt(env, "KEEPER_INVENTORY_RESERVE_PCT_BPS", 500, {
      min: 0,
      max: 10_000,
    }),
    maxPaybackDays: readInt(env, "KEEPER_MAX_PAYBACK_DAYS", 30, { min: 0, max: 3_650 }),
    gasUnitsPerAction: readInt(env, "KEEPER_GAS_UNITS_PER_ACTION", 500_000, {
      min: 1,
      max: 10_000_000,
    }),
    feeWindowSeconds: readInt(env, "KEEPER_FEE_WINDOW_SECONDS", 86_400, {
      min: 60,
      max: 2_419_200,
    }),
  };

  const risk = {
    minHealthFactor: readBigInt(env, "KEEPER_MIN_HEALTH_FACTOR", 1_500_000_000_000_000_000n, {
      min: 1n,
    }),
    maxBorrowAprBps: readInt(env, "KEEPER_MAX_BORROW_APR_BPS", 3_000, { min: 0, max: 100_000 }),
    deleverageBps: readBigInt(env, "KEEPER_DELEVERAGE_BPS", 1_000n, { min: 1n, max: 10_000n }),
    maxStockLtvBps: readInt(env, "KEEPER_MAX_STOCK_LTV_BPS", 4_000, { min: 0, max: 10_000 }),
    maxYieldLtvBps: readInt(env, "KEEPER_MAX_YIELD_LTV_BPS", 8_500, { min: 0, max: 10_000 }),
    minHealthBps: readInt(env, "KEEPER_MIN_HEALTH_BPS", 2_500, { min: 0, max: 10_000 }),
    minCarryBps: readInt(env, "KEEPER_MIN_CARRY_BPS", 300, { min: 0 }),
    maxVolatilityBps: readInt(env, "KEEPER_RISK_MAX_VOLATILITY_BPS", 300, { min: 0 }),
    minVolumeUsd: readNumber(env, "KEEPER_RISK_MIN_VOLUME_USD", 10_000, { min: 0 }),
    minFeeAprBps: readInt(env, "KEEPER_RISK_MIN_FEE_APR_BPS", 0, { min: 0 }),
    // Optional ETH/USD override used when no feed is configured (0 = unset).
    ethUsd: readNumber(env, "KEEPER_ETH_USD", 0, { min: 0 }),
  };

  const arm = {
    maxLtvBps: readInt(env, "KEEPER_ARM_MAX_LTV_BPS", 3_000, { min: 1, max: 10_000 }),
    targetLtvBps: readInt(env, "KEEPER_ARM_TARGET_LTV_BPS", 2_937, { min: 1, max: 10_000 }),
    loopEnabled: readBool(env, "KEEPER_ARM_LOOP_ENABLED", true),
    carryEnabled: readBool(env, "KEEPER_CARRY_ARM_ENABLED", true),
    minSpreadBps: readInt(env, "KEEPER_ARM_MIN_SPREAD_BPS", 100, { min: 0, max: 10_000 }),
    exitSpreadBps: readInt(env, "KEEPER_ARM_EXIT_SPREAD_BPS", 0, { min: 0, max: 10_000 }),
    minBorrowUsd: readNumber(env, "KEEPER_ARM_MIN_BORROW_USD", 50, { min: 0 }),
    collateralAlways: readBool(env, "KEEPER_ARM_COLLATERAL_ALWAYS", false),
    morphoShareBps: readInt(env, "KEEPER_MORPHO_ARM_SHARE_BPS", 8_000, { min: 0, max: 10_000 }),
    nvdaStepBps: readInt(env, "KEEPER_NVDA_STEP_BPS", 1_000, { min: 1, max: 10_000 }),
  };
  if (arm.targetLtvBps > arm.maxLtvBps) {
    throw new ConfigError(
      "KEEPER_ARM_TARGET_LTV_BPS",
      `must be <= KEEPER_ARM_MAX_LTV_BPS (${arm.maxLtvBps}), got ${arm.targetLtvBps}`,
    );
  }

  const sweep = {
    enabled: readBool(env, "KEEPER_SURPLUS_SWEEP", true),
    minUsd: readNumber(env, "KEEPER_SURPLUS_MIN_USD", 25, { min: 0 }),
  };

  const switchParams = {
    bufferBps: readInt(env, "KEEPER_SWITCH_BUFFER_BPS", 250, { min: 0, max: 10_000 }),
    confirmSeconds: readInt(env, "KEEPER_SWITCH_CONFIRM_SECONDS", 28_800, { min: 0, max: 2_592_000 }),
    unwindBps: readInt(env, "KEEPER_SWITCH_UNWIND_BPS", 10_000, { min: 0, max: 10_000 }),
    ilMultipleBps: readInt(env, "KEEPER_IL_MULTIPLE_BPS", 10_000, { min: 0 }),
    requireBothBooks: readBool(env, "KEEPER_REQUIRE_BOTH_BOOKS", true),
    logsChunkBlocks: readInt(env, "KEEPER_LOGS_CHUNK_BLOCKS", 50_000, {
      min: 1,
      max: 10_000_000,
    }),
  };

  const book = {
    stepBps: readInt(env, "KEEPER_BOOK_STEP_BPS", 2_500, { min: 1, max: 10_000 }),
    unwindDustQuote: readBigInt(env, "KEEPER_UNWIND_DUST_USDG", 1_000_000n),
    unwindDustEquity: readBigInt(env, "KEEPER_UNWIND_DUST_NVDA", 1_000_000_000_000_000n),
    repayBufferQuote: readBigInt(env, "KEEPER_REPAY_BUFFER_USDG", 1_000_000n),
    fundBps: readBigInt(env, "KEEPER_FUND_BOOK_BPS", 9_000n, { min: 0n, max: 10_000n }),
  };

  const pools = {
    manager: addresses.poolManager,
    bookA: {
      poolId: readBytes32(env, "KEEPER_BOOK_A_POOL_ID", { required: strictAllocator }),
      feePips: readInt(env, "KEEPER_BOOK_A_FEE_PIPS", 500, { min: 0, max: 1_000_000 }),
    },
    bookB: {
      poolId: readBytes32(env, "KEEPER_BOOK_B_POOL_ID", { required: strictAllocator }),
      feePips: readInt(env, "KEEPER_BOOK_B_FEE_PIPS", 3_000, { min: 0, max: 1_000_000 }),
    },
    candidates: readCandidates(env),
    candidatesRaw: readString(env, "KEEPER_CANDIDATE_POOLS", ""),
  };

  // External market view. Read-only: no LP, no capital movement. `mode` gates the whole path, so
  // an empty pool list is valid even in strict/execute mode.
  const reference = {
    mode: readEnum(env, "KEEPER_COURSE_CORRECT_MODE", "off", COURSE_CORRECT_MODES),
    allocUsd: readNumber(env, "KEEPER_REFERENCE_ALLOC_USD", 1_000, { min: 0 }),
    windowSeconds: readInt(env, "KEEPER_REFERENCE_WINDOW_SECONDS", 86_400, {
      min: 60,
      max: 2_592_000,
    }),
    fastWindowSeconds: readInt(env, "KEEPER_REFERENCE_FAST_WINDOW_SECONDS", 21_600, {
      min: 60,
      max: 2_592_000,
    }),
    maxPriceDevBps: readInt(env, "KEEPER_REFERENCE_MAX_PRICE_DEV_BPS", 200, {
      min: 0,
      max: 100_000,
    }),
    maxDispersionBps: readInt(env, "KEEPER_REFERENCE_MAX_DISPERSION_BPS", 300, {
      min: 0,
      max: 100_000,
    }),
    maxCrossDevBps: readInt(env, "KEEPER_REFERENCE_MAX_CROSS_DEV_BPS", 300, {
      min: 0,
      max: 100_000,
    }),
    maxStaleSeconds: readInt(env, "KEEPER_REFERENCE_MAX_STALE_SECONDS", 1_800, {
      min: 1,
      max: 604_800,
    }),
    minHealthy: readInt(env, "KEEPER_REFERENCE_MIN_HEALTHY", 2, { min: 0, max: 100 }),
    minVolumeUsd: readNumber(env, "KEEPER_REFERENCE_MIN_VOLUME_USD", 50_000, { min: 0 }),
    minSwaps: readInt(env, "KEEPER_REFERENCE_MIN_SWAPS", 50, { min: 0, max: 1_000_000 }),
    logsChunkBlocks: readInt(env, "KEEPER_REFERENCE_LOGS_CHUNK_BLOCKS", 50_000, {
      min: 1,
      max: 10_000_000,
    }),
    pools: readReferencePools(env),
  };
  assertAtMost(
    "KEEPER_REFERENCE_FAST_WINDOW_SECONDS",
    reference.fastWindowSeconds,
    "KEEPER_REFERENCE_WINDOW_SECONDS",
    reference.windowSeconds,
  );

  // Course-correct bands: the reference view nudges guard width/share and risk sizing, but only
  // inside these bounds. Off by default (`reference.mode`).
  const course = {
    bufferBps: readInt(env, "KEEPER_COURSE_BUFFER_BPS", 500, { min: 0, max: 10_000 }),
    fastBufferBps: readInt(env, "KEEPER_COURSE_FAST_BUFFER_BPS", 1_000, { min: 0, max: 10_000 }),
    guardWidthMinBps: readInt(env, "KEEPER_COURSE_GUARD_WIDTH_MIN_BPS", 200, {
      min: 1,
      max: 10_000,
    }),
    guardWidthMaxBps: readInt(env, "KEEPER_COURSE_GUARD_WIDTH_MAX_BPS", 3_000, {
      min: 1,
      max: 10_000,
    }),
    guardShareMinBps: readInt(env, "KEEPER_COURSE_GUARD_SHARE_MIN_BPS", 1_000, {
      min: 0,
      max: 10_000,
    }),
    guardShareMaxBps: readInt(env, "KEEPER_COURSE_GUARD_SHARE_MAX_BPS", 9_000, {
      min: 0,
      max: 10_000,
    }),
    riskVolMinBps: readInt(env, "KEEPER_COURSE_RISK_VOL_MIN_BPS", 150, { min: 0, max: 100_000 }),
    riskVolMaxBps: readInt(env, "KEEPER_COURSE_RISK_VOL_MAX_BPS", 1_200, { min: 0, max: 100_000 }),
    riskVolumeMinUsd: readNumber(env, "KEEPER_COURSE_RISK_VOLUME_MIN_USD", 5_000, { min: 0 }),
    riskVolumeMaxUsd: readNumber(env, "KEEPER_COURSE_RISK_VOLUME_MAX_USD", 100_000, { min: 0 }),
    baselineVolBps: readInt(env, "KEEPER_COURSE_BASELINE_VOL_BPS", 300, { min: 0, max: 100_000 }),
    baselineVolumeUsd: readNumber(env, "KEEPER_COURSE_BASELINE_VOLUME_USD", 15_000, { min: 0 }),
    armVolHighBps: readInt(env, "KEEPER_COURSE_ARM_VOL_HIGH_BPS", 600, { min: 0, max: 100_000 }),
  };
  assertAtMost(
    "KEEPER_COURSE_GUARD_WIDTH_MIN_BPS",
    course.guardWidthMinBps,
    "KEEPER_COURSE_GUARD_WIDTH_MAX_BPS",
    course.guardWidthMaxBps,
  );
  assertAtMost(
    "KEEPER_COURSE_GUARD_SHARE_MIN_BPS",
    course.guardShareMinBps,
    "KEEPER_COURSE_GUARD_SHARE_MAX_BPS",
    course.guardShareMaxBps,
  );
  assertAtMost(
    "KEEPER_COURSE_RISK_VOL_MIN_BPS",
    course.riskVolMinBps,
    "KEEPER_COURSE_RISK_VOL_MAX_BPS",
    course.riskVolMaxBps,
  );
  assertAtMost(
    "KEEPER_COURSE_RISK_VOLUME_MIN_USD",
    course.riskVolumeMinUsd,
    "KEEPER_COURSE_RISK_VOLUME_MAX_USD",
    course.riskVolumeMaxUsd,
  );

  const guard = {
    // Main keeper loop cadence (`KEEPER_INTERVAL_SECONDS`) lives with the other keeper timers.
    intervalSeconds: readInt(env, "KEEPER_INTERVAL_SECONDS", 300, { min: 10, max: 86_400 }),
    heartbeatSeconds: readInt(env, "KEEPER_HEARTBEAT_SECONDS", 1_800, { min: 60, max: 604_800 }),
    recheckSeconds: readInt(env, "KEEPER_RECHECK_SECONDS", 300, { min: 1, max: 86_400 }),
    cooldownSeconds: readInt(env, "KEEPER_GUARD_COOLDOWN_SECONDS", 0, {
      min: 0,
      max: 604_800,
    }),
    maxPulls: readInt(env, "KEEPER_MAX_GUARD_PULLS", 2, { min: 0, max: 100 }),
  };

  const preflight = {
    enabled: readBool(env, "KEEPER_PREFLIGHT", true),
    intervalSeconds: readInt(env, "KEEPER_PREFLIGHT_INTERVAL_SECONDS", 21_600, {
      min: 60,
      max: 604_800,
    }),
    strict,
    stateFile: readString(env, "KEEPER_STATE_FILE", ""),
    // Global send gate (`KEEPER_DRY_RUN`). It lives here because this group is the process-safety
    // group; `executor.createExecutor` takes it as an explicit argument.
    dryRun,
    webhookUrl: readString(env, "KEEPER_WEBHOOK_URL", ""),
  };

  return deepFreeze({
    rpc,
    addresses,
    allocator,
    risk,
    arm,
    sweep,
    switch: switchParams,
    book,
    pools,
    reference,
    course,
    guard,
    preflight,
  });
}

export default loadConfig;
