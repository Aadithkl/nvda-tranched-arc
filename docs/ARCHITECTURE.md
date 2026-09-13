# Architecture

NVDA exposure split into senior and junior tranches on Arc. Deposits mint one ERC-7575 hook
share; the capital behind it rests in an Aave fork and is deployed into a Uniswap v4 pool only as
just-in-time liquidity. An agent adjusts the hook within hard onchain bounds.

Interactive maps (self-contained HTML, open in a browser):

- [System architecture](archify/nvda-tranches.architecture.html)
- [Deposit to JIT swap](archify/nvda-deposit-jit.sequence.html)

Typed sources (`docs/archify/*.json`) regenerate with the Archify skill (validate, then deliver).

## 1. Uniswap v4 hook - execution

- `TrancheJITHook` is the only bridge between the book and the markets. The v4 pool carries zero
  standing liquidity; inventory waits in the Aave rest state.
- Before every quote it checks the gate stack - active pool, params TTL, oracle freshness (300s),
  deviation band - and prices the fee: toxic flow pays `baseFee + deviation x toxicityMultiplier`,
  with an EV floor.
- `afterSwap` removes the transient range: positive deltas become ERC-6909 claims, negative deltas
  are paid from Aave. `JitRangeExceeded` reverts if price left the bucket; the JIT risk budget is
  `juniorClaim` only while the senior escrow is funded.
- Code: [`_quoteWithGates`](../src/hook/TrancheJITHook.sol#L493),
  [`_jitBeforeSwap`](../src/hook/TrancheJITHook.sol#L500) /
  [`_jitAfterSwap`](../src/hook/TrancheJITHook.sol#L555)

## 2. ERC-7575 hook share - the tranche primitive

- `HookShareToken` (`tjSHARE`) is an ERC-20 whose `vault(asset)` points at the hook, with mint and
  burn callable only by the hook: one share per book, fully backed by the hook's basket.
- The senior and junior vaults are ERC-7540 wrappers over that same share; the accountant pegs
  their balances to entitlements and enforces senior priority. Exits: USDC for both, equity or
  proportional for junior.
- Code: [`HookShareToken.sol`](../src/core/HookShareToken.sol#L25),
  [`wrapUSDC`](../src/periphery/TranchePipeModule.sol#L173)

## 3. The Graph - what the agent reads

- The `tranch-stock` subgraph indexes oracle prices, v4 swaps, JIT episodes, share flows and agent
  actions in the Messari Yield Aggregator schema.
- The agent's market model and the frontend Markets page read it; it is a speed layer only -
  transactions never gate on subgraph data.
- See [`docs/GRAPH.md`](GRAPH.md).

## 4. Circle - what the agent pays with

- Every paid call settles through Circle Gateway nanopayments: the NVDA oracle quote and the 6-hour
  LLM verdict.
- No Arc listings in the marketplace, so the paid reasoning settles on Base/Polygon; Arc remains
  the execution chain.
- The frontend signs in with a Circle passkey smart account; userOps are gasless via paymaster.
- See [`docs/CIRCLE.md`](CIRCLE.md).

---

Artifacts in `docs/archify/`: JSON source + self-contained HTML per diagram. Addresses:
`deployments/arc-testnet.json` is the single source of truth.