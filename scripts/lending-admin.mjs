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
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) returns (uint256)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function updateState(address asset)",
  "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id))",
]);

const marketAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const configuratorAbi = parseAbi([
  "function initReserve(address asset, uint8 decimals, string aTokenName, string aTokenSymbol, address interestRateStrategy) returns (address, address)",
  "function setReserveInterestRateStrategyAddress(address asset, address strategy)",
  "function configureReserveAsCollateral(address asset, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus)",
  "function enableBorrowingOnReserve(address asset, bool enabled)",
  "function setReserveFactor(address asset, uint256 reserveFactor)",
]);

const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

const strategyAbi = parseAbi([
  "function baseVariableBorrowRate() view returns (uint256)",
  "function variableRateSlope1() view returns (uint256)",
  "function variableRateSlope2() view returns (uint256)",
  "function optimalUtilization() view returns (uint256)",
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
const pool = process.env.LENDING_POOL || "0x75E6E7711a87dbC53D613806bb961bc1Bb01e0c8";
const configurator = process.env.LENDING_CONFIGURATOR || "0x43169D2DaaC35E90ec4487E7f156A4958D20EFBe";
const oracle = process.env.LENDING_ORACLE || "0x6DC2A77B42B4049f96593b5Aa979227580aA510b";

const ZERO = "0x0000000000000000000000000000000000000000";
const explorer = (hash) => `https://testnet.arcscan.app/tx/${hash}`;

const rayPct = (v) => `${(Number(v) / 1e25).toFixed(2)}%`;
const toRay = (pct) => BigInt(Math.round(Number(pct) * 1e25));
const bps = (v) => `${(Number(v) / 100).toFixed(1)}%`;

function decodeConfig(configuration) {
  const cfg = BigInt(configuration);
  return {
    ltv: Number(cfg & 0xffffn),
    threshold: Number((cfg >> 16n) & 0xffffn),
    bonus: Number((cfg >> 32n) & 0xffffn),
    decimals: Number((cfg >> 48n) & 0xffn),
    active: ((cfg >> 56n) & 1n) === 1n,
    frozen: ((cfg >> 57n) & 1n) === 1n,
    borrowing: ((cfg >> 58n) & 1n) === 1n,
    reserveFactor: Number((cfg >> 64n) & 0xffffn),
  };
}

async function send(hashPromise, label) {
  const hash = await hashPromise;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`${label}: ${hash}`);
  console.log(`  ${explorer(hash)}`);
  return receipt;
}

async function reserveInfo(token) {
  const reserve = await publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "getReserveData",
    args: [token],
  });
  const cfg = decodeConfig(reserve.configuration);
  const symbol = await publicClient
    .readContract({ address: token, abi: erc20Abi, functionName: "symbol" })
    .catch(() => "?");
  const hasDebt = reserve.variableDebtTokenAddress.toLowerCase() !== ZERO;
  const [supplied, debt, cash] = await Promise.all([
    publicClient.readContract({ address: reserve.aTokenAddress, abi: marketAbi, functionName: "totalSupply" }),
    hasDebt
      ? publicClient.readContract({ address: reserve.variableDebtTokenAddress, abi: marketAbi, functionName: "totalSupply" })
      : Promise.resolve(0n),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [reserve.aTokenAddress] }),
  ]);
  const total = cash + debt;
  const util = total > 0n ? Number((debt * 10_000n) / total) / 100 : 0;
  const strategy =
    reserve.interestRateStrategyAddress.toLowerCase() !== ZERO
      ? await Promise.all([
          publicClient
            .readContract({ address: reserve.interestRateStrategyAddress, abi: strategyAbi, functionName: "baseVariableBorrowRate" })
            .catch(() => 0n),
          publicClient
            .readContract({ address: reserve.interestRateStrategyAddress, abi: strategyAbi, functionName: "variableRateSlope1" })
            .catch(() => 0n),
          publicClient
            .readContract({ address: reserve.interestRateStrategyAddress, abi: strategyAbi, functionName: "variableRateSlope2" })
            .catch(() => 0n),
          publicClient
            .readContract({ address: reserve.interestRateStrategyAddress, abi: strategyAbi, functionName: "optimalUtilization" })
            .catch(() => 0n),
        ])
      : [0n, 0n, 0n, 0n];
  return { symbol, reserve, cfg, supplied, debt, cash, total, util, strategy };
}

