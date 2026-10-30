import test from "node:test";
import assert from "node:assert/strict";
import { parseAbi } from "viem";
import { createExecutor } from "../executor.mjs";

const TX_HASH = `0x${"ab".repeat(32)}`;
const VAULT = `0x${"11".repeat(20)}`;
const AGENT = `0x${"22".repeat(20)}`;
const TOKEN = `0x${"33".repeat(20)}`;
const SPENDER = `0x${"44".repeat(20)}`;
const OWNER = `0x${"55".repeat(20)}`;

const abi = parseAbi(["function ping()"]);

function makeConfig() {
  return {
    rpc: { timeoutMs: 1000 },
    addresses: { vault: VAULT, agent: AGENT },
  };
}

function makeWallet() {
  /** @type {unknown[]} */
  const writes = [];
  return {
    writes,
    wallet: {
      account: { address: `0x${"66".repeat(20)}` },
      async writeContract(request) {
        writes.push(request);
        return TX_HASH;
      },
    },
  };
}

/**
 * Mock public client. `simulate` can override the simulation result (e.g. to throw).
 * Any non-allowance read throws so accidental module-resolution reads fail loudly.
 */
function makePublicClient({ allowance = 0n, simulate, receipt = { status: "success" } } = {}) {
  const calls = { simulate: [], read: [], wait: [] };
  return {
    calls,
    publicClient: {
      async simulateContract(args) {
        calls.simulate.push(args);
        if (simulate) return simulate(args);
        return { request: { to: args.address, data: "0xdeadbeef", account: args.account } };
      },
      async waitForTransactionReceipt(args) {
        calls.wait.push(args);
        return receipt;
      },
      async readContract(args) {
        calls.read.push(args);
        if (args.functionName === "allowance") return allowance;
        throw new Error(`unexpected readContract: ${args.functionName}`);
      },
      async getGasPrice() {
        return 1_000_000_000n;
      },
    },
  };
}

test("send: simulates, writes, waits for a success receipt", async () => {
  const { publicClient, calls } = makePublicClient();
  const { wallet, writes } = makeWallet();
  const executor = createExecutor({
    publicClient,
    wallet,
    dryRun: false,
    config: makeConfig(),
    log: () => {},
  });

  const hash = await executor.send({ address: VAULT, abi, functionName: "ping", args: [] });

  assert.equal(hash, TX_HASH);
  assert.equal(calls.simulate.length, 1);
  assert.equal(calls.simulate[0].address, VAULT);
  assert.equal(calls.simulate[0].functionName, "ping");
  assert.deepEqual(calls.simulate[0].account, wallet.account);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].to, VAULT);
  assert.equal(calls.wait.length, 1);
  assert.equal(calls.wait[0].hash, TX_HASH);
  assert.equal(calls.wait[0].timeout, 1000);
});

test("send: simulation failure rejects before writeContract", async () => {
  const { publicClient, calls } = makePublicClient({
    simulate: async () => {
      throw new Error("execution reverted: ping");
    },
  });
  const { wallet, writes } = makeWallet();
  const executor = createExecutor({
    publicClient,
    wallet,
    dryRun: false,
    config: makeConfig(),
    log: () => {},
  });

  await assert.rejects(
    executor.send({ address: VAULT, abi, functionName: "ping" }),
    /simulation failed: execution reverted: ping/,
  );
  assert.equal(writes.length, 0);
  assert.equal(calls.wait.length, 0);
});

test("send: reverted receipt rejects", async () => {
  const { publicClient } = makePublicClient({ receipt: { status: "reverted" } });
  const { wallet } = makeWallet();
  const executor = createExecutor({
    publicClient,
    wallet,
    dryRun: false,
    config: makeConfig(),
    log: () => {},
  });

  await assert.rejects(
    executor.send({ address: VAULT, abi, functionName: "ping" }),
    /reverted tx=/,
  );
});

test("send: dry-run returns null and does not simulate", async () => {
  const logs = [];
  const { publicClient, calls } = makePublicClient();
  const executor = createExecutor({
    publicClient,
    dryRun: true,
    config: makeConfig(),
    log: (message) => logs.push(String(message)),
  });

  const hash = await executor.send({ address: VAULT, abi, functionName: "ping" });

  assert.equal(hash, null);
  assert.equal(calls.simulate.length, 0);
  assert.match(logs.join("\n"), /\[dry-run\]/);
});

test("approveIfNeeded: sufficient allowance skips the write", async () => {
  const amount = 500n;
  const { publicClient, calls } = makePublicClient({ allowance: amount });
  const { wallet, writes } = makeWallet();
  const executor = createExecutor({
    publicClient,
    wallet,
    dryRun: false,
    config: makeConfig(),
    log: () => {},
  });

  const result = await executor.approveIfNeeded({
    token: TOKEN,
    amount,
    spender: SPENDER,
    owner: OWNER,
  });

  assert.equal(result, null);
  assert.equal(calls.read.length, 1);
  assert.equal(calls.read[0].functionName, "allowance");
  assert.deepEqual(calls.read[0].args, [OWNER, SPENDER]);
  assert.equal(calls.simulate.length, 0);
  assert.equal(writes.length, 0);
});

test("approveIfNeeded: short allowance submits submitApproveStrategy to the agent", async () => {
  const amount = 1_000n;
  const { publicClient, calls } = makePublicClient({ allowance: 1n });
  const { wallet, writes } = makeWallet();
  const executor = createExecutor({
    publicClient,
    wallet,
    dryRun: false,
    config: makeConfig(),
    log: () => {},
  });

  const hash = await executor.approveIfNeeded({
    token: TOKEN,
    amount,
    spender: SPENDER,
    owner: OWNER,
  });

  assert.equal(hash, TX_HASH);
  assert.equal(calls.simulate.length, 1);
  const simulated = calls.simulate[0];
  assert.equal(simulated.address, AGENT);
  assert.equal(simulated.functionName, "submitApproveStrategy");
  assert.equal(simulated.args[0], TOKEN);
  assert.equal(simulated.args[1], amount);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].to, AGENT);
});

test("approveIfNeeded: amount above the controller limit rejects before any read", async () => {
  const { publicClient, calls } = makePublicClient();
  const { wallet } = makeWallet();
  const executor = createExecutor({
    publicClient,
    wallet,
    dryRun: false,
    config: makeConfig(),
    log: () => {},
  });

  await assert.rejects(
    executor.approveIfNeeded({
      token: TOKEN,
      amount: 10n ** 36n + 1n,
      spender: SPENDER,
      owner: OWNER,
    }),
    /exceeds the controller limit/,
  );
  assert.equal(calls.read.length, 0);
  assert.equal(calls.simulate.length, 0);
});

test("createExecutor: wallet is required unless dryRun", () => {
  const { publicClient } = makePublicClient();

  assert.throws(
    () => createExecutor({ publicClient, dryRun: false, config: makeConfig() }),
    /wallet is required unless dryRun/,
  );
});
