// Yearn-style self-run keeper. Long-running process (systemd / Docker), not GitHub Actions.
//
// Loop: poll triggers -> pure decision (./decide.mjs) -> execute -> alert.
// It only ever calls permissionless or keeper-gated DE-RISK paths:
//   - DepegHeartbeat.performUpkeep()   (vault.checkDepeg under the hood)
//   - PoolGuardHook.recheckGuard()      (permissionless re-arm)
//   - Sleeve.deRisk() / Sleeve.pause()  (only if this bot is the sleeve keeper)
//
// Dry-run by default: set KEEPER_DRY_RUN=false to send transactions.

import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decideDepeg, decideSleeve, decideGuard, decideArm } from "./decide.mjs";
import {
  assessBookRisk,
  planArmEntry,
  planBookReturn,
  borrowSize,
  decidePoolSwitch,
  decideSwitchConfirmation,
  gasPaybackDays,
  guardSafeHarbor,
  ltvRepayAmount,
  loopSpreadBps,
  shouldEnterLoop,
  shouldExitLoop,
  surplusSweepPlan,
} from "./allocator.mjs";
import {
  SWAP_EVENT,
  summarizeBook,
  marketStats,
  activeLiquidityValue,
  positionValueUsd,
  liquidityForValue,
  rangeFromHalfWidth,
  chunkedBlockRanges,
  computeGuardUptime,
  filterSwapsByBlock,
  mergeSwapCache,
  pruneSwapCache,
} from "./stats.mjs";
import { loadConfig, ConfigError } from "./config.mjs";
import { createExecutor } from "./executor.mjs";
// Read-only external-market view. `scanReferencePools` reads outside pools and `buildMarketView` /
// `recommendCourse` are pure. Nothing here feeds a decision or a send: the results are logged and
// kept in module state for a future apply step.
import { scanReferencePools } from "./reference-scan.mjs";
import { buildMarketView } from "./market-view.mjs";
import { recommendCourse } from "./course-correct.mjs";

const env = process.env;

// One validated, frozen view over the `KEEPER_*` settings. `loadConfig` deliberately omits
// `KEEPER_PRIVATE_KEY`, so the signer is still read from `env` below. Anything market-specific
// (LLTV, market id, oracle, prices) stays out of this file and comes from config or chain reads.
const config = loadConfig(env);

const RPC_URL = config.rpc.url;
const CHAIN_ID = config.rpc.chainId;
const DRY_RUN = config.preflight.dryRun;

// The LTV sentinel runs on every loop tick; the allocator has its own, slower cadence
// (2h by default) so a risk-down check never waits for a market scan.
const INTERVAL = config.guard.intervalSeconds;
const HEARTBEAT_INTERVAL = config.guard.heartbeatSeconds;
const RECHECK_INTERVAL = config.guard.recheckSeconds;

const VAULT = config.addresses.vault;
const HEARTBEAT = config.addresses.heartbeat;
const HOOK = config.addresses.hook;
const SLEEVE = config.addresses.sleeve;
const ARM = config.addresses.arm;
const AGENT = config.addresses.agent;
const MIN_HEALTH_FACTOR = config.risk.minHealthFactor;
const MAX_BORROW_APR_BPS = config.risk.maxBorrowAprBps;
const DELEVERAGE_BPS = config.risk.deleverageBps;

// Loop-arm policy. Every LTV ceiling comes from the adapter (see `effectiveArmLtv`) or the
// operator config; nothing market-specific is baked in here.
const ARM_LOOP_ENABLED = config.arm.loopEnabled;
const ARM_MIN_SPREAD_BPS = config.arm.minSpreadBps;
const ARM_EXIT_SPREAD_BPS = config.arm.exitSpreadBps;
const ARM_MIN_BORROW_USD = config.arm.minBorrowUsd;
const ARM_COLLATERAL_ALWAYS = config.arm.collateralAlways;
const MAX_PAYBACK_DAYS = config.allocator.maxPaybackDays;
const GAS_UNITS_PER_ACTION = BigInt(config.allocator.gasUnitsPerAction);
const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
const WAD = 10n ** 18n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// The keeper loop always reads the vault, the heartbeat and the hub hook. `loadConfig` only
// requires them when the keeper may execute, so fail fast here instead of issuing reads
// against an empty address.
for (const [envKey, value] of [
  ["KEEPER_VAULT", VAULT],
  ["KEEPER_HEARTBEAT", HEARTBEAT],
  ["KEEPER_HOOK", HOOK],
]) {
  if (!value) throw new ConfigError(envKey, "required by the keeper loop");
}

// Risk allocator: fee, volume and price fluctuation over the lookback.
const ALLOCATOR_ENABLED = config.allocator.enabled;
const ALLOCATOR_INTERVAL = config.allocator.intervalSeconds;
const ALLOCATOR_EXECUTE = config.allocator.execute;
const POOL_MANAGER = config.pools.manager;
const BOOK_A_POOL = config.pools.bookA.poolId;
const BOOK_B_POOL = config.pools.bookB.poolId;
const BOOK_A_FEE_PIPS = config.pools.bookA.feePips;
const BOOK_B_FEE_PIPS = config.pools.bookB.feePips;
const USDG_ADAPTER = config.addresses.usdgAdapter;
const USDG = config.addresses.quote;
const NVDA = config.addresses.equity;
const STATS_LOOKBACK_SECONDS = config.allocator.statsLookbackSeconds;
const STATS_LOOKBACK_BLOCKS = config.allocator.statsLookbackBlocks;
const BLOCK_TIME_SECONDS = config.allocator.blockTimeSeconds;
// Annualize over the actual block span, not an assumed wall-clock window.
const STATS_WINDOW_SECONDS =
  BLOCK_TIME_SECONDS > 0 ? Number(STATS_LOOKBACK_BLOCKS) * BLOCK_TIME_SECONDS : STATS_LOOKBACK_SECONDS;
// 24h fee/IL window. `blockTimeSeconds` may be 0 (config floor), which would make the
// seconds->blocks ratio infinite; 0n then means "no usable 24h window" and the allocator
// holds instead of scoring a single block of swaps.
const FEE_WINDOW_SECONDS = config.allocator.feeWindowSeconds;
const FEE_WINDOW_BLOCKS = (() => {
  if (!(Number(FEE_WINDOW_SECONDS) > 0) || !(Number(BLOCK_TIME_SECONDS) > 0)) return 0n;
  const blocks = Math.ceil(Number(FEE_WINDOW_SECONDS) / Number(BLOCK_TIME_SECONDS));
  return Number.isFinite(blocks) && blocks > 0 ? BigInt(blocks) : 0n;
})();
const MORPHO_ARM_SHARE_BPS = config.arm.morphoShareBps;
const NVDA_STEP_BPS = config.arm.nvdaStepBps;
const BOOK_STEP_BPS = config.book.stepBps;
const CANDIDATE_POOLS_RAW = config.pools.candidatesRaw;
const RANGE_HALF_WIDTH_BPS = config.allocator.rangeHalfWidthBps;
const MIN_POOL_LIQUIDITY_USD = config.allocator.minPoolLiquidityUsd;
const SWITCH_BUFFER_BPS = config.switch.bufferBps;
const SWITCH_CONFIRM_SECONDS = config.switch.confirmSeconds;
const SWITCH_UNWIND_BPS = config.switch.unwindBps;
const IL_MULTIPLE_BPS = config.switch.ilMultipleBps;
const REQUIRE_BOTH_BOOKS = config.switch.requireBothBooks;
const LOGS_CHUNK_BLOCKS = config.switch.logsChunkBlocks;
const CARRY_ARM_ENABLED = config.arm.carryEnabled;
const GUARD_COOLDOWN_SECONDS = config.guard.cooldownSeconds;
const MAX_GUARD_PULLS = config.guard.maxPulls;
const UNWIND_DUST_USDG = config.book.unwindDustQuote;
const UNWIND_DUST_NVDA = config.book.unwindDustEquity;
const REPAY_BUFFER_USDG = config.book.repayBufferQuote;
const FUND_BOOK_BPS = config.book.fundBps;
const RISK_THRESHOLDS = {
  maxVolatilityBps: config.risk.maxVolatilityBps,
  minVolumeUsd: config.risk.minVolumeUsd,
  minFeeAprBps: config.risk.minFeeAprBps,
};
let lastAllocatorAt = 0;
let lastAllocatorBlock = null;
// Last read-only external-market view and its advisory course recommendation. Both are logged
// only: no decision, guard parameter, risk threshold or send reads them. They are the seam for a
// future apply step.
let lastMarketView = null;
let lastCourse = null;
// The reference path is skipped while the pool list is empty; say so once, not every 2h.
let referenceEmptyLogged = false;
// Inventory signature of the last depeg recall that was acted on. `recallToVault` pulls the
// guard and the hook's idle inventory but leaves the base in the pool, so the inventory
// pre-check alone would re-send a no-op recall on every 5m tick of the same depeg episode.
let lastDepegRecall = null;

// Rolling 24h swap cache, keyed by lowercase pool id. `lastFetchedBlock` only advances
// on a successful fetch; `fresh` turns false on a failed one so a stale cache can never
// justify a switch.
const swapCache = new Map();
// GuardPulled/GuardDeployed history per book hook (lowercase address), for guard uptime.
const guardEventCache = new Map();
// One debug line when the deployment has no hub/book hook to read guard history from.
let noBookHookLogged = false;
// Switch/arms target that must persist for `config.switch.confirmSeconds`: the value
// returned by `decideSwitchConfirmation` as `{ target, since, netAprBps }`.
let pendingSwitch = null;

const POLICY = {
  maxStockLtvBps: config.risk.maxStockLtvBps,
  maxYieldLtvBps: config.risk.maxYieldLtvBps,
  minHealthBps: config.risk.minHealthBps,
  minCarryBps: config.risk.minCarryBps,
};