async function status() {
  let usdcPrice = null;
  let nvdaPrice = null;
  try {
    usdcPrice = await publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [usdc] });
  } catch {
    usdcPrice = null;
  }
  if (nvda) {
    try {
      nvdaPrice = await publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [nvda] });
    } catch {
      nvdaPrice = null;
    }
  }
  console.log(`oracle USDC price: ${usdcPrice === null ? "unset" : `${Number(usdcPrice) / 1e8} (${usdcPrice})`}`);
  if (nvda) console.log(`oracle NVDA price: ${nvdaPrice === null ? "unset" : `${Number(nvdaPrice) / 1e8} (${nvdaPrice})`}`);

  for (const [symbol, token] of [
    ["USDC", usdc],
    ["NVDA", nvda],
  ]) {
    if (!token) continue;
    let info;
    try {
      info = await reserveInfo(token);
    } catch {
      console.log(`${symbol}: reserve not configured on this pool`);
      continue;
    }
    const { reserve, cfg } = info;
    const [walletBalance, aTokenBalance, debtBalance] = await Promise.all([
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      publicClient.readContract({ address: reserve.aTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      reserve.variableDebtTokenAddress.toLowerCase() !== ZERO
        ? publicClient.readContract({
            address: reserve.variableDebtTokenAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account.address],
          })
        : Promise.resolve(0n),
    ]);
    const d = cfg.decimals;
    console.log(`\n${symbol}`);
    console.log(`  supplied ${formatUnits(info.supplied, d)} | borrowed ${formatUnits(info.debt, d)} | available ${formatUnits(info.cash, d)}`);
    console.log(`  utilization ${info.util.toFixed(2)}% | supply APY ${rayPct(reserve.currentLiquidityRate)} | borrow APY ${rayPct(reserve.currentVariableBorrowRate)}`);
    console.log(`  LTV ${bps(cfg.ltv)} | threshold ${bps(cfg.threshold)} | bonus ${bps(cfg.bonus)} | reserve factor ${bps(cfg.reserveFactor)}`);
    console.log(
      `  rate model base ${rayPct(info.strategy[0])} | slope1 ${rayPct(info.strategy[1])} | slope2 ${rayPct(info.strategy[2])} | optimal ${rayPct(info.strategy[3])}`,
    );
    console.log(
      `  wallet ${formatUnits(walletBalance, d)} | aToken ${formatUnits(aTokenBalance, d)} | debt ${formatUnits(debtBalance, d)} | liquidityIndex ${Number(reserve.liquidityIndex) / 1e27}`,
    );
  }

  const [collateral, debt, available, threshold, ltv, hf] = await publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "getUserAccountData",
    args: [account.address],
  });
  console.log(
    `\naccount: collateral $${Number(collateral) / 1e8} | debt $${Number(debt) / 1e8} | available $${Number(available) / 1e8} | ` +
      `threshold ${bps(threshold)} | LTV ${bps(ltv)} | HF ${hf > 10n ** 30n ? "∞" : (Number(hf) / 1e18).toFixed(3)}`,
  );
}

