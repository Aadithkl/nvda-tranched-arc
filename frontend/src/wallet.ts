import { createPublicClient, createWalletClient, custom, type Address, type Hex } from "viem";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import {
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  WebAuthnMode,
} from "@circle-fin/modular-wallets-core";
import { CLIENT_KEY, CLIENT_URL, chain, publicClient } from "./config";

export type Call = { to: Address; data: Hex; value?: bigint };

export type Session = {
  kind: "injected" | "passkey";
  address: Address;
  sendCalls: (calls: Call[]) => Promise<Hex[]>;
};

export async function connectInjected(): Promise<Session> {
  const ethereum = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!ethereum) throw new Error("No browser wallet found — install MetaMask or use a passkey wallet");

  const walletClient = createWalletClient({ chain, transport: custom(ethereum as never) });
  const [address] = await walletClient.requestAddresses();

  const currentChain = await walletClient.getChainId();
  if (currentChain !== chain.id) {
    try {
      await walletClient.switchChain({ id: chain.id });
    } catch {
      await walletClient.addChain({ chain });
      await walletClient.switchChain({ id: chain.id });
    }
  }

  return {
    kind: "injected",
    address,
    sendCalls: async (calls) => {
      const hashes: Hex[] = [];
      for (const call of calls) {
        const hash = await walletClient.sendTransaction({
          account: address,
          chain,
          to: call.to,
          data: call.data,
          value: call.value,
        });
        hashes.push(hash);
        await publicClient.waitForTransactionReceipt({ hash });
      }
      return hashes;
    },
  };
}

function passkeyError(error: unknown, mode: "register" | "login"): Error {
  const name = (error as { name?: string })?.name ?? "";
  const message = String((error as { message?: string })?.message ?? error);

  if (name === "NotAllowedError" || /timed out|was not allowed/i.test(message)) {
    return new Error(
      mode === "login"
        ? "No passkey found for this site, or the prompt was cancelled — use Create once, or a browser wallet"
        : "Passkey creation was cancelled",
    );
  }
  if (name === "InvalidStateError" || /already (registered|exists)|credential already/i.test(message)) {
    return new Error("A passkey for this username already exists on this device — use Unlock instead");
  }
  if (name === "SecurityError" || /relying party|rp id|different origin/i.test(message)) {
    return new Error(
      "Passkey domain mismatch — set Console → Wallets → Modular Wallets → Passkey to this site's domain",
    );
  }
  if (/entity config/i.test(message)) {
    return new Error(
      "Circle Console setup missing — set Console → Wallets → Modular Wallets → Passkey to this site's domain",
    );
  }
  if (/invalid credentials/i.test(message)) {
    return new Error(
      "This client key isn't allowed for this domain — add the domain to the key under Console → Keys (one key per domain)",
    );
  }
  return error instanceof Error ? error : new Error(message);
}

export async function connectPasskey(username: string, mode: "register" | "login"): Promise<Session> {
  if (!CLIENT_KEY) throw new Error("VITE_CLIENT_KEY is not set (Circle Console client key)");

  const trimmed = username.trim();
  if (mode === "register" && !trimmed) throw new Error("Enter a username to create a passkey wallet");

  try {
    const passkeyTransport = toPasskeyTransport(CLIENT_URL, CLIENT_KEY);
    const credential = await toWebAuthnCredential({
      transport: passkeyTransport,
      mode: mode === "register" ? WebAuthnMode.Register : WebAuthnMode.Login,
      ...(trimmed ? { username: trimmed } : {}),
    });

    const modularTransport = toModularTransport(`${CLIENT_URL}/arcTestnet`, CLIENT_KEY);
    const client = createPublicClient({ chain, transport: modularTransport as never });
    const smartAccount = await toCircleSmartAccount({
      client: client as never,
      owner: toWebAuthnAccount({ credential: credential as never }),
    });
    const bundlerClient = createBundlerClient({
      account: smartAccount as never,
      chain,
      transport: modularTransport as never,
    });

    return {
      kind: "passkey",
      address: smartAccount.address as Address,
      sendCalls: async (calls) => {
        const sendUserOperation = bundlerClient.sendUserOperation as never as (args: unknown) => Promise<Hex>;
        const waitForReceipt = bundlerClient.waitForUserOperationReceipt as never as (args: {
          hash: Hex;
        }) => Promise<{ receipt?: { transactionHash?: Hex } }>;
        const hash = await sendUserOperation({ calls, paymaster: true });
        try {
          const receipt = await waitForReceipt({ hash });
          return [(receipt?.receipt?.transactionHash ?? hash) as Hex];
        } catch {
          return [hash];
        }
      },
    };
  } catch (error) {
    throw passkeyError(error, mode);
  }
}
