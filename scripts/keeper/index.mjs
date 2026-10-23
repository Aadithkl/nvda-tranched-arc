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
} from "./allocator.mjs";
import {
  fetchBookStats,
  marketStats,
  activeLiquidityValue,
  positionValueUsd,
  liquidityForValue,
  rangeFromHalfWidth,
} from "./stats.mjs";

const env = process.env;
const requireEnv = (k) => {
  const v = env[k];
  if (!v || v.trim() === "") throw new Error(`missing ${k}`);
  return v.trim();
};

const RPC_URL = requireEnv("KEEPER_RPC_URL");
const DRY_RUN = (env.KEEPER_DRY_RUN ?? "true").toLowerCase() !== "false";
const INTERVAL = Number(env.KEEPER_INTERVAL_SECONDS ?? 300);
const HEARTBEAT_INTERVAL = Number(env.KEEPER_HEARTBEAT_SECONDS ?? 1800);
const RECHECK_INTERVAL = Number(env.KEEPER_RECHECK_SECONDS ?? 300);
const CHAIN_ID = Number(env.KEEPER_CHAIN_ID ?? 4663);

const VAULT = requireEnv("KEEPER_VAULT");
const HEARTBEAT = requireEnv("KEEPER_HEARTBEAT");
const HOOK = requireEnv("KEEPER_HOOK");
const SLEEVE = env.KEEPER_SLEEVE?.trim() || "";
const ARM = env.KEEPER_ARM_ADAPTER?.trim() || "";
const AGENT = env.KEEPER_AGENT?.trim() || "";
const MIN_HEALTH_FACTOR = BigInt(env.KEEPER_MIN_HEALTH_FACTOR ?? "1500000000000000000");
const MAX_BORROW_APR_BPS = Number(env.KEEPER_MAX_BORROW_APR_BPS ?? 3000);
const DELEVERAGE_BPS = BigInt(env.KEEPER_DELEVERAGE_BPS ?? 1000);

// Risk allocator: fee, volume and price fluctuation over the lookback.
const ALLOCATOR_ENABLED = (env.KEEPER_ALLOCATOR_ENABLED ?? "false").toLowerCase() === "true";
const ALLOCATOR_INTERVAL = Number(env.KEEPER_ALLOCATOR_INTERVAL_SECONDS ?? 3600);
const ALLOCATOR_EXECUTE = (env.KEEPER_ALLOCATOR_EXECUTE ?? "false").toLowerCase() === "true";
const POOL_MANAGER = env.KEEPER_POOL_MANAGER?.trim() || "";
const BOOK_A_POOL = env.KEEPER_BOOK_A_POOL_ID?.trim() || "";
const BOOK_B_POOL = env.KEEPER_BOOK_B_POOL_ID?.trim() || "";
const BOOK_A_FEE_PIPS = Number(env.KEEPER_BOOK_A_FEE_PIPS ?? 500);
const BOOK_B_FEE_PIPS = Number(env.KEEPER_BOOK_B_FEE_PIPS ?? 3000);
const USDG_ADAPTER = env.KEEPER_USDG_ADAPTER?.trim() || "";
const USDG = env.KEEPER_USDG?.trim() || env.QUOTE_ADDRESS?.trim() || "";
const NVDA = env.KEEPER_NVDA?.trim() || env.NVDA_ADDRESS?.trim() || "";
const STATS_LOOKBACK_SECONDS = Number(env.KEEPER_STATS_LOOKBACK_SECONDS ?? 21600);
const STATS_LOOKBACK_BLOCKS = BigInt(env.KEEPER_STATS_LOOKBACK_BLOCKS ?? 21600);
const BLOCK_TIME_SECONDS = Number(env.KEEPER_BLOCK_TIME_SECONDS ?? 0.1);
// Annualize over the actual block span, not an assumed wall-clock window.
const STATS_WINDOW_SECONDS =
  BLOCK_TIME_SECONDS > 0 ? Number(STATS_LOOKBACK_BLOCKS) * BLOCK_TIME_SECONDS : STATS_LOOKBACK_SECONDS;