const vaultAbi = parseAbi([
  "function depegPaused() view returns (bool)",
  "function lastDepegCheck() view returns (uint256)",
  "function totalManagedAssets() view returns (uint256)",
  "function baseManagedAssets() view returns (uint256)",
]);
const heartbeatAbi = parseAbi([
  "function checkUpkeep(bytes) view returns (bool upkeepNeeded, bytes performData)",
  "function performUpkeep(bytes)",
]);
const hookAbi = parseAbi([
  "function guardPresent() view returns (bool)",
  "function pulledAt() view returns (uint256)",
  "function deployEnabled() view returns (bool)",
  "function recheckGuard()",
  "function activePoolId() view returns (bytes32)",
  "function poolPrice1e18() view returns (uint256)",
  "function basePosition() view returns (int24 tickLower, int24 tickUpper, uint128 liquidity)",
  "function guardPosition() view returns (int24 tickLower, int24 tickUpper, uint128 liquidity)",
  "function quoteIdle() view returns (uint256)",
  "function equityIdle() view returns (uint256)",
  "function bookA() view returns (address)",
  "function bookB() view returns (address)",
  "function activeBook() view returns (uint8)",
  "function poolInitialized() view returns (bool)",
  "function guardParams() view returns ((int24 guardTickWidth, int24 baseTickWidth, uint128 guardLiquidity, uint128 baseLiquidity, uint16 minEvBps, uint16 recheckMaxDeviationBps, uint32 recheckInterval, uint32 maxPriceAge, uint8 allowedSessionsMask))",
]);
const guardPulledEvent = parseAbiItem(
  "event GuardPulled(int24 tickLower, int24 tickUpper, uint128 liquidity)",
);
const guardDeployedEvent = parseAbiItem(
  "event GuardDeployed(int24 tickLower, int24 tickUpper, uint128 liquidity)",
);
const sleeveAbi = parseAbi([
  "function riskState() view returns (uint256 stockLtvBps, uint256 yieldLtvBps, uint256 healthBufferBps, int256 netCarryBps, bool venuePaused)",
  "function deRisk() returns (uint256)",
  "function pause()",
]);
const armAbi = parseAbi([
  "function healthFactor() view returns (uint256)",
  "function debt() view returns (uint256)",
  "function borrowAprBps() view returns (uint256)",
  "function collateralBalance() view returns (uint256)",
  "function collateralValue() view returns (uint256)",
  "function collateralValueOf(uint256 amount) view returns (uint256)",
  "function targetLtvOfLltvBps() view returns (uint16)",
  "function marketParams() view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function morpho() view returns (address)",
  "function marketId() view returns (bytes32)",
]);
// The lend-side adapter exposes the same market surface as the loop adapter.
const lendAdapterAbi = parseAbi([
  "function morpho() view returns (address)",
  "function marketId() view returns (bytes32)",
  "function marketParams() view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
]);
// Morpho's adaptive-curve IRM. `borrowRateView` is a view over (MarketParams, Market); viem
// encodes the two structs from the decoded tuple objects returned by `marketParams()`/`market()`.
const irmAbi = parseAbi([
  "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)",
]);
const chainlinkAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
// Morpho Blue market state. The struct decodes as six uint128 fields:
// totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee.
const morphoAbi = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const lendAbi = parseAbi(["function realAssets() view returns (uint256)"]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const v4PoolManagerAbi = parseAbi([
  "function getLiquidity(bytes32 id) view returns (uint128 liquidity)",
  "function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);

const agentAbi = parseAbi([
  "function submitDeleverage(address adapter, uint256 repayAmount, uint256 collateralWithdrawn)",
  "function submitRecall()",
  "function submitAllocate(address adapter, uint256 amount)",
  "function submitAllocateCollateral(address adapter, uint256 amount)",
  "function submitBorrow(address adapter, uint256 amount)",
  "function submitDeallocate(address adapter, uint256 amount) returns (uint256)",
  "function submitSwitchBook(uint8 toBook)",
  "function submitApproveStrategy(address token, uint256 amount)",
  "function submitFund(uint256 quoteAmount, uint256 equityAmount)",
  "function controller() view returns (address)",
]);
const controllerAbi = parseAbi([
  "function bounds() view returns (int24 maxGuardTickWidth, int24 maxBaseTickWidth, uint128 maxGuardLiquidity, uint128 maxBaseLiquidity, int24 minGuardTickWidth, int24 minBaseTickWidth, uint128 minGuardLiquidity, uint128 minBaseLiquidity, uint16 maxMinEvBps, uint32 minRecheckInterval, uint32 maxRecheckInterval, uint16 maxRecheckMaxDeviationBps, uint32 maxMaxPriceAge, uint256 maxFundQuotePerCall, uint256 maxFundEquityPerCall, uint256 maxRebalanceSwapQuote, uint256 maxAllocatePerCall, uint256 maxCollateralPerCall, uint256 maxBorrowPerCall, uint32 recenterCooldown, uint32 rebalanceCooldown, uint256 maxRebalanceQuotePerDay)",
  "function strategyModule() view returns (address)",
  "function paused() view returns (bool)",
  "function switchFrozen() view returns (bool)",
  "function switchDwell() view returns (uint32)",
  "function lastSwitchAt() view returns (uint256)",
]);
const moduleAbi = parseAbi([
  "function adapters(address) view returns (bool enabled, bool redemptionSafe, bool isLoop, uint256 absoluteCap, uint16 relativeCapBps)",
  "function adapterExposure(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
]);

const chain = {
  id: CHAIN_ID,
  name: "robinhood-chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { timeout: config.rpc.timeoutMs, retryCount: config.rpc.retries }),
});

const key = env.KEEPER_PRIVATE_KEY?.trim();
const account = key ? privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`) : null;
const wallet = account
  ? createWalletClient({
      account,
      chain,
      transport: http(RPC_URL, { timeout: config.rpc.timeoutMs, retryCount: config.rpc.retries }),
    })
  : null;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Every write is simulated before it is sent, and receipts are awaited with the RPC timeout.
// `send` keeps the previous `{ address, abi, functionName, args, label }` call shape.
const executor = createExecutor({ publicClient, wallet, dryRun: DRY_RUN, config, log });
const send = executor.send;

async function notify(text) {
  const url = env.KEEPER_WEBHOOK_URL?.trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    log("webhook failed:", e.message);
  }
}

async function vaultUsdgBalance() {
  return publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] });
}

async function readControllerBounds() {
  if (!AGENT) return null;
  try {
    const controller = await publicClient.readContract({
      address: AGENT,
      abi: agentAbi,
      functionName: "controller",
    });
    const b = await publicClient.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "bounds",
    });
    return {
      maxFundQuote: BigInt(b[13]),
      maxFundEquity: BigInt(b[14]),
      maxAllocate: BigInt(b[16]),
      maxCollateral: BigInt(b[17]),
      maxBorrow: BigInt(b[18]),
    };
  } catch (e) {
    log("allocator: bounds read failed:", e.shortMessage ?? e.message);
    return null;
  }
}

function capAmount(amount, cap) {
  if (cap === undefined || cap === null) return amount;
  return amount > cap ? cap : amount;
}

async function readControllerState() {
  if (!AGENT) return null;
  try {
    const controller = await publicClient.readContract({
      address: AGENT,
      abi: agentAbi,
      functionName: "controller",
    });
    const [paused, switchFrozen] = await Promise.all([
      publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "paused" }),
      publicClient.readContract({
        address: controller,
        abi: controllerAbi,
        functionName: "switchFrozen",
      }),
    ]);
    return { paused, switchFrozen };
  } catch (e) {
    log("allocator: controller state read failed:", e.shortMessage ?? e.message);
    return null;
  }
}

async function readModuleCaps(armDebt) {
  if (!AGENT) return null;
  try {
    const controller = await publicClient.readContract({
      address: AGENT,
      abi: agentAbi,
      functionName: "controller",
    });
    const module = await publicClient.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "strategyModule",
    });
    if (module === "0x0000000000000000000000000000000000000000") return null;

    const [usdgCfg, armCfg, totalAssets, baseAssets, usdgExposure, armExposure] =
      await Promise.all([
        USDG_ADAPTER
          ? publicClient.readContract({
              address: module,
              abi: moduleAbi,
              functionName: "adapters",
              args: [USDG_ADAPTER],
            })
          : Promise.resolve(null),
        ARM
          ? publicClient.readContract({
              address: module,
              abi: moduleAbi,
              functionName: "adapters",
              args: [ARM],
            })
          : Promise.resolve(null),
        publicClient.readContract({ address: module, abi: moduleAbi, functionName: "totalAssets" }),
        publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "baseManagedAssets" }),
        USDG_ADAPTER
          ? publicClient.readContract({
              address: module,
              abi: moduleAbi,
              functionName: "adapterExposure",
              args: [USDG_ADAPTER],
            })
          : Promise.resolve(0n),
        ARM
          ? publicClient.readContract({
              address: module,
              abi: moduleAbi,
              functionName: "adapterExposure",
              args: [ARM],
            })
          : Promise.resolve(0n),
      ]);

    const base = BigInt(baseAssets) + BigInt(totalAssets);
    const headroom = (cfg, exposure) => {
      if (!cfg || !cfg[0]) return 0n;
      const absolute = BigInt(cfg[3]);
      const relative = (base * BigInt(cfg[4])) / 10_000n;
      const limit = absolute < relative ? absolute : relative;
      return limit > BigInt(exposure) ? limit - BigInt(exposure) : 0n;
    };

    return {
      usdg: headroom(usdgCfg, usdgExposure),
      collateralValue: headroom(armCfg, armExposure),
      borrow: headroom(armCfg, armDebt),
    };
  } catch (e) {
    log("allocator: module caps read failed:", e.shortMessage ?? e.message);
    return null;
  }
}

/**
 * Borrow guard for the arm's Morpho market: the operator APR ceiling first (skip the market
 * read when it is already breached), then the liquidity actually available to borrow.
 * Returns `{ ok: false, reason }` when the borrow step must not be submitted this tick.
 */
async function readBorrowHeadroom() {
  if (!ARM) return { ok: false, reason: "no KEEPER_ARM_ADAPTER configured" };
  try {
    const [apr, morphoAddress, marketId] = await Promise.all([
      publicClient.readContract({ address: ARM, abi: armAbi, functionName: "borrowAprBps" }),
      publicClient.readContract({ address: ARM, abi: armAbi, functionName: "morpho" }),
      publicClient.readContract({ address: ARM, abi: armAbi, functionName: "marketId" }),
    ]);
    if (Number(apr) > MAX_BORROW_APR_BPS) {
      return { ok: false, reason: `borrow APR ${apr}bps > ${MAX_BORROW_APR_BPS}bps` };
    }

    const market = await publicClient.readContract({
      address: morphoAddress,
      abi: morphoAbi,
      functionName: "market",
      args: [marketId],
    });
    const totalSupplyAssets = BigInt(market[0]);
    const totalBorrowAssets = BigInt(market[2]);
    const available =
      totalSupplyAssets > totalBorrowAssets ? totalSupplyAssets - totalBorrowAssets : 0n;
    return { ok: true, aprBps: Number(apr), available };
  } catch (e) {
    // Fail closed: an unreadable market must not license a borrow.
    return { ok: false, reason: `market read failed: ${e.shortMessage ?? e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Loop arm: lend APR, gas gate, and the LTV clamp (all read from the adapters)
// ---------------------------------------------------------------------------

/** Quote/equity decimals, read once and cached. The default is only a failed-read fallback. */
const tokenDecimalsCache = new Map();

function readTokenDecimals(token, fallback) {
  if (!token) return Promise.resolve(fallback);
  const key = String(token).toLowerCase();
  const cached = tokenDecimalsCache.get(key);
  if (cached) return cached;
  const pending = publicClient
    .readContract({ address: token, abi: erc20Abi, functionName: "decimals" })
    .then((d) => Number(d))
    .catch((e) => {
      tokenDecimalsCache.delete(key);
      log(
        `token decimals read failed (${token}): ${e.shortMessage ?? e.message}; ` +
          `assuming ${fallback}`,
      );
      return fallback;
    });
  tokenDecimalsCache.set(key, pending);
  return pending;
}

let armLtvPromise = null;
let armLtvFallbackLogged = false;

/**
 * Effective arm LTV, resolved once per process:
 *   target = min(operator target, operator hard cap, adapter ceiling)
 *
 * The adapter ceiling is its `targetLtvOfLltvBps` fraction of the market LLTV in absolute
 * bps. `lltv` is WAD-scaled on chain, so pct/1e4 * lltv/1e18 * 1e4 = pct * lltv / 1e18.
 * A failed adapter read falls back to the operator hard cap; no LLTV is ever inferred.
 */
async function readArmLtv() {
  const configuredBps = config.arm.targetLtvBps;
  const hardCapBps = config.arm.maxLtvBps;
  const configOnly = {
    targetLtvBps: Math.min(configuredBps, hardCapBps),
    maxLtvBps: hardCapBps,
    hardCapBps,
    source: "config",
  };
  if (!ARM) return configOnly;

  try {
    const [pctRaw, params] = await Promise.all([
      publicClient.readContract({ address: ARM, abi: armAbi, functionName: "targetLtvOfLltvBps" }),
      publicClient.readContract({ address: ARM, abi: armAbi, functionName: "marketParams" }),
    ]);
    const pctOfLltv = BigInt(pctRaw);
    const lltv = BigInt(params[4]);
    const ceiling = Number((pctOfLltv * lltv) / WAD);
    const adapterTargetLtvBps = Math.max(0, Math.min(10_000, ceiling));
    const targetLtvBps = Math.min(configuredBps, hardCapBps, adapterTargetLtvBps);
    if (hardCapBps > adapterTargetLtvBps) {
      log(
        `arm ltv: operator hard cap ${hardCapBps}bps exceeds the adapter ceiling ` +
          `${adapterTargetLtvBps}bps; target and sentinel clamp to the ceiling`,
      );
    }
    log(
      `arm ltv: target=${targetLtvBps}bps (config ${configuredBps}bps, hard cap ${hardCapBps}bps, ` +
        `adapter ceiling ${adapterTargetLtvBps}bps = ${pctOfLltv}/10000 of lltv ${lltv})`,
    );
    return { targetLtvBps, maxLtvBps: adapterTargetLtvBps, hardCapBps, source: "adapter" };
  } catch (e) {
    if (!armLtvFallbackLogged) {
      armLtvFallbackLogged = true;
      log(
        `arm ltv: adapter read failed (${e.shortMessage ?? e.message}); falling back to the ` +
          `config hard cap ${hardCapBps}bps (market LLTV is not inferred)`,
      );
    }
    return { ...configOnly, source: "config-fallback" };
  }
}

/**
 * Cached LTV clamp. A fallback result is not cached, so a transient RPC error cannot
 * downgrade the clamp for the life of the process.
 */
function effectiveArmLtv() {
  if (!armLtvPromise) {
    armLtvPromise = readArmLtv().then((ltv) => {
      if (ltv.source === "config-fallback") armLtvPromise = null;
      return ltv;
    });
  }
  return armLtvPromise;
}

let lendAprCache = null;

/**
 * Lend-side APR (bps) from the live market: borrow APR * utilisation * (1 - fee).
 * Returns `{ ok: false, reason }` when the adapter or its market cannot be read.
 */
async function readLendAprBps() {
  if (!USDG_ADAPTER) return { ok: false, reason: "no USDG adapter" };
  const now = Date.now();
  if (lendAprCache && now - lendAprCache.at < 60_000) return lendAprCache.value;

  try {
    const [morphoAddress, marketId, params] = await Promise.all([
      publicClient.readContract({ address: USDG_ADAPTER, abi: lendAdapterAbi, functionName: "morpho" }),
      publicClient.readContract({ address: USDG_ADAPTER, abi: lendAdapterAbi, functionName: "marketId" }),
      publicClient.readContract({ address: USDG_ADAPTER, abi: lendAdapterAbi, functionName: "marketParams" }),
    ]);
    const irm = params[3];
    if (!irm || irm.toLowerCase() === ZERO_ADDRESS) {
      return { ok: false, reason: "lend market has no IRM" };
    }

    const market = await publicClient.readContract({
      address: morphoAddress,
      abi: morphoAbi,
      functionName: "market",
      args: [marketId],
    });
    const ratePerSecondWad = await publicClient.readContract({
      address: irm,
      abi: irmAbi,
      functionName: "borrowRateView",
      args: [params, market],
    });

    // Same simple annualization as MorphoLoopAdapter.borrowAprBps().
    const borrowAprBps = Number((BigInt(ratePerSecondWad) * SECONDS_PER_YEAR * 10_000n) / WAD);
    const totalSupplyAssets = BigInt(market[0]);
    const totalBorrowAssets = BigInt(market[2]);
    const util =
      totalSupplyAssets > 0n ? Number(totalBorrowAssets) / Number(totalSupplyAssets) : 0;
    const fee = Number(market[5]) / 1e18;
    const value = { ok: true, lendAprBps: borrowAprBps * util * (1 - fee), borrowAprBps, util, fee };
    lendAprCache = { at: now, value };
    return value;
  } catch (e) {
    return { ok: false, reason: `lend apr read failed: ${e.shortMessage ?? e.message}` };
  }
}

let ethUsdFeedDecimals = null;
let ethUsdSourceWarned = false;

/** ETH/USD from the configured Chainlink feed, then the config override, else 0 (unknown). */
async function readEthUsd() {
  const feed = config.addresses.ethUsdFeed;
  if (feed) {
    try {
      if (ethUsdFeedDecimals === null) {
        ethUsdFeedDecimals = Number(
          await publicClient.readContract({
            address: feed,
            abi: chainlinkAbi,
            functionName: "decimals",
          }),
        );
      }
      const round = await publicClient.readContract({
        address: feed,
        abi: chainlinkAbi,
        functionName: "latestRoundData",
      });
      const answer = round[1];
      if (answer > 0n) return Number(answer) / 10 ** ethUsdFeedDecimals;
      log("gas gate: ETH/USD feed answer is not positive");
    } catch (e) {
      log("gas gate: ETH/USD feed read failed:", e.shortMessage ?? e.message);
    }
  }
  if (config.risk.ethUsd > 0) return config.risk.ethUsd;
  if (!ethUsdSourceWarned) {
    ethUsdSourceWarned = true;
    log("gas gate: no ETH/USD source");
  }
  return 0;
}

/**
 * USD cost of one action at the current gas price.
 * null means unknown: economic gates must hold (never treat unknown gas as free).
 */
async function readGasCostUsd() {
  const ethUsd = await readEthUsd();
  if (!(ethUsd > 0)) return null;
  try {
    const gasPrice = await publicClient.getGasPrice();
    const wei = GAS_UNITS_PER_ACTION * BigInt(gasPrice);
    return (Number(wei) / 1e18) * ethUsd;
  } catch (e) {
    log("gas gate: gas price read failed:", e.shortMessage ?? e.message);
    return null;
  }
}

/** Live carry spread for the arm loop; `ok: false` when either leg cannot be read. */
async function readLoopSpread() {
  const [lend, headroom] = await Promise.all([readLendAprBps(), readBorrowHeadroom()]);
  if (!lend.ok) return { ok: false, reason: lend.reason };
  if (!headroom.ok) return { ok: false, reason: headroom.reason };
  return {
    ok: true,
    spread: loopSpreadBps({ lendAprBps: lend.lendAprBps, borrowAprBps: headroom.aprBps }),
  };
}

/**
 * Carry exit: a spread under the exit floor no longer pays for the loop, so unwind the debt
 * first and the collateral second. This is economic, not safety, so it obeys the allocator
 * execute gate; safety de-leverage never waits for it.
 */
async function maybeExitLoop({ debt, collateral }) {
  const live = await readLoopSpread();
  if (!live.ok) {
    if (debt > 0n) log(`loop exit: spread unknown (${live.reason}); holding debt`);
    return;
  }
  if (!shouldExitLoop({ spreadBps: live.spread, exitSpreadBps: ARM_EXIT_SPREAD_BPS })) return;
  const reason = `spread ${live.spread}bps < exit ${ARM_EXIT_SPREAD_BPS}bps`;

  if (!ALLOCATOR_EXECUTE || !AGENT) {
    log(`loop exit: would unwind (${reason}); execute disabled`);
    return;
  }

  if (debt > 0n) {
    const slice = (debt * DELEVERAGE_BPS) / 10_000n;
    const wanted = (slice > 0n ? slice : debt) + REPAY_BUFFER_USDG;
    const available = await ensureVaultUsdg(wanted);
    if (available <= 0n) {
      log(`loop exit: cannot fund ${wanted} USDG repayment (${reason})`);
      return;
    }
    const repay = available < wanted ? available : wanted;
    if (!DRY_RUN) await executor.approveIfNeeded({ token: USDG, amount: repay });
    await send({
      address: AGENT,
      abi: agentAbi,
      functionName: "submitDeleverage",
      args: [ARM, repay, 0n],
      label: `loop exit: repay ${repay} USDG (${reason})`,
    });
    return;
  }

  if (collateral > 0n) {
    await send({
      address: AGENT,
      abi: agentAbi,
      functionName: "submitDeleverage",
      args: [ARM, 0n, collateral],
      label: `loop exit: withdraw ${collateral} NVDA collateral (${reason})`,
    });
  }
}

/** Pulls USDG from the lend arm when needed; returns the vault's available balance. */
async function ensureVaultUsdg(amount) {
  let balance = await vaultUsdgBalance();
  if (amount <= 0n || balance >= amount) return balance;
  if (!USDG_ADAPTER) {
    log("allocator: vault USDG short and no KEEPER_USDG_ADAPTER to pull from");
    return balance;
  }
  const need = amount - balance;
  await send({
    address: AGENT,
    abi: agentAbi,
    functionName: "submitDeallocate",
    args: [USDG_ADAPTER, need],
    label: `allocator: pull ${need} USDG from lend arm for repayment`,
  });
  balance = await vaultUsdgBalance();
  return balance;
}

function candidatePools() {
  if (CANDIDATE_POOLS_RAW) {
    try {
      const list = JSON.parse(CANDIDATE_POOLS_RAW);
      if (Array.isArray(list)) return list;
    } catch (e) {
      log("allocator: invalid KEEPER_CANDIDATE_POOLS JSON:", e.message);
    }
  }

  const list = [];
  if (BOOK_A_POOL) {
    list.push({
      name: "bookA",
      kind: "v4",
      poolId: BOOK_A_POOL,
      feePips: BOOK_A_FEE_PIPS,
      book: 0,
      switchable: true,
    });
  }
  if (BOOK_B_POOL) {
    list.push({
      name: "bookB",
      kind: "v4",
      poolId: BOOK_B_POOL,
      feePips: BOOK_B_FEE_PIPS,
      book: 1,
      switchable: true,
    });
  }
  return list;
}

/**
 * First block of the 24h fee/IL window. 0n when the chain is younger than the window;
 * `blockNumber` when `blockTimeSeconds` is 0 (no usable window — callers hold).
 */
function feeFromBlockFor(blockNumber) {
  if (FEE_WINDOW_BLOCKS <= 0n) return blockNumber;
  return blockNumber > FEE_WINDOW_BLOCKS ? blockNumber - FEE_WINDOW_BLOCKS : 0n;
}

function maxBigInt(a, b) {
  return a > b ? a : b;
}

/** Named or positional `GuardParams.Params` decode -> plain values. */
function guardParamsOf(params) {
  const named = params ?? {};
  const positional = Array.isArray(params) ? params : [];
  return {
    guardLiquidity: BigInt(named.guardLiquidity ?? positional[2] ?? 0n),
    baseLiquidity: BigInt(named.baseLiquidity ?? positional[3] ?? 0n),
  };
}

/**
 * Raw Swap entries for one v4 pool, in block chunks (public RPCs cap `getLogs`).
 * `fetchBookStats` only returns a summary, so the rolling cache keeps these entries and
 * summarizes them per window with `summarizeBook` (the same function it wraps).
 */
async function fetchSwapEntries({ poolManager, poolId, fromBlock, toBlock }) {
  const query = { address: poolManager, event: SWAP_EVENT, args: { id: poolId } };
  const entries = [];
  for (const range of chunkedBlockRanges({ fromBlock, toBlock, chunkBlocks: LOGS_CHUNK_BLOCKS })) {
    const logs = await publicClient.getLogs({ ...query, ...range });
    for (const entry of logs) {
      entries.push({
        ...entry.args,
        blockNumber: entry.blockNumber,
        logIndex: entry.logIndex,
        transactionHash: entry.transactionHash,
      });
    }
  }
  return entries;
}

/**
 * Incremental 24h swap cache for one pool. The first run fetches the whole fee window,
 * later runs only `lastFetchedBlock + 1 .. current`, merged and pruned at
 * `block - feeWindowBlocks`. A failed fetch keeps the old entries but marks the pool
 * stale and does not advance `lastFetchedBlock`, so the next run refetches the gap.
 */
async function refreshSwapCache({ poolManager, poolId, blockNumber }) {
  const key = String(poolId).toLowerCase();
  const previous = swapCache.get(key);

  if (FEE_WINDOW_BLOCKS <= 0n) {
    // No 24h window: holding is safer than scoring one block of swaps as an APR.
    log("allocator: 24h fee window is 0 blocks (KEEPER_BLOCK_TIME_SECONDS); holding");
    return { entries: [], fresh: false, fromBlock: blockNumber };
  }

  const feeFromBlock = feeFromBlockFor(blockNumber);
  const fromBlock =
    previous?.lastFetchedBlock != null
      ? maxBigInt(previous.lastFetchedBlock + 1n, feeFromBlock)
      : feeFromBlock;

  if (fromBlock > blockNumber) {
    return {
      entries: pruneSwapCache({ entries: previous?.entries ?? [], fromBlock: feeFromBlock }),
      fresh: previous?.fresh !== false,
      fromBlock,
    };
  }

  try {
    const incoming = await fetchSwapEntries({
      poolManager,
      poolId,
      fromBlock,
      toBlock: blockNumber,
    });
    const entries = pruneSwapCache({
      entries: mergeSwapCache(previous?.entries ?? [], incoming),
      fromBlock: feeFromBlock,
    });
    swapCache.set(key, { entries, lastFetchedBlock: blockNumber, fresh: true });
    return { entries, fresh: true, fromBlock, fetched: incoming.length };
  } catch (e) {
    log(
      `allocator: swap fetch failed for ${key} (blocks ${fromBlock}-${blockNumber}):`,
      e.shortMessage ?? e.message,
    );
    const entries = pruneSwapCache({ entries: previous?.entries ?? [], fromBlock: feeFromBlock });
    swapCache.set(key, { entries, lastFetchedBlock: previous?.lastFetchedBlock ?? null, fresh: false });
    return { entries, fresh: false, fromBlock };
  }
}

function guardEventKey(event) {
  return `${event?.type}:${String(event?.blockNumber)}:${String(event?.logIndex)}`;
}

function sortGuardEvents(events) {
  return [...events].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0)
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
}

function mergeGuardEvents(existing, incoming) {
  const merged = [...(existing ?? [])];
  const seen = new Set(merged.map(guardEventKey));
  for (const event of incoming ?? []) {
    const key = guardEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return sortGuardEvents(merged);
}

/**
 * Keep events at or after `fromBlock`, plus the last `pulled` before it when the guard
 * was already down at the window start (dropping it would count that stretch as up).
 */
function pruneGuardEvents(entries, fromBlock) {
  const sorted = sortGuardEvents(entries ?? []);
  const kept = sorted.filter((event) => event.blockNumber >= fromBlock);
  let anchor = null;
  for (const event of sorted) {
    if (event.blockNumber < fromBlock) anchor = event;
    else break;
  }
  return anchor?.type === "pulled" ? [anchor, ...kept] : kept;
}

async function fetchGuardEvents({ bookHook, fromBlock, toBlock }) {
  const events = [];
  for (const range of chunkedBlockRanges({ fromBlock, toBlock, chunkBlocks: LOGS_CHUNK_BLOCKS })) {
    const [pulled, deployed] = await Promise.all([
      publicClient.getLogs({ address: bookHook, event: guardPulledEvent, ...range }),
      publicClient.getLogs({ address: bookHook, event: guardDeployedEvent, ...range }),
    ]);
    for (const entry of pulled) {
      events.push({ type: "pulled", blockNumber: BigInt(entry.blockNumber), logIndex: entry.logIndex });
    }
    for (const entry of deployed) {
      events.push({ type: "deployed", blockNumber: BigInt(entry.blockNumber), logIndex: entry.logIndex });
    }
  }
  return events;
}

/**
 * Fraction of the fee window one book's guard was deployed. A read failure keeps the
 * cached history (logged) instead of inventing an uptime.
 */
async function guardUptimeFor({ bookHook, fromBlock, toBlock }) {
  if (!bookHook) return { uptime: 1, fresh: false };
  const key = String(bookHook).toLowerCase();
  const previous = guardEventCache.get(key);
  let entries = previous?.entries ?? [];
  let fresh = false;

  const floor =
    previous?.lastFetchedBlock != null
      ? maxBigInt(previous.lastFetchedBlock + 1n, fromBlock)
      : fromBlock;

  if (fromBlock <= toBlock && floor <= toBlock) {
    try {
      const incoming = await fetchGuardEvents({ bookHook, fromBlock: floor, toBlock });
      entries = pruneGuardEvents(mergeGuardEvents(entries, incoming), fromBlock);
      guardEventCache.set(key, { entries, lastFetchedBlock: toBlock });
      fresh = true;
    } catch (e) {
      log(`allocator: guard event fetch failed for ${key}:`, e.shortMessage ?? e.message);
      entries = pruneGuardEvents(entries, fromBlock);
      guardEventCache.set(key, { entries, lastFetchedBlock: previous?.lastFetchedBlock ?? null });
    }
  } else {
    entries = pruneGuardEvents(entries, fromBlock);
    fresh = true;
  }

  const { uptime } = computeGuardUptime({
    events: entries,
    windowStart: fromBlock,
    windowEnd: toBlock,
    blockTimeSeconds: BLOCK_TIME_SECONDS,
  });
  return { uptime, fresh };
}

/** Book hooks for the two switchable books, so a candidate can read its own guard history. */
async function readBookHooks() {
  try {
    const [bookA, bookB] = await Promise.all([
      publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "bookA" }),
      publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "bookB" }),
    ]);
    return [bookA, bookB];
  } catch (e) {
    log("allocator: book hook read failed:", e.shortMessage ?? e.message);
    return [null, null];
  }
}