async function setPrices() {
  const usdcPrice = BigInt(value("--usdc-price", process.env.USDC_PEGGED_PRICE || "100000000"));
  console.log(`setting peg: USDC=${usdcPrice} (USD, 8d)`);
  await send(
    walletClient.writeContract({ address: oracle, abi: oracleAbi, functionName: "setAssetPrice", args: [usdc, usdcPrice] }),
    "setAssetPrice(USDC)",
  );
  if (nvda) {
    const nvdaPrice = BigInt(value("--nvda-price", process.env.NVDA_PEGGED_PRICE || "20000000000"));
    await send(
      walletClient.writeContract({ address: oracle, abi: oracleAbi, functionName: "setAssetPrice", args: [nvda, nvdaPrice] }),
      "setAssetPrice(NVDA)",
    );
  }
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

async function borrow(amount) {
  await send(
    walletClient.writeContract({
      address: pool,
      abi: poolAbi,
      functionName: "borrow",
      args: [usdc, amount, 2, 0, account.address],
    }),
    `borrow(USDC, ${formatUnits(amount, 6)})`,
  );
}

async function repay(amount) {
  const allowance = await publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, pool],
  });
  if (allowance < amount) {
    await send(
      walletClient.writeContract({ address: usdc, abi: erc20Abi, functionName: "approve", args: [pool, amount] }),
      "approve(USDC)",
    );
  }
  await send(
    walletClient.writeContract({
      address: pool,
      abi: poolAbi,
      functionName: "repay",
      args: [usdc, amount, 2, account.address],
    }),
    `repay(USDC, ${formatUnits(amount, 6)})`,
  );
}

async function withdraw(amount) {
  await send(
    walletClient.writeContract({
      address: pool,
      abi: poolAbi,
      functionName: "withdraw",
      args: [usdc, amount, account.address],
    }),
    `withdraw(USDC, ${formatUnits(amount, 6)})`,
  );
}

async function updateState() {
  for (const token of [usdc, nvda].filter(Boolean)) {
    try {
      await send(
        walletClient.writeContract({ address: pool, abi: poolAbi, functionName: "updateState", args: [token] }),
        `updateState(${token === usdc ? "USDC" : "NVDA"})`,
      );
    } catch (error) {
      console.log(`updateState skipped for ${token}: ${error.shortMessage || error.message}`);
    }
  }
}

async function initNvda() {
  if (!nvda) throw new Error("NVDA_ADDRESS (or MOCK_NVDA) must be set in .env");
  const price = BigInt(value("--nvda-price", process.env.NVDA_PEGGED_PRICE || "20000000000"));
  await send(
    walletClient.writeContract({ address: oracle, abi: oracleAbi, functionName: "setAssetPrice", args: [nvda, price] }),
    `setAssetPrice(NVDA, ${price})`,
  );
  const usdcReserve = await reserveInfo(usdc);
  await send(
    walletClient.writeContract({
      address: configurator,
      abi: configuratorAbi,
      functionName: "initReserve",
      args: [nvda, 18, "Aave Arc NVDA", "aNVDA", usdcReserve.reserve.interestRateStrategyAddress],
    }),
    "initReserve(NVDA)",
  );
  await send(
    walletClient.writeContract({
      address: configurator,
      abi: configuratorAbi,
      functionName: "configureReserveAsCollateral",
      args: [nvda, 7500, 8000, 10500],
    }),
    "configureReserveAsCollateral(NVDA)",
  );
  await send(
    walletClient.writeContract({
      address: configurator,
      abi: configuratorAbi,
      functionName: "enableBorrowingOnReserve",
      args: [nvda, true],
    }),
    "enableBorrowingOnReserve(NVDA)",
  );
  await send(
    walletClient.writeContract({
      address: configurator,
      abi: configuratorAbi,
      functionName: "setReserveFactor",
      args: [nvda, 1000],
    }),
    "setReserveFactor(NVDA)",
  );
}

async function mintTestToken(token, symbol, amount) {
  if (!token) throw new Error(`${symbol} token not configured`);
  await send(
    walletClient.writeContract({ address: token, abi: mintAbi, functionName: "mint", args: [account.address, amount] }),
    `mint(${symbol}, ${amount})`,
  );
}

