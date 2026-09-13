import fs from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  maxUint256,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

function loadEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
  }
}

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

const routerAbi = parseAbi([
  "function initializePool((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24)",
  "function addLiquidity((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, int24 tickLower, int24 tickUpper, int256 liquidityDelta, uint256 amount0Max, uint256 amount1Max, address recipient, bytes hookData) returns (int256)",
  "function swapExactIn((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint256 amountIn, uint256 minAmountOut, address recipient, bytes hookData) returns (int256)",
]);

loadEnv();

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const value = (flag, fallback) => {
  const i = rawArgs.indexOf(flag);
  return i >= 0 && rawArgs[i + 1] !== undefined ? rawArgs[i + 1] : fallback;
};

const rpc = process.env.ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0];
const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) });

const usdc = process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
const nvda = process.env.NVDA_ADDRESS || process.env.TEST_NVDA || process.env.MOCK_NVDA;
if (!nvda) throw new Error("NVDA_ADDRESS (or MOCK_NVDA) must be set in .env");
const stateView = process.env.STATE_VIEW;
const router = process.env.DEMO_ROUTER;
if (!stateView || !router) throw new Error("STATE_VIEW and DEMO_ROUTER must be set in .env");

const fee = Number(value("--fee", process.env.NVDA_POOL_FEE || 3000));
const tickSpacing = Number(value("--spacing", process.env.NVDA_POOL_TICK_SPACING || 60));
const priceUsdPerNvda = Number(value("--price", process.env.NVDA_POOL_PRICE || 200));
const rangeTicks = Number(value("--range", "6000"));
const targetUsdc = Number(value("--usdc", "50"));
const targetNvda = Number(value("--nvda", String(targetUsdc / priceUsdPerNvda)));
const swaps = Number(value("--swaps", "0"));
const swapUsdc = Number(value("--swap-usdc", "3"));
const skipLp = args.has("--skip-lp");

const usdcIsToken0 = usdc.toLowerCase() < nvda.toLowerCase();
const [currency0, currency1] = usdcIsToken0 ? [usdc, nvda] : [nvda, usdc];
const key = { currency0, currency1, fee, tickSpacing, hooks: "0x0000000000000000000000000000000000000000" };
const poolId = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [currency0, currency1, fee, tickSpacing, key.hooks]
  )
);

const [usdcDecimals, nvdaDecimals] = await Promise.all([
  publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" }),
  publicClient.readContract({ address: nvda, abi: erc20Abi, functionName: "decimals" }),
]);

// human price = raw price * 10^(dec0 - dec1); raw price = token1 per token0 at the given USD/NVDA price
function rawPriceFromUsd() {
  const dec0 = usdcIsToken0 ? Number(usdcDecimals) : Number(nvdaDecimals);
  const dec1 = usdcIsToken0 ? Number(nvdaDecimals) : Number(usdcDecimals);
  const human = usdcIsToken0 ? 1 / priceUsdPerNvda : priceUsdPerNvda;
  return human * 10 ** (dec1 - dec0);
}

const tickAt = (price) => Math.round(Math.log(price) / Math.log(1.0001));
const align = (v) => Math.floor(v / tickSpacing) * tickSpacing;

const rawPrice = rawPriceFromUsd();
const tick = process.env.NVDA_POOL_TICK ? Number(process.env.NVDA_POOL_TICK) : tickAt(rawPrice);
const tickLower = process.env.NVDA_POOL_TICK_LOWER ? Number(process.env.NVDA_POOL_TICK_LOWER) : align(tick - rangeTicks / 2);
const tickUpper = process.env.NVDA_POOL_TICK_UPPER ? Number(process.env.NVDA_POOL_TICK_UPPER) : align(tick + rangeTicks / 2);

function usdPerNvdaFromTick(poolTick) {
  const raw = Math.exp(Number(poolTick) * Math.log(1.0001));
  const dec0 = usdcIsToken0 ? Number(usdcDecimals) : Number(nvdaDecimals);
  const dec1 = usdcIsToken0 ? Number(nvdaDecimals) : Number(usdcDecimals);
  const human = raw * 10 ** (dec0 - dec1);
  return usdcIsToken0 ? 1 / human : human;
}

async function readPool() {
  try {
    const slot0 = await publicClient.readContract({
      address: stateView,
      abi: stateViewAbi,
      functionName: "getSlot0",
      args: [poolId],
    });
    const liquidity_ = await publicClient.readContract({
      address: stateView,
      abi: stateViewAbi,
      functionName: "getLiquidity",
      args: [poolId],
    });
    return { initialized: slot0[0] !== 0n, sqrtPriceX96: slot0[0], tick: slot0[1], lpFee: slot0[3], liquidity: liquidity_ };
  } catch {
    return { initialized: false, sqrtPriceX96: 0n, tick: 0, lpFee: 0, liquidity: 0n };
  }
}

