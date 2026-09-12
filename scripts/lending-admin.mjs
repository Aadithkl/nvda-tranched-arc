import fs from "node:fs";
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, parseAbi } from "viem";
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
  "function symbol() view returns (string)",
]);

const oracleAbi = parseAbi([
  "function getAssetPrice(address asset) view returns (uint256)",
  "function setAssetPrice(address asset, uint256 price)",
]);

const poolAbi = parseAbi([
  "function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id))",
]);

loadEnv();

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const rpc = process.env.ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0];
const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) });

const usdc = process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
const nvda = process.env.NVDA_ADDRESS;
const pool = process.env.LENDING_POOL || "0x75E6E7711a87dbC53D613806bb961bc1Bb01e0c8";
const oracle = process.env.LENDING_ORACLE || "0x6DC2A77B42B4049f96593b5Aa979227580aA510b";
if (!nvda) throw new Error("NVDA_ADDRESS must be set in .env");

const explorer = (hash) => `https://testnet.arcscan.app/tx/${hash}`;

async function send(hashPromise, label) {
  const hash = await hashPromise;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`${label}: ${hash}`);
  console.log(`  ${explorer(hash)}`);
  return receipt;
}

async function status() {
  let usdcPrice = null;
  let nvdaPrice = null;
  try {
    usdcPrice = await publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [usdc] });
  } catch {
    usdcPrice = null;
  }
  try {
    nvdaPrice = await publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [nvda] });
  } catch {
    nvdaPrice = null;
  }
  console.log(`oracle USDC price: ${usdcPrice === null ? "unset" : `${Number(usdcPrice) / 1e8} (${usdcPrice})`}`);
  console.log(`oracle NVDA price: ${nvdaPrice === null ? "unset" : `${Number(nvdaPrice) / 1e8} (${nvdaPrice})`}`);

  for (const [symbol, token] of [
    ["USDC", usdc],
    ["NVDA", nvda],
  ]) {
    let reserve;
    try {
      reserve = await publicClient.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "getReserveData",
        args: [token],
      });
    } catch {
      console.log(`${symbol}: reserve not configured on this pool`);
      continue;
    }
    const [walletBalance, aTokenBalance, decimals] = await Promise.all([
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      publicClient.readContract({ address: reserve.aTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    ]);
    console.log(
      `${symbol}: wallet ${formatUnits(walletBalance, decimals)} | aToken ${formatUnits(aTokenBalance, decimals)} | liquidityIndex ${reserve.liquidityIndex}`,
    );
  }
}

async function setPrices() {
  const usdcPrice = BigInt(value("--usdc-price", process.env.USDC_PEGGED_PRICE || "100000000"));
  const nvdaPrice = BigInt(value("--nvda-price", process.env.NVDA_PEGGED_PRICE || "20000000000"));
  console.log(`setting pegs: USDC=${usdcPrice} NVDA=${nvdaPrice} (USD, 8d)`);
  await send(
    walletClient.writeContract({ address: oracle, abi: oracleAbi, functionName: "setAssetPrice", args: [usdc, usdcPrice] }),
    "setAssetPrice(USDC)",
  );
  await send(
    walletClient.writeContract({ address: oracle, abi: oracleAbi, functionName: "setAssetPrice", args: [nvda, nvdaPrice] }),
    "setAssetPrice(NVDA)",
  );
}

async function depositOne(token, symbol, amount) {
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, pool],
  });
  if (allowance < amount) {
    await send(
      walletClient.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [pool, amount] }),
      `approve(${symbol})`,
    );
  }
  await send(
    walletClient.writeContract({
      address: pool,
      abi: poolAbi,
      functionName: "deposit",
      args: [token, amount, account.address, 0],
    }),
    `deposit(${symbol}, ${amount})`,
  );
}

async function seed() {
  const usdcAmount = BigInt(value("--usdc-amount", "10000000"));
  const nvdaAmount = BigInt(value("--nvda-amount", "1000000000000000000"));
  console.log(`seeding Aave: ${formatUnits(usdcAmount, 6)} USDC + ${formatUnits(nvdaAmount, 18)} NVDA`);
  await depositOne(usdc, "USDC", usdcAmount);
  await depositOne(nvda, "NVDA", nvdaAmount);
}

const doSetPrice = has("--set-price");
const doSeed = has("--seed");
const doStatus = has("--status") || (!doSetPrice && !doSeed);

if (doSetPrice) await setPrices();
if (doSeed) await seed();
if (doStatus) await status();