const MORPHO_ARM_SHARE_BPS = Number(env.KEEPER_MORPHO_ARM_SHARE_BPS ?? 8000);
const NVDA_STEP_BPS = Number(env.KEEPER_NVDA_STEP_BPS ?? 1000);
const BOOK_STEP_BPS = Number(env.KEEPER_BOOK_STEP_BPS ?? 2500);
const CANDIDATE_POOLS_RAW = env.KEEPER_CANDIDATE_POOLS?.trim() || "";
const RANGE_HALF_WIDTH_BPS = Number(env.KEEPER_RANGE_HALF_WIDTH_BPS ?? 1000);
const MIN_POOL_LIQUIDITY_USD = Number(env.KEEPER_MIN_POOL_LIQUIDITY_USD ?? 10000);
const SWITCH_BUFFER_BPS = Number(env.KEEPER_SWITCH_BUFFER_BPS ?? 500);
const GUARD_COOLDOWN_SECONDS = Number(env.KEEPER_GUARD_COOLDOWN_SECONDS ?? 0);
const MAX_GUARD_PULLS = Number(env.KEEPER_MAX_GUARD_PULLS ?? 2);
const UNWIND_DUST_USDG = BigInt(env.KEEPER_UNWIND_DUST_USDG ?? 1_000_000);
const UNWIND_DUST_NVDA = BigInt(env.KEEPER_UNWIND_DUST_NVDA ?? 1_000_000_000_000_000n);
const REPAY_BUFFER_USDG = BigInt(env.KEEPER_REPAY_BUFFER_USDG ?? 1_000_000);
const FUND_BOOK_BPS = BigInt(env.KEEPER_FUND_BOOK_BPS ?? 9_000);
const RISK_THRESHOLDS = {
  maxVolatilityBps: Number(env.KEEPER_RISK_MAX_VOLATILITY_BPS ?? 300),
  minVolumeUsd: Number(env.KEEPER_RISK_MIN_VOLUME_USD ?? 10000),
  minFeeAprBps: Number(env.KEEPER_RISK_MIN_FEE_APR_BPS ?? 0),
};
let lastAllocatorAt = 0;
let lastAllocatorBlock = null;

const POLICY = {
  maxStockLtvBps: Number(env.KEEPER_MAX_STOCK_LTV_BPS ?? 4000),
  maxYieldLtvBps: Number(env.KEEPER_MAX_YIELD_LTV_BPS ?? 8500),
  minHealthBps: Number(env.KEEPER_MIN_HEALTH_BPS ?? 2500),
  minCarryBps: Number(env.KEEPER_MIN_CARRY_BPS ?? 300),
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
]);
const guardPulledEvent = parseAbiItem(
  "event GuardPulled(int24 tickLower, int24 tickUpper, uint128 liquidity)",
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
]);
const lendAbi = parseAbi(["function realAssets() view returns (uint256)"]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
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

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

const key = env.KEEPER_PRIVATE_KEY?.trim();
const account = key ? privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`) : null;
const wallet = account
  ? createWalletClient({ account, chain, transport: http(RPC_URL) })
  : null;

const log = (...a) => console.log(new Date().toISOString(), ...a);

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

async function send({ address, abi, functionName, args = [], label }) {
  if (DRY_RUN) {
    log(`[dry-run] ${label}`);
    return null;
  }
  if (!wallet) throw new Error(`${label}: no KEEPER_PRIVATE_KEY`);
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted tx=${hash}`);
  log(`${label} tx=${hash}`);
  return hash;
}