/** Configured guard size for a book; used when the guard is absent right now. */
async function readGuardLiquidity(bookHook) {
  if (!bookHook) return 0n;
  try {
    const params = await publicClient.readContract({
      address: bookHook,
      abi: hookAbi,
      functionName: "guardParams",
    });
    return guardParamsOf(params).guardLiquidity;
  } catch (e) {
    log("allocator: guardParams read failed:", e.shortMessage ?? e.message);
    return 0n;
  }
}

/**
 * A switch is ~4 actions: recall/pull, fund, push/activate, plus the book switch itself.
 * null means unknown: the switch gate must hold rather than treat gas as free.
 */
async function readSwitchGasCostUsd() {
  const ethUsd = await readEthUsd();
  if (!(ethUsd > 0)) return null;
  try {
    const gasPrice = await publicClient.getGasPrice();
    const wei = GAS_UNITS_PER_ACTION * 4n * BigInt(gasPrice);
    return (Number(wei) / 1e18) * ethUsd;
  } catch (e) {
    log("allocator: switch gas price read failed:", e.shortMessage ?? e.message);
    return null;
  }
}

/**
 * Controller dwell gate: the controller reverts a switch inside `switchDwell` of the
 * last one, so read it before sending. An unreadable gate fails closed.
 */
async function readSwitchDwellGate(now) {
  if (!AGENT) return { ok: false, reason: "no KEEPER_AGENT configured" };
  try {
    const controller = await publicClient.readContract({
      address: AGENT,
      abi: agentAbi,
      functionName: "controller",
    });
    const [dwell, lastSwitchAt] = await Promise.all([
      publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "switchDwell" }),
      publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "lastSwitchAt" }),
    ]);
    const dwellSeconds = Number(dwell);
    const lastSwitch = Number(lastSwitchAt);
    if (lastSwitch > 0 && now < lastSwitch + dwellSeconds) {
      return {
        ok: false,
        reason: `switchDwell active: ${lastSwitch + dwellSeconds - now}s remaining`,
      };
    }
    return { ok: true, switchDwell: dwellSeconds, lastSwitchAt: lastSwitch };
  } catch (e) {
    return { ok: false, reason: `switch dwell read failed: ${e.shortMessage ?? e.message}` };
  }
}

