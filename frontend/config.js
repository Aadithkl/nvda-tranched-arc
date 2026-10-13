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
  const d = {};
  for (const [k] of DEPLOYMENT_FIELDS) d[k] = "";
  return d;
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
