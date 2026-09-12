import fs from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
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
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const routerAbi = parseAbi([
  "function addLiquidity((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, int24 tickLower, int24 tickUpper, int256 liquidityDelta, uint256 amount0Max, uint256 amount1Max, address recipient, bytes hookData) returns (int256)",
  "function swapExactIn((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint256 amountIn, uint256 minAmountOut, address recipient, bytes hookData) returns (int256)",
]);

const hookAbi = parseAbi([
  "function previewQuote(bool zeroForOne) view returns (uint24 fee, bool toxic, uint16 deviationBps, uint8 state)",
  "function params() view returns ((bool quotingEnabled, uint24 baseFee, uint24 maxSurgeFee, uint16 maxDeviationBps, uint16 toxicityMultiplierBps, uint16 minEvBps, uint32 cooldownSeconds, uint32 ttl, uint32 gracePeriod, uint128 maxDeployPerSwap, int24 bucketTicks))",
  "function quoteState() view returns (uint8)",
  "function lastQuotedAt() view returns (uint256)",
  "function totalManagedAssets() view returns (uint256)",
  "function convertToShares(uint256 usdcAmount) view returns (uint256)",
  "function convertToUsdc(uint256 shares) view returns (uint256)",
  "function wrapUSDC(uint256 usdcAmount, address receiver) returns (uint256)",
  "function unwrapUSDC(uint256 shares, address receiver) returns (uint256)",
  "function aToken() view returns (address)",
  "function shareToken() view returns (address)",
  "function activePoolId() view returns (bytes32)",
  "function priceOracle() view returns (address)",
  "function effectiveMaxDeploy() view returns (uint256)",
]);

const agentAbi = parseAbi([
  "function submitParams((bool quotingEnabled, uint24 baseFee, uint24 maxSurgeFee, uint16 maxDeviationBps, uint16 toxicityMultiplierBps, uint16 minEvBps, uint32 cooldownSeconds, uint32 ttl, uint32 gracePeriod, uint128 maxDeployPerSwap, int24 bucketTicks) params)",
  "function submitBaseFee(uint24 baseFee)",
  "function submitQuotingEnabled(bool enabled)",
]);

const oracleAbi = parseAbi([
  "function getPrice() view returns ((int192 mid, int192 bid, int192 ask, uint32 marketStatus, uint8 session, uint32 sourceTimestamp, uint256 updatedAt, bytes32 paymentRef, bool valid))",
  "function updatePrice(int192 mid, uint32 marketStatus, uint32 sourceTimestamp, bytes32 paymentRef)",
]);

const poolManagerAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);

const DEFAULT_PARAMS = {
  quotingEnabled: true,
  baseFee: 3000,
  maxSurgeFee: 30000,
  maxDeviationBps: 300,
  toxicityMultiplierBps: 1000,
  minEvBps: 0,
  cooldownSeconds: 0,
  ttl: 3600,
  gracePeriod: 3600,
  maxDeployPerSwap: 1_000_000n,
  bucketTicks: 1,
};

loadEnv();

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const rpc = process.env.ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0];
const config = {
  usdc: process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000",
  nvda: process.env.EURC_ADDRESS || "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  router: process.env.DEMO_ROUTER,
  hook: process.env.HOOK_DEMO_HOOK,
  oracle: process.env.HOOK_DEMO_ORACLE,
  agent: process.env.HOOK_DEMO_AGENT,
  poolManager: process.env.V4_POOL_MANAGER || "0xFc4146c0de93B518Ce60158e2eD0943697c3Ae67",
};
if (!config.hook || !config.oracle || !config.agent || !config.router) {
  throw new Error("HOOK_DEMO_HOOK, HOOK_DEMO_ORACLE, HOOK_DEMO_AGENT, DEMO_ROUTER must be in .env");
}

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
const operatorKey = process.env.AGENT_OPERATOR_PRIVATE_KEY;
if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");
const deployer = privateKeyToAccount(deployerKey.startsWith("0x") ? deployerKey : `0x${deployerKey}`);
const operator = operatorKey ? privateKeyToAccount(operatorKey.startsWith("0x") ? operatorKey : `0x${operatorKey}`) : null;

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) });
const deployerClient = createWalletClient({ account: deployer, chain: arcTestnet, transport: http(rpc) });
const operatorClient = operator ? createWalletClient({ account: operator, chain: arcTestnet, transport: http(rpc) }) : null;

const [currency0, currency1] =
  config.usdc.toLowerCase() < config.nvda.toLowerCase() ? [config.usdc, config.nvda] : [config.nvda, config.usdc];
const key = { currency0, currency1, fee: 0x800000, tickSpacing: 1, hooks: config.hook };
const poolId = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ),
);

const explorer = (hash) => `https://testnet.arcscan.app/tx/${hash}`;