/** Target book readiness: initialized pool with a non-zero guard size. */
async function readBookReadiness(book) {
  try {
    const address = await publicClient.readContract({
      address: HOOK,
      abi: hookAbi,
      functionName: book === 0 ? "bookA" : "bookB",
    });
    const [initialized, params] = await Promise.all([
      publicClient.readContract({ address, abi: hookAbi, functionName: "poolInitialized" }),
      publicClient.readContract({ address, abi: hookAbi, functionName: "guardParams" }),
    ]);
    if (!initialized) return { ok: false, reason: "pool not initialized" };
    const { guardLiquidity } = guardParamsOf(params);
    if (guardLiquidity <= 0n) return { ok: false, reason: "guardParams.guardLiquidity is 0" };
    return { ok: true, address, guardLiquidity };
  } catch (e) {
    return { ok: false, reason: `read failed: ${e.shortMessage ?? e.message}` };
  }
}

/**
 * One candidate's market read over two windows of the same rolling swap cache:
 *   - risk (36m): volume + fluctuation -> the hard-risk score;
 *   - fee/IL (24h): fee APR after worst-case IL and guard uptime -> the carry score.
 * Position value/share is the same book capital for both books, so the net APRs are
 * comparable before a switch. Every market parameter comes from config or the book hook.
 */
async function scanCandidate(c, view) {
  if (c.kind !== "v4") throw new Error(`unsupported candidate kind ${c.kind}`);
  const pm = c.poolManager || POOL_MANAGER;
  if (!pm || !c.poolId) throw new Error("v4 candidate missing poolManager/poolId");

  const { blockNumber, riskFromBlock, feeFromBlock, activePoolId, capitalUsd, bookHooks, quoteDecimals } =
    view;

  const [liquidity, slot0] = await Promise.all([
    publicClient.readContract({
      address: pm,
      abi: v4PoolManagerAbi,
      functionName: "getLiquidity",
      args: [c.poolId],
    }),
    publicClient.readContract({
      address: pm,
      abi: v4PoolManagerAbi,
      functionName: "getSlot0",
      args: [c.poolId],
    }),
  ]);

  // The pool's current LP fee is authoritative (dynamic-fee pools can change it).
  const onchainFeePips = Number(slot0[3] ?? 0);
  const feePips = onchainFeePips > 0 ? onchainFeePips : (c.feePips ?? 0);

  const cache = await refreshSwapCache({ poolManager: pm, poolId: c.poolId, blockNumber });
  const riskBook = summarizeBook({
    swaps: filterSwapsByBlock(cache.entries, riskFromBlock, blockNumber),
    feePips,
    nav: 0n,
    windowSeconds: STATS_WINDOW_SECONDS,
    token0Decimals: quoteDecimals,
  });
  const feeBook = summarizeBook({
    swaps: filterSwapsByBlock(cache.entries, feeFromBlock, blockNumber),
    feePips,
    nav: 0n,
    windowSeconds: FEE_WINDOW_SECONDS,
    token0Decimals: quoteDecimals,
  });

  const sqrtPriceX96 = slot0[0];
  const currentTick = Number(slot0[1]);
  const poolL = Number(liquidity);
  const activeLiquidityUsd = activeLiquidityValue({
    liquidity,
    sqrtPriceX96,
    token0Decimals: quoteDecimals,
  });

  const isActive = String(c.poolId).toLowerCase() === String(activePoolId).toLowerCase();
  const bookHook = c.book === 0 || c.book === 1 ? bookHooks[c.book] ?? null : null;
  let bookShare;
  let bookValueUsd;
  let bookRange;
  let baseShare;
  let guardShare;
  let guardUptime = 1;
  // A guard-uptime read that failed must not license a switch, so freshness is returned
  // to the tick. No hook at all (single-book) is not a failed read and stays fresh.
  let guardUptimeFresh = true;
  let bookPositionLiquidity = 0n;
  let bookGuardPresent = false;

  if (isActive) {
    const [base, guard] = await Promise.all([
      publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "basePosition" }),
      publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "guardPosition" }),
    ]);
    const positions = [
      { tickLower: Number(base[0]), tickUpper: Number(base[1]), liquidity: base[2] },
      { tickLower: Number(guard[0]), tickUpper: Number(guard[1]), liquidity: guard[2] },
    ];

    let bookLiquidity = 0n;
    let value = 0;
    for (const p of positions) {
      if (p.liquidity <= 0n) continue;
      bookPositionLiquidity += p.liquidity;
      const inRange = currentTick >= p.tickLower && currentTick < p.tickUpper;
      if (inRange) bookLiquidity += p.liquidity;
      value += positionValueUsd({
        liquidity: p.liquidity,
        sqrtPriceX96,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        token0Decimals: quoteDecimals,
      });
    }

    // Use the base range for IL when it has liquidity; otherwise the guard is the book.
    bookRange =
      base[2] > 0n
        ? { tickLower: Number(base[0]), tickUpper: Number(base[1]) }
        : { tickLower: Number(guard[0]), tickUpper: Number(guard[1]) };
    bookValueUsd = value;
    bookShare = poolL > 0 ? Number(bookLiquidity) / poolL : 0;
    bookGuardPresent = guard[2] > 0n;

    if (bookPositionLiquidity === 0n && Number(capitalUsd) > 0) {
      // An empty active book has no fee history of its own. Use the same hypothetical
      // deployment as the other book; it will be armed on return, so uptime 1.
      const range = rangeFromHalfWidth({
        currentTick,
        halfWidthBps: RANGE_HALF_WIDTH_BPS,
      });
      const hypotheticalL = liquidityForValue({
        valueUsd: Number(capitalUsd),
        sqrtPriceX96,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        token0Decimals: quoteDecimals,
      });
      bookValueUsd = Number(capitalUsd);
      bookShare = poolL + hypotheticalL > 0 ? hypotheticalL / (poolL + hypotheticalL) : 0;
      bookRange = range;
    } else if (poolL > 0) {
      // Fee share is the book's base plus the guard only while it is actually deployed.
      // A recalled guard is sized from `guardParams().guardLiquidity`.
      const guardLiquidity = guard[2] > 0n ? guard[2] : await readGuardLiquidity(bookHook);
      baseShare = Number(base[2]) / poolL;
      guardShare = Number(guardLiquidity) / poolL;
      if (bookHook) {
        const uptime = await guardUptimeFor({
          bookHook,
          fromBlock: feeFromBlock,
          toBlock: blockNumber,
        });
        guardUptime = uptime.uptime;
        guardUptimeFresh = uptime.fresh;
        if (!uptime.fresh) log(`allocator: guard uptime for ${c.name} is from cache (read failed)`);
      } else if (!noBookHookLogged) {
        // Single-book deployment (no hub): there is no guard history to read. This is
        // not a failed read, so the book stays scoreable at full uptime.
        noBookHookLogged = true;
        log(`allocator (debug): no book hook for ${c.name}; guard uptime not read from history`);
      }
    }
  } else if (Number(capitalUsd) > 0) {
    // Hypothetical deployment of the same book capital into the other book,
    // at the same relative range around that pool's current tick.
    const range = rangeFromHalfWidth({
      currentTick,
      halfWidthBps: RANGE_HALF_WIDTH_BPS,
    });
    const hypotheticalL = liquidityForValue({
      valueUsd: Number(capitalUsd),
      sqrtPriceX96,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      token0Decimals: quoteDecimals,
    });
    bookValueUsd = Number(capitalUsd);
    bookShare = poolL + hypotheticalL > 0 ? hypotheticalL / (poolL + hypotheticalL) : 0;
    bookRange = range;
    // The guard is armed on switch, so the destination is scored at full uptime.
    guardUptime = 1;
  }

  const market = marketStats({
    book: feeBook,
    activeLiquidityUsd,
    windowSeconds: FEE_WINDOW_SECONDS,
    rangeHalfWidthBps: RANGE_HALF_WIDTH_BPS,
    bookShare,
    bookValueUsd,
    bookRange,
    tickStart: feeBook.tickFirst,
    tickEnd: feeBook.tickLast,
    tickMin: feeBook.tickMin,
    tickMax: feeBook.tickMax,
    guardUptime,
    baseShare,
    guardShare,
    ilMultipleBps: IL_MULTIPLE_BPS,
  });

  const eligible = activeLiquidityUsd >= MIN_POOL_LIQUIDITY_USD;
  // Guard/depeg are portfolio-state gates handled by tickAllocator before this
  // market-risk score. Do not feed them in here, or a deliberately recalled book
  // (guard absent by design) can never become eligible to return to the book.
  const risk = assessBookRisk({
    feeAprBps: market.feeAprBps,
    volumeUsd: riskBook.volumeUsd,
    volatilityBps: riskBook.volatilityBps,
    guardPresent: true,
    depegPaused: false,
    thresholds: RISK_THRESHOLDS,
  });

  return {
    ...c,
    ...market,
    activeLiquidityUsd,
    bookPositionLiquidity,
    bookGuardPresent,
    bookShare,
    baseShare,
    guardShare,
    guardUptimeFresh,
    // The range the IL/guard math used (base, else guard, else hypothetical). Exposed so the
    // advisory course-correct can express the guard width in bps without re-reading the hook.
    bookRange,
    riskVolumeUsd: riskBook.volumeUsd,
    riskVolatilityBps: riskBook.volatilityBps,
    riskSwaps: riskBook.swaps,
    feeSwaps: feeBook.swaps,
    eligible,
    risk: eligible ? risk.risk : "HIGH",
    riskReasons: eligible ? risk.reasons : ["thin-active-liquidity"],
    netAprBps: market.netAprBps,
    fresh: cache.fresh,
  };
}

