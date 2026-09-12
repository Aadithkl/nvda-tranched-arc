import { createPublicClient, defineChain, formatUnits, http, parseAbi, type Abi, type Address } from "viem";
import manifestJson from "../../deployments/arc-testnet.json";

import erc20Json from "../../docs/abis/ERC20.json";
import oracleJson from "../../docs/abis/NVDAPriceOracle.json";
import hookJson from "../../docs/abis/TrancheJITHook.json";
import pipeJson from "../../docs/abis/TranchePipeModule.json";
import accountantJson from "../../docs/abis/TrancheAccountant.json";
import seniorVaultJson from "../../docs/abis/SeniorVault.json";
import juniorVaultJson from "../../docs/abis/JuniorVault.json";
import routerJson from "../../docs/abis/DemoRouter.json";
import stateViewJson from "../../docs/abis/StateView.json";
import quoterJson from "../../docs/abis/V4Quoter.json";
import controllerJson from "../../docs/abis/StrategyController.json";

export type Manifest = typeof manifestJson;

export const manifest = manifestJson;
export const chain = defineChain({
  id: manifest.network.chainId,
  name: manifest.network.name,
  nativeCurrency: manifest.network.nativeCurrency,
  rpcUrls: { default: { http: [manifest.network.rpc] } },
  blockExplorers: { default: { name: "ArcScan", url: manifest.network.explorer } },
  testnet: true,
});

export const publicClient = createPublicClient({ chain, transport: http(manifest.network.rpc) });

export const abis = {
  erc20: erc20Json as Abi,
  oracle: oracleJson as Abi,
  hook: hookJson as Abi,
  pipe: pipeJson as Abi,
  accountant: accountantJson as Abi,
  seniorVault: seniorVaultJson as Abi,
  juniorVault: juniorVaultJson as Abi,
  router: routerJson as Abi,
  stateView: stateViewJson as Abi,
  quoter: quoterJson as Abi,
  controller: controllerJson as Abi,
} as const;

export const testTokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function symbol() view returns (string)",
]);

export const ADDR = {
  usdc: manifest.contracts.usdc as Address,
  equity: (manifest.contracts.nvda ?? manifest.contracts.mNvda) as Address | null,
  oracle: manifest.contracts.nvdAPriceOracle as Address,
  poolManager: manifest.contracts.poolManager as Address,
  demoRouter: manifest.contracts.demoRouter as Address,
  stateView: manifest.contracts.stateView as Address,
  v4Quoter: manifest.contracts.v4Quoter as Address,
  hook: manifest.stack.hook as Address | null,
  pipe: manifest.stack.pipe as Address | null,
  accountant: manifest.stack.accountant as Address | null,
  seniorVault: manifest.stack.seniorVault as Address | null,
  juniorVault: manifest.stack.juniorVault as Address | null,
  shareToken: manifest.stack.shareToken as Address | null,
  controller: manifest.stack.controller as Address | null,
} as const;

export type PoolInfo = {
  poolId: `0x${string}`;
  key: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  };
  sqrtPriceX96?: string;
  tick?: number;
  lpFee?: number;
  liquidity?: string;
  note?: string;
};

export const usdcPool = manifest.pools.usdcNvda as unknown as PoolInfo | null;

export const CLIENT_URL = import.meta.env.VITE_CLIENT_URL ?? "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";
export const CLIENT_KEY = import.meta.env.VITE_CLIENT_KEY ?? "";

export const MARKET_STATUS: Record<number, string> = {
  1: "pre-market",
  2: "regular",
  3: "post-market",
  4: "overnight",
  5: "closed",
};

export const QUOTE_STATE = ["rest", "degraded", "active"] as const;

export const explorerTx = (hash: string) => `${manifest.network.explorer}/tx/${hash}`;
export const explorerAddr = (addr: string) => `${manifest.network.explorer}/address/${addr}`;

export function shortAddr(addr: string | null | undefined): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function fmtAmount(value: bigint | undefined | null, decimals: number, maxFrac = 4): string {
  if (value === undefined || value === null) return "—";
  const raw = formatUnits(value, decimals);
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

export const fmtUsdc = (v?: bigint | null, frac = 2) => fmtAmount(v, 6, frac);
export const fmtEquity = (v?: bigint | null, frac = 4) => fmtAmount(v, 18, frac);
export const fmtShares = (v?: bigint | null, frac = 4) => fmtAmount(v, 18, frac);
export const fmtPrice8 = (v?: bigint | null, frac = 2) => fmtAmount(v, 8, frac);
