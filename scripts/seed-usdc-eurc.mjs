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
]);

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

const routerAbi = parseAbi([
  "function initializePool((address,address,uint24,int24,address) key, uint160 sqrtPriceX96) returns (int24)",
  "function addLiquidity((address,address,uint24,int24,address) key, int24 tickLower, int24 tickUpper, int256 liquidityDelta, uint256 amount0Max, uint256 amount1Max, address recipient, bytes hookData) returns (int256)",
  "function swapExactIn((address,address,uint24,int24,address) key, bool zeroForOne, uint256 amountIn, uint256 minAmountOut, address recipient, bytes hookData) returns (int256)",
]);

loadEnv();

const args = new Set(process.argv.slice(2));

const rpc = process.env.ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0];
const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) });

const usdc = process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
const eurc = process.env.EURC_ADDRESS || "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const stateView = process.env.STATE_VIEW;
const router = process.env.DEMO_ROUTER;
if (!stateView || !router) throw new Error("STATE_VIEW and DEMO_ROUTER must be set in .env");

const fee = Number(process.env.EURC_POOL_FEE || 100);
const tickSpacing = Number(process.env.EURC_POOL_TICK_SPACING || 1);
const tick = Number(process.env.EURC_POOL_TICK || -1499);
const tickLower = Number(process.env.EURC_POOL_TICK_LOWER || -1987);
const tickUpper = Number(process.env.EURC_POOL_TICK_UPPER || -1062);
const liquidity = BigInt(process.env.EURC_POOL_LIQUIDITY || "214639290");

const [currency0, currency1] = usdc.toLowerCase() < eurc.toLowerCase() ? [usdc, eurc] : [eurc, usdc];
const key = { currency0, currency1, fee, tickSpacing, hooks: "0x0000000000000000000000000000000000000000" };
const poolId = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [currency0, currency1, fee, tickSpacing, key.hooks]
  )
);

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

async function status() {
  const pool = await readPool();
  const [usdcBalance, eurcBalance, usdcAllowance, eurcAllowance] = await Promise.all([
    publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: eurc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, router] }),
    publicClient.readContract({ address: eurc, abi: erc20Abi, functionName: "allowance", args: [account.address, router] }),
  ]);
  const price = Math.exp(Number(pool.tick) * Math.log(1.0001));
  console.log(
    JSON.stringify(
      {
        poolId,
        initialized: pool.initialized,
        tick: Number(pool.tick),
        lpFee: Number(pool.lpFee),
        liquidity: pool.liquidity.toString(),
        eurcPerUsdc: Number(price.toFixed(6)),
        usdPerEurc: Number((1 / price).toFixed(4)),
        wallet: {
          usdc: usdcBalance.toString(),
          eurc: eurcBalance.toString(),
          usdcAllowance: usdcAllowance.toString(),
          eurcAllowance: eurcAllowance.toString(),
        },
      },
      null,
      2
    )
  );
}

async function execute() {
  const pool = await readPool();
  const needsApprove = (allowance) => allowance < 10_000_000n;

  const [usdcAllowance, eurcAllowance] = await Promise.all([
    publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, router] }),
    publicClient.readContract({ address: eurc, abi: erc20Abi, functionName: "allowance", args: [account.address, router] }),
  ]);

  if (needsApprove(usdcAllowance)) {
    const hash = await walletClient.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [router, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log("approved USDC:", hash);
  }
  if (needsApprove(eurcAllowance)) {
    const hash = await walletClient.writeContract({
      address: eurc,
      abi: erc20Abi,
      functionName: "approve",
      args: [router, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log("approved EURC:", hash);
  }

  if (!pool.initialized) {
    const sqrtPriceX96 = BigInt(Math.floor(Math.pow(1.0001, tick / 2) * 2 ** 96));
    const hash = await walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "initializePool",
      args: [key, sqrtPriceX96],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log("initialized pool:", hash);
  } else {
    console.log("pool already initialized at tick", Number(pool.tick));
  }

  if (pool.liquidity === 0n) {
    const hash = await walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "addLiquidity",
      args: [key, tickLower, tickUpper, liquidity, 5_050_000n, 4_850_000n, account.address, "0x757364632d65757263"],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log("added liquidity:", hash);
  } else {
    console.log("liquidity already present:", pool.liquidity.toString());
  }

  if (args.has("--swap")) {
    const hash = await walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "swapExactIn",
      args: [key, currency0.toLowerCase() === usdc.toLowerCase(), 500_000n, 0n, account.address, "0x01"],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log("swap 0.5 USDC -> EURC:", hash);
  }

  await status();
}

if (args.has("--execute")) {
  await execute();
} else {
  await status();
}
