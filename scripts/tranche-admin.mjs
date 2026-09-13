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
]);

const vaultAbi = parseAbi([
  "function depositUSDC(uint256 usdcAmount, address receiver) returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
]);

const accountantAbi = parseAbi([
  "function seniorClaim() view returns (uint256)",
  "function juniorClaim() view returns (uint256)",
  "function escrowFunded() view returns (bool)",
  "function poolValue() view returns (uint256)",
  "function effectivePool() view returns (uint256)",
  "function lastRebalanceAt() view returns (uint256)",
  "function rebalance() returns (uint256, uint256)",
]);

const hookAbi = parseAbi([
  "function seedInventory(address asset, uint256 amount)",
  "function totalManagedAssets() view returns (uint256)",
  "function aToken() view returns (address)",
  "function aTokenEquity() view returns (address)",
  "function shareToken() view returns (address)",
  "function effectiveMaxDeploy() view returns (uint256)",
  "function riskBudget() view returns (uint256)",
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
const nvda = process.env.NVDA_ADDRESS || process.env.TEST_NVDA || process.env.MOCK_NVDA || null;
const hook = process.env.TRANCHE_HOOK;
const seniorVault = process.env.TRANCHE_SENIOR;
const juniorVault = process.env.TRANCHE_JUNIOR;
const accountant = process.env.TRANCHE_ACCOUNTANT;

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
  const [usdcBal, nvdaBal] = await Promise.all([
    publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    nvda
      ? publicClient.readContract({ address: nvda, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })
      : Promise.resolve(0n),
  ]);
  console.log(`wallet: ${formatUnits(usdcBal, 6)} USDC / ${nvda ? formatUnits(nvdaBal, 18) : "0"} NVDA`);

  if (accountant) {
    const [seniorClaim, juniorClaim, escrow, poolValue, effPool, lastRebal] = await Promise.all([
      publicClient.readContract({ address: accountant, abi: accountantAbi, functionName: "seniorClaim" }),
      publicClient.readContract({ address: accountant, abi: accountantAbi, functionName: "juniorClaim" }),
      publicClient.readContract({ address: accountant, abi: accountantAbi, functionName: "escrowFunded" }),
      publicClient.readContract({ address: accountant, abi: accountantAbi, functionName: "poolValue" }),
      publicClient.readContract({ address: accountant, abi: accountantAbi, functionName: "effectivePool" }),
      publicClient.readContract({ address: accountant, abi: accountantAbi, functionName: "lastRebalanceAt" }),
    ]);
    console.log(
      `accountant: seniorClaim ${formatUnits(seniorClaim, 6)} | juniorClaim ${formatUnits(juniorClaim, 6)} | ` +
        `escrowFunded ${escrow} | poolValue ${formatUnits(poolValue, 6)} | target ${formatUnits(effPool, 6)} | ` +
        `lastRebalance ${lastRebal > 0n ? new Date(Number(lastRebal) * 1000).toISOString() : "never"}`,
    );
  }

  for (const [label, vault] of [
    ["senior", seniorVault],
    ["junior", juniorVault],
  ]) {
    if (!vault) continue;
    const [shares, maxDep] = await Promise.all([
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account.address] }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "maxDeposit", args: [account.address] }),
    ]);
    console.log(`${label} vault: your shares ${formatUnits(shares, 18)} | maxDeposit ${formatUnits(maxDep, 6)}`);
  }

  if (hook) {
    const [managed, aToken, aEquity, maxDeploy, riskBudget] = await Promise.all([
      publicClient.readContract({ address: hook, abi: hookAbi, functionName: "totalManagedAssets" }),
      publicClient.readContract({ address: hook, abi: hookAbi, functionName: "aToken" }),
      publicClient.readContract({ address: hook, abi: hookAbi, functionName: "aTokenEquity" }).catch(() => null),
      publicClient.readContract({ address: hook, abi: hookAbi, functionName: "effectiveMaxDeploy" }),
      publicClient.readContract({ address: hook, abi: hookAbi, functionName: "riskBudget" }).catch(() => 0n),
    ]);
    const [aBal, aEqBal] = await Promise.all([
      publicClient.readContract({ address: aToken, abi: erc20Abi, functionName: "balanceOf", args: [hook] }),
      aEquity
        ? publicClient.readContract({ address: aEquity, abi: erc20Abi, functionName: "balanceOf", args: [hook] })
        : Promise.resolve(0n),
    ]);
    console.log(
      `hook: managed ${formatUnits(managed, 6)} USDC | aUSDC ${formatUnits(aBal, 6)} | aEquity ${formatUnits(aEqBal, 18)} | ` +
        `effectiveMaxDeploy ${formatUnits(maxDeploy, 6)} | riskBudget ${formatUnits(riskBudget, 6)}`,
    );
  }
}

async function approveIfNeeded(token, spender, amount) {
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, spender],
  });
  if (allowance >= amount) return;
  await send(
    walletClient.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
    `approve(${token.slice(0, 10)}…)`,
  );
}

async function fund() {
  const seniorAmount = BigInt(value("--senior", "0"));
  const juniorAmount = BigInt(value("--junior", "0"));
  for (const [label, vault, amount] of [
    ["senior", seniorVault, seniorAmount],
    ["junior", juniorVault, juniorAmount],
  ]) {
    if (!vault || amount === 0n) continue;
    await approveIfNeeded(usdc, vault, amount);
    await send(
      walletClient.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: "depositUSDC",
        args: [amount, account.address],
      }),
      `depositUSDC(${label}, ${formatUnits(amount, 6)})`,
    );
  }
}

async function rebalance() {
  if (!accountant) throw new Error("TRANCHE_ACCOUNTANT not set");
  await send(
    walletClient.writeContract({ address: accountant, abi: accountantAbi, functionName: "rebalance" }),
    "accountant.rebalance()",
  );
}

async function seed() {
  const usdcAmount = BigInt(value("--usdc", "0"));
  const nvdaAmount = BigInt(value("--nvda", "0"));
  if (usdcAmount > 0n) {
    await approveIfNeeded(usdc, hook, usdcAmount);
    await send(
      walletClient.writeContract({ address: hook, abi: hookAbi, functionName: "seedInventory", args: [usdc, usdcAmount] }),
      `seedInventory(USDC, ${formatUnits(usdcAmount, 6)})`,
    );
  }
  if (nvdaAmount > 0n && nvda) {
    await approveIfNeeded(nvda, hook, nvdaAmount);
    await send(
      walletClient.writeContract({ address: hook, abi: hookAbi, functionName: "seedInventory", args: [nvda, nvdaAmount] }),
      `seedInventory(NVDA, ${formatUnits(nvdaAmount, 18)})`,
    );
  }
}

const doStatus = has("--status") || (!has("--fund") && !has("--rebalance") && !has("--seed"));
if (has("--fund")) await fund();
if (has("--rebalance")) await rebalance();
if (has("--seed")) await seed();
if (doStatus) await status();