async function depositNvda(amount) {
  if (!nvda) throw new Error("NVDA_ADDRESS (or MOCK_NVDA) must be set in .env");
  await depositOne(nvda, "NVDA", amount);
}

async function borrowNvda(amount) {
  if (!nvda) throw new Error("NVDA_ADDRESS (or MOCK_NVDA) must be set in .env");
  await send(
    walletClient.writeContract({
      address: pool,
      abi: poolAbi,
      functionName: "borrow",
      args: [nvda, amount, 2, 0, account.address],
    }),
    `borrow(NVDA, ${formatUnits(amount, 18)})`,
  );
}

async function setStrategy() {
  const artifactPath = "out/DefaultReserveInterestRateStrategy.sol/DefaultReserveInterestRateStrategy.json";
  if (!fs.existsSync(artifactPath)) throw new Error(`missing ${artifactPath}; run \`forge build\` first`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const base = toRay(value("--base", "0"));
  const slope1 = toRay(value("--slope1", "9"));
  const slope2 = toRay(value("--slope2", "60"));
  const optimal = toRay(value("--optimal", "80"));
  console.log(`deploying rate strategy: base ${rayPct(base)} | slope1 ${rayPct(slope1)} | slope2 ${rayPct(slope2)} | optimal ${rayPct(optimal)}`);
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [base, slope1, slope2, optimal],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`strategy deploy failed: ${hash}`);
  console.log(`strategy: ${receipt.contractAddress}`);
  console.log(`  ${explorer(hash)}`);
  await send(
    walletClient.writeContract({
      address: configurator,
      abi: configuratorAbi,
      functionName: "setReserveInterestRateStrategyAddress",
      args: [usdc, receipt.contractAddress],
    }),
    "setReserveInterestRateStrategyAddress(USDC)",
  );
}

async function seed() {
  const usdcAmount = BigInt(value("--usdc-amount", "10000000"));
  console.log(`seeding Aave: ${formatUnits(usdcAmount, 6)} USDC`);
  await depositOne(usdc, "USDC", usdcAmount);
  if (nvda) {
    const nvdaAmount = BigInt(value("--nvda-amount", "1000000000000000000"));
    await depositOne(nvda, "NVDA", nvdaAmount);
  }
}

const doSetPrice = has("--set-price");
const doSeed = has("--seed");
const doDeposit = has("--deposit");
const doBorrow = has("--borrow");
const doRepay = has("--repay");
const doWithdraw = has("--withdraw");
const doUpdate = has("--update");
const doSetStrategy = has("--set-strategy");
const doInitNvda = has("--init-nvda");
const doMintNvda = has("--mint-nvda");
const doDepositNvda = has("--deposit-nvda");
const doBorrowNvda = has("--borrow-nvda");
const doStatus =
  has("--status") ||
  (!doSetPrice &&
    !doSeed &&
    !doDeposit &&
    !doBorrow &&
    !doRepay &&
    !doWithdraw &&
    !doUpdate &&
    !doSetStrategy &&
    !doInitNvda &&
    !doMintNvda &&
    !doDepositNvda &&
    !doBorrowNvda);

if (doSetPrice) await setPrices();
if (doSetStrategy) await setStrategy();
if (doInitNvda) await initNvda();
if (doMintNvda) await mintTestToken(nvda, "NVDA", BigInt(value("--mint-nvda", "0")));
if (doSeed) await seed();
if (doDeposit) await depositOne(usdc, "USDC", BigInt(value("--deposit", "0")));
if (doBorrow) await borrow(BigInt(value("--borrow", "0")));
if (doRepay) await repay(BigInt(value("--repay", "0")));
if (doWithdraw) await withdraw(BigInt(value("--withdraw", "0")));
if (doDepositNvda) await depositNvda(BigInt(value("--deposit-nvda", "0")));
if (doBorrowNvda) await borrowNvda(BigInt(value("--borrow-nvda", "0")));
if (doUpdate) await updateState();
if (doStatus) await status();