async function status(extra = {}) {
  const pool = await readPool();
  const [usdcBalance, nvdaBalance] = await Promise.all([
    publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: nvda, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  ]);
  console.log(
    JSON.stringify(
      {
        pair: "USDC/NVDA",
        poolId,
        initialized: pool.initialized,
        tick: Number(pool.tick),
        lpFee: Number(pool.lpFee),
        liquidity: pool.liquidity.toString(),
        usdPerNvda: pool.initialized ? Number(usdPerNvdaFromTick(pool.tick).toFixed(2)) : priceUsdPerNvda,
        wallet: { usdc: Number(usdcBalance) / 1e6, nvda: Number(nvdaBalance) / 1e18 },
        ...extra,
      },
      null,
      2
    )
  );
}

// Liquidity L that spends ~target amounts at the current price inside [tickLower, tickUpper].
function liquidityForTargets() {
  const sqrtP = Math.sqrt(rawPrice);
  const sqrtA = Math.sqrt(1.0001 ** tickLower);
  const sqrtB = Math.sqrt(1.0001 ** tickUpper);
  const per0 = (sqrtB - sqrtP) / (sqrtP * sqrtB);
  const per1 = sqrtP - sqrtA;
  const target0 = usdcIsToken0 ? targetUsdc * 10 ** Number(usdcDecimals) : targetNvda * 10 ** Number(nvdaDecimals);
  const target1 = usdcIsToken0 ? targetNvda * 10 ** Number(nvdaDecimals) : targetUsdc * 10 ** Number(usdcDecimals);
  const l0 = per0 > 0 ? target0 / per0 : Infinity;
  const l1 = per1 > 0 ? target1 / per1 : Infinity;
  const liquidity = Math.floor(Math.min(l0, l1));
  const amount0 = BigInt(Math.ceil(liquidity * per0 * 1.02));
  const amount1 = BigInt(Math.ceil(liquidity * per1 * 1.02));
  return { liquidity: BigInt(liquidity), amount0, amount1 };
}

async function approveIfNeeded(token, symbol, spender, minAmount) {
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, spender],
  });
  if (allowance >= minAmount) return;
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`approved ${symbol}: ${hash}`);
}

async function execute() {
  if (!usdc || !nvda || !router || !stateView) {
    throw new Error(`missing address: usdc=${usdc} nvda=${nvda} router=${router} stateView=${stateView}`);
  }
  let pool = await readPool();
  await approveIfNeeded(usdc, "USDC", router, BigInt(Math.ceil(targetUsdc * 1e6)));
  await approveIfNeeded(nvda, "NVDA", router, BigInt(Math.ceil(targetNvda * 1e18)));

  if (!pool.initialized) {
    const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(rawPrice) * 2 ** 96));
    const hash = await walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "initializePool",
      args: [key, sqrtPriceX96],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`initialized pool at tick ${tick}: ${hash}`);
    pool = await readPool();
  } else {
    console.log(`pool already initialized at tick ${Number(pool.tick)}`);
  }

  if (!skipLp && (targetUsdc > 0 || targetNvda > 0)) {
    const { liquidity, amount0, amount1 } = liquidityForTargets();
    const hash = await walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "addLiquidity",
      args: [key, tickLower, tickUpper, liquidity, amount0, amount1, account.address, "0x757364632d6e766461"],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(
      `added liquidity L=${liquidity} target ${targetUsdc} USDC + ${targetNvda} NVDA range [${tickLower},${tickUpper}]: ${hash}`,
    );
  }

  for (let i = 0; i < swaps; i += 1) {
    const sellUsdc = i % 2 === 0;
    const zeroForOne = sellUsdc ? usdcIsToken0 : !usdcIsToken0;
    const amountIn = sellUsdc
      ? BigInt(Math.round(swapUsdc * 1e6))
      : BigInt(Math.round((swapUsdc / priceUsdPerNvda) * 1e18));
    const hash = await walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "swapExactIn",
      args: [key, zeroForOne, amountIn, 0n, account.address, "0x01"],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    const after = await readPool();
    console.log(
      `swap ${i + 1}/${swaps} ${sellUsdc ? `${swapUsdc} USDC→NVDA` : `${(swapUsdc / priceUsdPerNvda).toFixed(5)} NVDA→USDC`} ` +
        `tick ${Number(after.tick)}: ${hash}`,
    );
  }

  await status({ swaps, swapUsdc, targetUsdc, targetNvda });
}

if (args.has("--execute")) {
  await execute();
} else {
  const preview = skipLp ? null : liquidityForTargets();
  await status({
    preview: preview
      ? { liquidity: preview.liquidity.toString(), amount0Max: preview.amount0.toString(), amount1Max: preview.amount1.toString() }
      : null,
    swaps,
  });
}
