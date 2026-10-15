// Chain + deployment configuration for the testnet frontend.
// Address fields mirror deployments/robinhood-testnet.json `contracts` + `stack`.
// Overrides persist in localStorage under "rh_static_deployment".

export const CHAIN_ID = 46630;

export const CHAIN = {
  id: CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" },
  },
};

export const RPC_OPTIONS = [
  { label: "Public RPC (verified working)", url: "https://rpc.testnet.chain.robinhood.com" },
  { label: "Public RPC /rpc path (faucet docs)", url: "https://rpc.testnet.chain.robinhood.com/rpc" },
  { label: "PublicNode", url: "https://robinhood-sepolia-rpc.publicnode.com" },
  { label: "Local proxy (npm run robinhood:proxy)", url: "http://127.0.0.1:8546" },
];

export const FAUCET_URL = "https://faucet.testnet.chain.robinhood.com/";
export const EXPLORER_URL = "https://explorer.testnet.chain.robinhood.com";

// [key, label, hint] — order shown in the config bar.
export const DEPLOYMENT_FIELDS = [
  ["poolManager", "PoolManager", "v4 PoolManager (DeployV4Stack)"],
  ["router", "DemoRouter", "demo router / rebalance venue"],
  ["quote", "Quote token (mUSDC)", "6-dec test quote"],
  ["equity", "Equity token (mNVDA)", "18-dec test NVDA"],
  ["oracle", "NVDA oracle", "NVDAPriceOracle (writer pushes prices)"],
  ["hook", "PoolGuardHook", "the book hook"],
  ["vault", "LedgerVault", "combined vault"],
  ["senior", "SeniorVault", "senior tranche"],
  ["junior", "JuniorVault", "junior tranche"],
  ["accountant", "TrancheAccountant", "epoch + entitlement accounting"],
  ["entry", "LedgerEntry7575", "ERC-7575 entry (optional)"],
  ["controller", "VaultStrategyController", "keeper / agent controller (info)"],
  ["agent", "VaultStrategyAgent", "operator relay (info)"],
  ["strategyModule", "StrategyModule", "Morpho/lend module (optional)"],
  ["poolFee", "Book pool fee", "e.g. 3000"],
  ["poolTickSpacing", "Book tick spacing", "e.g. 60"],
];

const LS_KEY = "rh_static_deployment";
const LS_RPC = "rh_static_rpc";

export function defaultDeployment() {
  // Live testnet stack (deployments/robinhood-testnet.json, 2026-10-16 heartbeat
  // build) so the console works out of the box. Clear in the UI to start empty.
  return {
    poolManager: "0xe6EC071602Cc9483c518c7Ec746e10BAb555FE00",
    router: "0xFaaf80ac538181DE26EC53Ea1a6cC363Ecf8744c",
    quote: "0x2022D0876132E26f32Df4a3bDdF2cFcB96010B28",
    equity: "0x071E67900B728370969eFF988085CF3D84195E31",
    oracle: "0xF790D17103a81Bd62F54480B991f2Cdb374FCd74",
    hook: "0xd7897865A68C83784A10617b6141C0aCE25D2080",
    vault: "0x75E6E7711a87dbC53D613806bb961bc1Bb01e0c8",
    senior: "0x7181F02c192367813505EA4E59d7de72Ab88431d",
    junior: "0x2B30281849E0E0f3340ec38042bb62cC15fe6D46",
    accountant: "0x624F06fF6bF69329a8f76FD963Ebf3c6650E312a",
    entry: "0x139682bbC5A8d5f038fd80E924D8bECB4F9Bbf59",
    controller: "0xec43CB615ec2b70Ec87ACe57DAc64FE2177EB212",
    agent: "0x761433a9E19020cdc1802bC9fa368F50dD42B587",
    strategyModule: "",
    poolFee: "3000",
    poolTickSpacing: "60",
  };
}

export function loadDeployment() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...defaultDeployment(), ...JSON.parse(raw) };
  } catch {}
  return defaultDeployment();
}

export function saveDeployment(d) {
  localStorage.setItem(LS_KEY, JSON.stringify(d));
}

export function clearDeployment() {
  localStorage.removeItem(LS_KEY);
}

export function loadRpc() {
  return localStorage.getItem(LS_RPC) || RPC_OPTIONS[0].url;
}

export function saveRpc(url) {
  localStorage.setItem(LS_RPC, url);
}
