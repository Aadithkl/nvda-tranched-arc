import fs from "node:fs";
import { createPublicClient, defineChain, encodeAbiParameters, http, keccak256, parseAbi } from "viem";

function loadEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
  }
}

loadEnv();

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

const contracts = {
  usdc: process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000",
  nvda: process.env.NVDA_ADDRESS || null,
  poolManager: process.env.V4_POOL_MANAGER || "0xFc4146c0de93B518Ce60158e2eD0943697c3Ae67",
  demoRouter: process.env.DEMO_ROUTER || "0xC76fd7Ee062C5E498a0E2be6CcB7c2aD2dF0d062",
  positionManager: process.env.POSITION_MANAGER || "0x7Cdfa5f9369c3869c63B0fF0Ca89165Ae2B2b111",
  positionDescriptor: process.env.POSITION_DESCRIPTOR || "0x449d1311782EC031087199d497bF05A35fCe7a4f",
  stateView: process.env.STATE_VIEW || "0xb60F573748341F202818B09730d59333392b8CcC",
  v4Quoter: process.env.V4_QUOTER || "0x8f9ba259d70aF45c26Ef56A713Fb6F0159C4526B",
  reservesLens: process.env.RESERVES_LENS || "0x8D98aa45020c81F4751271B70cecc6399659bCef",
  testWeth9: process.env.TEST_WETH9 || process.env.MOCK_WETH9 || "0x08Ac921E786a5e19eC5D053E4c4eabe3BE042f90",
  mUsdc: process.env.TEST_USDC || process.env.MOCK_USDC || "0x071E67900B728370969eFF988085CF3D84195E31",
  mNvda: process.env.TEST_NVDA || process.env.MOCK_NVDA || "0x308F5c32fF62c24DA5F66f4F6d40d698B8d37BE9",
  nvdAPriceOracle: process.env.ORACLE_ADDRESS || "0x2D58dE768ABff2da0e4a00BE92f63DFB6CE0738A",
  smokeHook: process.env.SMOKE_HOOK || "0x3Cee7340818FD498e54D44DA2E634d02a72800C0",
  lendingAddressesProvider: process.env.LENDING_PROVIDER || "0xd70165E2eC57c8367f6D93eB8F576978d3b75529",
  lendingPool: process.env.LENDING_POOL || "0x75E6E7711a87dbC53D613806bb961bc1Bb01e0c8",
  lendingConfigurator: process.env.LENDING_CONFIGURATOR || "0x43169D2DaaC35E90ec4487E7f156A4958D20EFBe",
  peggedPriceOracle: process.env.LENDING_ORACLE || "0x6DC2A77B42B4049f96593b5Aa979227580aA510b",
  aUsdc: process.env.A_USDC || "0x7d38DBec34bbe287181328E9f5Bd66A199E80eA1",
  dUsdc: process.env.D_USDC || "0x2C42c727A7cE9B0f3FC5cbad473228E948ee8ee6",
  aNvda: process.env.A_NVDA || null,
  dNvda: process.env.D_NVDA || null,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  create2Deployer: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  demoSeller: process.env.DEMO_SELLER || "0x25E7D4287eCDCFA04BF59aBEd594e51dc3DabaF3",
};

// Tranche stack addresses are env-sourced so redeploys only touch .env, never code.
// Null means "not deployed yet"; scripts and the frontend read the manifest, not constants.
function previousStack() {
  try {
    return JSON.parse(fs.readFileSync("deployments/arc-testnet.json", "utf8")).stack ?? {};
  } catch {
    return {};
  }
}

const priorStack = previousStack();
const stack = {
  status: process.env.STACK_STATUS || "test-only — superseded by v3 redeploy",
  ...priorStack,
  hook: process.env.TRANCHE_HOOK || process.env.AGENT_HOOK || priorStack.hook || null,
  pipe: process.env.PIPE_ADDRESS || priorStack.pipe || null,
  shareToken: process.env.TRANCHE_SHARE || priorStack.shareToken || null,
  accountant: process.env.TRANCHE_ACCOUNTANT || priorStack.accountant || null,
  seniorVault: process.env.TRANCHE_SENIOR || priorStack.seniorVault || null,
  juniorVault: process.env.TRANCHE_JUNIOR || priorStack.juniorVault || null,
  poolId: process.env.TRANCHE_POOL_ID || priorStack.poolId || null,
  keeper: process.env.AGENT_KEEPER || priorStack.keeper || null,
  controller: process.env.HOOK_DEMO_CONTROLLER || priorStack.controller || null,
  agent: process.env.HOOK_DEMO_AGENT || priorStack.agent || null,
};

