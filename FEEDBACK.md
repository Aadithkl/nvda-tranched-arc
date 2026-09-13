# Uniswap Developer Feedback — nvda-tranched-arc

Notes from building a tranched RWA book on Uniswap v4. The integration is the
`TrancheJITHook`: dynamic fee, oracle-gated quoting and bucket-exact JIT liquidity inside the
v4 `PoolManager`, with the full tranche stack (ERC-7575 share + ERC-7540 vaults) on top.

## What we built on Uniswap v4

Canonical v4 contracts (pinned submodules) are redeployed on Arc testnet because Arc has no
canonical v4 deployment — `PoolManager`, the full periphery (`PositionManager`,
`PositionDescriptor`, `StateView`, `V4Quoter`, `ReservesLens`) and a custom hook, with
`DemoRouter` as the swap entry. `TrancheJITHook` prices each swap from the oracle-vs-pool price
deviation multiplied by a toxicity multiplier, gates quoting on oracle validity and market
window, seeds a byte-exact one-sided JIT position sized from v4 amount-delta math, and parks
idle USDC in a lending market between windows. See `script/DeployV4Stack.s.sol` and
`docs/ARCHITECTURE.md` for code pointers.

## What worked well

The Uniswap docs were detailed, and I used the publicly available hooks and samples to understand more — the resources are vast and helpful.

## Friction, bugs, and surprises

- Hook address mining: permission bits have to be encoded in the deployed address. Salt mining is workable, but a first-class deploy helper for hooks with a mixed permission set would remove an easy source of confusion.
- EIP-170: the full periphery plus the hook only fit with `via_ir = true` and `bytecode_hash = "none"`; size pressure is a constant design constraint on hook code.
- Redeploying v4 on a new chain means standing up your own periphery and quoter before the hook is usable; the router surface for direct `PoolManager` calls (e.g. a minimal swap entry) is thin.
- ERC-6909 claims: positive JIT deltas land as claims and need explicit redeem paths and accounting; more guidance on claim lifecycle in hooks would help.
- Agent-facing data: indexing v4 swap/JIT events for an offchain agent required custom subgraph handlers — the shape of hook-level events (quotes, JIT episodes, realized fees) is not standardized.

## Suggestions

From an agentic point of view, it would have been better if there was at least a community tool/library with historical data and fees (or other things) — agent-ready aggregated data — to make more predictive and responsive agents.

## Links

- Repository: https://github.com/Aadithkl/nvda-tranched-arc
- Hook: [src/hook/TrancheJITHook.sol](https://github.com/Aadithkl/nvda-tranched-arc/blob/main/src/hook/TrancheJITHook.sol)
- v4 deployment script: [script/DeployV4Stack.s.sol](https://github.com/Aadithkl/nvda-tranched-arc/blob/main/script/DeployV4Stack.s.sol)
- Architecture: [docs/ARCHITECTURE.md](https://github.com/Aadithkl/nvda-tranched-arc/blob/main/docs/ARCHITECTURE.md)