async function armBalances() {
  const [collateral, debt, usdg] = await Promise.all([
    ARM
      ? publicClient.readContract({ address: ARM, abi: armAbi, functionName: "collateralBalance" })
      : Promise.resolve(0n),
    ARM ? publicClient.readContract({ address: ARM, abi: armAbi, functionName: "debt" }) : Promise.resolve(0n),
    USDG_ADAPTER
      ? publicClient.readContract({ address: USDG_ADAPTER, abi: lendAbi, functionName: "realAssets" })
      : Promise.resolve(0n),
  ]);
  return { collateral, debt, usdg };
}

async function deployToArms({ armCollateral, armDebt, usdgDeployed, nvdaPriceWad }) {
  const [idleUsdg, idleNvda, lend, headroom, ltv] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] }),
    publicClient.readContract({ address: NVDA, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] }),
    readLendAprBps(),
    readBorrowHeadroom(),
    effectiveArmLtv(),
  ]);

  // The plan and the borrow cap both run off the clamped LTV and the live spread.
  const plan = planArmEntry({
    usdgAvailable: idleUsdg,
    nvdaAvailable: idleNvda,
    usdgDeployed,
    nvdaDeployed: armCollateral,
    nvdaPriceWad,
    targetLtvBps: ltv.targetLtvBps,
    maxLtvBps: ltv.maxLtvBps,
    hardCapBps: ltv.hardCapBps,
    morphoShareBps: MORPHO_ARM_SHARE_BPS,
    nvdaStepBps: NVDA_STEP_BPS,
  });

  const bounds = await readControllerBounds();
  const moduleCaps = await readModuleCaps(armDebt);
  const usdgMove = capAmount(capAmount(plan.usdgMove, bounds?.maxAllocate), moduleCaps?.usdg);

  let nvdaValueCap;
  if (moduleCaps && ARM) {
    try {
      const valuePerNvda = await publicClient.readContract({
        address: ARM,
        abi: armAbi,
        functionName: "collateralValueOf",
        args: [10n ** 18n],
      });
      if (valuePerNvda > 0n) {
        nvdaValueCap = (moduleCaps.collateralValue * 10n ** 18n) / valuePerNvda;
      }
    } catch {
      // Fall through without the value cap; the module itself still enforces it.
    }
  }

  let nvdaMove = capAmount(capAmount(plan.nvdaMove, bounds?.maxCollateral), nvdaValueCap);

  // Live arm value backs the borrow sizing and the payback estimate. A failed read falls
  // back to the plan's own (this-tick) estimate rather than aborting the allocator run.
  let collateralValue = 0n;
  if (ARM) {
    try {
      collateralValue = await publicClient.readContract({
        address: ARM,
        abi: armAbi,
        functionName: "collateralValue",
      });
    } catch (e) {
      log("allocator: arm collateralValue read failed:", e.shortMessage ?? e.message);
    }
  }

  const quoteDecimals = await readTokenDecimals(USDG, 6);
  const spread = lend.ok && headroom.ok
    ? loopSpreadBps({ lendAprBps: lend.lendAprBps, borrowAprBps: headroom.aprBps })
    : 0;
  const desiredBorrow = borrowSize({
    collateralValue,
    targetLtvBps: ltv.targetLtvBps,
    maxLtvBps: ltv.maxLtvBps,
    hardCapBps: ltv.hardCapBps,
  });
  const shortfall = desiredBorrow > armDebt ? desiredBorrow - armDebt : 0n;
  const borrowWanted = shortfall > plan.borrow ? shortfall : plan.borrow;
  const borrowUsd = Number(borrowWanted) / 10 ** quoteDecimals;

  const gasCostUsd =
    ARM_LOOP_ENABLED && lend.ok && headroom.ok ? await readGasCostUsd() : null;
  // Unknown gas fails closed: without a payback estimate the loop may not enter.
  const enter =
    gasCostUsd == null
      ? { enter: false, reason: "gas unknown", paybackDays: null }
      : shouldEnterLoop({
          spreadBps: spread,
          minSpreadBps: ARM_MIN_SPREAD_BPS,
          borrowUsd,
          minBorrowUsd: ARM_MIN_BORROW_USD,
          gasCostUsd,
          maxPaybackDays: MAX_PAYBACK_DAYS,
        });
  const canLoop =
    ARM_LOOP_ENABLED && lend.ok && headroom.ok && gasCostUsd != null && enter.enter;

  if (!canLoop) {
    const why = !ARM_LOOP_ENABLED
      ? "loop disabled"
      : !lend.ok
        ? lend.reason
        : !headroom.ok
          ? headroom.reason
          : enter.reason;
    // Keep the quote leg (it earns the lend APR either way); adding collateral without a
    // borrow would only add market exposure for no carry.
    if (!ARM_COLLATERAL_ALWAYS) nvdaMove = 0n;
    const gasLog = gasCostUsd == null ? "gas unknown" : `gas $${gasCostUsd.toFixed(2)}`;
    const paybackLog = enter.paybackDays == null ? "unknown" : `${enter.paybackDays}d`;
    log(
      `loop skip: ${why} (spread ${spread}bps, borrow $${borrowUsd.toFixed(2)}, ` +
        `${gasLog}, payback ${paybackLog})` +
        `${ARM_COLLATERAL_ALWAYS ? " [collateral kept]" : ""}`,
    );
  }

  const borrowAllowed = canLoop && Boolean(USDG_ADAPTER);
  if (canLoop && !USDG_ADAPTER) {
    log("loop skip: no USDG adapter; borrowed USDG would sit idle in the vault");
  }

  const steps = [
    usdgMove > 0n ? "ALLOCATE_USDG" : null,
    nvdaMove > 0n ? "ALLOCATE_NVDA" : null,
    borrowAllowed && shortfall > 0n ? "BORROW_USDG" : null,
  ].filter(Boolean);

  log(
    `allocator plan: usdg=${usdgMove} nvda=${nvdaMove} borrow=${shortfall} ` +
      `loop=${canLoop ? "on" : "off"} spread=${spread}bps steps=${steps.join(">") || "none"}`,
  );

  if (!ALLOCATOR_EXECUTE) return;
  if (!AGENT) {
    log("allocator: no KEEPER_AGENT configured");
    return;
  }

  if (usdgMove > 0n && !USDG_ADAPTER) {
    log("allocator: USDG adapter not configured; idle USDG will not be lent");
  }

  if (usdgMove > 0n && USDG_ADAPTER) {
    // Already gated by ALLOCATOR_EXECUTE && AGENT above; dry-run must not read allowances.
    if (!DRY_RUN) await executor.approveIfNeeded({ token: USDG, amount: usdgMove });
    await send({
      address: AGENT,
      abi: agentAbi,
      functionName: "submitAllocate",
      args: [USDG_ADAPTER, usdgMove],
      label: `allocator: ${usdgMove} USDG -> lend arm`,
    });
    return;
  }

  if (nvdaMove > 0n && ARM) {
    if (!DRY_RUN) await executor.approveIfNeeded({ token: NVDA, amount: nvdaMove });
    await send({
      address: AGENT,
      abi: agentAbi,
      functionName: "submitAllocateCollateral",
      args: [ARM, nvdaMove],
      label: `allocator: ${nvdaMove} NVDA -> collateral arm`,
    });
    return;
  }

  if (borrowAllowed && shortfall > 0n) {
    const borrowAmount = capAmount(
      capAmount(capAmount(shortfall, bounds?.maxBorrow), moduleCaps?.borrow),
      headroom.available,
    );
    if (borrowAmount > 0n) {
      await send({
        address: AGENT,
        abi: agentAbi,
        functionName: "submitBorrow",
        args: [ARM, borrowAmount],
        label:
          `allocator: borrow ${borrowAmount} USDG at <=${ltv.targetLtvBps}bps LTV ` +
          `(market APR ${headroom.aprBps}bps, liquidity ${headroom.available})`,
      });
      // Close the loop in the same run: the borrowed quote must earn the lend APR.
      if (!DRY_RUN) await executor.approveIfNeeded({ token: USDG, amount: borrowAmount });
      const lendAmount = capAmount(borrowAmount, moduleCaps?.usdg);
      if (lendAmount > 0n) {
        await send({
          address: AGENT,
          abi: agentAbi,
          functionName: "submitAllocate",
          args: [USDG_ADAPTER, lendAmount],
          label: `loop: ${lendAmount} borrowed USDG -> lend arm (spread ${spread}bps)`,
        });
      } else {
        log(`loop: borrowed ${borrowAmount} USDG but the lend-arm cap is exhausted`);
      }
      return;
    }
    log(
      `allocator: borrow skipped (caps/liquidity) wanted=${shortfall} ` +
        `available=${headroom.available} maxBorrow=${bounds?.maxBorrow ?? "n/a"} ` +
        `moduleCap=${moduleCaps?.borrow ?? "n/a"}`,
    );
  }

  const bookHook = await activeBookHook();
  const [base, guard] = await Promise.all([
    publicClient.readContract({ address: bookHook, abi: hookAbi, functionName: "basePosition" }),
    publicClient.readContract({ address: bookHook, abi: hookAbi, functionName: "guardPosition" }),
  ]);
  // The hub aggregates idle inventory over both books.
  const [quoteIdle, equityIdle] = await Promise.all([
    publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "quoteIdle" }),
    publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "equityIdle" }),
  ]);
  if (base[2] === 0n && guard[2] === 0n && quoteIdle === 0n && equityIdle === 0n) {
    log("allocator: arms already deployed; nothing to recall");
    return;
  }

  await send({
    address: AGENT,
    abi: agentAbi,
    functionName: "submitRecall",
    label: "allocator: recall book -> vault",
  });
}

