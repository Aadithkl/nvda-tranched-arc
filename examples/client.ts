import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "./arc";

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(arcTestnet.rpcUrls.default.http[0]),
});

export function walletFromKey(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });
  return { account, wallet };
}
