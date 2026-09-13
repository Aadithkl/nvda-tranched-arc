import { createPublicClient, defineChain, formatUnits, http, parseAbi, type Abi, type Address } from "viem";
import manifestJson from "../../deployments/arc-testnet.json";
import poolsRegistry from "../../agent/pools.json";

import erc20Json from "../../docs/abis/ERC20.json";
import oracleJson from "../../docs/abis/NVDAPriceOracle.json";
import hookJson from "../../docs/abis/TrancheJITHook.json";
import pipeJson from "../../docs/abis/TranchePipeModule.json";
import accountantJson from "../../docs/abis/TrancheAccountant.json";
import controllerJson from "../../docs/abis/StrategyController.json";
import lendingPoolJson from "../../docs/abis/LendingPool.json";
import lendingConfiguratorJson from "../../docs/abis/LendingPoolConfigurator.json";
import rateStrategyJson from "../../docs/abis/DefaultReserveInterestRateStrategy.json";

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
  controller: controllerJson as Abi,
  lendingPool: lendingPoolJson as Abi,
  lendingConfigurator: lendingConfiguratorJson as Abi,
  rateStrategy: rateStrategyJson as Abi,
} as const;

export const testTokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function symbol() view returns (string)",
]);

export const ADDR = {
  usdc: manifest.contracts.usdc as Address,
  equity: (manifest.contracts.nvda ?? manifest.contracts.mNvda) as Address | null,
  oracle: manifest.contracts.nvdAPriceOracle as Address,
  hook: manifest.stack.hook as Address | null,
  pipe: manifest.stack.pipe as Address | null,
  accountant: manifest.stack.accountant as Address | null,
  seniorVault: manifest.stack.seniorVault as Address | null,
  juniorVault: manifest.stack.juniorVault as Address | null,
  shareToken: manifest.stack.shareToken as Address | null,
  controller: manifest.stack.controller as Address | null,
  lendingPool: manifest.contracts.lendingPool as Address,
  lendingConfigurator: manifest.contracts.lendingConfigurator as Address,
  peggedOracle: manifest.contracts.peggedPriceOracle as Address,
} as const;

// Outside market reference: NVDAc pools from the agent's registry, read through The Graph
// gateway (no oracle). This is the outside market price, not our own Arc v4 pool.
export type MarketPool = {
  id: string;
  venue: string;
  subgraph: string;
  schema: string;
  pool: string;
  quote: string;
  feeBps: number;
  priority: string;
  status: string;
};

export const GRAPH_GATEWAY =
  (import.meta.env.VITE_GRAPH_GATEWAY as string | undefined) ?? "https://gateway.thegraph.com/api";
export const GRAPH_API_KEY = (import.meta.env.VITE_GRAPH_API_KEY as string | undefined) ?? "";

// Arc tranche subgraph (hook state, JIT episodes) — the manifest carries the live query URL.
export const ARC_SUBGRAPH_URL = (manifest.subgraph.url as string | undefined) ?? "";

export const marketPools = (poolsRegistry.pools as MarketPool[]).filter(
  (pool) => pool.quote === "USDC" && pool.schema === "v3",
);

// NVDA pools from the agent registry, shown on the Strategy page. Pools whose
// subgraph has not indexed them yet are rendered as "not indexed yet" rather than hidden.
export const strategyPools = poolsRegistry.pools as MarketPool[];

export const graphEndpoint = (subgraph: string): string =>
  `${GRAPH_GATEWAY}/${GRAPH_API_KEY}/subgraphs/id/${(poolsRegistry.subgraphs as Record<string, string>)[subgraph]}`;

const TOKEN_DECIMALS: Record<string, number> = {};
for (const [address, decimals] of [
  [manifest.contracts.usdc, 6],
  [manifest.contracts.mUsdc, 6],
  [manifest.contracts.nvda, 18],
  [manifest.contracts.mNvda, 18],
] as const) {
  if (address) TOKEN_DECIMALS[address.toLowerCase()] = decimals;
}

export function tokenDecimals(address: string): number {
  return TOKEN_DECIMALS[address.toLowerCase()] ?? 18;
}

export const CLIENT_URL = import.meta.env.VITE_CLIENT_URL ?? "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";
export const CLIENT_KEY = import.meta.env.VITE_CLIENT_KEY ?? "";

// Local agent HTTP bridge (`npm run agent:serve`) used by the "Run agent check" button.
export const AGENT_URL = (import.meta.env.VITE_AGENT_URL as string | undefined) ?? "http://127.0.0.1:8787";

export const MARKET_STATUS: Record<number, string> = {
  1: "pre-market",
  2: "open",
  3: "after hours",
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
  if (n !== 0 && Math.abs(n) < 10 ** -maxFrac) return `<${(10 ** -maxFrac).toFixed(maxFrac)}`;
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

export const fmtUsdc = (v?: bigint | null, frac = 2): string => {
  if (v === undefined || v === null) return "—";
  const n = Number(formatUnits(v, 6));
  if (!Number.isFinite(n)) return formatUnits(v, 6);
  return n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });
};

// Compact USD for market stats: $1.24K, $3.5M, $27.5K ...
export const fmtCompactUsd = (value?: number | null, frac = 2): string => {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(frac)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(frac)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(frac)}K`;
  return `$${value.toFixed(frac)}`;
};
export const fmtEquity = (v?: bigint | null, frac = 4) => fmtAmount(v, 18, frac);
export const fmtPrice8 = (v?: bigint | null, frac = 2) => fmtAmount(v, 8, frac);

// Vault shares carry their own decimals (the ERC-7540 vaults use 21); never assume 18.
export const fmtShares = (v?: bigint | null, decimals = 21, maxFrac = 4) => fmtAmount(v, decimals, maxFrac);

// `type(uint256).max` (routinely returned by maxDeposit) means "no limit".
export const isUnlimited = (v?: bigint | null): boolean => v !== undefined && v !== null && v >= 2n ** 255n;
export const fmtLimit = (v?: bigint | null): string => (isUnlimited(v) ? "Unlimited" : `${fmtUsdc(v)} USDC`);

// Rates in the lending pool are ray (1e27) per year; 1e27 = 100%.
export const fmtPctRay = (v?: bigint | null, frac = 2): string =>
  v === undefined || v === null ? "—" : `${(Number(v) / 1e25).toFixed(frac)}%`;

export const fmtBps = (v?: number | null, frac = 1): string =>
  v === undefined || v === null ? "—" : `${(v / 100).toFixed(frac)}%`;