async function returnToBooks({ armCollateral, armDebt, usdgDeployed, urgent = false }) {
  // A switch must clear the arms fast: `unwindBps` (default a full 10000bps) per step
  // instead of the slow book-funding step. Dust floors still finish a 0bps step.
  const stepBps = urgent ? Math.max(1, SWITCH_UNWIND_BPS) : BOOK_STEP_BPS;
  const plan = planBookReturn({
    usdgDeployed,
    nvdaCollateral: armCollateral,
    debt: armDebt,
    stepBps,
    dustUsdg: UNWIND_DUST_USDG,
    dustNvda: UNWIND_DUST_NVDA,
  });
  log(
    `allocator plan: steps=${plan.steps.map((s) => s.action).join(">")} ` +
      `repay=${plan.repay} collateral=${plan.collateralOut}` +
      `${urgent ? ` [urgent ${stepBps}bps]` : ""}`,
  );
  if (!ALLOCATOR_EXECUTE || !AGENT) return;

  const step = plan.steps[0];
  if (!step) {
    // Arms are empty. Fund the active book if it is still empty.
    const bookHook = await activeBookHook();
    const [base, guard] = await Promise.all([
      publicClient.readContract({ address: bookHook, abi: hookAbi, functionName: "basePosition" }),
      publicClient.readContract({ address: bookHook, abi: hookAbi, functionName: "guardPosition" }),
    ]);
    // recallToVault keeps the base, so a base-only book is not "fully funded".
    // Only a live guard means the book already has both legs.
    if (guard[2] > 0n) {
      log("allocator: book already funded (base + guard)");
      return;
    }
    const baseOnly = base[2] > 0n && guard[2] === 0n;
    const [quoteIdle, equityIdle] = await Promise.all([
      publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "quoteIdle" }),
      publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "equityIdle" }),
    ]);
    if (baseOnly && (quoteIdle > 0n || equityIdle > 0n)) {
      log("allocator: guard inventory staged; waiting for recheckGuard");
      return;
    }
    if (!baseOnly && (quoteIdle > 0n || equityIdle > 0n)) {
      await send({
        address: AGENT,
        abi: agentAbi,
        functionName: "submitRecall",
        label: "allocator: recall hook idle before funding the book",
      });
      return;
    }
    // For a base-only book, hook idle is the inventory the guard recheck will
    // deploy. Do not recall it; fund the missing quote/equity from the vault.
    const [quoteBal, equityBal] = await Promise.all([
      publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] }),
      publicClient.readContract({ address: NVDA, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] }),
    ]);
    const bounds = await readControllerBounds();
    const quoteFund = capAmount((quoteBal * FUND_BOOK_BPS) / 10_000n, bounds?.maxFundQuote);
    const equityFund = capAmount((equityBal * FUND_BOOK_BPS) / 10_000n, bounds?.maxFundEquity);
    if (quoteFund === 0n && equityFund === 0n) {
      log("allocator: vault empty or fund cap is zero; nothing to fund");
      return;
    }
    await send({
      address: AGENT,
      abi: agentAbi,
      functionName: "submitFund",
      args: [quoteFund, equityFund],
      label: `allocator: fund book quote=${quoteFund} equity=${equityFund}`,
    });
    return;
  }

  if (step.action === "REPAY_NVDA") {
    const wanted = step.repay + REPAY_BUFFER_USDG;
    const available = await ensureVaultUsdg(wanted);
    if (available <= 0n) {
      log(`allocator: cannot fund ${wanted} USDG repayment`);
      return;
    }
    const repay = available < wanted ? available : wanted;
    // Already gated by ALLOCATOR_EXECUTE && AGENT above; dry-run must not read allowances.
    if (!DRY_RUN) await executor.approveIfNeeded({ token: USDG, amount: repay });
    await send({
      address: AGENT,
      abi: agentAbi,
      functionName: "submitDeleverage",
      args: [ARM, repay, 0n],
      label: `allocator: repay ${repay} NVDA-arm debt`,
    });
    return;
  }

  if (step.action === "WITHDRAW_NVDA") {
    await send({
      address: AGENT,
      abi: agentAbi,
      functionName: "submitDeleverage",
      args: [ARM, 0n, step.collateral],
      label: `allocator: withdraw ${step.collateral} NVDA collateral`,
    });
    return;
  }

  if (step.action === "DEALLOCATE_USDG") {
    if (!USDG_ADAPTER) {
      log("allocator: USDG adapter not configured; cannot deallocate");
      return;
    }
    await send({
      address: AGENT,
      abi: agentAbi,
      functionName: "submitDeallocate",
      args: [USDG_ADAPTER, step.amount],
      label: `allocator: ${step.amount} USDG out of lend arm`,
    });
  }
}

/**
 * Surplus sweep. Runs only while the active book is funded (never competing with book
 * funding) and moves at most one step per run: equity surplus -> arm collateral, then
 * borrow toward the target LTV, then quote surplus -> lend arm. No swaps.
 */
async function sweepToArms({ current, balances, navUsd, nvdaPriceWad }) {
  if (!config.sweep.enabled || !ALLOCATOR_EXECUTE || !AGENT || !ARM || !USDG_ADAPTER) return;
  // The book must own both legs; a recalled or base-only book is still being funded.
  if (current?.bookGuardPresent !== true) return;
  if (!(current.bookPositionLiquidity > 0n)) return;

  const ltv = await effectiveArmLtv();
  const [idleQuote, idleEquity, armCollateralValue, armDebt] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] }),
    publicClient.readContract({ address: NVDA, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] }),
    publicClient.readContract({ address: ARM, abi: armAbi, functionName: "collateralValue" }),
    publicClient.readContract({ address: ARM, abi: armAbi, functionName: "debt" }),
  ]);
  const [moduleCaps, headroom, lend, gasCostUsd, equityDecimals, quoteDecimals] = await Promise.all([
    readModuleCaps(armDebt),
    readBorrowHeadroom(),
    readLendAprBps(),
    readGasCostUsd(),
    readTokenDecimals(NVDA, 18),
    readTokenDecimals(USDG, 6),
  ]);

  if (gasCostUsd == null) {
    log("sweep skip: gas unknown");
    return;
  }

  const spread = lend.ok && headroom.ok
    ? loopSpreadBps({ lendAprBps: lend.lendAprBps, borrowAprBps: headroom.aprBps })
    : 0;

  const plan = surplusSweepPlan({
    idleQuote,
    idleEquity,
    quotePriceWad: nvdaPriceWad,
    navUsd,
    reserveUsd: config.allocator.inventoryReserveUsd,
    reservePctBps: config.allocator.inventoryReservePctBps,
    armCollateralValue,
    armDebt,
    maxLtvBps: Math.min(ltv.hardCapBps, ltv.maxLtvBps),
    targetLtvBps: ltv.targetLtvBps,
    armCollateralRoom: moduleCaps?.collateralValue ?? 0n,
    borrowRoom: moduleCaps?.borrow ?? 0n,
    borrowLiquidity: headroom.ok ? headroom.available : 0n,
    lendRoom: moduleCaps?.usdg ?? 0n,
    minSweepUsd: config.sweep.minUsd,
    gasCostUsd,
    maxPaybackDays: MAX_PAYBACK_DAYS,
    loopSpreadBps: spread,
    minSpreadBps: ARM_MIN_SPREAD_BPS,
    loopEnabled: ARM_LOOP_ENABLED,
    lendAprBps: lend.ok ? lend.lendAprBps : 0,
    equityDecimals,
    quoteDecimals,
  });

  log(
    `sweep: ${plan.action} amount=${plan.amount} ($${plan.amountUsd.toFixed(2)}) ` +
      `${plan.reason} payback=${plan.paybackDays}d ` +
      `(arm debt=${balances.debt}, lend=${balances.usdg}, spread=${spread}bps)`,
  );
  if (plan.action === "NONE" || plan.amount <= 0n) return;

  if (plan.action === "ALLOCATE_EQUITY") {
    if (!DRY_RUN) await executor.approveIfNeeded({ token: NVDA, amount: plan.amount });
    await send({
      address: AGENT,
      abi: agentAbi,
      functionName: "submitAllocateCollateral",
      args: [ARM, plan.amount],
      label: `sweep: ${plan.amount} NVDA -> collateral arm`,
    });
    return;
  }

  if (plan.action === "BORROW") {
    await send({
      address: AGENT,
      abi: agentAbi,
      functionName: "submitBorrow",
      args: [ARM, plan.amount],
      label: `sweep: borrow ${plan.amount} USDG toward target LTV (spread ${spread}bps)`,
    });
    return;
  }

  if (plan.action === "ALLOCATE_QUOTE") {
    if (!DRY_RUN) await executor.approveIfNeeded({ token: USDG, amount: plan.amount });
    await send({
      address: AGENT,
      abi: agentAbi,
      functionName: "submitAllocate",
      args: [USDG_ADAPTER, plan.amount],
      label: `sweep: ${plan.amount} USDG -> lend arm`,
    });
  }
}

async function switchBook(book, name) {
  if (!ALLOCATOR_EXECUTE) {
    log(`allocator: would switch book -> ${name}`);
    return;
  }
  if (!AGENT) {
    log("allocator: no KEEPER_AGENT configured");
    return;
  }
  await send({
    address: AGENT,
    abi: agentAbi,
    functionName: "submitSwitchBook",
    args: [book],
    label: `allocator: switch book -> ${name}`,
  });
}

async function activeBookHook() {
  try {
    const [a, b, active] = await Promise.all([
      publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "bookA" }),
      publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "bookB" }),
      publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "activeBook" }),
    ]);
    return Number(active) === 0 ? a : b;
  } catch {
    return HOOK;
  }
}

async function guardPullCount(blockNumber, fromBlock) {
  try {
    const address = await activeBookHook();
    const logs = await publicClient.getLogs({
      address,
      event: guardPulledEvent,
      fromBlock,
      toBlock: blockNumber,
    });
    return logs.length;
  } catch {
    return 0;
  }
}

/** Four-decimal display for the reference-view log lines; "-" when a value is unknown. */
function fmt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(4) : "-";
}

