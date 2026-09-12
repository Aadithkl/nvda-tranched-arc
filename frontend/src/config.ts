import { defineChain, parseAbi } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [import.meta.env.VITE_ARC_RPC ?? "https://rpc.testnet.arc.network"] },
  },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

export const ADDRESSES = {
  // Defaults target the live Arc testnet demo pool (MockUSDC / MockNVDA). Point
  // VITE_USDC_ADDRESS / VITE_NVDA_ADDRESS at the v3 USDC/NVDA assets after redeploy.
  usdc: import.meta.env.VITE_USDC_ADDRESS ?? "0x071E67900B728370969eFF988085CF3D84195E31",
  nvda: import.meta.env.VITE_NVDA_ADDRESS ?? "0x308F5c32fF62c24DA5F66f4F6d40d698B8d37BE9",
  demoRouter: "0xC76fd7Ee062C5E498a0E2be6CcB7c2aD2dF0d062",
  poolManager: "0xFc4146c0de93B518Ce60158e2eD0943697c3Ae67",
} as const;

export const USDC_IS_TOKEN0 = ADDRESSES.usdc.toLowerCase() < ADDRESSES.nvda.toLowerCase();

// USDC/NVDA pool (defaults: live demo pool, fee 0.3%, tickSpacing 60, no hook)
export const USDC_NVDA_KEY = {
  currency0: USDC_IS_TOKEN0 ? ADDRESSES.usdc : ADDRESSES.nvda,
  currency1: USDC_IS_TOKEN0 ? ADDRESSES.nvda : ADDRESSES.usdc,
  fee: Number(import.meta.env.VITE_NVDA_POOL_FEE ?? 3000),
  tickSpacing: Number(import.meta.env.VITE_NVDA_POOL_TICK_SPACING ?? 60),
  hooks: "0x0000000000000000000000000000000000000000",
} as const;

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export const routerAbi = parseAbi([
  "function swapExactIn((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint256 amountIn, uint256 minAmountOut, address recipient, bytes hookData) returns (int256)",
]);

export const CLIENT_URL =
  import.meta.env.VITE_CLIENT_URL ?? "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";

export const CLIENT_KEY = import.meta.env.VITE_CLIENT_KEY ?? "";

export const explorerTx = (hash: string) => `https://testnet.arcscan.app/tx/${hash}`;
