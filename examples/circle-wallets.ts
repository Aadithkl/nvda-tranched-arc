import {
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  WebAuthnMode,
} from "@circle-fin/modular-wallets-core";
import { createPublicClient, encodeFunctionData, parseUnits } from "viem";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import { arcTestnet } from "./arc";
import { contracts, erc20Abi, pools, routerAbi } from "./contracts";

const CLIENT_URL = "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";

export async function createPasskeyWallet(clientKey: string, username: string) {
  const passkeyTransport = toPasskeyTransport(CLIENT_URL, clientKey);
  const credential = await toWebAuthnCredential({
    transport: passkeyTransport,
    mode: WebAuthnMode.Register, // Login for returning users
    username,
  });

  const modularTransport = toModularTransport(`${CLIENT_URL}/arcTestnet`, clientKey);
  const client = createPublicClient({ chain: arcTestnet, transport: modularTransport });
  const smartAccount = await toCircleSmartAccount({ client, owner: toWebAuthnAccount({ credential }) });
  const bundlerClient = createBundlerClient({ account: smartAccount, chain: arcTestnet, transport: modularTransport });

  return { smartAccount, bundlerClient };
}

// Gasless batched flow: approve USDC + swap in one sponsored user operation
export async function gaslessSwap(bundlerClient: ReturnType<typeof createBundlerClient>, amountUsdc = "1") {
  const pool = pools.usdcNvda ?? pools.demoNvdaUsdc;
  const tokenIn = [pool.key.currency0, pool.key.currency1].some(
    (currency) => currency.toLowerCase() === contracts.usdc.toLowerCase(),
  )
    ? contracts.usdc
    : contracts.mUsdc;
  const zeroForOne = pool.key.currency0.toLowerCase() === tokenIn.toLowerCase();

  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [contracts.demoRouter as `0x${string}`, 2n ** 256n - 1n],
  });
  const swapData = encodeFunctionData({
    abi: routerAbi,
    functionName: "swapExactIn",
    args: [pool.key, zeroForOne, parseUnits(amountUsdc, 6), 0n, bundlerClient.account.address, "0x"],
  });

  return bundlerClient.sendUserOperation({
    calls: [
      { to: tokenIn as `0x${string}`, data: approveData },
      { to: contracts.demoRouter as `0x${string}`, data: swapData },
    ],
    paymaster: true, // testnet sponsorship is automatic
  });
}