async function send(hashPromise, label) {
  const hash = await hashPromise;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${explorer(hash)}`);
  console.log(`${label}: ${hash}`);
  console.log(`  ${explorer(hash)}`);
  return receipt;
}

async function approveIfNeeded(token, spender, amount, owner = deployer, client = deployerClient) {
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner.address, spender],
  });
  if (allowance < amount) {
    await send(
      client.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
      `approve ${token} → ${spender}`,
    );
  }
}

async function slot0() {
  const stateSlot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
  const raw = BigInt(
    await publicClient.readContract({
      address: config.poolManager,
      abi: poolManagerAbi,
      functionName: "extsload",
      args: [stateSlot],
    }),
  );
  return {
    sqrtPriceX96: raw & ((1n << 160n) - 1n),
    tick: Number(BigInt.asIntN(24, raw >> 160n)),
    protocolFee: Number((raw >> 184n) & 0xffffffn),
    lpFee: Number((raw >> 208n) & 0xffffffn),
  };
}

async function tryPreview(zeroForOne) {
  try {
    const [fee, toxic, deviationBps, state] = await publicClient.readContract({
      address: config.hook,
      abi: hookAbi,
      functionName: "previewQuote",
      args: [zeroForOne],
    });
    return { fee: Number(fee), toxic, deviationBps: Number(deviationBps), state: Number(state) };
  } catch (error) {
    return { error: (error.shortMessage || error.message || "").slice(0, 120) };
  }
}

async function status() {
  const oracle = await publicClient.readContract({ address: config.oracle, abi: oracleAbi, functionName: "getPrice" });
  const [params, state, lastQuotedAt, totalManaged, aTokenAddress, shareTokenAddress, maxDeploy] = await Promise.all([
    publicClient.readContract({ address: config.hook, abi: hookAbi, functionName: "params" }),
    publicClient.readContract({ address: config.hook, abi: hookAbi, functionName: "quoteState" }),
    publicClient.readContract({ address: config.hook, abi: hookAbi, functionName: "lastQuotedAt" }),
    publicClient.readContract({ address: config.hook, abi: hookAbi, functionName: "totalManagedAssets" }),
    publicClient.readContract({ address: config.hook, abi: hookAbi, functionName: "aToken" }),
    publicClient.readContract({ address: config.hook, abi: hookAbi, functionName: "shareToken" }),
    publicClient.readContract({ address: config.hook, abi: hookAbi, functionName: "effectiveMaxDeploy" }),
  ]);
  const [s0, usdcBal, nvdaBal, aTokenBal, shareSupply] = await Promise.all([
    slot0(),
    publicClient.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] }),
    publicClient.readContract({ address: config.nvda, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] }),
    publicClient.readContract({ address: aTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [config.hook] }),
    publicClient.readContract({ address: shareTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] }),
  ]);

  console.log("=== hook demo status ===");
  console.log(`hook: ${config.hook} poolId: ${poolId}`);
  console.log(`oracle EURC/USD mid: ${Number(oracle.mid) / 1e8} (valid: ${oracle.valid}, session: ${oracle.session})`);
  console.log(`pool tick: ${s0.tick} | stored lpFee: ${s0.lpFee} | sqrtPriceX96: ${s0.sqrtPriceX96}`);
  console.log(`params.baseFee: ${params.baseFee} | maxSurgeFee: ${params.maxSurgeFee} | maxDeviationBps: ${params.maxDeviationBps} | ttl: ${params.ttl}`);
  console.log(`quoteState: ${["Rest", "Degraded", "Active"][Number(state)]} | lastQuotedAt: ${lastQuotedAt}`);
  console.log(`effectiveMaxDeploy: ${maxDeploy} (risk budget)`);
  console.log(`hook Aave rest: aToken ${aTokenAddress} balance ${formatUnits(aTokenBal, 6)} USDC | totalManaged ${formatUnits(totalManaged, 6)} USDC | deployer shares ${formatUnits(shareSupply, 18)}`);
  console.log(`deployer wallet: ${formatUnits(usdcBal, 6)} USDC / ${formatUnits(nvdaBal, 6)} EURC`);
  console.log(`previewQuote USDC→EURC:`, await tryPreview(true));
  console.log(`previewQuote EURC→USDC:`, await tryPreview(false));
}

async function setParams() {
  if (!operatorClient) throw new Error("AGENT_OPERATOR_PRIVATE_KEY not set");
  await send(
    operatorClient.writeContract({ address: config.agent, abi: agentAbi, functionName: "submitParams", args: [DEFAULT_PARAMS] }),
    "agent.submitParams (operator)",
  );
}

async function setFee() {
  if (!operatorClient) throw new Error("AGENT_OPERATOR_PRIVATE_KEY not set");
  const fee = Number(value("--set-fee", "5000"));
  await send(
    operatorClient.writeContract({ address: config.agent, abi: agentAbi, functionName: "submitBaseFee", args: [fee] }),
    `agent.submitBaseFee(${fee})`,
  );
}

async function setOracle() {
  const price = Number(value("--set-oracle", "116170000"));
  await send(
    deployerClient.writeContract({
      address: config.oracle,
      abi: oracleAbi,
      functionName: "updatePrice",
      args: [BigInt(price), 2, Math.floor(Date.now() / 1000), `0x${"0".repeat(64)}`],
    }),
    `oracle.updatePrice(${price})`,
  );
}

async function addLiquidity() {
  const liquidity = BigInt(value("--liquidity", "42000000"));
  const tickLower = Number(value("--tick-lower", "-1987"));
  const tickUpper = Number(value("--tick-upper", "-1062"));
  const max0 = BigInt(value("--max0", "1100000"));
  const max1 = BigInt(value("--max1", "1000000"));
  await approveIfNeeded(config.usdc, config.router, max0);
  await approveIfNeeded(config.nvda, config.router, max1);
  await send(
    deployerClient.writeContract({
      address: config.router,
      abi: routerAbi,
      functionName: "addLiquidity",
      args: [key, tickLower, tickUpper, liquidity, max0, max1, deployer.address, "0x"],
    }),
    `addLiquidity L=${liquidity} [${tickLower},${tickUpper}]`,
  );
}

async function swap() {
  const amountIn = BigInt(value("--swap", "10000"));
  const zeroForOne = value("--direction", "usdc-to-nvda") !== "nvda-to-usdc";
  await approveIfNeeded(config.usdc, config.router, amountIn);
  await approveIfNeeded(config.nvda, config.router, amountIn);
  const preview = await tryPreview(zeroForOne);
  console.log("preview before swap:", preview);
  const receipt = await send(
    deployerClient.writeContract({
      address: config.router,
      abi: routerAbi,
      functionName: "swapExactIn",
      args: [key, zeroForOne, amountIn, 0n, deployer.address, "0x"],
    }),
    `swapExactIn(${zeroForOne ? "USDC→EURC" : "EURC→USDC"}, ${formatUnits(amountIn, 6)})`,
  );
  const hookAbiFull = JSON.parse(fs.readFileSync("out/TrancheJITHook.sol/TrancheJITHook.json", "utf8")).abi;
  const [quoted] = parseEventLogs({ abi: hookAbiFull, logs: receipt.logs, eventName: "SwapQuoted" });
  if (quoted) {
    console.log(
      `SwapQuoted: fee=${quoted.args.fee} toxic=${quoted.args.toxic} deviationBps=${quoted.args.deviationBps} state=${quoted.args.state}`,
    );
  }
  console.log("stored lpFee after swap:", (await slot0()).lpFee);
}

async function wrap() {
  const amount = BigInt(value("--wrap", "1000000"));
  await approveIfNeeded(config.usdc, config.hook, amount);
  const receipt = await send(
    deployerClient.writeContract({
      address: config.hook,
      abi: hookAbi,
      functionName: "wrapUSDC",
      args: [amount, deployer.address],
    }),
    `hook.wrapUSDC(${formatUnits(amount, 6)} USDC → Aave)`,
  );
  const aTokenAddress = await publicClient.readContract({ address: config.hook, abi: hookAbi, functionName: "aToken" });
  const aTokenBal = await publicClient.readContract({ address: aTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [config.hook] });
  console.log(`hook aToken balance now: ${formatUnits(aTokenBal, 6)} USDC`);
  return receipt;
}

async function unwrap() {
  const shares = BigInt(value("--unwrap", "1000000000000000000"));
  await send(
    deployerClient.writeContract({
      address: config.hook,
      abi: hookAbi,
      functionName: "unwrapUSDC",
      args: [shares, deployer.address],
    }),
    `hook.unwrapUSDC(${formatUnits(shares, 18)} shares → USDC)`,
  );
  const aTokenAddress = await publicClient.readContract({ address: config.hook, abi: hookAbi, functionName: "aToken" });
  const aTokenBal = await publicClient.readContract({ address: aTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [config.hook] });
  console.log(`hook aToken balance now: ${formatUnits(aTokenBal, 6)} USDC`);
}

async function fundOperator() {
  if (!operator) throw new Error("AGENT_OPERATOR_PRIVATE_KEY not set");
  const amount = BigInt(value("--fund-operator", "2000000"));
  await send(
    deployerClient.writeContract({
      address: config.usdc,
      abi: erc20Abi,
      functionName: "transfer",
      args: [operator.address, amount],
    }),
    `fund operator ${operator.address} with ${formatUnits(amount, 6)} USDC`,
  );
}

async function main() {
  if (has("--status") || args.length === 0) return status();
  if (has("--set-params")) return setParams();
  if (has("--set-fee")) return setFee();
  if (has("--set-oracle")) return setOracle();
  if (has("--add-liquidity")) return addLiquidity();
  if (has("--swap")) return swap();
  if (has("--wrap")) return wrap();
  if (has("--unwrap")) return unwrap();
  if (has("--fund-operator")) return fundOperator();
  throw new Error(`unknown action: ${args.join(" ")}`);
}

await main();