async function approveStrategy(token, amount) {
  if (amount <= 0n) return;
  await send({
    address: AGENT,
    abi: agentAbi,
    functionName: "submitApproveStrategy",
    args: [token, amount],
    label: `approve ${amount} for ${token}`,
  });
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

async function scanCandidate(
  c,
  blockNumber,
  fromBlock,
  guardPresent,
  depegPaused,
  activePoolId,
  capitalUsd,
) {
  if (c.kind !== "v4") throw new Error(`unsupported candidate kind ${c.kind}`);
  const pm = c.poolManager || POOL_MANAGER;
  if (!pm || !c.poolId) throw new Error("v4 candidate missing poolManager/poolId");

  const windowSeconds = STATS_WINDOW_SECONDS;
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
  const book = await fetchBookStats({
    publicClient,
    poolManager: pm,
    poolId: c.poolId,
    feePips,
    nav: 0n,
    fromBlock,
    toBlock: blockNumber,
    windowSeconds,
  });

  const sqrtPriceX96 = slot0[0];
  const currentTick = Number(slot0[1]);
  const activeLiquidityUsd = activeLiquidityValue({
    liquidity,
    sqrtPriceX96,
    token0Decimals: 6,
  });

  const isActive = String(c.poolId).toLowerCase() === String(activePoolId).toLowerCase();
  let bookShare;
  let bookValueUsd;
  let bookRange;
  let bookPositionLiquidity = 0n;

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
        token0Decimals: 6,
      });
    }

    // Use the base range for IL when it has liquidity; otherwise the guard is the book.
    bookRange =
      base[2] > 0n
        ? { tickLower: Number(base[0]), tickUpper: Number(base[1]) }
        : { tickLower: Number(guard[0]), tickUpper: Number(guard[1]) };
    bookValueUsd = value;
    bookShare = liquidity > 0n ? Number(bookLiquidity) / Number(liquidity) : 0;

    // An empty active book has no fee history of its own. Use the same hypothetical
    // deployment as the other book so a normal-risk allocator can choose/fund it.
    if (bookPositionLiquidity === 0n && Number(capitalUsd) > 0) {
      const range = rangeFromHalfWidth({
        currentTick,
        halfWidthBps: RANGE_HALF_WIDTH_BPS,
      });
      const hypotheticalL = liquidityForValue({
        valueUsd: Number(capitalUsd),
        sqrtPriceX96,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        token0Decimals: 6,
      });
      const poolL = Number(liquidity);
      bookValueUsd = Number(capitalUsd);
      bookShare = poolL + hypotheticalL > 0 ? hypotheticalL / (poolL + hypotheticalL) : 0;
      bookRange = range;
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
      token0Decimals: 6,
    });
    const poolL = Number(liquidity);
    bookValueUsd = Number(capitalUsd);
    bookShare = poolL + hypotheticalL > 0 ? hypotheticalL / (poolL + hypotheticalL) : 0;
    bookRange = range;
  }

  const market = marketStats({
    book,
    activeLiquidityUsd,
    windowSeconds,
    rangeHalfWidthBps: RANGE_HALF_WIDTH_BPS,
    bookShare,
    bookValueUsd,
    bookRange,
    tickStart: book.tickFirst,
    tickEnd: book.tickLast,
  });

  const eligible = activeLiquidityUsd >= MIN_POOL_LIQUIDITY_USD;
  const risk = assessBookRisk({
    feeAprBps: market.feeAprBps,
    volumeUsd: market.volumeUsd,
    volatilityBps: market.volatilityBps,
    // The inactive book's guard is not deployed yet; assume it will be on switch.
    guardPresent: isActive ? guardPresent : true,
    depegPaused: isActive ? depegPaused : false,
    thresholds: RISK_THRESHOLDS,
  });

  return {
    ...c,
    ...market,
    activeLiquidityUsd,
    bookPositionLiquidity,
    eligible,
    risk: eligible ? risk.risk : "HIGH",
    riskReasons: eligible ? risk.reasons : ["thin-active-liquidity"],
    netAprBps: market.netAprBps,
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
  const [idleUsdg, idleNvda] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] }),
    publicClient.readContract({ address: NVDA, abi: erc20Abi, functionName: "balanceOf", args: [VAULT] }),
  ]);

  const plan = planArmEntry({
    usdgAvailable: idleUsdg,
    nvdaAvailable: idleNvda,
    usdgDeployed,
    nvdaDeployed: armCollateral,
    nvdaPriceWad,
    ltvBps: 2_937,
    maxLtvBps: 6_250,
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

  const nvdaMove = capAmount(capAmount(plan.nvdaMove, bounds?.maxCollateral), nvdaValueCap);

  log(
    `allocator plan: usdg=${usdgMove} nvda=${nvdaMove} borrow=${plan.borrow} ` +
      `steps=${plan.steps.map((s) => s.action).join(">")}`,
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
    await approveStrategy(USDG, usdgMove);
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
    await approveStrategy(NVDA, nvdaMove);
    await send({
      address: AGENT,
      abi: agentAbi,
      functionName: "submitAllocateCollateral",
      args: [ARM, nvdaMove],
      label: `allocator: ${nvdaMove} NVDA -> collateral arm`,
    });
    return;
  }

  if (ARM && armCollateral > 0n) {
    const collateralValue = await publicClient.readContract({
      address: ARM,
      abi: armAbi,
      functionName: "collateralValue",
    });
    const desired = borrowSize({ collateralValue, ltvBps: 2_937, maxLtvBps: 6_250 });
    if (desired > armDebt) {
      const borrowAmount = capAmount(
        capAmount(desired - armDebt, bounds?.maxBorrow),
        moduleCaps?.borrow,
      );
      if (borrowAmount > 0n) {
        await send({
          address: AGENT,
          abi: agentAbi,
          functionName: "submitBorrow",
          args: [ARM, borrowAmount],
          label: `allocator: borrow ${borrowAmount} USDG at <30% LTV`,
        });
        return;
      }
    }
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

async function returnToBooks({ armCollateral, armDebt, usdgDeployed }) {
  const plan = planBookReturn({
    usdgDeployed,
    nvdaCollateral: armCollateral,
    debt: armDebt,
    stepBps: BOOK_STEP_BPS,
    dustUsdg: UNWIND_DUST_USDG,
    dustNvda: UNWIND_DUST_NVDA,
  });
  log(
    `allocator plan: steps=${plan.steps.map((s) => s.action).join(">")} ` +
      `repay=${plan.repay} collateral=${plan.collateralOut}`,
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
    if (base[2] > 0n || guard[2] > 0n) {
      log("allocator: book already funded");
      return;
    }
    const [quoteIdle, equityIdle] = await Promise.all([
      publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "quoteIdle" }),
      publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "equityIdle" }),
    ]);
    if (quoteIdle > 0n || equityIdle > 0n) {
      await send({
        address: AGENT,
        abi: agentAbi,
        functionName: "submitRecall",
        label: "allocator: recall hook idle before funding the book",
      });
      return;
    }
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
    await approveStrategy(USDG, repay);
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
  const [activePoolId, blockNumber, guardPresent, depegPaused, nvdaPriceWad, nav] = await Promise.all([
    publicClient.readContract({ address: HOOK, abi: hookAbi, functionName: "activePoolId" }),
    publicClient.getBlockNumber(),
    publicClient.readContract({ address: bookHook, abi: hookAbi, functionName: "guardPresent" }),
    publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "depegPaused" }),
    publicClient.readContract({ address: bookHook, abi: hookAbi, functionName: "poolPrice1e18" }),
    publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "totalManagedAssets" }),
  ]);
  const navUsd = Number(nav) / 1e6;

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

  const fromBlock = blockNumber > STATS_LOOKBACK_BLOCKS ? blockNumber - STATS_LOOKBACK_BLOCKS : 0n;

  // Guard pulls are counted since the previous allocator run, so the count resets
  // every hour. On the first run (or after a restart) use the stats lookback.
  const guardFromBlock =
    lastAllocatorBlock ??
    (blockNumber > STATS_LOOKBACK_BLOCKS ? blockNumber - STATS_LOOKBACK_BLOCKS : 0n);
  const guardPulls = await guardPullCount(blockNumber, guardFromBlock);
  lastAllocatorBlock = blockNumber;

  const activeCandidate = candidates.find(
    (c) =>
      c.kind === "v4" &&
      c.poolId &&
      String(c.poolId).toLowerCase() === String(activePoolId).toLowerCase(),
  );

  const scanned = [];
  let capitalUsd;

  // Scan the active book first so the other book is compared at the same capital,
  // not at 100% of the other pool's active liquidity.
  if (activeCandidate) {
    try {
      const s = await scanCandidate(
        activeCandidate,
        blockNumber,
        fromBlock,
        guardPresent,
        depegPaused,
        activePoolId,
        navUsd,
      );
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
      scanned.push(
        await scanCandidate(
          c,
          blockNumber,
          fromBlock,
          guardPresent,
          depegPaused,
          activePoolId,
          capitalUsd,
        ),
      );
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
      `allocator scan: ${c.name} fee=${c.feeAprBps}bps il=${c.ilAprBps}bps net=${c.netAprBps}bps ` +
        `volume=$${Math.round(c.volumeUsd)} fluct=${c.volatilityBps}bps ` +
        `liq=$${Math.round(c.activeLiquidityUsd)} risk=${c.risk}` +
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

  const balances = await armBalances();
  const currentMode = balances.collateral > 0n || balances.usdg > 0n ? "ARMS" : "BOOKS";
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
    if (ALLOCATOR_EXECUTE && AGENT) {
      await send({
        address: AGENT,
        abi: agentAbi,
        functionName: "submitRecall",
        label: `allocator: recall book on ${why}`,
      });
    }
    return;
  }

  if (!guardPresent || guardRecentlyPulled || guardPulls > MAX_GUARD_PULLS || current.risk === "HIGH") {
    const why = !guardPresent
      ? "guard"
      : guardRecentlyPulled
        ? "guard-pulled"
        : guardPulls > MAX_GUARD_PULLS
          ? `guard-pulls=${guardPulls}`
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

  const decision = decidePoolSwitch({
    candidates: scanned,
    currentPool: current.name,
    switchBufferBps: SWITCH_BUFFER_BPS,
  });
  log(
    `allocator: current=${current.name} net=${current.netAprBps}bps ` +
      `-> ${decision.action}${decision.pool ? ` ${decision.pool}` : ""} ` +
      `(execute=${ALLOCATOR_EXECUTE}, mode=${currentMode})`,
  );

  if (decision.action === "ARMS") {
    await deployToArms({
      armCollateral: balances.collateral,
      armDebt: balances.debt,
      usdgDeployed: balances.usdg,
      nvdaPriceWad,
    });
    return;
  }

  if (decision.action === "HOLD") {
    if (currentMode === "ARMS") {
      await returnToBooks({
        armCollateral: balances.collateral,
        armDebt: balances.debt,
        usdgDeployed: balances.usdg,
      });
    } else if ((current.bookPositionLiquidity ?? 0n) === 0n) {
      // The active book is empty but still the best venue: fund it from idle inventory.
      await returnToBooks({
        armCollateral: balances.collateral,
        armDebt: balances.debt,
        usdgDeployed: balances.usdg,
      });
    }
    return;
  }

  if (decision.action === "SWITCH") {
    const best = decision.ranked[0];
    if (!best?.switchable || !Number.isInteger(best.book)) {
      log(`allocator: best is ${best?.name} (external, no venue adapter); staying`);
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
    await switchBook(best.book, best.name);
  }
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

  // 4. Morpho loop arm (Spiral NVDA strategy): de-leverage only.
  if (ARM) {
    try {
      const [hf, debt, apr] = await Promise.all([
        publicClient.readContract({ address: ARM, abi: armAbi, functionName: "healthFactor" }),
        publicClient.readContract({ address: ARM, abi: armAbi, functionName: "debt" }),
        publicClient.readContract({ address: ARM, abi: armAbi, functionName: "borrowAprBps" }),
      ]);
      const decision = decideArm({
        healthFactorWad: hf,
        debt,
        minHealthFactorWad: MIN_HEALTH_FACTOR,
        borrowAprBps: apr,
        maxBorrowAprBps: MAX_BORROW_APR_BPS,
      });
      if (decision.action === "DELEVERAGE") {
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
            await approveStrategy(USDG, repay);
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