async function tickAllocator(now) {
  if (!ALLOCATOR_ENABLED) return;
  if (now - lastAllocatorAt < ALLOCATOR_INTERVAL) return;
  lastAllocatorAt = now;

  if (!POOL_MANAGER || !HOOK || !VAULT || !USDG || !NVDA) {
    log("allocator: missing POOL_MANAGER/HOOK/VAULT/USDG/NVDA");
    return;
  }

  const candidates = candidatePools();
  if (candidates.length === 0) {
    log("allocator: no candidate pools");
    return;
  }

  const bookHook = await activeBookHook();
  const [activePoolId, blockNumber, depegPaused, nvdaPriceWad, nav] = await Promise.all([
    publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "activePoolId" }),
    publicClient.getBlockNumber(),
    publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "depegPaused" }),
    publicClient.readContract({ address: bookHook, abi: hookAbi, functionName: "poolPrice1e18" }),
    publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "totalManagedAssets" }),
  ]);
  // The quote token's decimals come from the token itself (cached, one read per process);
  // 6 is only the failed-read fallback. Resolved before the NAV conversion so a quote that
  // is not 6-decimal scales correctly, and reused for the scan view further down.
  const quoteDecimals = await readTokenDecimals(USDG, 6);
  // NAV is quote-denominated: the vault reports `totalManagedAssets` in quote units.
  // Everything downstream (gas payback, inventory reserve) treats it as USD, which holds
  // only because the quote token in this deployment is USDG.
  const navUsd = Number(nav) / 10 ** quoteDecimals;

  let pulledAt = 0n;
  try {
    pulledAt = await publicClient.readContract({
      address: bookHook,
      abi: hookAbi,
      functionName: "pulledAt",
    });
  } catch {
    // Some hooks do not expose pulledAt; guardPresent and GuardPulled logs still apply.
  }
  const guardRecentlyPulled =
    pulledAt > 0n && now - Number(pulledAt) < GUARD_COOLDOWN_SECONDS;

  const riskFromBlock = blockNumber > STATS_LOOKBACK_BLOCKS ? blockNumber - STATS_LOOKBACK_BLOCKS : 0n;
  const feeFromBlock = feeFromBlockFor(blockNumber);

  // Guard pulls are counted since the previous allocator run, so the count resets
  // each allocator run. On the first run (or after a restart) use the stats lookback.
  const guardFromBlock = lastAllocatorBlock ?? riskFromBlock;
  const guardPulls = await guardPullCount(blockNumber, guardFromBlock);
  lastAllocatorBlock = blockNumber;

  const balances = await armBalances();
  const currentMode = balances.collateral > 0n || balances.usdg > 0n ? "ARMS" : "BOOKS";

  const activeCandidate = candidates.find(
    (c) =>
      c.kind === "v4" &&
      c.poolId &&
      String(c.poolId).toLowerCase() === String(activePoolId).toLowerCase(),
  );

  // Guard uptime is per book, so resolve both book hooks once per run.
  const bookHooks = await readBookHooks();
  const view = { blockNumber, riskFromBlock, feeFromBlock, activePoolId, bookHooks, quoteDecimals };

  const scanned = [];
  let capitalUsd;

  // Scan the active book first so the other book is compared at the same capital,
  // not at 100% of the other pool's active liquidity.
  if (activeCandidate) {
    try {
      const s = await scanCandidate(activeCandidate, { ...view, capitalUsd: navUsd });
      scanned.push(s);
      capitalUsd = s.bookValueUsd;
    } catch (e) {
      log(
        `allocator scan ${activeCandidate.name ?? activeCandidate.poolId} failed:`,
        e.shortMessage ?? e.message,
      );
    }
  }

  for (const c of candidates) {
    if (c === activeCandidate) continue;
    try {
      scanned.push(await scanCandidate(c, { ...view, capitalUsd }));
    } catch (e) {
      log(`allocator scan ${c.name ?? c.poolId ?? c.address} failed:`, e.shortMessage ?? e.message);
    }
  }
  if (scanned.length === 0) {
    log("allocator: no scan results");
    return;
  }

  for (const c of scanned) {
    log(
      `allocator scan: ${c.name} fee24h=${c.feeAprBps}bps il=${c.ilBps}bps ` +
        `worst=${c.ilWorstBps}bps ilApr=${c.ilAprBps}bps net=${c.netAprBps}bps ` +
        `share=${Number(c.effectiveShare ?? 0).toFixed(4)} guardUp=${Number(c.guardUptime ?? 1).toFixed(3)} ` +
        `vol24h=$${Math.round(c.volumeUsd)} riskVol=${c.riskVolatilityBps}bps ` +
        `liq=$${Math.round(c.activeLiquidityUsd)} risk=${c.risk}${c.fresh ? "" : " [stale]"}` +
        `${c.riskReasons?.length ? ` (${c.riskReasons.join(",")})` : ""}`,
    );
  }

  const current = scanned.find(
    (c) =>
      c.kind === "v4" &&
      c.poolId &&
      String(c.poolId).toLowerCase() === String(activePoolId).toLowerCase(),
  );
  if (!current) {
    log(`allocator: active pool ${activePoolId} is not in candidates`);
    return;
  }

  const control = await readControllerState();

  if (depegPaused || control?.paused || control?.switchFrozen) {
    // Risk-up calls are blocked by the vault/controller. Recall only; leave arm positions
    // alone (deallocate/deleverage remain available to the sentinel/keeper separately).
    const why = depegPaused
      ? "depeg"
      : control?.switchFrozen
        ? "switch-frozen"
        : "controller-paused";
    log(`allocator: ${why} -> recall only (risk-up blocked)`);
    // Safety, not allocation: the recall is gated by `AGENT` + `DRY_RUN` only, never
    // `KEEPER_ALLOCATOR_EXECUTE`. This branch covers controller paused/switchFrozen and acts
    // as the slow backstop for the 5m depeg recall in `tick()`; both are idempotent on-chain.
    if (AGENT) {
      await send({
        address: AGENT,
        abi: agentAbi,
        functionName: "submitRecall",
        label: `allocator: recall book on ${why}`,
      });
    }
    return;
  }

  // External market view and advisory course correction, read-only. This runs only when the
  // allocator is active (not depeg-paused / controller-stopped) and never feeds a decision or a
  // send below: `decidePoolSwitch`, the guard gate, the risk score and every call are unchanged.
  // A reference failure is logged and swallowed so the book/arm block still runs.
  if (config.reference.mode === "advisory" || config.reference.mode === "apply") {
    try {
      // `config.reference.pools` keeps disabled registry placeholders, so the skip is on
      // "nothing enabled" rather than only on an empty array (the shipped registry is all
      // disabled). `scanReferencePools` applies the same filter again.
      const enabledPools = config.reference.pools.filter((pool) => pool.enabled !== false);
      if (enabledPools.length === 0) {
        if (!referenceEmptyLogged) {
          referenceEmptyLogged = true;
          log("reference market view: no enabled pools; set KEEPER_REFERENCE_POOLS");
        }
      } else {
        const oracle = { nvdaUsd: Number(nvdaPriceWad) / 1e18, ethUsd: await readEthUsd() };
        const { observations, errors } = await scanReferencePools({
          publicClient,
          pools: config.reference.pools,
          blockNumber,
          config,
          log,
        });
        for (const e of errors) log(`reference scan: ${e}`);
        const marketView = buildMarketView({
          observations,
          oracle,
          config: { reference: config.reference, course: config.course },
        });
        lastMarketView = marketView;
        log(
          `reference market: regime=${marketView.regime} healthy=${marketView.healthy.length} ` +
            `excluded=${marketView.excluded.length} nvdaUsd=${fmt(marketView.price.nvdaUsd)} ` +
            `nvdaEth=${fmt(marketView.price.nvdaEth)} ` +
            `impliedEth=${fmt(marketView.price.impliedEthUsd)} ` +
            `dispersion=${marketView.price.dispersionBps ?? "-"}bps`,
        );
        for (const p of marketView.pools) {
          log(
            `reference pool: ${p.name} status=${p.status} net24h=${p.netApr24h ?? "-"}bps ` +
              `net6h=${p.netApr6h ?? "-"}bps vol6h=${p.volatilityBps ?? "-"}bps ` +
              `share=${p.ourShareBps ?? "-"}bps`,
          );
        }
        // The current book's own bands, in the units `recommendCourse` expects: the guard's half
        // width in bps of price and the guard's share of the book's liquidity in bps.
        const guardWidthBps = current.bookRange
          ? Math.max(
              0,
              Math.round(
                (Math.pow(
                  1.0001,
                  (current.bookRange.tickUpper - current.bookRange.tickLower) / 2,
                ) -
                  1) *
                  10_000,
              ),
            )
          : 0;
        const shareSum = Number(current.baseShare ?? 0) + Number(current.guardShare ?? 0);
        const guardShareBps =
          shareSum > 0 ? Math.round((Number(current.guardShare ?? 0) / shareSum) * 10_000) : 0;
        const referenceBook = {
          ...current,
          maxVolatilityBps: RISK_THRESHOLDS.maxVolatilityBps,
          minVolumeUsd: RISK_THRESHOLDS.minVolumeUsd,
          guardWidthBps,
          guardShareBps,
          nvdaStepBps: NVDA_STEP_BPS,
        };
        const course = recommendCourse({
          marketView,
          book: referenceBook,
          config: config.course,
        });
        lastCourse = course;
        log(
          `course recommendation: riskVol=${course.risk.maxVolatilityBps}bps ` +
            `volumeFloor=$${Math.round(course.risk.minVolumeUsd)} ` +
            `guardWidth=${course.guard.widthBps}bps guardShare=${course.guard.shareBps}bps ` +
            `bookBias=${course.bookBias.preferredFeePips ?? "none"} ` +
            `armStep=${course.arm.nvdaStepBps} reArm=${course.reArm.allowed} ` +
            `apply=${course.apply} warnings=${course.warnings.join(",") || "none"}`,
        );
        if (config.reference.mode === "apply") {
          log("course: apply is not implemented on-chain yet; recommendation logged only");
        }
      }
    } catch (e) {
      // Market data is optional: a reference failure must not block the allocator.
      log("reference market view failed:", e.shortMessage ?? e.message);
    }
  }

  const bookHasPosition = (current.bookPositionLiquidity ?? 0n) > 0n;
  // Guard absence alone is not a safe-harbor trigger: recalled books are
  // intentionally guard-less (recallToVault keeps the base). Only guard history
  // on a funded book is a gate; the guard keeper re-arms via recheckGuard.
  const guardGate = guardSafeHarbor({
    currentMode,
    bookHasPosition,
    guardRecentlyPulled,
    guardPulls,
    maxGuardPulls: MAX_GUARD_PULLS,
  });

  if (guardGate.blocked || current.risk === "HIGH") {
    const why = guardGate.blocked
      ? guardGate.reason
      : current.riskReasons.join(",") || "book risk";
    log(`allocator: safe-harbor trigger (${why}) -> arms`);
    await deployToArms({
      armCollateral: balances.collateral,
      armDebt: balances.debt,
      usdgDeployed: balances.usdg,
      nvdaPriceWad,
    });
    return;
  }

  // 3. Carry/switch on the 24h fee/IL read. This runs before the guard wait so a
  //    recent pull cannot pin capital in a book that has no economic edge.
  let decision = decidePoolSwitch({
    candidates: scanned,
    currentPool: current.name,
    switchBufferBps: SWITCH_BUFFER_BPS,
    carryArmEnabled: CARRY_ARM_ENABLED,
  });

  let best = decision.ranked?.find((c) => c.name === decision.pool) ?? decision.ranked?.[0] ?? null;

  // A failed log fetch (or a failed guard-uptime read) leaves a stale cache. It may inform
  // the display, never a move.
  const stalePools = scanned
    .filter((c) => c.fresh !== true || c.guardUptimeFresh === false)
    .map((c) => c.name);
  if (decision.action !== "HOLD" && stalePools.length > 0) {
    log(`allocator: stale 24h swap cache (${stalePools.join(",")}) -> holding ${current.name}`);
    decision = {
      action: "HOLD",
      pool: current.name,
      reason: "stale-fee-data",
      ranked: decision.ranked,
    };
    best = null;
    pendingSwitch = null;
  }

  // A target must persist for `SWITCH_CONFIRM_SECONDS` before capital moves. A carry-only
  // ARMS target has no positive edge by construction, so it is confirmed on persistence
  // alone: `allowNonPositive` keeps the timer alive instead of seeding a fake net APR.
  const confirmTarget = decision.pool ?? (decision.action === "ARMS" ? "ARMS" : null);
  const decisionNet = decision.netAprBps ?? best?.netAprBps ?? 0;
  const confirm = decideSwitchConfirmation({
    pending: pendingSwitch,
    target: confirmTarget,
    netAprBps: decisionNet,
    now,
    confirmSeconds: SWITCH_CONFIRM_SECONDS,
    allowNonPositive: confirmTarget === "ARMS",
  });
  pendingSwitch = confirm.pending;

  log(
    `allocator: current=${current.name} net=${current.netAprBps}bps ` +
      `-> ${decision.action}${decision.pool ? ` ${decision.pool}` : ""} ` +
      `(${decision.reason}; confirmed=${confirm.confirmed}, execute=${ALLOCATOR_EXECUTE}, mode=${currentMode})`,
  );

  // 4. HOLD: stay put, fund/re-arm the book, and only then sweep surplus.
  if (decision.action === "HOLD") {
    if (guardGate.wait) {
      log("allocator: recent guard pull; waiting/re-arming the book (not arming)");
      if (
        currentMode === "BOOKS" &&
        (!current.bookGuardPresent || (current.bookPositionLiquidity ?? 0n) === 0n)
      ) {
        await returnToBooks({
          armCollateral: balances.collateral,
          armDebt: balances.debt,
          usdgDeployed: balances.usdg,
        });
      }
      return;
    }
    if (currentMode === "ARMS") {
      await returnToBooks({
        armCollateral: balances.collateral,
        armDebt: balances.debt,
        usdgDeployed: balances.usdg,
      });
      return;
    }
    if ((current.bookPositionLiquidity ?? 0n) === 0n || !current.bookGuardPresent) {
      // Empty, or base-only after recallToVault kept the base: fund the missing
      // quote/equity so the hook can re-arm the guard. Do not skip this just
      // because the base position exists.
      await returnToBooks({
        armCollateral: balances.collateral,
        armDebt: balances.debt,
        usdgDeployed: balances.usdg,
      });
      return;
    }
    // Book is funded and staying: only now may surplus inventory leave the vault.
    await sweepToArms({ current, balances, navUsd, nvdaPriceWad });
    return;
  }

  // 5. ARMS: carry-driven only (risk HIGH returned above), so it needs confirmation.
  if (decision.action === "ARMS") {
    if (!confirm.confirmed) {
      log(
        `allocator: carry arm pending confirmation (${SWITCH_CONFIRM_SECONDS}s, ` +
          `since ${confirm.pending?.since ?? now})`,
      );
      return;
    }
    await deployToArms({
      armCollateral: balances.collateral,
      armDebt: balances.debt,
      usdgDeployed: balances.usdg,
      nvdaPriceWad,
    });
    return;
  }

  // 6. SWITCH: confirmed target, gas paid back, dwell clear, target book ready.
  if (decision.action === "SWITCH") {
    if (!confirm.confirmed) {
      log(
        `allocator: switch -> ${decision.pool} pending confirmation ` +
          `(${SWITCH_CONFIRM_SECONDS}s); holding ${current.name}`,
      );
      return;
    }
    if (!best?.switchable || !Number.isInteger(best.book)) {
      log(`allocator: best is ${best?.name} (external, no venue adapter); staying`);
      return;
    }

    const edgeBps = Number(best.netAprBps ?? 0) - Number(current.netAprBps ?? 0);
    const switchGasCostUsd = await readSwitchGasCostUsd();
    if (switchGasCostUsd == null) {
      log("allocator: switch gas unknown; holding");
      return;
    }
    const paybackDays = gasPaybackDays({
      amountUsd: current.bookValueUsd,
      aprBps: edgeBps,
      gasCostUsd: switchGasCostUsd,
    });
    // `!(x <= max)` also catches NaN and Infinity (no positive edge -> never pays back).
    if (!(paybackDays <= MAX_PAYBACK_DAYS)) {
      log(
        `allocator: switch gas payback ` +
          `${Number.isFinite(paybackDays) ? `${paybackDays.toFixed(1)}d` : "never"} > ` +
          `${MAX_PAYBACK_DAYS}d (edge ${edgeBps}bps, gas $${switchGasCostUsd.toFixed(2)}); holding`,
      );
      return;
    }
    log(
      `allocator: switch payback ${paybackDays.toFixed(1)}d <= ${MAX_PAYBACK_DAYS}d ` +
        `(edge ${edgeBps}bps, gas $${switchGasCostUsd.toFixed(2)})`,
    );

    const dwell = await readSwitchDwellGate(now);
    if (!dwell.ok) {
      log(`allocator: switch blocked: ${dwell.reason}`);
      return;
    }

    const ready = await readBookReadiness(best.book);
    if (!ready.ok) {
      log(`allocator: target book ${best.name} not ready (${ready.reason}); holding`);
      return;
    }
    if (REQUIRE_BOTH_BOOKS) {
      const otherBook = best.book === 0 ? 1 : 0;
      const other = await readBookReadiness(otherBook);
      if (!other.ok) {
        log(
          `allocator: book ${otherBook} not ready (${other.reason}); ` +
            `requireBothBooks holds ${current.name}`,
        );
        return;
      }
    }

    if (currentMode === "ARMS") {
      // Capital is still in the arms: unwind at the fast step, switch on a later run.
      await returnToBooks({
        armCollateral: balances.collateral,
        armDebt: balances.debt,
        usdgDeployed: balances.usdg,
        urgent: true,
      });
      return;
    }
    await switchBook(best.book, best.name);
  }
}

