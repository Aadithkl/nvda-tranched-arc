import {
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  WebAuthnMode,
} from "@circle-fin/modular-wallets-core";
import { createPublicClient, encodeFunctionData, parseUnits, type Address } from "viem";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import { ADDRESSES, CLIENT_KEY, CLIENT_URL, USDC_IS_TOKEN0, USDC_NVDA_KEY, arcTestnet, erc20Abi, routerAbi } from "./config";

export type Wallet = {
  address: Address;
  client: ReturnType<typeof createPublicClient>;
  bundlerClient: ReturnType<typeof createBundlerClient>;
  sendUserOperation: (calls: { to: Address; data: `0x${string}` }[]) => Promise<`0x${string}`>;
};

export async function connectPasskeyWallet(username: string, mode: "register" | "login"): Promise<Wallet> {
  if (!CLIENT_KEY) throw new Error("VITE_CLIENT_KEY is not set (Circle Console client key)");

  const passkeyTransport = toPasskeyTransport(CLIENT_URL, CLIENT_KEY);
  const credential = await toWebAuthnCredential({
    transport: passkeyTransport,
    mode: mode === "register" ? WebAuthnMode.Register : WebAuthnMode.Login,
    username,
  });

  const modularTransport = toModularTransport(`${CLIENT_URL}/arcTestnet`, CLIENT_KEY);
  const client = createPublicClient({ chain: arcTestnet, transport: modularTransport });
  const smartAccount = await toCircleSmartAccount({
    client,
    owner: toWebAuthnAccount({ credential }),
  });
  const bundlerClient = createBundlerClient({
    account: smartAccount,
    chain: arcTestnet,
    transport: modularTransport,
  });

  return {
    address: smartAccount.address as Address,
    client: client as unknown as ReturnType<typeof createPublicClient>,
    bundlerClient: bundlerClient as unknown as ReturnType<typeof createBundlerClient>,
    sendUserOperation: async (calls) => {
      // Gasless: Circle's testnet Gas Station policy sponsors the user operation.
      const hash = await (bundlerClient as any).sendUserOperation({ calls, paymaster: true });
      return hash as `0x${string}`;
    },
  };
}

export function buildApproveAndSwapCalls(address: Address, amountUsdc = "1"): { to: Address; data: `0x${string}` }[] {
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [ADDRESSES.demoRouter, 2n ** 256n - 1n],
  });
  const swapData = encodeFunctionData({
    abi: routerAbi,
    functionName: "swapExactIn",
    args: [USDC_NVDA_KEY, USDC_IS_TOKEN0, parseUnits(amountUsdc, 6), 0n, address, "0x"],
  });
  return [
    { to: ADDRESSES.usdc, data: approveData },
    { to: ADDRESSES.demoRouter, data: swapData },
  ];
}

export async function readBalances(wallet: Wallet): Promise<{ usdc: bigint; nvda: bigint }> {
  const [usdc, nvda] = await Promise.all([
    wallet.client.readContract({ address: ADDRESSES.usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] }),
    wallet.client.readContract({ address: ADDRESSES.nvda, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] }),
  ]);
  return { usdc: usdc as bigint, nvda: nvda as bigint };
}

export function formatUsdc(amount: bigint): string {
  return (Number(amount) / 1e6).toFixed(4);
}

export function formatNvda(amount: bigint): string {
  return (Number(amount) / 1e18).toFixed(6);
}
