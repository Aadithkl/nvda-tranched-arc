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
  // Live testnet stack (deployments/robinhood-testnet.json, 2026-10-14) so the
  // console works out of the box. Clear in the UI to start empty.
  return {
    poolManager: "0xe6EC071602Cc9483c518c7Ec746e10BAb555FE00",
    router: "0xFaaf80ac538181DE26EC53Ea1a6cC363Ecf8744c",
    quote: "0x2022D0876132E26f32Df4a3bDdF2cFcB96010B28",
    equity: "0x071E67900B728370969eFF988085CF3D84195E31",
    oracle: "0xF790D17103a81Bd62F54480B991f2Cdb374FCd74",
    hook: "0xa5e5516233b2631B8982D543305c066204a72080",
    vault: "0x30C6e6068EC44Bbe830E68B721dfCB691904325E",
    senior: "0x0ad9A5A86972fF0A22092570d78C2DB411D0aD41",
    junior: "0xD067D3E79aA5A05432734825c12a9C62d9543790",
    accountant: "0xD0EAa0b95b03997E880a87Bc79cB2D576a0269A4",
    entry: "0x94f4F95F6A8cB0aAeB90BeAE09C60C7A0bd60692",
    controller: "0x1Be800E5Ab3196Fd1047d21f0eBc63F4A1E87A58",
    agent: "0x1Aa9a13793A4E5A7c0C057d2e806CA0D491fA4b9",
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