/**
 * Fast safety recall, run from the 5m tick. The vault's depeg latch blocks risk-up on-chain,
 * but the base/guard inventory already in the pool stays exposed, so the book must not wait
 * for the 2h allocator run. `PoolGuardHook.recallToVault` pulls the guard and the hook's idle
 * inventory; the base position stays in the pool by design.
 *
 * Gated by `KEEPER_AGENT` (and `KEEPER_DRY_RUN`) only: a safety recall never waits for
 * `KEEPER_ALLOCATOR_EXECUTE`. The inventory pre-check keeps an empty book from sending a
 * no-op recall, and the signature below keeps unchanged inventory from re-sending every tick.
 */
async function recallBookOnDepeg() {
  const bookHook = await activeBookHook();
  const [base, guard] = await Promise.all([
    publicClient.readContract({ address: bookHook, abi: hookAbi, functionName: "basePosition" }),
    publicClient.readContract({ address: bookHook, abi: hookAbi, functionName: "guardPosition" }),
  ]);
  // The hub aggregates idle inventory over both books.
  const [quoteIdle, equityIdle] = await Promise.all([
    publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "quoteIdle" }),
    publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "equityIdle" }),
  ]);
  if (base[2] === 0n && guard[2] === 0n && quoteIdle === 0n && equityIdle === 0n) {
    log("depeg recall: book is empty; nothing to recall");
    return;
  }

  // `recallToVault` leaves the base deployed, so the pre-check alone would fire again on the
  // next tick. Act once per distinct inventory state inside one depeg episode.
  const signature = `${base[2]}:${guard[2]}:${quoteIdle}:${equityIdle}`;
  if (signature === lastDepegRecall) return;

  if (!AGENT) {
    log("depeg recall: depeg but no KEEPER_AGENT configured; book not recalled");
    await notify("keeper: depeg but no KEEPER_AGENT configured; book not recalled");
    return;
  }

  if (DRY_RUN) {
    log(
      `depeg recall: would submitRecall (base=${base[2]} guard=${guard[2]} ` +
        `quoteIdle=${quoteIdle} equityIdle=${equityIdle})`,
    );
    lastDepegRecall = signature;
    return;
  }

  await send({
    address: AGENT,
    abi: agentAbi,
    functionName: "submitRecall",
    label: "depeg recall",
  });
  lastDepegRecall = signature;
}

async function tick() {
  const now = Math.floor(Date.now() / 1000);

  // 1. Depeg heartbeat.
  try {
    const [due] = await publicClient.readContract({
      address: HEARTBEAT,
      abi: heartbeatAbi,
      functionName: "checkUpkeep",
      args: ["0x"],
    });
    const last = await publicClient.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: "lastDepegCheck",
    });
    const decision = decideDepeg({ now, lastCheck: last, interval: HEARTBEAT_INTERVAL });
    if (due && decision.action === "CHECK") {
      await send({
        address: HEARTBEAT,
        abi: heartbeatAbi,
        functionName: "performUpkeep",
        args: ["0x"],
        label: "depeg heartbeat",
      });
    } else {
      log("depeg:", due ? decision.reason : "not due");
    }
  } catch (e) {
    log("depeg error:", e.shortMessage ?? e.message);
    await notify(`keeper: depeg check failed: ${e.shortMessage ?? e.message}`);
  }

  // 1b. Fast depeg recall. The heartbeat only latches the vault; inventory already in the
  //     pool stays exposed, so recall on this 5m loop instead of the allocator's 2h cadence.
  //     Its own try/catch keeps a recall failure from stopping the rest of the tick.
  try {
    const depegPaused = await publicClient.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: "depegPaused",
    });
    if (depegPaused) {
      await recallBookOnDepeg();
    } else {
      // A new depeg episode must recall again even with unchanged inventory.
      lastDepegRecall = null;
    }
  } catch (e) {
    log("depeg recall error:", e.shortMessage ?? e.message);
    await notify(`keeper: depeg recall failed: ${e.shortMessage ?? e.message}`);
  }

  // 2. Guard re-arm (permissionless). The hub forwards guardPresent/deployEnabled,
  //    but pulledAt/recheckGuard live on the active PoolGuardHook.
  try {
    const bookHook = await activeBookHook();
    const [present, pulledAt, deployEnabled] = await Promise.all([
      publicClient.readContract({ address: bookHook, abi: hookAbi, functionName: "guardPresent" }),
      publicClient.readContract({ address: bookHook, abi: hookAbi, functionName: "pulledAt" }),
      publicClient.readContract({ address: bookHook, abi: hookAbi, functionName: "deployEnabled" }),
    ]);
    const decision = decideGuard({
      now,
      pulledAt,
      recheckInterval: RECHECK_INTERVAL,
      guardPresent: present,
      deployEnabled,
    });
    if (decision.action === "RECHECK") {
      await send({
        address: bookHook,
        abi: hookAbi,
        functionName: "recheckGuard",
        label: "guard recheck",
      });
    }
  } catch (e) {
    log("guard error:", e.shortMessage ?? e.message);
  }

  // 3. Sleeve risk (de-risk / pause only).
  if (SLEEVE) {
    try {
      const s = await publicClient.readContract({
        address: SLEEVE,
        abi: sleeveAbi,
        functionName: "riskState",
      });
      const state = {
        stockLtvBps: s[0],
        yieldLtvBps: s[1],
        healthBufferBps: s[2],
        netCarryBps: s[3],
        venuePaused: s[4],
        // The sleeve does not assert carry on-chain; compute it off-chain before enabling
        // this gate.
        carryKnown: false,
      };
      const decision = decideSleeve(state, POLICY);
      if (decision.action === "PAUSE") {
        await send({ address: SLEEVE, abi: sleeveAbi, functionName: "pause", label: "sleeve pause" });
      } else if (decision.action === "DERISK") {
        await send({ address: SLEEVE, abi: sleeveAbi, functionName: "deRisk", label: "sleeve de-risk" });
      } else {
        log("sleeve:", decision.reason);
      }
    } catch (e) {
      log("sleeve error:", e.shortMessage ?? e.message);
      await notify(`keeper: sleeve check failed: ${e.shortMessage ?? e.message}`);
    }
  }

  // 4. Morpho loop arm (Spiral NVDA strategy): de-leverage only, plus the carry exit.
  //
  // Two independent risk-down reasons, checked on every tick (INTERVAL, 300s by default):
  //   a. the operator LTV sentinel (hard cap from config, target clamped by the adapter), and
  //   b. the health-factor / borrow-APR floor (`decideArm`).
  // Only one of them acts per tick; the LTV repay already de-risks the position. When
  // neither fires, a spread below the exit floor unwinds the carry.
  if (ARM) {
    try {
      const ltv = await effectiveArmLtv();
      const [hf, debt, apr, collateralValue, collateral] = await Promise.all([
        publicClient.readContract({ address: ARM, abi: armAbi, functionName: "healthFactor" }),
        publicClient.readContract({ address: ARM, abi: armAbi, functionName: "debt" }),
        publicClient.readContract({ address: ARM, abi: armAbi, functionName: "borrowAprBps" }),
        publicClient.readContract({ address: ARM, abi: armAbi, functionName: "collateralValue" }),
        publicClient.readContract({ address: ARM, abi: armAbi, functionName: "collateralBalance" }),
      ]);

      const zeroCollateral = debt > 0n && collateralValue === 0n;
      if (zeroCollateral) {
        // No collateral value to size a partial repay against; never divide by zero here.
        // The HF/APR path below still runs (it only needs debt).
        log(`arm: debt ${debt} with zero collateral value; skipping the LTV sentinel`);
        await notify("keeper: arm has debt but zero collateral value; LTV sentinel skipped");
      }

      // The sentinel clamps to the adapter ceiling, not just the operator hard cap.
      const sentinelMaxLtvBps = Math.min(ltv.hardCapBps, ltv.maxLtvBps);
      const ltvRepay = zeroCollateral
        ? 0n
        : ltvRepayAmount({
            debt,
            collateralValue,
            maxLtvBps: sentinelMaxLtvBps,
            targetLtvBps: ltv.targetLtvBps,
          });

      // A risk-down path that fired owns the tick; the carry exit waits so the two
      // never size repayments against the same debt.
      let acted = false;

      if (ltvRepay > 0n) {
        acted = true;
        const ltvBps = Number((debt * 10_000n) / collateralValue);
        const reason =
          `ltv ${ltvBps}bps > ${sentinelMaxLtvBps}bps ` +
          `(target ${ltv.targetLtvBps}bps)`;
        // Safety, not allocation: the LTV cap must be enforced whenever the keeper is
        // live, so this branch is gated by DRY_RUN and AGENT only. Waiting for
        // KEEPER_ALLOCATOR_EXECUTE here would leave a live keeper over its hard cap.
        if (!AGENT) {
          log(`arm LTV sentinel: needs to repay ${ltvRepay} USDG (${reason}); no KEEPER_AGENT configured`);
          await notify(`keeper: arm ${reason} but no agent configured to repay ${ltvRepay} USDG`);
        } else if (DRY_RUN) {
          // No funding read: a dry-run deallocate cannot change the vault balance anyway.
          log(`arm LTV sentinel: would repay ${ltvRepay} USDG (${reason})`);
        } else {
          const wanted = ltvRepay + REPAY_BUFFER_USDG;
          const available = await ensureVaultUsdg(wanted);
          if (available <= 0n) {
            log(`arm LTV sentinel: cannot fund ${wanted} USDG repayment (${reason})`);
            await notify(`keeper: arm ${reason} but cannot fund ${wanted} USDG`);
          } else {
            const repay = available < ltvRepay ? available : ltvRepay;
            await executor.approveIfNeeded({ token: USDG, amount: repay });
            await send({
              address: AGENT,
              abi: agentAbi,
              functionName: "submitDeleverage",
              args: [ARM, repay, 0n],
              label: `arm LTV repay ${repay} USDG (${reason}${repay < ltvRepay ? ", partial" : ""})`,
            });
          }
        }
      } else {
        const decision = decideArm({
          healthFactorWad: hf,
          debt,
          minHealthFactorWad: MIN_HEALTH_FACTOR,
          borrowAprBps: apr,
          maxBorrowAprBps: MAX_BORROW_APR_BPS,
        });
        if (decision.action === "DELEVERAGE") {
          acted = true;
          if (!AGENT) {
            log("arm unhealthy, no KEEPER_AGENT configured:", decision.reason);
            await notify(`keeper: arm needs deleverage (${decision.reason}) but no agent configured`);
          } else {
            const scaled = (BigInt(debt) * DELEVERAGE_BPS) / 10_000n;
            const wanted = scaled === 0n ? BigInt(debt) : scaled;
            const available = await ensureVaultUsdg(wanted);
            if (available <= 0n) {
              log(`arm deleverage: cannot fund ${wanted} USDG repayment`);
              await notify(`keeper: arm needs deleverage but cannot fund ${wanted} USDG`);
            } else {
              const repay = available < wanted ? available : wanted;
              // Safety de-leverage must not depend on the allocator execute flag: the
              // agent gate above already decided that a write may happen.
              if (!DRY_RUN) {
                await executor.approveIfNeeded({ token: USDG, amount: repay });
              }
              await send({
                address: AGENT,
                abi: agentAbi,
                functionName: "submitDeleverage",
                args: [ARM, repay, 0n],
                label: `arm deleverage (${decision.reason})`,
              });
            }
          }
        } else {
          log("arm:", decision.reason);
        }
      }

      // Carry exit: nothing at risk fired, so the spread alone may retire the loop.
      const exitCandidate = debt > 0n || (collateral > 0n && !ARM_COLLATERAL_ALWAYS);
      if (!acted && exitCandidate) {
        await maybeExitLoop({ debt, collateral });
      }
    } catch (e) {
      log("arm error:", e.shortMessage ?? e.message);
      await notify(`keeper: arm check failed: ${e.shortMessage ?? e.message}`);
    }
  }

  // 5. Risk allocator: fee + volume + price fluctuation -> arms or books.
  try {
    await tickAllocator(now);
  } catch (e) {
    log("allocator error:", e.shortMessage ?? e.message);
    await notify(`keeper: allocator failed: ${e.shortMessage ?? e.message}`);
  }
}

async function main() {
  log(
    `keeper start chain=${CHAIN_ID} dryRun=${DRY_RUN} interval=${INTERVAL}s heartbeat=${HEARTBEAT_INTERVAL}s sleeve=${SLEEVE || "none"} arm=${ARM || "none"}`,
  );
  let running = true;
  process.on("SIGINT", () => {
    running = false;
    log("keeper stopping");
  });
  process.on("SIGTERM", () => {
    running = false;
    log("keeper stopping");
  });

  while (running) {
    try {
      await tick();
    } catch (e) {
      log("tick error:", e.shortMessage ?? e.message);
      await notify(`keeper: tick failed: ${e.shortMessage ?? e.message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
