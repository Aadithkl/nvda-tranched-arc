// Hardened transaction executor for the keeper.
//
// Every write goes through `simulateContract` first, so a revert is caught before gas is spent,
// and receipts are awaited with a bound timeout. Dry-run keeps the exact same call shape and only
// skips the send, which makes it safe to wire into `index.mjs` behind `KEEPER_DRY_RUN`.
//
// Allowance note: `VaultStrategyAgent.submitApproveStrategy` relays to the vault, and the vault is
// what calls `forceApprove(module, amount)`. The allowance owner is therefore the VAULT (not the
// agent) and the spender is the strategy module.

import { parseAbi } from "viem";

const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const agentAbi = parseAbi([
  "function submitApproveStrategy(address token, uint256 amount)",
  "function controller() view returns (address)",
]);

const controllerAbi = parseAbi(["function strategyModule() view returns (address)"]);

const ZERO_ADDRESS_RE = /^0x0{40}$/i;
// `VaultStrategyController.submitApproveStrategy` rejects amounts above 1e36.
const MAX_APPROVE = 10n ** 36n;

function shortError(error) {
  const text = error?.shortMessage ?? error?.message ?? String(error);
  return text.length <= 240 ? text : `${text.slice(0, 237)}...`;
}

function toBigInt(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${label}: expected a non-negative integer, got ${String(value)}`);
}

/**
 * Create a transaction executor for the keeper.
 *
 * @param {object} args
 * @param {import("viem").PublicClient} args.publicClient
 * @param {import("viem").WalletClient | null} [args.wallet] required unless `dryRun`
 * @param {boolean} [args.dryRun] log instead of sending (default true)
 * @param {ReturnType<typeof import("./config.mjs").loadConfig>} args.config
 * @param {(...args: unknown[]) => void} [args.log]
 * @returns {{ send: Function, approveIfNeeded: Function, readAllowance: Function }}
 */
export function createExecutor({ publicClient, wallet, dryRun = true, config, log } = {}) {
  if (!publicClient) throw new Error("createExecutor: publicClient is required");
  if (!config) throw new Error("createExecutor: config is required");
  if (!dryRun && !wallet) throw new Error("createExecutor: wallet is required unless dryRun");

  const logger =
    typeof log === "function" ? log : (...args) => console.log(new Date().toISOString(), ...args);
  const timeoutMs = config.rpc.timeoutMs;

  /** @type {Promise<string> | undefined} */
  let modulePromise;

  async function resolveModule() {
    if (!modulePromise) {
      modulePromise = (async () => {
        const agent = config.addresses.agent;
        if (!agent) throw new Error("KEEPER_AGENT is not configured");
        const controller = await publicClient.readContract({
          address: agent,
          abi: agentAbi,
          functionName: "controller",
        });
        if (!controller || ZERO_ADDRESS_RE.test(controller)) {
          throw new Error("agent.controller() is the zero address");
        }
        const module = await publicClient.readContract({
          address: controller,
          abi: controllerAbi,
          functionName: "strategyModule",
        });
        if (!module || ZERO_ADDRESS_RE.test(module)) {
          throw new Error("controller.strategyModule() is the zero address");
        }
        return module;
      })().catch((e) => {
        modulePromise = undefined;
        throw e;
      });
    }
    return modulePromise;
  }

  async function readAllowance(token, owner, spender) {
    if (!token) throw new Error("readAllowance: token is required");
    const owner_ = owner || config.addresses.vault;
    if (!owner_) throw new Error("readAllowance: owner is required (KEEPER_VAULT is not configured)");
    const spender_ = spender || (await resolveModule());
    return publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner_, spender_],
    });
  }

  /**
   * Simulate, send, and wait for a receipt.
   * @returns {Promise<`0x${string}` | null>} tx hash, or null in dry-run
   */
  async function send({ address, abi, functionName, args = [], label, value, account } = {}) {
    if (!address) throw new Error(`send: address is required (${functionName ?? "call"})`);
    if (!abi) throw new Error(`send: abi is required (${label ?? functionName ?? address})`);
    if (!functionName) throw new Error(`send: functionName is required (${label ?? address})`);
    const name = label ?? `${functionName} @ ${address}`;

    if (dryRun) {
      logger(`[dry-run] ${name}`);
      return null;
    }
    if (!wallet) throw new Error(`${name}: no wallet configured`);
    const from = account ?? wallet.account;
    if (!from) throw new Error(`${name}: wallet has no account`);

    let request;
    try {
      ({ request } = await publicClient.simulateContract({
        address,
        abi,
        functionName,
        args,
        value,
        account: from,
      }));
    } catch (e) {
      throw new Error(`${name}: simulation failed: ${shortError(e)}`, { cause: e });
    }

    const hash = await wallet.writeContract(request);
    logger(`${name} tx=${hash}`);

    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs });
    } catch (e) {
      if (e?.name === "WaitForTransactionReceiptTimeoutError") {
        throw new Error(`${name}: receipt timeout after ${timeoutMs}ms tx=${hash}`, { cause: e });
      }
      throw new Error(`${name}: receipt failed: ${shortError(e)} tx=${hash}`, { cause: e });
    }

    if (receipt.status !== "success") {
      throw new Error(`${name}: reverted tx=${hash}`);
    }
    return hash;
  }

  /**
   * Approve the strategy module if the vault's allowance is short.
   * @returns {Promise<`0x${string}` | null>} approve tx hash, or null when already approved/dry-run
   */
  async function approveIfNeeded({ token, amount, spender, owner, label } = {}) {
    if (!token) throw new Error("approveIfNeeded: token is required");
    const amount_ = toBigInt(amount, "approveIfNeeded: amount");
    if (amount_ === 0n) return null;
    if (amount_ > MAX_APPROVE) {
      throw new Error(`approveIfNeeded: amount ${amount_} exceeds the controller limit of ${MAX_APPROVE}`);
    }

    const spender_ = spender || (await resolveModule());
    const owner_ = owner || config.addresses.vault;
    if (!owner_) throw new Error("approveIfNeeded: owner is required (KEEPER_VAULT is not configured)");

    const allowance = await readAllowance(token, owner_, spender_);
    if (allowance >= amount_) {
      logger(`allowance ok: ${allowance} >= ${amount_} for ${token}`);
      return null;
    }

    const agent = config.addresses.agent;
    if (!agent) throw new Error("approveIfNeeded: KEEPER_AGENT is not configured");

    return send({
      address: agent,
      abi: agentAbi,
      functionName: "submitApproveStrategy",
      args: [token, amount_],
      label: label ?? `approve ${amount_} for ${token} (spender ${spender_})`,
    });
  }

  return Object.freeze({ send, approveIfNeeded, readAllowance });
}

export default createExecutor;