const zero = "0x0000000000000000000000000000000000000000";

function poolId(key) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

function sortedKey(a, b, fee, tickSpacing, hooks) {
  const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return { currency0, currency1, fee, tickSpacing, hooks };
}

const demoPoolKey = sortedKey(contracts.mUsdc, contracts.mNvda, 3000, 60, zero);
const nvdaPoolKey = contracts.nvda
  ? sortedKey(
      contracts.usdc,
      contracts.nvda,
      Number(process.env.NVDA_POOL_FEE || 3000),
      Number(process.env.NVDA_POOL_TICK_SPACING || 60),
      zero
    )
  : null;
const smokePoolKey = sortedKey(contracts.mUsdc, contracts.mNvda, 3000, 60, contracts.smokeHook);

const oracleAbi = parseAbi([
  "function getPrice() view returns ((int192 mid, int192 bid, int192 ask, uint32 marketStatus, uint8 session, uint32 sourceTimestamp, uint256 updatedAt, bytes32 paymentRef, bool valid))",
]);
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

const client = createPublicClient({ chain: arcTestnet, transport: http(arcTestnet.rpcUrls.default.http[0]) });

async function poolState(key) {
  const id = poolId(key);
  try {
    const [slot0, liquidity] = await Promise.all([
      client.readContract({ address: contracts.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] }),
      client.readContract({ address: contracts.stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [id] }),
    ]);
    return {
      poolId: id,
      key,
      sqrtPriceX96: slot0[0].toString(),
      tick: Number(slot0[1]),
      protocolFee: Number(slot0[2]),
      lpFee: Number(slot0[3]),
      liquidity: liquidity.toString(),
    };
  } catch {
    return { poolId: id, key, error: "uninitialized or unreadable" };
  }
}

async function oracleState() {
  try {
    const price = await client.readContract({
      address: contracts.nvdAPriceOracle,
      abi: oracleAbi,
      functionName: "getPrice",
    });
    const p = price;
    return {
      mid: p.mid.toString(),
      bid: p.bid.toString(),
      ask: p.ask.toString(),
      marketStatus: Number(p.marketStatus),
      session: Number(p.session),
      sourceTimestamp: Number(p.sourceTimestamp),
      updatedAt: Number(p.updatedAt),
      paymentRef: p.paymentRef,
      valid: p.valid,
    };
  } catch (error) {
    return { error: error.message };
  }
}

const ABI_CONTRACTS = [
  "NVDAPriceOracle",
  "DemoRouter",
  "PoolManager",
  "PositionManager",
  "PositionDescriptor",
  "StateView",
  "V4Quoter",
  "ReservesLens",
  "TestToken",
  "TestWETH9",
  "SmokeHook",
  "LendingPool",
  "LendingPoolConfigurator",
  "LendingPoolAddressesProvider",
  "PeggedPriceOracle",
  "AToken",
  "VariableDebtToken",
  "DefaultReserveInterestRateStrategy",
  "TrancheJITHook",
  "TranchePipeModule",
  "HookShareToken",
  "SeniorVault",
  "JuniorVault",
  "TrancheAccountant",
  "StrategyController",
  "StrategyAgent",
];

fs.mkdirSync("docs/abis", { recursive: true });
const exported = [];
for (const name of ABI_CONTRACTS) {
  let artifact = `out/${name}.sol/${name}.json`;
  if (!fs.existsSync(artifact)) {
    // Contracts compiled under multiple solc versions get a `<name>.<version>.json` artifact.
    const dir = `out/${name}.sol`;
    const versioned = fs.existsSync(dir)
      ? fs.readdirSync(dir).find((file) => file.startsWith(`${name}.`) && file.endsWith(".json"))
      : null;
    if (versioned) artifact = `${dir}/${versioned}`;
  }
  if (!fs.existsSync(artifact)) {
    console.warn(`missing artifact for ${name}; run \`forge build\` first`);
    continue;
  }
  const json = JSON.parse(fs.readFileSync(artifact, "utf8"));
  fs.writeFileSync(`docs/abis/${name}.json`, `${JSON.stringify(json.abi, null, 2)}\n`);
  exported.push(name);
}

