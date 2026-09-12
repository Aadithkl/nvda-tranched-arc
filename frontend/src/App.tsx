import { useState } from "react";
import {
  buildApproveAndSwapCalls,
  connectPasskeyWallet,
  formatUsdc,
  readBalances,
  type Wallet,
} from "./circle";
import { explorerTx } from "./config";

export default function App() {
  const [username, setUsername] = useState("");
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [balances, setBalances] = useState<{ usdc: bigint; nvda: bigint } | null>(null);
  const [status, setStatus] = useState("Not connected");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect(mode: "register" | "login") {
    try {
      setBusy(true);
      setStatus(`${mode === "register" ? "Creating" : "Unlocking"} passkey wallet…`);
      const next = await connectPasskeyWallet(username || "tranched-arc-demo", mode);
      setWallet(next);
      setStatus(`Connected: ${next.address}`);
      setBalances(await readBalances(next));
    } catch (error) {
      setStatus(`Error: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshBalances() {
    if (!wallet) return;
    setBalances(await readBalances(wallet));
  }

  async function gaslessSwap() {
    if (!wallet) return;
    try {
      setBusy(true);
      setStatus("Submitting gasless swap (approve + swap in one sponsored user op)…");
      const hash = await wallet.sendUserOperation(buildApproveAndSwapCalls(wallet.address, "1"));
      setTxHash(hash);
      setStatus(`User operation submitted: ${hash}`);
      setTimeout(() => refreshBalances().catch(() => undefined), 4000);
    } catch (error) {
      setStatus(`Swap failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: "ui-monospace, monospace", maxWidth: 760, margin: "40px auto", padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>Tranched Arc — Arc testnet console</h1>
      <p style={{ color: "#666" }}>
        Circle modular wallet (passkey) + Gas Station Paymaster: gasless USDC/EURC swap on the real Arc testnet FX pool.
      </p>

      <section style={{ border: "1px solid #ddd", padding: 16, borderRadius: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 16 }}>1. Passkey wallet</h2>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="passkey username (e.g. your email)"
          style={{ padding: 8, width: 280, marginRight: 8 }}
        />
        <button disabled={busy} onClick={() => connect("register")}>
          Create passkey
        </button>
        <button disabled={busy} onClick={() => connect("login")} style={{ marginLeft: 8 }}>
          Unlock existing
        </button>
        <p>{status}</p>
        {wallet && (
          <p>
            USDC: {balances ? formatUsdc(balances.usdc) : "…"} · EURC: {balances ? formatUsdc(balances.nvda) : "…"}{" "}
            <button onClick={refreshBalances} disabled={busy}>
              refresh
            </button>
          </p>
        )}
      </section>

      <section style={{ border: "1px solid #ddd", padding: 16, borderRadius: 12 }}>
        <h2 style={{ fontSize: 16 }}>2. Gasless swap (Paymaster)</h2>
        <button disabled={!wallet || busy} onClick={gaslessSwap}>
          Swap 1 USDC → EURC (sponsored)
        </button>
        {txHash && (
          <p>
            <a href={explorerTx(txHash)} target="_blank" rel="noreferrer">
              {explorerTx(txHash)}
            </a>
          </p>
        )}
      </section>
    </main>
  );
}
