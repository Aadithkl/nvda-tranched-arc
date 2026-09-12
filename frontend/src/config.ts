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
  usdc: "0x3600000000000000000000000000000000000000",
  nvda: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  demoRouter: "0xC76fd7Ee062C5E498a0E2be6CcB7c2aD2dF0d062",
  poolManager: "0xFc4146c0de93B518Ce60158e2eD0943697c3Ae67",
} as const;

// Real USDC/EURC FX pool (fee 0.01%, tickSpacing 1, no hook)
export const USDC_EURC_KEY = {
  currency0: ADDRESSES.usdc,
  currency1: ADDRESSES.nvda,
  fee: 100,
  tickSpacing: 1,
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