const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];
fs.writeFileSync("docs/abis/ERC20.json", `${JSON.stringify(erc20Abi, null, 2)}\n`);
exported.push("ERC20");

const manifest = {
  generatedAt: new Date().toISOString().slice(0, 10),
  network: {
    name: "Arc Testnet",
    chainId: 5042002,
    caip2: "eip155:5042002",
    rpc: arcTestnet.rpcUrls.default.http[0],
    explorer: "https://testnet.arcscan.app",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    usdcErc20Decimals: 6,
    note: "Native USDC has 18 decimals (gas); the ERC-20 interface at 0x3600…0000 uses 6 decimals and shares the same balance.",
  },
  contracts,
  stack,
  tokens: {
    USDC: { address: contracts.usdc, decimals: 6 },
    ...(contracts.nvda ? { NVDA: { address: contracts.nvda, decimals: 18 } } : {}),
    mUSDC: { address: contracts.mUsdc, decimals: 6 },
    mNVDA: { address: contracts.mNvda, decimals: 18 },
    testWETH9: { address: contracts.testWeth9, decimals: 18 },
  },
  pools: {
    usdcNvda: nvdaPoolKey
      ? { ...(await poolState(nvdaPoolKey)), note: "USDC/NVDA pool (NVDA_POOL_FEE / NVDA_POOL_TICK_SPACING, no hook)" }
      : null,
    demoNvdaUsdc: { ...(await poolState(demoPoolKey)), note: "demo pool (test tokens, no hook)" },
    smokeHookPool: { ...(await poolState(smokePoolKey)), note: "hook callback proof pool (test-only hook)" },
  },
  oracle: {
    address: contracts.nvdAPriceOracle,
    decimals: 8,
    maxStalenessSeconds: 300,
    writer: process.env.DEPLOYER_ADDRESS || null,
    description: "NVDA/USD (x402 push)",
    state: await oracleState(),
  },
  lending: {
    addressesProvider: contracts.lendingAddressesProvider,
    pool: contracts.lendingPool,
    configurator: contracts.lendingConfigurator,
    priceOracle: contracts.peggedPriceOracle,
    model: "Aave V2 semi-fork (independent implementation) — supply/withdraw, variable borrow/repay, no liquidations",
    markets: [
      { symbol: "USDC", underlying: contracts.usdc, decimals: 6, aToken: contracts.aUsdc, variableDebtToken: contracts.dUsdc, peggedPriceUsd8: 100000000 },
      { symbol: "NVDA", underlying: contracts.nvda ?? contracts.mNvda, decimals: 18, aToken: contracts.aNvda, variableDebtToken: contracts.dNvda, peggedPriceUsd8: Number(process.env.NVDA_PEGGED_PRICE || 20000000000) },
    ],
    note: "Rest state for the tranche hook; see docs/LENDING.md",
  },
  x402: {
    gatewayWallet: contracts.gatewayWallet,
    gatewayMinter: contracts.gatewayMinter,
    gatewayDomain: 26,
    testnetFacilitator: "https://gateway-api-testnet.circle.com",
    demoSeller: contracts.demoSeller,
    note: "Keeper: scripts/x402-price.mjs --gateway --push; seller: scripts/x402-seller.mjs",
  },
  subgraph: {
    network: "arc-testnet",
    url: process.env.GRAPH_URL || null,
    directory: "subgraph/",
    entities: [
      "OracleState",
      "PriceUpdate",
      "Pool",
      "PoolSwap",
      "HookState",
      "VaultState",
      "VaultFlow",
      "AccountantReport",
      "Rebalance",
      "RedemptionFulfilment",
      "Quote",
      "JitDeployment",
      "JitRemoval",
      "ShareFlow",
      "AgentAction",
    ],
    note: "Live as Graph Studio subgraph 'tranch-stock' (query version/latest). Tranche entities fill in once the indexer passes the v2 stack deploy block; see docs/GRAPH.md",
  },
  abis: exported.map((name) => `docs/abis/${name}.json`),
};

fs.mkdirSync("deployments", { recursive: true });
fs.writeFileSync("deployments/arc-testnet.json", `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`exported ABIs: ${exported.join(", ")}`);
console.log("manifest: deployments/arc-testnet.json");
